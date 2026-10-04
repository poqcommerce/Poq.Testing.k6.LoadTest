#!/usr/bin/env node
// Finds the categories of a client and checks which of them really work, before a run. Port of the
// Python category_id_extractor (Poq.Testing.Utilities new_gen): the /shop tree is walked recursively
// and each category's URL is split into a clean URL and its filter. New here: every category is then
// opened as a product list (PLP), with each of the client's sort orders, so categories that answer 500
// or are nearly empty can be left out of a run (the sanity run on hottopic-perf hit one that returned 500
// for every sort).
//
//   node prep/extract-categories.mjs <client> --env <dev|staging|prod> [options]
//
//   --allow-prod        required for --env prod
//   --all-sorts         check every sort order of the client (default: the plain list plus the first sort order,
//                       enough to catch a category that fails for sorting; 3 times fewer requests)
//   --base-only         check only the plain PLP (6 times fewer requests than --all-sorts)
//   --no-validate       just extract the tree (what the Python extractor did)
//   --min-items <n>     fewer products than this = not usable (default 7). Tiny categories are the unstable ones: on hottopic-perf
//                       7 of the 8 categories that answered 500 during the 2026-10-04 prod run had 2-6 products when they were
//                       last checked, and all of them had passed a single check three days earlier
//   --no-confirm        skip the confirm pass (default: once every category has been checked, the ones that passed are checked
//                       a second time, so a category that is flaky or went bad while the run was going is dropped too)
//   --max-rpm <n>       hard cap on requests per minute for the whole run (default 40)
//   --limit <n>         validate only the first n categories (a quick look)
//   --max-age <hours>   resume window (default 12, the client's maxDataAgeHours): results younger than this are kept and not checked again
//   --fresh             ignore earlier results and check everything again

// Resuming: every checked category carries its own checkedAt. A new run reads categories_<env>.json and its
// .partial (saved every 10 checks and on Ctrl+C), keeps the results younger than --max-age and checks only
// the rest, so an interrupted run just continues when started again. The file's generatedAt is the age of its
// OLDEST check, which is what k6's freshness check looks at.
//
// Writes clients/<client>/data/categories_<env>.json (all categories, with their check results, plus
// the list of valid ids).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, loadClient, createApi, nowIso } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--min-items', '--max-rpm', '--limit', '--max-age']);
const [clientName] = positional;
if (!clientName || !opts.env) {
  console.error('Usage: node prep/extract-categories.mjs <client> --env <dev|staging|prod> [--allow-prod] [--all-sorts] [--base-only] [--no-validate] [--no-confirm] [--min-items n] [--max-rpm n] [--limit n] [--max-age hours] [--fresh]');
  process.exit(2);
}

let ctx;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const minItems = Number(opts['min-items'] ?? 7);
const api = createApi(ctx, { maxRpm: Number(opts['max-rpm'] ?? 40) });
const allVariants = ctx.client.plpVariants || [];
const variants = opts['base-only'] ? [] : opts['all-sorts'] ? allVariants : allVariants.slice(0, 1);

