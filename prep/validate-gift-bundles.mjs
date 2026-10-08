#!/usr/bin/env node
// Validates every gift bundle in clients/<client>/input/gift_bundles.json before a run and
// writes clients/<client>/data/gift_bundles_<env>.json. Port of the Python gift_bundle_validator
// (Poq.Testing.Utilities new_gen), same rules, per bundle with its own guest cart:
//   bundle PDP → customData.bundle.entries
//   → one-size entry: its defaultVariantCode; sized entry: the entry's variants with
//     customData.stock.ctaStatus == "AddToBag", highest stock first
//   → bulk add (recorded only: known no-op on TWC) → fresh guest cart → add each entry,
//     falling back to the next size on a stock rejection (412 / InsufficientQuantity / noStock).
// Only bundles whose every entry was added ("ok") are written to "bundles".
//
//   node prep/validate-gift-bundles.mjs <client> --env <dev|staging|prod> [--allow-prod] [--input file] [--max-rpm n]  (--max-rpm is required with --env prod)

import { parseArgs, loadClient, readIds, createApi, sleep, writeData, nowIso } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--input', '--max-rpm']);
const [clientName] = positional;
if (!clientName || !opts.env) {
  console.error('Usage: node prep/validate-gift-bundles.mjs <client> --env <dev|staging|prod> [--allow-prod] [--input file] [--max-rpm n]');
  process.exit(2);
}

let ctx;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const inputPath = opts.input || `clients/${clientName}/input/gift_bundles.json`;
const ids = readIds(inputPath);
const api = createApi(ctx, { maxRpm: opts['max-rpm'] ? Number(opts['max-rpm']) : undefined });
const PAUSE = 0.5; // seconds between entry calls, as in the Python validator

const bundles = [];
const rejected = [];
for (const [i, bundleId] of ids.entries()) {
  const r = await validateBundle(bundleId);
  if (r.status === 'ok') bundles.push(r.bundle);
  else rejected.push({ bundleId, status: r.status, notes: r.notes });
  console.log(`[${i + 1}/${ids.length}] ${bundleId}: ${r.status}${r.notes ? ` — ${r.notes}` : ''}`);
}

const out = writeData(clientName, `gift_bundles_${opts.env}.json`, {
  client: clientName,
  env: opts.env,
  generatedAt: nowIso(),
  source: `prep/validate-gift-bundles.mjs, input ${inputPath}`,
  scope: opts.input ? `custom input ${inputPath} (${ids.length} ids)` : 'full list',
  rules: { entriesAddToCartProof: true },
  summary: { checked: ids.length, valid: bundles.length, rejected: rejected.length },
  bundles,
  rejected,
});
console.log(`\n${out}: ${bundles.length} ok of ${ids.length}; ${api.requestCount()} requests`);
process.exit(0);

async function validateBundle(bundleId) {
  let session = await api.newSession();
  if (!session) return { status: 'guest_token_failed', notes: 'no guest token' };

  const pdp = await api.product(session, bundleId);
  if (!pdp.product) return { status: 'not_found', notes: `PDP status ${pdp.status}` };
  const p = pdp.product;
  const custom = p.customData || {};
  const bundle = custom.bundle;
  if (!bundle || !Array.isArray(bundle.entries) || !bundle.entries.length) return { status: 'not_a_bundle', notes: 'no customData.bundle.entries' };
  const categoryId = (custom.analyticsCategory && custom.analyticsCategory.id) || 'gifts';

  const resolved = []; // { code, candidates: [variantId, ...] best first }
  const unresolved = [];
  for (const entry of bundle.entries) {
    const candidates = await entryCandidates(session, entry);
    if (candidates.length) resolved.push({ code: entry.code, candidates });
    else unresolved.push(entry.code);
    await sleep(PAUSE);
  }
  if (!resolved.length) return { status: 'no_stock', notes: `no available size for: ${unresolved.join(', ')}` };

  const line = (code, variantId) => ({ productId: code, deleted: false, variantId, customData: { productId: code, categoryId, productType: 'Standard' }, quantity: 1 });
  const entryAdd = (code, variantId) => ({ productId: code, variantId, categoryId, productType: 'Standard' });
  const bulk = await api.send(session, 'POST', '/cart/items/bulk', {
    query: { showConfirmationOverlay: 'true' },
    body: { items: resolved.map((r) => line(r.code, r.candidates[0])) },
  });
  const bulkAdded = bulk.json && bulk.json.customData ? bulk.json.customData.quantityAdded : undefined;

  // Fresh guest cart so the bulk call can't skew the per-entry adds.
  session = await api.newSession();
  if (!session) return { status: 'guest_token_failed', notes: 'no guest token for sequential adds' };
  const entries = [];
  const failed = [];
  for (const { code, candidates } of resolved) {
    let chosen = null;
    for (const variantId of candidates) {
      const add = await api.addToCart(session, entryAdd(code, variantId));
      if (add.ok) {
        chosen = variantId;
        break;
      }
      const stockRejection = add.status === 412 || /InsufficientQuantity|noStock/.test(add.text || '');
      if (!stockRejection) break; // auth/validation problem: another size won't help
      await sleep(PAUSE);
    }
    if (chosen) entries.push({ code, variantId: chosen });
    else failed.push(code);
    await sleep(PAUSE);
  }

  const notes = [
    unresolved.length ? `no available size for: ${unresolved.join(', ')}` : '',
    failed.length ? `no size could be added for: ${failed.join(', ')}` : '',
    `bulk add status ${bulk.status}, quantityAdded ${bulkAdded}`,
  ].filter(Boolean).join('; ');
  const name = (p.details && p.details.name) || '';
  if (unresolved.length || failed.length) return { status: 'partial', notes };
  return { status: 'ok', notes, bundle: { bundleId, name, entries } };
}

// One-size: the entry's defaultVariantCode. Sized: variants the app would let you add
// (customData.stock.ctaStatus == "AddToBag" — stock.available was seen to be wrong here), highest stock first.
async function entryCandidates(session, entry) {
  if (entry.oneSize && entry.defaultVariantCode) return [entry.defaultVariantCode];
  const pdp = await api.product(session, entry.code);
  if (!pdp.product) return [];
  return Object.entries(pdp.product.variants || {})
    .filter(([, v]) => v && v.customData && v.customData.stock && v.customData.stock.ctaStatus === 'AddToBag')
    .sort(([, a], [, b]) => Number((b.stock && b.stock.quantity) || 0) - Number((a.stock && a.stock.quantity) || 0))
    .map(([id]) => id);
}
