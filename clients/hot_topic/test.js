// Hot Topic load test.
//   k6 run -e ENV=staging -e PROFILE=smoke clients/hot_topic/test.js
// The account and register scenarios sign every request (poq-auth) and need the secrets:
// --secret-source=file=secrets/hot_topic.secrets (keys poq-secret-key and poq-salt; see README).

import exec from 'k6/execution';
import secrets from 'k6/secrets';
import { createTest } from '../../lib/test-kit.js';
import { correlationFailure } from '../../lib/http.js';
import { derivePoqAuthKey } from '../../lib/auth.js';
import { loadList } from '../../lib/data.js';
import client from './config.js';
import * as ht from './journeys.js';
import { NAMES } from './endpoints.js';

// Requests per iteration from the JMeter thread groups (33 / 34 / 24), plus the bag clean-up
// step k6 adds to the browser journey. Check against "req/iter" after each real run.
const test = createTest(client, {
  resolve: (p) => import.meta.resolve(p),
  scenarios: {
    browser: { requestsPerIteration: 35, estimatedIterationSeconds: 40 },
    shopper: { requestsPerIteration: 36, estimatedIterationSeconds: 40 },
    // Measured on the prod warm-up (2026-10-05): 35 / 36 / 42 / 12 requests per iteration.
    account: { requestsPerIteration: 42, estimatedIterationSeconds: 50 },
    register: { requestsPerIteration: 12, estimatedIterationSeconds: 20 },
  },
  endpointNames: ht.endpointNames,
  accountScenarios: ['account'],
});
const universalLinks = loadList('universalLinks', import.meta.resolve('./data/universal_links.json'));

export const options = test.options;

export async function setup() {
  const { s, warnings, categories, categorySource } = test.baseSetup();

  // poq-auth signing key, derived once (only the account and register scenarios sign). The salt
  // is the configured secret: it reproduced 22 captured app signatures, so the settings
  // "fragmentSuffix" lookup (an extra request) is no longer needed.
  let authKey = null;
  if (test.scenarios.account || test.scenarios.register) {
    authKey = await derivePoqAuthKey(await readSecret('poq-secret-key'), await readSecret('poq-salt'));
  }

  const dataScope = [
    `products ${test.describe(test.products.meta)}`,
    test.scenarios.account ? `accounts ${test.accounts.length}` : null,
    authKey ? 'poq-auth signing on' : null,
    `client ${test.cfg.apiPath}`,
  ].filter(Boolean).join('; ');
  console.log(`setup: ${categorySource}; ${dataScope}`);
  return { categories, authKey, staleWarning: warnings.filter(Boolean).join(' | ') || null, dataScope };
}

async function readSecret(name) {
  try {
    const value = await secrets.get(name);
    if (value) return value;
  } catch (e) {}
  exec.test.abort(`setup: secret "${name}" missing — run with --secret-source=file=secrets/hot_topic.secrets`);
}

function sessionData(data) {
  return { ...data, products: test.products.items, keywords: test.keywords, universalLinks };
}

export function browser(data) {
  ht.browser(test.session(), sessionData(data));
}

export function shopper(data) {
  ht.shopper(test.session(), sessionData(data));
}

export function register(data) {
  ht.register(test.session(), sessionData(data));
}

export function account(data) {
  const s = test.session();
  // Existing test accounts, taken in turn by iteration number (k6 VU ids are global, so in a mixed run the
  // account VUs would start far beyond the list). Two iterations share an account only when they are a whole
  // list apart (978 iterations, many minutes), long after the first has logged out.
  const acct = test.accounts[exec.scenario.iterationInTest % test.accounts.length];
  if (!acct) {
    correlationFailure(s, NAMES.login, 'no account available');
    return ht.browser(s, sessionData(data));
  }
  ht.account(s, sessionData(data), acct);
}

export const handleSummary = test.handleSummary;