// The client's config.js endpoint tweaks (a query value of undefined drops the parameter), as lib/http.js applies them.
const withTweak = (key, query) => {
  const out = { ...query };
  for (const [k, v] of Object.entries((ctx.client.endpoints && ctx.client.endpoints[key] && ctx.client.endpoints[key].query) || {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

const session = await api.newSession();
if (!session) {
  console.error('Could not start a session (guest token) — stopping.');
  process.exit(1);
}

console.log(`Extracting categories for ${clientName} ${opts.env} via ${ctx.apiPath}`);
const shop = await api.send(session, 'GET', '/shop', { query: withTweak('shopCategories', { 'slot-content-id': 'shop' }) });
const tree = Array.isArray(shop.json) ? shop.json : shop.json && shop.json.categories;
if (shop.status !== 200 || !Array.isArray(tree) || !tree.length) {
  console.error(`/shop returned status ${shop.status} with no categories: ${(shop.text || '').slice(0, 200)}`);
  process.exit(1);
}

// Children first, then the category itself (the Python order). A category can appear under several parents.
const categories = [];
(function walk(list, parentId) {
  for (const c of list || []) {
    const kids = c.categories || c.children;
    if (kids && kids.length) walk(kids, c.id);
    if (!c.id || !c.name) continue;
    const [url, query = ''] = String(c.categoryUrl || '').split('?');
    const filter = [...new URLSearchParams(query)][0] || ['', ''];
    categories.push({
      id: String(c.id),
      title: c.name,
      categoryUrl: url,
      filterKey: filter[0],
      filterValue: filter[1].replaceAll('|', ';'), // pipes become semicolons so the CSV stays readable
      parentId: parentId ? String(parentId) : null,
      leaf: !(kids && kids.length),
    });
  }
})(tree, null);
const unique = [...new Map(categories.map((c) => [c.id, c])).values()];
const carried = opts.fresh ? 0 : carryOver(unique);
console.log(`${tree.length} top-level categories, ${categories.length} entries, ${unique.length} unique, ${unique.filter((c) => c.leaf).length} leaves, ${categories.filter((c) => c.filterKey).length} with a filter`);

process.on('SIGINT', () => {
  const out = save(true);
  console.log(`\nInterrupted: results so far saved to ${out}.`);
  process.exit(130);
});

if (!opts['no-validate']) {
  // Only leaf categories are opened by the app's product lists; parents are listed but not judged.
  const leaves = unique.filter((c) => c.leaf).slice(0, opts.limit ? Number(opts.limit) : undefined);
  const todo = leaves.filter((c) => !c.check);
  console.log(`${carried} results carried over from earlier runs (younger than ${opts['max-age'] ?? 12} h).`);
  console.log(`Checking ${todo.length} leaf categories${variants.length ? ` (plain list + ${variants.length} sort order${variants.length > 1 ? 's' : ''} each)` : ' (plain list only)'}, at most ${opts['max-rpm'] ?? 40} requests/min…`);
  let n = 0;
  for (const c of todo) {
    n++;
    c.check = await check(c.id);
    c.checkedAt = nowIso();
    console.log(`[${n}/${todo.length}] ${c.id}: ${c.check.ok ? `ok (${c.check.items} products)` : c.check.reason}`);
    if (n % 10 === 0) save(true);
  }

  // Confirm pass: a category that passed once is checked again after the whole first pass, minutes later, so one that
  // is flaky or went bad in between is dropped. Results already confirmed (this run or a resumed one) are not repeated.
  if (!opts['no-confirm']) {
    const again = leaves.filter((c) => c.check && c.check.ok && !c.check.confirmed);
    console.log(`Confirm pass: checking ${again.length} categories that passed once…`);
    let m = 0;
    for (const c of again) {
      m++;
      const r = await check(c.id);
      c.check = r.ok ? { ...r, confirmed: true } : { ...r, reason: `unstable (passed before): ${r.reason}` };
      c.checkedAt = nowIso();
      if (!r.ok) console.log(`[confirm ${m}/${again.length}] ${c.id}: ${c.check.reason}`);
      if (m % 10 === 0) save(true);
    }
  }
}

const out = save(false);
const valid = unique.filter((c) => c.check && c.check.ok);
const bad = unique.filter((c) => c.check && !c.check.ok);
console.log(`\n${out}: ${valid.length} valid, ${bad.length} not usable${bad.length ? ` (${JSON.stringify(countBy(bad.map((c) => c.check.reason.split(':')[0])))})` : ''}; ${api.requestCount()} requests`);
process.exit(opts['no-validate'] || valid.length ? 0 : 1);

// A category is usable when its plain list and every sort order answer 200 with enough products.
async function check(id) {
  const calls = [{ name: 'plain', query: {} }, ...variants.map((v) => ({ name: v.name, query: v.query || {} }))];
  let items = 0;
  for (const call of calls) {
    const r = await api.send(session, 'GET', '/search', { query: withTweak('plp', { categories: id, ...call.query, 'slot-content-id': 'plp' }) });
    if (r.status !== 200) return { ok: false, reason: `status ${r.status}: ${call.name}` };
    const n = r.json && r.json.pagination ? Number(r.json.pagination.numberOfItems) : NaN;
    if (!(n >= minItems)) return { ok: false, reason: `too few products (${Number.isNaN(n) ? 'no pagination' : n}): ${call.name}`, items: Number.isNaN(n) ? null : n };
    if (call.name === 'plain') items = n;
  }
  return { ok: true, items };
}

function save(partial) {
  const doc = {
    client: clientName,
    env: opts.env,
    apiPath: ctx.apiPath,
    generatedAt: unique.filter((c) => c.checkedAt).map((c) => c.checkedAt).sort()[0] || nowIso(),
    checked: !opts['no-validate'],
    sortOrdersChecked: variants.map((v) => v.name),
    minItems,
    validIds: unique.filter((c) => c.check && c.check.ok).map((c) => c.id),
    categories: unique,
  };
  const base = `clients/${clientName}/data/categories_${opts.env}`;
  writeFileSync(`${base}.json${partial ? '.partial' : ''}`, JSON.stringify(doc, null, 1));
  return `${base}.json${partial ? '.partial' : ''}`;
}

// Copies earlier check results onto the freshly extracted categories (same environment and API path only).
function carryOver(list) {
  const maxAgeMs = Number(opts['max-age'] ?? 12) * 3.6e6;
  const byId = new Map(list.map((c) => [c.id, c]));
  let n = 0;
  for (const file of [`clients/${clientName}/data/categories_${opts.env}.json`, `clients/${clientName}/data/categories_${opts.env}.json.partial`]) {
    if (!existsSync(file)) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (doc.env !== opts.env || doc.apiPath !== ctx.apiPath) continue;
    for (const old of doc.categories || []) {
      const c = byId.get(old.id);
      const at = old.checkedAt || doc.generatedAt; // files from before checkedAt existed
      if (!c || !old.check || !(Date.now() - Date.parse(at) <= maxAgeMs)) continue;
      // A rejection for too few products under an older, stricter --min-items is checked again.
      const few = !old.check.ok && /^too few products \((\d+)\)/.exec(old.check.reason);
      if (few && Number(few[1]) >= minItems) continue;
      // A pass with fewer products than today's --min-items is checked again too.
      if (old.check.ok && !(old.check.items >= minItems)) continue;
      if (c.check && c.checkedAt >= at) continue; // keep the newer result
      if (!c.check) n++;
      c.check = old.check;
      c.checkedAt = at;
    }
  }
  return n;
}

function countBy(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}
