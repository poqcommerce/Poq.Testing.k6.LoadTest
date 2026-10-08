#!/usr/bin/env node
// Validates every product in clients/<client>/input/products.json before a run (plan §10.1)
// and writes clients/<client>/data/products_<env>.json. Port of the Python
// products_availability_validator (Poq.Testing.Utilities new_gen), same rules:
//   PDP → default variant first, then the others → stock.available and quantity ≥ minStock
//   → guest-cart add-to-cart must return customData.quantityAdded > 0.
// A new cart session (guest token, or a new device id for Gen-2 clients) every 10 products; 2–5 s between products.
//
//   node prep/validate-products.mjs <client> --env <dev|staging|prod> [options]
//
//   --allow-prod          required for --env prod
//   --max-valid <n>       stop after n valid products (sanity subset; recorded in the file's scope)
//   --input <file>        product ids as a JSON array (default clients/<client>/input/products_<env>.json or products.json)
//   --min-stock <n>       default 5
//   --delay <min,max>     seconds between products (default 2,5)
//   --max-rpm <n>         hard cap on requests per minute for the whole run (required with --env prod)
//   --max-age <hours>     resume window (default: the client's maxDataAgeHours)
//   --fresh               ignore earlier results and start from the first product
//
// Resuming: every stored product carries its own validatedAt (rejections: checkedAt). A new run reads
// products_<env>.json and its .partial (written every 10 checks and on Ctrl+C), keeps everything younger
// than --max-age, and checks only the remaining ids; an interrupted run just continues when started
// again. The file's generatedAt is the age of its OLDEST product, so k6's freshness check stays honest.

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, loadClient, readIds, shuffle, createApi, sleep, between, writeData, nowIso } from './lib/poq-api.mjs';

const { positional, opts } = parseArgs(process.argv.slice(2), ['--env', '--max-valid', '--input', '--min-stock', '--delay', '--max-rpm', '--max-age']);
const [clientName] = positional;
if (!clientName || !opts.env) {
  console.error('Usage: node prep/validate-products.mjs <client> --env <dev|staging|prod> [--allow-prod] [--max-valid n] [--input file] [--min-stock n] [--delay min,max] [--max-rpm n] [--max-age hours] [--fresh]');
  process.exit(2);
}

