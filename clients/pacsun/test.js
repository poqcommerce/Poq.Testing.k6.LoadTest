// Pacsun load test.
//   k6 run -e ENV=dev -e PROFILE=smoke clients/pacsun/test.js

import exec from 'k6/execution';
import { createTest } from '../../lib/test-kit.js';
import { correlationFailure } from '../../lib/http.js';
import client from './config.js';
import * as pacsun from './journeys.js';

// requestsPerIteration is counted from the journeys with one home carousel, each common request
// (shop, wishlist, bag) once per session, plus Dynamic Yield identifiers: guestBrowse 29, guestCartAbandon 38. Check against the
// "req/iter" column of the end-of-test summary after each real run.
const test = createTest(client, {
  resolve: (p) => import.meta.resolve(p),
  scenarios: {
    guestBrowse: { requestsPerIteration: 29, estimatedIterationSeconds: 35 },
    guestCartAbandon: { requestsPerIteration: 38, estimatedIterationSeconds: 50 },
    // Measured in a dev smoke run (2026-10-15): guestCheckout 31, loggedInCheckout 33 (+1 each for Dynamic Yield identifiers since).
    guestCheckout: { requestsPerIteration: 32, estimatedIterationSeconds: 45 },
    loggedInCheckout: { requestsPerIteration: 35, estimatedIterationSeconds: 55, maxVUs: 120 }, // 120 accounts: no two live sessions share one
    // Counted from the journey (guest token, account content, register, loyalty rewards); not measured yet.
    register: { requestsPerIteration: 4, estimatedIterationSeconds: 8 },
    // Counted from the journey (guest token, login, account content, logout); not measured yet.
    loggedInUser: { requestsPerIteration: 4, estimatedIterationSeconds: 8 },
  },
  endpointNames: pacsun.endpointNames,
  accountScenarios: ['loggedInUser', 'loggedInCheckout'],
});

export const options = test.options;

export function setup() {
  const { warnings, categories: all } = test.baseSetup();
  // /shop has "<id>-poqParentCategoryId" grouping nodes (Men's, Women's, Pants…); the app opens
  // their children, never a PLP for the group itself.
  const categories = all.filter((id) => !id.endsWith('-poqParentCategoryId'));
  const dataScope = `products ${test.describe(test.products.meta)}`;
  console.log(`setup: ${categories.length} categories; ${dataScope}`);
  return { categories, staleWarning: warnings.filter(Boolean).join(' | ') || null, dataScope };
}

function sessionData(data) {
  return { ...data, products: test.products.items, keywords: test.keywords };
}

export function guestBrowse(data) {
  pacsun.guestBrowse(test.session(), sessionData(data));
}

export function guestCartAbandon(data) {
  pacsun.guestCartAbandon(test.session(), sessionData(data));
}

export function guestCheckout(data) {
  pacsun.guestCheckout(test.session(), sessionData(data));
}

export function loggedInCheckout(data) {
  const s = test.session();
  const acct = test.accounts[exec.scenario.iterationInTest % test.accounts.length];
  if (!acct) return correlationFailure(s, 'Login', 'account (the account list is empty)');
  pacsun.loggedInCheckout(s, sessionData(data), acct);
}

export function register() {
  pacsun.register(test.session());
}

export function loggedInUser(data) {
  const s = test.session();
  // Existing test accounts, taken in turn by iteration number (k6 VU ids are global across scenarios).
  const acct = test.accounts[exec.scenario.iterationInTest % test.accounts.length];
  if (!acct) return correlationFailure(s, 'Login', 'account (the account list is empty)');
  pacsun.loggedInUser(s, acct);
}

export const handleSummary = test.handleSummary;
