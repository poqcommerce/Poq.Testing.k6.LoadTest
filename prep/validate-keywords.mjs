#!/usr/bin/env node
// Checks every search keyword of a client before a run: each keyword must answer the two calls the journeys
// make with it (keyword search, and predictive search with the whole keyword) with the expected status and the
// body checks from clients/<client>/config.js (endpoints.search / endpoints.predictive). A keyword that returns
// 500 (e.g. "zach bryan" on hottopic-perf: /search?q=zach bryan&isBloomreachKeywordSearch=true) only adds noise to
// a load run. The failures are intermittent, so a keyword is valid only if all --repeat rounds pass.
//
//   node prep/validate-keywords.mjs <client> --env <dev|staging|prod> [options]
//
//   --allow-prod        required for --env prod
//   --max-rpm <n>       hard cap on requests per minute for the whole run (default 40)
//   --repeat <n>        rounds per keyword, each round = search + predictive (default 3)
//   --no-predictive     check the keyword search only
//   --input <file>      keywords as a JSON array of strings (default clients/<client>/data/keywords.json)
//   --max-age <hours>   resume window (default 24): results younger than this are kept and not checked again
//   --fresh             ignore earlier results and check everything again
//   --apply             rewrite the input file without the keywords that failed (see below)
//
// Without --apply nothing the k6 test reads is changed. Files next to the input, in clients/<client>/data/:
//   keywords_<env>.checked.json  the result per keyword (ok / reason / detail / Poq-Request-Id / checkedAt), for resuming
//   keywords.all.json            with --apply: the original list, kept the first time; later runs check this full list
//                                again, so a keyword that works again comes back
// Progress is saved every 10 keywords and on Ctrl+C; the same command resumes. Exit code 1 when any keyword failed.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, loadClient, createApi, sleep, nowIso } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--max-rpm', '--repeat', '--input', '--max-age']);
const [clientName] = positional;
if (!clientName || !opts.env) {
  console.error('Usage: node prep/validate-keywords.mjs <client> --env <dev|staging|prod> [--allow-prod] [--max-rpm n] [--repeat n] [--no-predictive] [--input file] [--max-age hours] [--fresh] [--apply]');
  process.exit(2);
}

let ctx;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const inputPath = opts.input || `clients/${clientName}/data/keywords.json`;
const dir = dirname(inputPath);
const allPath = join(dir, `${basename(inputPath, '.json')}.all.json`);
const checkedPath = join(dir, `${basename(inputPath, '.json')}_${opts.env}.checked.json`);
const repeat = Number(opts.repeat ?? 3);
const maxAgeHours = Number(opts['max-age'] ?? 24);
const withPredictive = !opts['no-predictive'];
// The full candidate list: the kept original when an earlier --apply has trimmed the input file.
const candidates = [...new Set(JSON.parse(readFileSync(existsSync(allPath) ? allPath : inputPath, 'utf8')).map((k) => String(k).trim()).filter(Boolean))];

const api = createApi(ctx, { maxRpm: Number(opts['max-rpm'] ?? 40) });
const endpoints = ctx.client.endpoints || {};
const checked = loadChecked();
const todo = candidates.filter((k) => !checked[k]);
let done = 0;

console.log(`Validating ${candidates.length} keywords for ${clientName} ${opts.env} via ${ctx.apiPath}: ${repeat} round(s) of search${withPredictive ? ' + predictive' : ''} each, max ${opts['max-rpm'] ?? 40} req/min`);
console.log(`${candidates.length - todo.length} kept from an earlier run (younger than ${maxAgeHours} h), ${todo.length} to check`);

process.on('SIGINT', () => {
  save();
  console.log(`\nInterrupted: progress saved to ${checkedPath}. Run the same command to resume.`);
  process.exit(130);
});

const session = await api.newSession();
if (!session) {
  console.error('Could not start an API session (guest token), stopping.');
  process.exit(2);
}

