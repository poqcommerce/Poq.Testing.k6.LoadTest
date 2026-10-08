// Every Poq API call goes through request(): it builds the header contract, tags the
// request by name, checks the expected result and logs anything that doesn't match it
// (migration plan §14.2). Journeys never need their own logging code.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { poqAuth } from './auth.js';

export const endpointFailures = new Counter('endpoint_failures');

// Status tags counted per endpoint in failures.csv. Anything else is counted as "other"
// (the exact status is still in failures.log). "check" = expected status but a body check
// failed; "correlation" = a value needed by a later step was missing.
export const FAILURE_STATUSES = [
  '0', '400', '401', '403', '404', '405', '409', '410', '412', '415', '422', '424', '429',
  '500', '502', '503', '504', 'other', 'check', 'correlation',
];

const LOG_LIMIT = Number(__ENV.FAILURE_LOG_LIMIT ?? 10); // per VU, per request name + status; 0 = unlimited
const BODY_LIMIT = 1024;
const loggedCounts = {}; // module state is per VU

// Optional per-VU request pacing: -e MAX_RPM_PER_VU=40 keeps each VU at ≤ 40 requests/minute
// (with a single-VU smoke run that is the whole test's rate). Used for low-impact prod checks.
const MIN_INTERVAL_S = parseMaxRpm(__ENV.MAX_RPM_PER_VU);
// A value that is not a positive number would silently turn pacing off (NaN) or hang every VU (0).
function parseMaxRpm(raw) {
  if (raw === undefined || raw === '') return 0;
  const rpm = Number(raw);
  if (!(rpm > 0 && Number.isFinite(rpm))) throw new Error(`MAX_RPM_PER_VU must be a positive number (got "${raw}")`);
  return 60 / rpm;
}
let lastRequestAt = 0;

function pace() {
  if (!MIN_INTERVAL_S) return;
  const wait = lastRequestAt + MIN_INTERVAL_S - Date.now() / 1000;
  if (wait > 0) sleep(wait);
  lastRequestAt = Date.now() / 1000;
}

// One session = one app user journey (one iteration). Holds identity and correlated state.
// poqUserId: pass one to keep a device id across iterations (clients without guest tokens).
export function newSession(cfg, { poqUserId } = {}) {
  return { cfg, poqUserId: poqUserId || crypto.randomUUID(), token: null, headers: {} };
}

// Header contract: the client's static headers (clients/<client>/config.js `headers`) plus the
// per-environment app identity and the session's user id / token.
function poqHeaders(s) {
  const { env, headers: clientHeaders } = s.cfg;
  const headers = {
    ...clientHeaders,
    'version-code': env.versionCode,
    'poq-app-id': String(env.appId),
    'Poq-App-Identifier': env.appIdentifier,
    'user-agent': env.userAgent,
    'poq-user-id': s.poqUserId,
    ...s.headers,
  };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  return headers;
}

export function apiUrl(s, path) {
  return `${s.cfg.env.baseUrl}/clients/${s.cfg.apiPath}${path}`;
}

// Per-client endpoint tweaks (clients/<client>/config.js `endpoints: { <key>: {...} }`), merged
// into a shared platform endpoint's spec: path, query / headers / checks (merged; a query value of
// undefined drops that parameter), expect (replaced). Strings may use {appId} and {poqUserId}.
function applyTweak(s, spec) {
  const t = spec.key && s.cfg.endpoints && s.cfg.endpoints[spec.key];
  if (!t) return spec;
  const fill = (v) => (typeof v === 'string' ? v.replace('{appId}', s.cfg.env.appId).replace('{poqUserId}', s.poqUserId) : v);
  const query = t.query ? { ...spec.query } : spec.query;
  for (const [k, v] of Object.entries(t.query || {})) query[k] = fill(v);
  return {
    ...spec,
    path: t.path ? fill(t.path) : spec.path,
    query,
    headers: t.headers ? { ...spec.headers, ...t.headers } : spec.headers,
    checks: t.checks ? { ...spec.checks, ...t.checks } : spec.checks,
    expect: t.expect || spec.expect,
  };
}

/**
 * spec: {
 *   name        stable request name (tag, thresholds, reports)
 *   key         platform endpoint key: applies the client's config.endpoints[key] tweaks
 *   method      default GET
 *   path        relative to /clients/{apiPath}; or url for an absolute URL
 *   query       object of query parameters
 *   body        object (sent as JSON, or form-encoded with form: true) or string
 *   form        true: send body as application/x-www-form-urlencoded
 *   plain       true: no Poq headers or token (storefront / webview calls) — only user-agent and language
 *   redirects   max redirects to follow (0 to read a 302 Location header)
 *   headers     per-call header overrides
 *   expect      expected status codes, default [200]
 *   checks      { label: (json, res) => boolean } body checks
 *   data        test-data references for the failure log (product_id, sku, ...)
 *   sensitive   true for auth calls: bodies are never logged
 * }
 * Returns { res, ok, json }.
 */
