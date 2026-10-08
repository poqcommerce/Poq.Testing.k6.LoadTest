// Resolves the client configuration for the selected ENV/PROFILE. Fails fast on anything
// missing — a silent default is how the JMeter suites ended up spawning stray threads or
// running against the wrong environment. The prod guards run in setup() (assertRunAllowed),
// so `k6 inspect` works for any environment while a real run still stops before any request.

import exec from 'k6/execution';

const ENVIRONMENTS = ['dev', 'staging', 'prod'];
const REQUIRED_ENV_KEYS = ['baseUrl', 'appId', 'appIdentifier', 'versionCode', 'userAgent'];

export function resolveConfig(client) {
  const envName = (__ENV.ENV || '').toLowerCase();
  if (!ENVIRONMENTS.includes(envName)) {
    throw new Error(`ENV must be one of ${ENVIRONMENTS.join(', ')} (got "${__ENV.ENV || ''}")`);
  }
  const env = client.environments[envName];
  if (!env) throw new Error(`Client "${client.name}" has no "${envName}" environment configured`);
  const missing = REQUIRED_ENV_KEYS.filter((k) => env[k] === undefined || env[k] === '');
  if (missing.length) throw new Error(`${client.name}.${envName} is missing: ${missing.join(', ')}`);

  const allowStaleData = __ENV.ALLOW_STALE_DATA === 'true';

  return {
    client: client.name,
    displayName: client.displayName,
    // API_PATH overrides the /clients/<apiPath> segment, e.g. an isolated perf client (hottopic-perf/v2).
    apiPath: __ENV.API_PATH || env.apiPath || client.apiPath,
    headers: client.headers,
    endpoints: client.endpoints || {},
    envName,
    profile: (__ENV.PROFILE || 'smoke').toLowerCase(),
    env: { ...env, baseUrl: resolveBaseUrl(client, envName, env) },
    locale: client.locale,
    thinkTime: parseThinkTime(__ENV.THINK_TIME, client.thinkTimeSeconds),
    // MAX_DATA_AGE_HOURS overrides the client's limit for one run (works on prod, unlike ALLOW_STALE_DATA).
    maxDataAgeHours: parseMaxDataAge(__ENV.MAX_DATA_AGE_HOURS, client.maxDataAgeHours),
    allowStaleData,
    runDir: __ENV.RUN_DIR || '',
    prodAbort: parseProdAbort(client.limits || {}),
  };
}

// Called first thing in setup(), before any request: a run against prod needs an explicit
// -e ALLOW_PROD=true, and stale data is never allowed on prod.
export function assertRunAllowed(cfg) {
  if (cfg.envName !== 'prod') return;
  if (__ENV.ALLOW_PROD !== 'true') exec.test.abort('Refusing to run against prod without -e ALLOW_PROD=true');
  if (cfg.allowStaleData) exec.test.abort('ALLOW_STALE_DATA is not permitted against prod — re-run the validators');
}

// Prod safety stop: abort the run when the failure rate goes above `rate`, evaluated from `delay`
// onwards. Defaults 10% after 60 s; the client's limits (prodAbortFailedRate / prodAbortDelay)
// and then -e ABORT_FAILED_RATE=0.05 / -e ABORT_DELAY=30s override them.
function parseProdAbort(limits) {
  const rate = Number(__ENV.ABORT_FAILED_RATE ?? limits.prodAbortFailedRate ?? 0.1);
  const delay = __ENV.ABORT_DELAY || limits.prodAbortDelay || '60s';
  if (!(rate > 0 && rate <= 1)) throw new Error(`ABORT_FAILED_RATE must be a fraction between 0 and 1 (got "${__ENV.ABORT_FAILED_RATE}")`);
  if (!/^\d+(\.\d+)?(ms|s|m|h)$/.test(delay)) throw new Error(`ABORT_DELAY must be a duration like 60s or 2m (got "${delay}")`);
  return { rate, delay };
}

// BASE_URL points the run at another host (a local mock). It must not reach the prod host under a
// non-prod ENV, which would skip the ALLOW_PROD guard, the prod abort threshold and the stale-data refusal.
function resolveBaseUrl(client, envName, env) {
  const override = __ENV.BASE_URL;
  if (!override) return env.baseUrl;
  const prod = client.environments.prod;
  const origin = (u) => u.toLowerCase().replace(/\/+$/, '');
  if (envName !== 'prod' && prod && origin(override) === origin(prod.baseUrl)) {
    throw new Error(`BASE_URL ${override} is ${client.name}'s prod host; use -e ENV=prod (with ALLOW_PROD=true) instead`);
  }
  return override;
}

// THINK_TIME="0" disables pauses; THINK_TIME="1,3" overrides the client's [min, max] seconds.
function parseThinkTime(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const [min, max = min] = value.split(',').map(Number);
  if ([min, max].some((n) => Number.isNaN(n) || n < 0) || max < min) {
    throw new Error(`THINK_TIME must be "seconds" or "min,max" (got "${value}")`);
  }
  return [min, max];
}

function parseMaxDataAge(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const hours = Number(raw);
  if (!(hours > 0)) throw new Error(`MAX_DATA_AGE_HOURS must be a positive number of hours, got "${raw}"`);
  return hours;
}