for (const keyword of todo) {
  checked[keyword] = { ...(await validate(keyword)), checkedAt: nowIso() };
  done++;
  const r = checked[keyword];
  console.log(`[${candidates.length - todo.length + done}/${candidates.length}] ${keyword}: ${r.ok ? 'ok' : `FAIL ${r.reason} (${r.detail})`}`);
  if (done % 10 === 0) save();
}
save();

const failed = candidates.filter((k) => !checked[k].ok);
console.log(`\n${candidates.length - failed.length} valid, ${failed.length} failed of ${candidates.length} keywords; ${api.requestCount()} requests; results in ${checkedPath}`);
for (const k of failed) {
  const r = checked[k];
  console.log(`  FAIL "${k}": ${r.call} ${r.reason} (${r.detail})${r.requestId ? `, Poq-Request-Id ${r.requestId}` : ''}`);
}

if (opts.apply) {
  if (failed.length === candidates.length) {
    console.error('Every keyword failed (the host is probably down): not rewriting the input file.');
    process.exit(1);
  }
  if (!existsSync(allPath)) writeFileSync(allPath, `${JSON.stringify(candidates, null, 1)}\n`);
  const keep = candidates.filter((k) => checked[k].ok);
  writeFileSync(`${inputPath}.partial`, `${JSON.stringify(keep, null, 1)}\n`);
  renameSync(`${inputPath}.partial`, inputPath);
  console.log(`${inputPath} rewritten with ${keep.length} keywords (${failed.length} removed; full list kept in ${allPath})`);
} else if (failed.length) {
  console.log('Add --apply to remove the failed keywords from the list the test reads.');
}
process.exit(failed.length ? 1 : 0);

// One keyword: `repeat` rounds, stopping at the first failure. Returns { ok } or { ok:false, call, reason, detail, requestId }.
async function validate(keyword) {
  for (let round = 1; round <= repeat; round++) {
    const calls = [['search', '/search', { q: keyword }]];
    if (withPredictive) calls.push(['predictive', '/search/predictive', { keyword }]);
    for (const [key, path, query] of calls) {
      const r = await call(key, path, query);
      if (r) return { ok: false, ...r, detail: `${r.detail}${repeat > 1 ? `, round ${round} of ${repeat}` : ''}` };
    }
  }
  return { ok: true };
}

// Sends one call with the client's endpoint tweak (path, extra query, expected statuses, body checks); null when it passes.
async function call(key, defaultPath, baseQuery) {
  const tweak = endpoints[key] || {};
  const query = Object.fromEntries(Object.entries({ ...baseQuery, ...tweak.query }).filter(([, v]) => v !== undefined && v !== null));
  const res = await api.send(session, 'GET', tweak.path || defaultPath, { query });
  const expect = tweak.expect || [200];
  const fail = (reason, detail) => ({ call: key, reason, detail, requestId: res.requestId || null });
  if (res.status === 0) return fail('network', res.text);
  if (!expect.includes(res.status)) return fail(`status ${res.status}`, `expected ${expect.join('|')}: ${(res.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  for (const [label, fn] of Object.entries(tweak.checks || {})) {
    let pass = false;
    try {
      pass = Boolean(fn(res.json, { status: res.status, body: res.text }));
    } catch {}
    if (!pass) return fail('check', `"${label}" failed`);
  }
  return null;
}

function loadChecked() {
  if (opts.fresh || !existsSync(checkedPath)) return {};
  let doc;
  try {
    doc = JSON.parse(readFileSync(checkedPath, 'utf8'));
  } catch {
    return {};
  }
  if (doc.apiPath && doc.apiPath !== ctx.apiPath) return {};
  const cutoff = Date.now() - maxAgeHours * 3.6e6;
  const onList = new Set(candidates);
  return Object.fromEntries(Object.entries(doc.keywords || {}).filter(([k, v]) => onList.has(k) && Date.parse(v.checkedAt) >= cutoff));
}

function save() {
  writeFileSync(`${checkedPath}.partial`, JSON.stringify({ client: clientName, env: opts.env, apiPath: ctx.apiPath, repeat, predictive: withPredictive, savedAt: nowIso(), keywords: checked }, null, 1));
  renameSync(`${checkedPath}.partial`, checkedPath);
}