export function request(s, rawSpec) {
  const spec = applyTweak(s, rawSpec);
  const method = spec.method || 'GET';
  const expect = spec.expect || [200];
  const url = withQuery(spec.url || apiUrl(s, spec.path), spec.query);
  const body = spec.body === undefined || typeof spec.body === 'string' || spec.form ? spec.body : JSON.stringify(spec.body);
  const base = spec.plain
    ? { 'user-agent': s.cfg.env.userAgent, 'Accept-Language': s.cfg.locale.acceptLanguage }
    : poqHeaders(s);

  // Sessions with an authKey (set by the journey) sign every request like the app does; an explicit
  // poq-auth in spec.headers wins.
  const signature = s.authKey && !spec.plain ? { 'poq-auth': poqAuth(s.authKey, body ?? '', s.poqUserId) } : null;

  pace();
  // An empty string body would go out chunked with no Content-Length (hottopic-perf answers 411 Length Required);
  // no body goes out with Content-Length: 0. The signature still covers the empty string.
  const res = http.request(method, url, body === '' ? null : body ?? null, {
    headers: { ...base, ...signature, ...(spec.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...spec.headers },
    tags: { name: spec.name },
    responseCallback: http.expectedStatuses(...expect),
    redirects: spec.redirects,
  });

  const json = parseJson(res);
  const statusOk = expect.includes(res.status);
  const results = { [`${spec.name}: status ${expect.join('|')}`]: statusOk };
  for (const [label, fn] of Object.entries(spec.checks || {})) {
    results[`${spec.name}: ${label}`] = statusOk && safe(() => fn(json, res));
  }
  const ok = check(null, mapToFns(results), { name: spec.name });

  if (!ok) {
    const failedChecks = Object.keys(results).filter((k) => !results[k]);
    recordFailure(s, {
      name: spec.name,
      status: statusOk ? 'check' : statusTag(res.status),
      method,
      url,
      expected: { status: expect, checks: Object.keys(spec.checks || {}) },
      actual: {
        status: res.status,
        errorCode: res.error_code || null,
        error: res.error || null,
        durationMs: Math.round(res.timings.duration),
        failedChecks,
        headers: pickHeaders(res.headers),
        // Sensitive calls keep their success bodies private (tokens); an error body (4xx/5xx) is logged, redacted.
        body: spec.sensitive && res.status < 400 ? '[omitted: sensitive endpoint]' : redactBody(res.body),
      },
      data: spec.data,
    });
  }
  return { res, ok, json };
}

// A value a later step depends on was missing. Counted and logged like a failed request;
// the caller decides whether the iteration can continue.
export function correlationFailure(s, name, missing, data) {
  recordFailure(s, { name, status: 'correlation', reason: `missing ${missing}`, data });
}

// A step was deliberately not performed (e.g. a safety guard). Counted under "correlation".
export function stepBlocked(s, name, reason, data) {
  recordFailure(s, { name, status: 'correlation', reason, data });
}

function recordFailure(s, entry) {
  endpointFailures.add(1, { name: entry.name, status: entry.status });

  const key = `${entry.name}|${entry.status}`;
  loggedCounts[key] = (loggedCounts[key] || 0) + 1;
  if (LOG_LIMIT > 0 && loggedCounts[key] > LOG_LIMIT) return;

  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    client: s.cfg.client,
    env: s.cfg.envName,
    profile: s.cfg.profile,
    scenario: exec.scenario.name,
    vu: exec.vu.idInTest,
    iter: exec.scenario.iterationInTest,
    request: entry.name,
    method: entry.method,
    url: entry.url && redactUrl(entry.url),
    reason: entry.reason,
    expected: entry.expected,
    actual: entry.actual,
    data: entry.data,
  }));
}

function statusTag(status) {
  const tag = String(status);
  return FAILURE_STATUSES.includes(tag) ? tag : 'other';
}

function withQuery(url, query) {
  if (!query) return url;
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}` : url;
}

function parseJson(res) {
  try {
    return res.body ? JSON.parse(res.body) : null;
  } catch (e) {
    return null;
  }
}

function safe(fn) {
  try {
    return Boolean(fn());
  } catch (e) {
    return false;
  }
}

function mapToFns(results) {
  const out = {};
  for (const [label, value] of Object.entries(results)) out[label] = () => value;
  return out;
}

// ---- redaction: never log credentials, tokens or customer emails ----

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// "code" is deliberately not masked: error codes (e.g. InsufficientQuantity) are the most useful
// part of a failure body, and OAuth codes only appear on sensitive calls, whose bodies are never logged.
const SECRET_FIELDS = /"(accessToken|refreshToken|guestToken|token|password|encryptedPassword|codeVerifier|secret|secretKey)"\s*:\s*"[^"]*"/gi;
const SECRET_PARAMS = /([?&](?:[^=&]*token|code|password|email|verifier|secret)[^=&]*=)[^&]*/gi;
const HEADER_ALLOWLIST = /^(content-type|retry-after|location|.*request-id|.*correlation.*|.*trace.*)$/i;

function redactUrl(url) {
  return url.replace(SECRET_PARAMS, '$1***').replace(EMAIL, '***@***');
}

function redactBody(body) {
  if (!body) return '';
  const text = typeof body === 'string' ? body : '[binary]';
  const clean = text.replace(SECRET_FIELDS, '"$1":"***"').replace(EMAIL, '***@***');
  return clean.length > BODY_LIMIT ? `${clean.slice(0, BODY_LIMIT)}…[truncated]` : clean;
}

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (HEADER_ALLOWLIST.test(k)) out[k] = redactUrl(String(v));
  return out;
}