let ctx;
try {
  ctx = await loadClient(clientName, opts.env, { allowProd: opts['allow-prod'] });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const minStock = Number(opts['min-stock'] ?? 5);
const maxValid = opts['max-valid'] ? Number(opts['max-valid']) : null;
const delay = (opts.delay || '2,5').split(',').map(Number);
// Per-environment list (input/products_<env>.json) when the client has one, else input/products.json.
const envInput = `clients/${clientName}/input/products_${opts.env}.json`;
const inputPath = opts.input || (existsSync(envInput) ? envInput : `clients/${clientName}/input/products.json`);
const allIds = readIds(inputPath);
const api = createApi(ctx, { maxRpm: opts['max-rpm'] ? Number(opts['max-rpm']) : undefined });

const maxAgeHours = Number(opts['max-age'] ?? ctx.client.maxDataAgeHours ?? 12);
const dataPath = `clients/${clientName}/data/products_${opts.env}.json`;
const prior = opts.fresh ? { products: [], rejected: [], note: 'starting over (--fresh)' } : loadPrior();
const products = prior.products;
const rejected = prior.rejected;
const carried = products.length + rejected.length;
const doneIds = new Set([...products, ...rejected].map((e) => e.productId));
const todo = shuffle(allIds.filter((id) => !doneIds.has(id)));
const startedAt = Date.now();
let session = null;
let checked = 0; // checked in this run

console.log(`Validating ${allIds.length} products for ${clientName} ${opts.env} via ${ctx.apiPath} (minStock ${minStock}${maxValid ? `, stop at ${maxValid} valid` : ''})`);
console.log(prior.note);

// Ctrl+C keeps the progress: save the partial file, then continue later with the same command.
process.on('SIGINT', () => {
  const out = save(true);
  console.log(`\nInterrupted: ${products.length} valid, ${rejected.length} rejected saved to ${out}.partial. Run the same command to resume, or add --max-valid <n> to finish with what is valid.`);
  process.exit(130);
});

for (const productId of maxValid && products.length >= maxValid ? [] : todo) {
  if (checked % 10 === 0) {
    session = await api.newSession();
    if (!session) {
      console.error('Could not start a cart session (guest token) — stopping.');
      break;
    }
  }
  checked++;

  const result = await validate(productId);
  if (result.product) products.push({ ...result.product, validatedAt: nowIso() });
  else rejected.push({ productId, reason: result.reason, detail: result.detail, checkedAt: nowIso() });

  const eta = ((Date.now() - startedAt) / checked) * ((maxValid ? Infinity : todo.length) - checked);
  console.log(`[${carried + checked}/${allIds.length}] ${productId}: ${result.product ? 'valid' : `${result.reason} (${result.detail})`} — ${products.length} valid${Number.isFinite(eta) ? `, ~${Math.round(eta / 60000)} min left` : ''}`);
  if (checked % 10 === 0) save(true);
  if (maxValid && products.length >= maxValid) break;
  await sleep(between(delay));
}

const out = save(false);
console.log(`\n${out}: ${products.length} valid of ${carried + checked} checked (${carried} carried over, ${checked} new); rejected by reason: ${JSON.stringify(countBy(rejected))}; ${api.requestCount()} requests`);
process.exit(products.length ? 0 : 1);

async function validate(productId) {
  const pdp = await api.product(session, productId);
  if (!pdp.product) return { reason: pdp.status === 404 || pdp.status === 'empty' ? 'notFound' : 'pdpError', detail: `PDP status ${pdp.status}` };
  const p = pdp.product;
  const variants = p.variants || {};
  const ids = Object.keys(variants);
  if (!ids.length) return { reason: 'noVariants', detail: 'no variants' };

  // Default variant first, then the rest (as the Python validator does).
  const defaultId = (p.meta && p.meta.defaultVariantId) || ids[0];
  const order = [defaultId, ...ids.filter((id) => id !== defaultId)].filter((id) => variants[id]);
  const inStock = order.filter((id) => variants[id].stock && variants[id].stock.available);
  const qualifying = inStock.filter((id) => Number(variants[id].stock.quantity || 0) >= minStock);
  if (!inStock.length) return { reason: 'outOfStock', detail: `${ids.length} variant(s), none available` };
  if (!qualifying.length) return { reason: 'lowStock', detail: `available but quantity < ${minStock}` };

  const custom = p.customData || {};
  const categoryId = (custom.analyticsCategory && custom.analyticsCategory.id) || null;
  let lastFailure = '';
  for (const variantId of qualifying) {
    const add = await api.addToCart(session, { productId, variantId, categoryId, productType: custom.productType });
    if (!add.ok) {
      lastFailure = `status ${add.status}: ${(add.text || '').slice(0, 120)}`;
      continue;
    }
    const v = variants[variantId];
    const xsell = ((v.customData && v.customData.xSellProductsData) || []).map((x) => x && x.productId).filter(Boolean);
    return {
      product: {
        productId,
        listingId: v.listingId || null,
        sku: variantId,
        categoryId,
        productType: custom.productType || null,
        recentlyViewedIds: shuffle(allIds.filter((id) => id !== productId)).slice(0, 10),
        productListings: xsell.length ? shuffle(xsell) : null,
        colourSwatch: (v.forms && v.forms.colour && v.forms.colour.id) || null,
      },
    };
  }
  return { reason: 'addToCartFailed', detail: lastFailure };
}

function save(partial) {
  const total = carried + checked;
  const oldest = products.map((p) => p.validatedAt).sort()[0];
  const base = maxValid
    ? `sanity subset: ${products.length} valid products (${total} checked, --max-valid ${maxValid})`
    : total < allIds.length
      ? `incomplete: ${total} of ${allIds.length} checked`
      : opts.input ? `custom input ${inputPath} (${allIds.length} ids)` : 'full list';
  return writeData(clientName, `products_${opts.env}.json`, {
    client: clientName,
    env: opts.env,
    apiPath: ctx.apiPath,
    // k6 judges freshness by this: the age of the oldest product, not of the last save.
    generatedAt: oldest || nowIso(),
    savedAt: nowIso(),
    source: `prep/validate-products.mjs, input ${inputPath}`,
    scope: carried ? `${base}; ${carried} carried over from earlier runs (younger than ${maxAgeHours} h)` : base,
    rules: { minStock, addToCartProof: true },
    summary: { checked: total, valid: products.length, rejected: rejected.length, rejectedBy: countBy(rejected) },
    products,
    rejected,
  }, { partial });
}

// Earlier results for this client and environment: the final file and the .partial, merged by id (the
// newest stamp wins), keeping what is younger than --max-age and still on the input list.
function loadPrior() {
  const stamps = { products: new Map(), rejected: new Map() };
  const notes = [];
  for (const file of [dataPath, `${dataPath}.partial`]) {
    if (!existsSync(file)) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      notes.push(`ignored ${file}: unreadable`);
      continue;
    }
    if (doc.env !== opts.env || (doc.apiPath && doc.apiPath !== ctx.apiPath)) {
      notes.push(`ignored ${file}: made for ${doc.env}${doc.apiPath ? ` ${doc.apiPath}` : ''}, this run is ${opts.env} ${ctx.apiPath}`);
      continue;
    }
    // Files from before per-product stamps: the file's own generatedAt is the best estimate.
    for (const p of doc.products || []) keepNewest(stamps.products, p, p.validatedAt || doc.generatedAt, 'validatedAt');
    for (const r of doc.rejected || []) keepNewest(stamps.rejected, r, r.checkedAt || doc.generatedAt, 'checkedAt');
  }
  const onList = new Set(allIds);
  const cutoff = Date.now() - maxAgeHours * 3.6e6;
  const fresh = (e, field) => onList.has(e.productId) && Date.parse(e[field]) >= cutoff;
  const kept = {
    products: [...stamps.products.values()].filter((e) => fresh(e, 'validatedAt')),
    rejected: [...stamps.rejected.values()].filter((e) => fresh(e, 'checkedAt') && !stamps.products.has(e.productId)),
  };
  const stored = stamps.products.size + stamps.rejected.size;
  const oldest = kept.products.map((p) => p.validatedAt).sort()[0];
  if (stored) {
    notes.push(`Resuming: ${kept.products.length} valid and ${kept.rejected.length} rejected kept (younger than ${maxAgeHours} h${oldest ? `, oldest validated ${oldest}` : ''}); ${stored - kept.products.length - kept.rejected.length} older or off-list entries will be checked again`);
  } else if (!notes.length) {
    notes.push('No earlier results: starting from the first product');
  }
  return { ...kept, note: notes.join('\n') };
}

function keepNewest(map, entry, stamp, field) {
  const old = map.get(entry.productId);
  if (!old || Date.parse(stamp) > Date.parse(old[field])) map.set(entry.productId, { ...entry, [field]: stamp });
}

function countBy(list) {
  const out = {};
  for (const r of list) out[r.reason] = (out[r.reason] || 0) + 1;
  return out;
}
