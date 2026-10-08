// Thresholds and end-of-test reporting (plan §14).
//
// k6 only reports per-tag values for sub-metrics named in thresholds, so buildThresholds()
// also registers always-true thresholds (count>=0 / rate>=0) for every endpoint, scenario
// and failure status that the reports need. Only the p(95), failure-rate and checks
// thresholds can fail a run.

import { FAILURE_STATUSES } from './http.js';

export function buildThresholds(cfg, { scenarioNames, endpointNames, limits }) {
  const t = {};
  for (const sc of scenarioNames) {
    const failed = [`rate<${limits.maxFailedRate}`];
    if (cfg.envName === 'prod') {
      failed.push({ threshold: `rate<${cfg.prodAbort.rate}`, abortOnFail: true, delayAbortEval: cfg.prodAbort.delay });
    }
    t[`http_req_failed{scenario:${sc}}`] = failed;
    const checks = [`rate>${limits.minChecksRate}`];
    if (cfg.envName === 'prod') {
      // A 200 with a broken body passes http_req_failed; the same abort limit applies to failed checks.
      checks.push({ threshold: `rate>${1 - cfg.prodAbort.rate}`, abortOnFail: true, delayAbortEval: cfg.prodAbort.delay });
    }
    t[`checks{scenario:${sc}}`] = checks;
    t[`iterations{scenario:${sc}}`] = ['count>=0'];
    t[`http_reqs{scenario:${sc}}`] = ['count>=0'];
  }
  for (const name of endpointNames) {
    const p95 = limits.p95Ms[name] ?? limits.p95Ms.default;
    t[`http_req_duration{name:${name}}`] = [`p(95)<${p95}`];
    t[`http_req_failed{name:${name}}`] = ['rate>=0'];
    t[`endpoint_failures{name:${name}}`] = ['count>=0'];
    for (const status of FAILURE_STATUSES) t[`endpoint_failures{name:${name},status:${status}}`] = ['count>=0'];
  }
  return t;
}

export function makeHandleSummary(cfg, { scenarioNames, endpointNames }) {
  return function handleSummary(data) {
    const m = data.metrics;
    const val = (key, stat) => (m[key] ? m[key].values[stat] : undefined);
    const thresholdOk = (key) => !m[key] || !m[key].thresholds || Object.values(m[key].thresholds).every((x) => x.ok);

    const endpoints = endpointNames
      .map((name) => ({
        name,
        requests: val(`http_req_duration{name:${name}}`, 'count') || 0,
        failedPct: pct(val(`http_req_failed{name:${name}}`, 'rate')),
        avg: ms(val(`http_req_duration{name:${name}}`, 'avg')),
        p90: ms(val(`http_req_duration{name:${name}}`, 'p(90)')),
        p95: ms(val(`http_req_duration{name:${name}}`, 'p(95)')),
        p99: ms(val(`http_req_duration{name:${name}}`, 'p(99)')),
        max: ms(val(`http_req_duration{name:${name}}`, 'max')),
        failures: val(`endpoint_failures{name:${name}}`, 'count') || 0,
        p95Threshold: Object.keys((m[`http_req_duration{name:${name}}`] || {}).thresholds || {})[0] || '',
        p95Ok: thresholdOk(`http_req_duration{name:${name}}`),
      }))
      .filter((e) => e.requests > 0 || e.failures > 0);

    const failures = [];
    for (const name of endpointNames) {
      for (const status of FAILURE_STATUSES) {
        const count = val(`endpoint_failures{name:${name},status:${status}}`, 'count');
        if (count) failures.push({ name, status, count });
      }
    }

    const scenarios = scenarioNames.map((sc) => {
      const iterations = val(`iterations{scenario:${sc}}`, 'count') || 0;
      const requests = val(`http_reqs{scenario:${sc}}`, 'count') || 0;
      return {
        name: sc,
        iterations,
        requests,
        requestsPerIteration: iterations ? (requests / iterations).toFixed(1) : '-',
        failedPct: pct(val(`http_req_failed{scenario:${sc}}`, 'rate')),
        checksPct: pct(val(`checks{scenario:${sc}}`, 'rate')),
        ok: thresholdOk(`http_req_failed{scenario:${sc}}`) && thresholdOk(`checks{scenario:${sc}}`),
      };
    });

    const breached = Object.entries(m)
      .flatMap(([key, metric]) => Object.entries(metric.thresholds || {}).filter(([, r]) => !r.ok).map(([expr]) => `${key}: ${expr}`));

    // run.mjs passes RUN_DIR (one folder per run). A plain `k6 run` writes flat files into results/
    // instead (k6 can't create folders; results/ is kept in the repo via results/.gitkeep).
    const prefix = cfg.runDir ? `${cfg.runDir}/` : `results/${cfg.client}_${cfg.envName}_${cfg.profile}_${stamp()}_`;
    return {
      stdout: textReport(cfg, data, scenarios, endpoints, failures, breached, prefix),
      [`${prefix}summary.json`]: JSON.stringify(redactSetupData(data), null, 2),
      [`${prefix}endpoints.csv`]: csv(
        ['name', 'requests', 'failed_pct', 'avg_ms', 'p90_ms', 'p95_ms', 'p99_ms', 'max_ms', 'failures', 'p95_threshold', 'p95_ok'],
        endpoints.map((e) => [e.name, e.requests, e.failedPct, e.avg, e.p90, e.p95, e.p99, e.max, e.failures, e.p95Threshold, e.p95Ok]),
      ),
      [`${prefix}failures.csv`]: csv(['name', 'status', 'count'], failures.map((f) => [f.name, f.status, f.count])),
      [`${prefix}endpoints.html`]: htmlReport(cfg, data, scenarios, endpoints, failures, breached),
    };
  };
}

