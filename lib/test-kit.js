// The plumbing every clients/<client>/test.js shares: config, data, scenarios, options,
// the common setup steps and the end-of-test summary. A client's test.js only lists its
// scenarios, adds client-specific setup and exports one function per scenario.

import exec from 'k6/execution';
import { resolveConfig, assertRunAllowed } from './config.js';
import { newSession } from './http.js';
import { account, catalog } from './platform/index.js';
import { loadValidated, loadOptionalJson, loadList, assertDataFresh } from './data.js';
import { selectScenarios, buildScenarios } from './profiles.js';
import { buildThresholds, makeHandleSummary } from './summary.js';

/**
 * client            the client's config.js default export
 * resolve           the caller's import.meta.resolve (data paths are relative to the client folder)
 * scenarios         { name: { requestsPerIteration, estimatedIterationSeconds } }
 * endpointNames     every request name the client's journeys use (thresholds / reports)
 * accountScenarios  scenarios that need data/accounts_<env>.json
 */
export function createTest(client, { resolve, scenarios: defs, endpointNames, accountScenarios = [] }) {
  const cfg = resolveConfig(client);

  // Validated by prep/ before each run (plan §10.1); k6 never re-validates.
  const products = loadValidated('products', resolve(`./data/products_${cfg.envName}.json`), 'products');
  // Login accounts (gitignored): [{ email, password }], taken in turn by iteration number.
  const accounts = loadOptionalJson('accounts', resolve(`./data/accounts_${cfg.envName}.json`));
  const keywords = loadList('keywords', resolve('./data/keywords.json'));
  // Categories that prep/extract-categories.mjs found working (optional): { env, apiPath, generatedAt, validIds }.
  const categoryFile = loadValidated('categories', resolve(`./data/categories_${cfg.envName}.json`), 'validIds', { optional: true });

  const scenarios = selectScenarios(defs, client.mix);
  // The scale and warmup profiles add the client's fixed-count scenarios (e.g. new registrations) unless SCENARIOS picks them.
  if ((cfg.profile === 'scale' || cfg.profile === 'warmup') && client.load.shape && !__ENV.SCENARIOS) {
    for (const n of Object.keys((client.load.shape || {}).fixed || {})) if (defs[n]) scenarios[n] = { ...defs[n], share: 0 };
  }
  const withoutAccounts = accountScenarios.filter((n) => scenarios[n]);
  if (withoutAccounts.length && !accounts.length) {
    throw new Error(`${withoutAccounts.join(', ')} needs clients/${client.name}/data/accounts_${cfg.envName}.json (gitignored) — or pick scenarios without it`);
  }
  const reportSpec = { scenarioNames: Object.keys(scenarios), endpointNames };
  let deviceId; // per VU

  function chooseCategories(live) {
    const m = categoryFile.meta;
    const file = `categories_${cfg.envName}.json`;
    if (m.missing) return { categories: live, source: `${live.length} categories (live /shop list)` };
    const ageHours = (Date.now() - Date.parse(m.generatedAt)) / 3.6e6;
    const maxAge = client.maxCategoryAgeHours ?? 168;
    let problem = null;
    if (m.env !== cfg.envName || m.apiPath !== cfg.apiPath) problem = `was made for ${m.env} ${m.apiPath}`;
    else if (!(ageHours <= maxAge)) problem = `is ${ageHours.toFixed(0)} h old (limit ${maxAge} h)`;
    else if (!categoryFile.items.length) problem = 'has no valid categories';
    if (problem) return { categories: live, source: `${live.length} categories (live /shop list)`, warning: `${file} ${problem}: using the live /shop list` };
    const ids = [];
    for (let i = 0; i < categoryFile.items.length; i++) ids.push(categoryFile.items[i]);
    return { categories: ids, source: `${ids.length} validated categories (${file}, ${ageHours.toFixed(1)} h old)` };
  }

  return {
    cfg,
    scenarios,
    products,
    accounts,
    keywords,
    options: {
      scenarios: buildScenarios(cfg, client.load, scenarios),
      thresholds: buildThresholds(cfg, { ...reportSpec, limits: client.limits }),
      summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
      setupTimeout: '2m',
      // Run-level tags and the Grafana Cloud test name (both ignored unless `--out cloud` is used),
      // so runs can be told apart in one project.
      tags: { client: client.name, env: cfg.envName, profile: cfg.profile },
      cloud: { name: `${client.name}_${cfg.envName}_${cfg.profile}` },
    },

    // Common setup — call it first in the client's setup(): prod guard, product-data freshness,
    // a session (guest token for Gen-3 clients) and the live category list. Returns the session
    // so the client can make its own setup calls.
    baseSetup() {
      assertRunAllowed(cfg); // prod guard — before the first request
      const warnings = [assertDataFresh(cfg, `products_${cfg.envName}.json`, products.meta)];
      const s = newSession(cfg);
      if (client.session === 'guestToken' && !account.guestToken(s, 'setup: guest token')) {
        exec.test.abort('setup: could not obtain a guest token');
      }
      // The live category list is fetched every run (one call). When prep/extract-categories.mjs has produced a
      // usable file for this environment and client path, its validated categories are used instead, so a category
      // that answers 500 never reaches the run. A file for another environment or path, or an old one, is ignored.
      const live = catalog.shopCategories(s);
      if (!live.length) exec.test.abort('setup: /shop returned no categories');
      const chosen = chooseCategories(live);
      if (chosen.warning) warnings.push(chosen.warning);
      return { s, warnings, categories: chosen.categories, categorySource: chosen.source };
    },

    // A session for one iteration. client.session:
    //   'guestToken' (Gen-3): a fresh identity each iteration (the journey gets a guest token);
    //   'device' (Gen-2): one persistent poq-user-id per VU, like a real app install.
    session() {
      if (client.session !== 'device') return newSession(cfg);
      deviceId = deviceId || crypto.randomUUID();
      return newSession(cfg, { poqUserId: deviceId });
    },

    // "60 (sanity subset…, generated …)" for the run report.
    describe: (meta) => `${meta.count} (${meta.scope || 'full list'}, generated ${meta.generatedAt})`,

    handleSummary: makeHandleSummary(cfg, reportSpec),
  };
}
