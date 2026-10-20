#!/usr/bin/env node
// Creates login accounts for a client by registering them through the API, and appends them to
// clients/<client>/data/accounts_<env>.json ([{ email, password }], the file the `account` scenario reads).
// Every account is real and cannot be deleted through the API: run it with a small --count.
//
//   node prep/create-accounts.mjs pacsun --env dev --count 5
//   node prep/create-accounts.mjs pacsun --env prod --allow-prod --count 5 --max-rpm 20
//
//   --count <n>      accounts to create (required)
//   --email-pattern  email with {id} for the random part, e.g. 'k6reg.{id}@byom.de' (default: client.registration.emailPattern)
//   --allow-prod     required for --env prod
//   --max-rpm <n>    hard cap on requests per minute (default 20; 2 requests per account); required on prod
//
// Only Pacsun's register (POST /account/register with a guest token) is implemented. The file is written
// after every account, so an interrupted run keeps what it created. Credentials are never printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, loadClient, createApi } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--count', '--max-rpm', '--email-pattern']);
const [clientName] = positional;
const count = Number(opts.count);
if (!clientName || !opts.env || !(count > 0)) {
  console.error('Usage: node prep/create-accounts.mjs <client> --env <dev|prod> --count <n> [--allow-prod] [--max-rpm n]');
  process.exit(2);
}
if (clientName !== 'pacsun') {
  console.error('Only Pacsun registration is implemented here (Hot Topic accounts come from its loyalty system, TWC logs in through its storefront).');
  process.exit(2);
}

let ctx;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { newPerson, registerBody } = await import(pathToFileURL(resolve('clients', clientName, 'registration.js')).href);
if (opts['email-pattern'] && !opts['email-pattern'].includes('{id}')) {
  console.error('--email-pattern needs {id}, or every account gets the same email');
  process.exit(2);
}
const api = createApi(ctx, { maxRpm: Number(opts['max-rpm'] ?? 20) });

const file = `clients/${clientName}/data/accounts_${opts.env}.json`;
const accounts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const mask = (email) => `${email.slice(0, 2)}***@${email.split('@')[1]}`;
console.log(`Creating ${count} ${clientName} accounts on ${opts.env} via ${ctx.apiPath} (${accounts.length} already in ${file})`);

let created = 0;
const failures = {};
for (let i = 1; i <= count; i++) {
  const session = await api.newSession(); // guest token, as the app's sign-up form has
  if (!session) {
    failures['guest token failed'] = (failures['guest token failed'] || 0) + 1;
    console.log(`[${i}/${count}] guest token failed`);
    continue;
  }
  const p = newPerson(ctx.client.registration, opts['email-pattern']);
  const r = await api.send(session, 'POST', '/account/register', { body: registerBody(p) });
  if (r.status >= 200 && r.status < 300) {
    accounts.push({ email: p.email, password: p.password });
    writeFileSync(file, JSON.stringify(accounts, null, 1));
    created++;
    console.log(`[${i}/${count}] ${mask(p.email)}: created (${r.status})`);
  } else {
    const why = `register status ${r.status}`;
    failures[why] = (failures[why] || 0) + 1;
    console.log(`[${i}/${count}] ${mask(p.email)}: ${why}`);
    if (i === 1 && created === 0) console.log(`  response: ${String(r.text).slice(0, 300).replace(/"(password|accessToken|refreshToken)":"[^"]*"/g, '"$1":"***"')}`);
  }
}
console.log(`\n${created} of ${count} created; ${file} now holds ${accounts.length}; ${api.requestCount()} requests${Object.keys(failures).length ? ` ; failures ${JSON.stringify(failures)}` : ''}`);
process.exit(created ? 0 : 1);