// One self-contained page with the per-endpoint table (the k6 dashboard has run-wide charts only).
// Click a column header to sort; rows over their p95 limit are marked.
function htmlReport(cfg, data, scenarios, endpoints, failures, breached) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const secs = Math.round((data.state.testRunDurationMs || 0) / 1000);
  const rows = (items, cls) => items.map((r) => `<tr${cls ? ` class="${cls(r)}"` : ''}>${r.map((c, i) => `<td${i ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  const tbl = (id, head, body) => `<table id="${id}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const scenarioRows = scenarios.map((x) => [x.name, x.iterations, x.requests, x.requestsPerIteration, x.failedPct, x.checksPct, x.ok ? 'yes' : 'NO']);
  const endpointRows = endpoints.map((e) => [e.name, e.requests, e.failedPct, e.avg, e.p90, e.p95, e.p99, e.max, e.failures, e.p95Threshold, e.p95Ok ? 'yes' : 'NO']);
  const failureRows = [...failures].sort((a, b) => b.count - a.count).map((f) => [f.name, f.status, f.count]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.displayName)} endpoints</title>
<style>
:root{--bg:#fff;--fg:#1d2330;--mut:#6b7280;--line:#e5e7eb;--bad:#fde8e8;--head:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#161a22;--fg:#e6e8ee;--mut:#9aa3b2;--line:#2a3140;--bad:#4a1f24;--head:#1f2530}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px 16px 40px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p{margin:4px 0;color:var(--mut)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{background:var(--head);cursor:pointer;position:sticky;top:0}td.n{text-align:right}
tr.bad{background:var(--bad)}.wrap{overflow-x:auto}ul{margin:6px 0;padding-left:20px}
</style></head><body>
<h1>${esc(cfg.displayName)}: ${esc(cfg.envName)}, ${esc(cfg.profile)}</h1>
<p>${secs}s &middot; ${breached.length ? `${breached.length} threshold(s) breached` : 'all thresholds passed'}${data.setup_data && data.setup_data.dataScope ? ` &middot; ${esc(data.setup_data.dataScope)}` : ''}</p>
<h2>Endpoints (${endpoints.length})</h2><div class="wrap">${tbl('e', ['endpoint', 'reqs', 'fail %', 'avg ms', 'p90 ms', 'p95 ms', 'p99 ms', 'max ms', 'failures', 'p95 limit', 'ok'], rows(endpointRows, (r) => (r[10] === 'NO' || r[8] ? 'bad' : '')))}</div>
<h2>Scenarios</h2><div class="wrap">${tbl('s', ['scenario', 'iterations', 'requests', 'req/iter', 'failed %', 'checks %', 'ok'], rows(scenarioRows, (r) => (r[6] === 'NO' ? 'bad' : '')))}</div>
${failureRows.length ? `<h2>Failures</h2><div class="wrap">${tbl('f', ['endpoint', 'status', 'count'], rows(failureRows))}</div>` : ''}
${breached.length ? `<h2>Thresholds breached</h2><ul>${breached.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
<script>
document.querySelectorAll('th').forEach(function(th){th.addEventListener('click',function(){
var t=th.closest('table'),i=[].indexOf.call(th.parentNode.children,th),d=th.dataset.d=th.dataset.d==='1'?'-1':'1';
var rs=[].slice.call(t.tBodies[0].rows);rs.sort(function(a,b){var x=a.cells[i].textContent,y=b.cells[i].textContent,nx=parseFloat(x),ny=parseFloat(y);
return (isNaN(nx)||isNaN(ny)?x.localeCompare(y):nx-ny)*d});rs.forEach(function(r){t.tBodies[0].appendChild(r)})})});
</script></body></html>
`;
}

// setup() hands secrets to the VUs (e.g. the derived poq-auth key); they must never reach an output file.
function redactSetupData(data) {
  if (!data.setup_data || typeof data.setup_data !== 'object') return data;
  const setup = Object.fromEntries(Object.entries(data.setup_data).map(([k, v]) => [k, /key|secret|token|password|salt/i.test(k) && v ? '[redacted]' : v]));
  return { ...data, setup_data: setup };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function textReport(cfg, data, scenarios, endpoints, failures, breached, prefix) {
  const lines = [];
  const secs = Math.round((data.state.testRunDurationMs || 0) / 1000);
  lines.push('', `=== ${cfg.displayName} | env=${cfg.envName} | profile=${cfg.profile} | ${secs}s ===`, '');
  if (data.setup_data && data.setup_data.dataScope) lines.push(`Data: ${data.setup_data.dataScope}`, '');
  const stale = data.setup_data && data.setup_data.staleWarning;
  if (stale) lines.push(`WARNING — run used stale data: ${stale}`, '');
  lines.push('Scenarios');
  lines.push(table(
    ['scenario', 'iterations', 'requests', 'req/iter', 'failed %', 'checks %', 'ok'],
    scenarios.map((s) => [s.name, s.iterations, s.requests, s.requestsPerIteration, s.failedPct, s.checksPct, s.ok ? 'yes' : 'NO']),
  ));
  lines.push('', 'Endpoints');
  lines.push(table(
    ['endpoint', 'reqs', 'fail %', 'avg', 'p95', 'p99', 'p95 limit', 'ok'],
    endpoints.map((e) => [e.name, e.requests, e.failedPct, e.avg, e.p95, e.p99, e.p95Threshold, e.p95Ok ? 'yes' : 'NO']),
  ));
  if (failures.length) {
    lines.push('', 'Failures (all counted; details in failures.log)');
    lines.push(table(['endpoint', 'status', 'count'], failures.sort((a, b) => b.count - a.count).map((f) => [f.name, f.status, f.count])));
  }
  lines.push('', breached.length ? `THRESHOLDS BREACHED (${breached.length}):` : 'All thresholds passed.');
  for (const b of breached) lines.push(`  - ${b}`);
  lines.push('', cfg.runDir
    ? `Reports: ${cfg.runDir}/{report.html, summary.json, endpoints.csv, endpoints.html, failures.csv, failures.log}`
    : `Reports: ${prefix}{summary.json, endpoints.csv, endpoints.html, failures.csv}`);
  lines.push('');
  return lines.join('\n');
}

function table(header, rows) {
  const all = [header, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r, i) => {
    const line = r.map((c, j) => (j === 0 ? c.padEnd(widths[j]) : c.padStart(widths[j]))).join('  ');
    return i === 0 ? `  ${line}\n  ${widths.map((w) => '-'.repeat(w)).join('  ')}` : `  ${line}`;
  }).join('\n');
}

function csv(header, rows) {
  const cell = (c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

const ms = (v) => (v === undefined ? '' : Math.round(v));
const pct = (v) => (v === undefined ? '' : (v * 100).toFixed(2));
