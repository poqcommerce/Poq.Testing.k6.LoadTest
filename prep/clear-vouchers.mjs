#!/usr/bin/env node
// Removes vouchers left on the login accounts' bags (e.g. by an interrupted run), so a run starts with clean
// carts: a voucher already in a bag makes the next apply of the same code fail with 400 "invalid". For every
// account in clients/<client>/data/accounts_<env>.json: guest token → login → GET /cart → DELETE
// /cart/vouchers/{vouchers[].id} for each voucher (Salesforce removes by coupon item id, not by code).
// Bag lines are only counted, not removed.
//
//   node prep/clear-vouchers.mjs pacsun --env prod --allow-prod --max-rpm 300
//
//   --allow-prod     required for --env prod
//   --max-rpm <n>    hard cap on requests per minute (required on prod; about 3 requests per account)
//   --limit <n>      check only the first n accounts
//
// Only Pacsun's login (POST /account/login with a guest token) is implemented. Credentials are never printed.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, loadClient, createApi } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--max-rpm', '--limit']);
const [clientName] = positional;
if (!clientName || !opts.env) {
  console.error('Usage: node prep/clear-vouchers.mjs <client> --env <dev|prod> [--allow-prod] [--max-rpm n] [--limit n]');
  process.exit(2);
}
if (clientName !== 'pacsun') {
  console.error('Only the Pacsun login is implemented here.');
  process.exit(2);
}

let ctx;
let api;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
  api = createApi(ctx, { maxRpm: opts['max-rpm'] === undefined ? undefined : Number(opts['max-rpm']) });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const file = resolve('clients', clientName, 'data', `accounts_${opts.env}.json`);
if (!existsSync(file)) {
  console.error(`No ${file}`);
  process.exit(2);
}
const all = JSON.parse(readFileSync(file, 'utf8'));
const accounts = opts.limit ? all.slice(0, Number(opts.limit)) : all;
const mask = (email) => `${email.slice(0, 2)}***@${email.split('@')[1]}`;
const loggedIn = { 'poq-slot-conditions': 'loggedIn=true&notifications=true&inStore=false' };

const totals = { accounts: accounts.length, clean: 0, cleared: 0, vouchersRemoved: 0, failed: 0, withBagLines: 0 };
for (const [n, acct] of accounts.entries()) {
  const tag = `[${n + 1}/${accounts.length}] ${mask(acct.email)}`;
  const session = await api.newSession();
  if (!session) {
    totals.failed++;
    console.log(`${tag}: guest token failed`);
    continue;
  }
  const login = await api.send(session, 'POST', '/account/login', { body: { username: acct.email, password: acct.password }, headers: loggedIn });
  if (login.status !== 200 || !login.json || !login.json.accessToken) {
    totals.failed++;
    console.log(`${tag}: login failed (${login.status})`);
    continue;
  }
  session.token = login.json.accessToken;

  const cart = await api.send(session, 'GET', '/cart', { query: { 'slot-content-id': 'cart' }, headers: loggedIn });
  if (cart.status !== 200 || !cart.json) {
    totals.failed++;
    console.log(`${tag}: get bag failed (${cart.status})`);
    continue;
  }
  const lines = Array.isArray(cart.json.cartItems) ? cart.json.cartItems.length : 0;
  if (lines) totals.withBagLines++;
  const vouchers = (cart.json.vouchers || []).filter((v) => v && v.id);
  if (!vouchers.length) {
    totals.clean++;
    console.log(`${tag}: no voucher${lines ? ` (${lines} bag line(s) left)` : ''}`);
    continue;
  }

  let ok = true;
  for (const v of vouchers) {
    const r = await api.send(session, 'DELETE', `/cart/vouchers/${encodeURIComponent(v.id)}`, { headers: loggedIn });
    if (r.status === 200 || r.status === 204) totals.vouchersRemoved++;
    else {
      ok = false;
      console.log(`${tag}: removing ${v.code} failed (${r.status}, Poq-Request-Id ${r.requestId})`);
    }
  }
  if (ok) totals.cleared++;
  else totals.failed++;
  console.log(`${tag}: removed ${vouchers.map((v) => v.code).join(', ')}${lines ? ` (${lines} bag line(s) left)` : ''}`);
}

console.log(`\n${JSON.stringify(totals)}; ${api.requestCount()} requests`);
process.exit(totals.failed ? 1 : 0);
