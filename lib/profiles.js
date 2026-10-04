// Turns a profile name into k6 scenarios (open model, plan §13).
//
// Each client scenario declares its share of total traffic and how many requests one
// iteration makes; the arrival rate is derived from the client's load target:
//   iterations/s = targetRps × fraction × share ÷ requestsPerIteration
// The end-of-test summary prints the measured requests per iteration so the
// declared value can be corrected after a real run.

const PROFILES = {
  smoke: null, // one iteration per scenario
  sanity: (load) => ({ fraction: 0.01, stages: [['1m', 1], ['4m', 1]] }),
  // warmup: 10% of the load. A client with load.shape gets the same structure compressed to WARMUP_MINUTES.
  warmup: (load) => ({ targetRps: shapeRps(load) * WARMUP_FRACTION, stages: load.shape ? shapeStages(warmupShape(load.shape).stages) : [['3m', 1], ['12m', 1]] }),
  load: (load) => ({ fraction: 1, stages: [[load.rampUp, 1], [load.hold, 1]] }),
  paced: null, // 1 VU per scenario for DURATION, each VU capped by MAX_RPM_PER_VU (low-impact comparisons)
  // Ad-hoc absolute rate: -e TARGET_RPS=60 -e DURATION=1m [-e RAMP_UP=10s]
  custom: (load, custom) => ({ targetRps: custom.rps, stages: [[custom.rampUp, 1], [custom.duration, 1]] }),
  // scale: the client's own shape (load.shape, minutes × factor of the target rate): gradual ramp, spikes,
  // some scenarios starting later, some with a fixed number of iterations.
  scale: (load) => ({ targetRps: shapeRps(load), stages: shapeStages(load.shape.stages) }),
  // performance: level not agreed yet (plan §13 / §16) — intentionally not defined.
};

// Picks the scenarios to run and their traffic shares. Default: every scenario with a share > 0
// in the client mix. -e SCENARIOS=a,b runs only those, with their shares renormalised to 1
// (a scenario outside the mix, e.g. guestBrowse, counts as weight 1).
export function selectScenarios(defs, mix) {
  const requested = __ENV.SCENARIOS ? __ENV.SCENARIOS.split(',').map((n) => n.trim()).filter(Boolean) : null;
  const names = requested || Object.keys(mix).filter((n) => mix[n] > 0);
  const unknown = names.filter((n) => !defs[n]);
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(defs).join(', ')}`);
  const weight = (n) => (requested ? mix[n] || 1 : mix[n]);
  const total = names.reduce((sum, n) => sum + weight(n), 0);
  const out = {};
  for (const n of names) out[n] = { ...defs[n], share: weight(n) / total };
  return out;
}

// The base rate of a shaped run: load.shape.targetRps when the shape has its own, else load.targetRps
// (a client without a shape gets the same value as before: 10% of load.targetRps for warmup).
const shapeRps = (load) => (load.shape && load.shape.targetRps) || load.targetRps;

const WARMUP_MINUTES = 15;
const WARMUP_FRACTION = 0.1;

// The client's shape squeezed into WARMUP_MINUTES: same stages, start offsets and fixed-count windows
// in proportion; the fixed counts follow the 10% load.
function warmupShape(shape) {
  const k = WARMUP_MINUTES / shape.stages.reduce((sum, [m]) => sum + m, 0);
  const scale = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([n, v]) => [n, fn(v)]));
  return {
    stages: shape.stages.map(([m, f]) => [m * k, f]),
    startAfter: scale(shape.startAfter, (m) => m * k),
    fixed: scale(shape.fixed, (x) => ({ count: Math.max(1, Math.round(x.count * WARMUP_FRACTION)), startAfter: x.startAfter * k, over: x.over * k })),
  };
}

// The shape a run follows, or null for the flat profiles.
function activeShape(profile, load) {
  if (!load.shape) return null;
  if (profile === 'scale') return load.shape;
  if (profile === 'warmup') return warmupShape(load.shape);
  return null;
}

const seconds = (m) => `${Math.round(m * 60)}s`;
const shapeStages = (stages) => stages.map(([m, f]) => [seconds(m), f]);

// Drops the first `minutes` of the shape, so a scenario (e.g. logged-in users) starts later and ends with the rest.
function startLater(stages, minutes) {
  let skip = minutes;
  const out = [];
  for (const [m, f] of stages) {
    if (skip >= m) { skip -= m; continue; }
    out.push([m - skip, f]);
    skip = 0;
  }
  return out;
}

export function buildScenarios(cfg, load, scenarios) {
  if (!(cfg.profile in PROFILES)) {
    throw new Error(`Unknown PROFILE "${cfg.profile}". Available: ${Object.keys(PROFILES).join(', ')}`);
  }
  const out = {};
  for (const [name, sc] of Object.entries(scenarios)) {
    if (cfg.profile === 'smoke') {
      out[name] = { executor: 'per-vu-iterations', exec: name, vus: 1, iterations: 1, maxDuration: '10m' };
      continue;
    }
    if (cfg.profile === 'paced') {
      if (!__ENV.DURATION || !__ENV.MAX_RPM_PER_VU) throw new Error('PROFILE=paced needs -e DURATION=<e.g. 6m> and -e MAX_RPM_PER_VU=<n> (total rate = n × scenarios)');
      out[name] = { executor: 'constant-vus', exec: name, vus: 1, duration: __ENV.DURATION };
      continue;
    }
    const shape = activeShape(cfg.profile, load);
    const fixed = shape && shape.fixed && shape.fixed[name];
    if (fixed) {
      // A fixed number of iterations spread evenly over a window, e.g. new registrations.
      out[name] = {
        executor: 'constant-arrival-rate', exec: name, startTime: seconds(fixed.startAfter),
        rate: fixed.count, timeUnit: seconds(fixed.over), duration: seconds(fixed.over),
        preAllocatedVUs: 2, maxVUs: 10,
      };
      continue;
    }
    const { fraction, targetRps, stages: allStages } = PROFILES[cfg.profile](load, customProfile(cfg));
    const later = shape && shape.startAfter && shape.startAfter[name];
    const stages = later ? shapeStages(startLater(shape.stages, later)) : allStages;
    const rps = targetRps ?? load.targetRps * fraction;
    const perMinute = (rps * sc.share * 60) / sc.requestsPerIteration;
    const target = Math.max(1, Math.round(perMinute));
    const peak = Math.max(...stages.map(([, f]) => f));
    const concurrent = Math.ceil((perMinute * peak / 60) * sc.estimatedIterationSeconds);
    out[name] = {
      executor: 'ramping-arrival-rate',
      exec: name,
      startRate: 0,
      timeUnit: '1m',
      preAllocatedVUs: Math.max(2, concurrent),
      maxVUs: Math.max(10, concurrent * 3),
      stages: stages.map(([duration, f]) => ({ duration, target: Math.max(1, Math.round(target * f)) })),
    };
  }
  return out;
}

function customProfile(cfg) {
  if (cfg.profile !== 'custom') return null;
  const rps = Number(__ENV.TARGET_RPS);
  if (!(rps > 0) || !__ENV.DURATION) throw new Error('PROFILE=custom needs -e TARGET_RPS=<req/s> -e DURATION=<e.g. 1m>');
  return { rps, duration: __ENV.DURATION, rampUp: __ENV.RAMP_UP || '10s' };
}
