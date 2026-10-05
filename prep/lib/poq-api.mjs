// Shared helpers for the prep/ validators (Node 20, no dependencies).
// Reads the same clients/<client>/config.js as the k6 tests, so hosts, app ids and the
// header contract are defined once.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENVIRONMENTS = ['dev', 'staging', 'prod'];

// --flag value / --flag parsing. Returns { positional: [...], opts: { flag: value|true } }.
export function parseArgs(argv, valueFlags) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positional.push(a);
    else if (valueFlags.includes(a)) opts[a.slice(2)] = argv[++i];
    else opts[a.slice(2)] = true;
  }
  return { positional, opts };
}

export async function loadClient(name, envName, { allowProd }) {
  const path = resolve('clients', name, 'config.js');
  if (!existsSync(path)) throw new Error(`Unknown client "${name}" (no ${path})`);
  if (!ENVIRONMENTS.includes(envName)) throw new Error(`--env must be one of ${ENVIRONMENTS.join(', ')}`);
  if (envName === 'prod' && !allowProd) throw new Error('Refusing to run against prod without --allow-prod');
  const client = (await import(pathToFileURL(path).href)).default;
  const env = client.environments[envName];
  if (!env) throw new Error(`Client "${name}" has no "${envName}" environment`);
  const apiPath = process.env.API_PATH || env.apiPath || client.apiPath;
  return { client, env: { ...env, baseUrl: process.env.BASE_URL || env.baseUrl }, envName, apiPath };
}

export function readIds(path) {
  return [...new Set(JSON.parse(readFileSync(path, 'utf8')))];
}

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
export const between = ([min, max]) => min + Math.random() * (max - min);

// An API session = one cart. client.session:
//   'guestToken' (Gen-3): a guest token per session (the guest cart);
//   'device' (Gen-2): just a new poq-user-id (the device's cart), no token.
// maxRpm caps every request this process sends (all sessions share the limiter).
export function createApi({ client, env, apiPath }, { maxRpm } = {}) {
  const rules = { session: client.session || 'guestToken', addToCart: 'full', success: 'quantityAdded', ...client.validator };
  const minInterval = maxRpm ? 60 / maxRpm : 0;
  let last = 0;
  let requests = 0;

  async function send(session, method, path, { query, body, headers } = {}) {
    if (minInterval) {
      const wait = last + minInterval - Date.now() / 1000;
      if (wait > 0) await sleep(wait);
      last = Date.now() / 1000;
    }
    requests++;
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const url = `${env.baseUrl}/clients/${apiPath}${path}${qs}`;
    const h = {
      ...client.headers,
      ...client.validatorHeaders, // e.g. what the Python validators sent
      'version-code': env.versionCode,
      'poq-app-id': String(env.appId),
      'Poq-App-Identifier': env.appIdentifier,
      'user-agent': env.userAgent,
      'poq-user-id': session.poqUserId,
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    };
    try {
      const res = await fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, json, text, requestId: res.headers.get('poq-request-id') };
    } catch (e) {
      return { status: 0, json: null, text: String(e.message || e) };
    }
  }

  async function newSession() {
    const session = { poqUserId: crypto.randomUUID().toUpperCase(), token: null };
    if (rules.session === 'device') return session;
    const r = await send(session, 'POST', '/account/guest-token', { body: '', headers: { 'Content-Type': 'text/plain' } });
    if (r.status !== 200 || !r.json || !r.json.accessToken) return null;
    session.token = r.json.accessToken;
    if (r.json.externalUserId) session.poqUserId = r.json.externalUserId;
    return session;
  }

  // PDP fetch: { product } or { status } when not found / failed.
  async function product(session, id) {
    const r = await send(session, 'GET', '/products', { query: { ids: id, 'slot-content-id': 'pdp' } });
    if (r.status !== 200) return { status: r.status };
    const p = Array.isArray(r.json) ? r.json[0] : null;
    return p ? { product: p, status: 200 } : { status: 'empty' };
  }

  // Cart add proving the variant is purchasable, per client rules (same as each client's Python validator):
  //   'full' body + 'quantityAdded': 200 with customData.quantityAdded > 0 (Gen-3, e.g. TWC)
  //   'minimal' body + 'status200': {quantity, variantId, productId} → 200 (Gen-2, e.g. Hot Topic)
  //   'direct' body + 'inCart': the app's {variantId, quantity, shipmentType} → 200 with the variant
  //     in cartItems (Pacsun: customData comes back empty, so there is no quantityAdded)
  async function addToCart(session, { productId, variantId, categoryId, productType }) {
    const mode = rules.addToCart;
    const body = mode === 'full'
      ? { productId, deleted: false, variantId, customData: { productId, categoryId, productType }, quantity: 1 }
      : mode === 'direct'
        ? { variantId, quantity: 1, shipmentType: 'direct' }
        : { quantity: 1, variantId, productId };
    const query = mode === 'full' ? { showConfirmationOverlay: 'true' } : mode === 'direct' ? { 'slot-content-id': 'added-to-cart' } : undefined;
    const r = await send(session, 'POST', '/cart/items', { query, body });
    const j = r.json || {};
    const proof = {
      status200: () => true,
      quantityAdded: () => j.customData && j.customData.quantityAdded > 0,
      inCart: () => Array.isArray(j.cartItems) && j.cartItems.some((i) => String(i.variantId) === String(variantId)),
    }[rules.success];
    const added = r.status === 200 && proof && proof();
    return { ok: Boolean(added), status: r.status, text: r.text };
  }

  return { send, newSession, product, addToCart, requestCount: () => requests };
}

// Writes the data file atomically (…json.partial, then rename) so a k6 run never sees a half-written file.
export function writeData(clientName, fileName, doc, { partial = false } = {}) {
  const out = join('clients', clientName, 'data', fileName);
  writeFileSync(`${out}.partial`, JSON.stringify(doc, null, 1));
  if (!partial) renameSync(`${out}.partial`, out);
  return out;
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
