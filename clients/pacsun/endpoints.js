// Pacsun-only calls: the bag (add body, update / delete via POST /cart), the wishlist's array bodies,
// PLP paging, home carousels, predictive product suggestions and the store finder. Standard Poq
// endpoints come from lib/platform/ with the tweaks in ./config.js. Shapes as captured from the
// Android dev app on 2026-09-30.

import { request, correlationFailure } from '../../lib/http.js';
import { randomItem } from '../../lib/data.js';
import { newPerson, registerBody } from './registration.js';
import client from './config.js';
import { productRefs } from '../../lib/platform/product.js';
import { NAMES as CART } from '../../lib/platform/cart.js';
import { NAMES as WISHLIST } from '../../lib/platform/wishlist.js';
import { NAMES as STORES } from '../../lib/platform/stores.js';

export const NAMES = {
  wishlistItemIds: 'Wishlist item ids',
  homeCarousel: 'Home carousel products',
  plpNextPage: 'PLP next page',
  searchNextPage: 'Search next page',
  predictiveProducts: 'Predictive search products',
  wishlistClear: 'Clear wishlist',
  storesByZip: 'Stores by ZIP code',
  webViewCss: 'Web view assets: CSS',
  webViewJs: 'Web view assets: JS',
  register: 'Register',
  loyaltyRewards: 'Loyalty rewards',
  login: 'Login',
  voucher: 'Apply voucher',
  voucherRemove: 'Remove voucher',
};

const V3 = { 'Accept-Version': 'v3' };
const inBag = (sku) => (j) => Array.isArray(j.cartItems) && j.cartItems.some((i) => String(i.variantId) === String(sku));

// ---- registration ----

// POST /account/register with the guest token, as the app's sign-up form does. Creates a real account
// (the API cannot delete it); the scenario is opt-in. The app is logged in as the new user afterwards,
// so the response's token replaces the guest token for the later steps. Returns the new account's
// { email, password } or null. Auth call: bodies are never logged.
export function register(s) {
  const p = newPerson(client.registration);
  const { ok, json } = request(s, {
    name: NAMES.register,
    method: 'POST',
    path: '/account/register',
    body: registerBody(p),
    checks: { 'has accessToken': (j) => j.accessToken }, // the response is the new account's logged-in session
    sensitive: true,
  });
  if (!ok) return null;
  // Assumed to be the guest-token shape ({ accessToken, refreshToken }): not yet confirmed from a capture.
  if (json && json.accessToken) {
    s.token = json.accessToken;
    s.refreshToken = json.refreshToken || s.refreshToken;
    s.loggedIn = true;
  }
  return { email: p.email, password: p.password };
}

// ---- login ----

// POST /account/login with an existing test account, as the app's sign-in form does. Same response
// shape as Hot Topic's login ({ accessToken, refreshToken }); not yet confirmed from a Pacsun response
// body. The app flips poq-slot-conditions to loggedIn=true, and its next call is the account content.
// Auth call: bodies are never logged. Returns true when the session is logged in.
export function login(s, acct) {
  const { json } = request(s, {
    name: NAMES.login,
    method: 'POST',
    path: '/account/login',
    body: { password: acct.password, username: acct.email },
    checks: { 'has accessToken': (j) => j.accessToken },
    sensitive: true,
  });
  if (!json || !json.accessToken) {
    correlationFailure(s, NAMES.login, 'accessToken');
    return false;
  }
  s.token = json.accessToken;
  s.refreshToken = json.refreshToken || s.refreshToken;
  s.loggedIn = true;
  s.headers['poq-slot-conditions'] = 'loggedIn=true&notifications=true&inStore=false';
  return true;
}

// ---- loyalty ----

// Rewards tab of the logged-in app (GET /loyalty/rewards). Only after register: it needs the new
// account's token, so a guest session is never sent here. The app flips poq-slot-conditions to loggedIn=true.
export function loyaltyRewards(s) {
  if (!s.loggedIn) return correlationFailure(s, NAMES.loyaltyRewards, 'logged-in token from register');
  request(s, {
    name: NAMES.loyaltyRewards,
    path: '/loyalty/rewards',
    headers: { 'poq-slot-conditions': 'loggedIn=true&notifications=true&inStore=false' },
    sensitive: true, // customer rewards: success bodies stay out of the failure log
  });
}

// ---- bag ----

// Applies one of the environment's voucher codes to the bag (the app's promo field: POST /cart/vouchers with
// {code}). Returns the applied voucher { id, code } from the response, or null (none configured, or the apply
// failed: nothing to remove). Only shown to logged-in sessions, as in the app.
export function applyVoucher(s) {
  const codes = s.cfg.env.voucherCodes || client.voucherCodes;
  if (!codes.length) return null;
  const code = randomItem(codes);
  const find = (j) => (j && Array.isArray(j.vouchers) ? j.vouchers.find((v) => v.code === code && v.status === 'Applied') : null);
  const { json } = request(s, {
    name: NAMES.voucher,
    method: 'POST',
    path: '/cart/vouchers',
    query: { 'slot-content-id': 'cart' },
    body: { code },
    checks: { 'voucher applied': (j) => Boolean(find(j)) },
    data: { voucher: code },
  });
  const voucher = find(json);
  return voucher && voucher.id ? voucher : null;
}

// Removes a voucher from the bag: DELETE /cart/vouchers/{id}, where id is the voucher's coupon item id from
// the bag (vouchers[].id) — Salesforce removes coupons by item id, not by code (the code answers 404
// "Coupon Item Not Found"). Pacsun answers with the bag (vouchers: []); TWC expected 204.
export function removeVoucher(s, voucher) {
  request(s, {
    name: NAMES.voucherRemove,
    method: 'DELETE',
    path: `/cart/vouchers/${encodeURIComponent(voucher.id)}`,
    expect: [200, 204],
    checks: { 'voucher removed': (j, res) => res.status === 204 || (Array.isArray(j.vouchers) && !j.vouchers.some((v) => v.id === voucher.id)) },
    data: { voucher: voucher.code, voucherId: voucher.id },
  });
}

// Returns the bag JSON when the variant is in it (the response has no quantityAdded), else null.
export function addToBag(s, product) {
  const { ok, json } = request(s, {
    name: CART.addToBag,
    method: 'POST',
    path: '/cart/items',
    query: { 'slot-content-id': 'added-to-cart' },
    body: { variantId: product.sku, quantity: 1, shipmentType: 'direct' },
    checks: { 'variant in bag': inBag(product.sku) },
    data: productRefs(product),
  });
  return ok ? json : null;
}

// The app changes and removes bag lines with POST /cart and an items list (not PATCH/DELETE /cart/items).
function updateCart(s, name, item, quantity, deleted, product) {
  return request(s, {
    name,
    method: 'POST',
    path: '/cart',
    query: { 'slot-content-id': 'cart' },
    body: { items: [{ cartItemId: item.id, quantity, deleted, shipmentType: item.shipmentType || 'direct' }] },
    checks: { 'has cartItems': (j) => Array.isArray(j.cartItems) },
    data: { ...productRefs(product), cartItemId: item.id },
  });
}

export function updateBagItem(s, item, product, quantity) {
  updateCart(s, CART.updateCartItem, item, quantity, false, product);
}

export function deleteBagItem(s, item, product) {
  updateCart(s, CART.deleteCartItem, item, item.quantity || 1, true, product);
}

// ---- wishlist (v3; add and delete take a list of {productId, listingId}) ----

export function wishlistItemIds(s) {
  request(s, { name: NAMES.wishlistItemIds, path: '/wishlist/item-ids', headers: V3, checks: { 'is a list': (j) => Array.isArray(j) } });
}

function wishlistItems(product) {
  return [{ productId: product.productId, listingId: product.listingId }];
}

export function wishlistAdd(s, product) {
  if (!product.listingId) return correlationFailure(s, WISHLIST.wishlistAdd, 'listingId', productRefs(product));
  request(s, { name: WISHLIST.wishlistAdd, method: 'POST', path: '/wishlist/items', headers: V3, body: wishlistItems(product), expect: [204], data: productRefs(product) });
}

export function wishlistDelete(s, product) {
  if (!product.listingId) return;
  request(s, { name: WISHLIST.wishlistDelete, method: 'DELETE', path: '/wishlist/items', headers: V3, body: wishlistItems(product), expect: [204], data: productRefs(product) });
}

// The wishlist's "Clear All" (after the app's confirmation dialog).
export function wishlistClear(s) {
  request(s, { name: NAMES.wishlistClear, method: 'DELETE', path: '/wishlist', headers: V3, expect: [204] });
}

// ---- catalogue ----

// Home product carousels: banners with contentType productCarousel → /search?categories=<actionParameter>.
export function homeCarousels(s, banners) {
  const categories = (Array.isArray(banners) ? banners : [])
    .filter((b) => b && b.contentType === 'productCarousel' && b.actionType === 'category' && b.actionParameter)
    .map((b) => b.actionParameter);
  for (const categoryId of categories) {
    request(s, { name: NAMES.homeCarousel, path: '/search', query: { categories: categoryId }, checks: { 'has listings': (j) => Array.isArray(j.listings) }, data: { category_id: categoryId } });
  }
}

// The second page the app loads while scrolling (16 per page; no slot-content-id on later pages).
export function plpNextPage(s, categoryId, query = {}) {
  request(s, { name: NAMES.plpNextPage, path: '/search', query: { categories: categoryId, ...query, skip: 16 }, data: { category_id: categoryId } });
}

export function searchNextPage(s, keyword) {
  request(s, { name: NAMES.searchNextPage, path: '/search', query: { q: keyword, skip: 16 }, data: { keyword } });
}

// Product suggestions under predictive search: /products?ids=<productListSuggestion ids>.
export function predictiveProducts(s, suggestions) {
  const ids = [];
  for (const r of (suggestions && suggestions.results) || []) {
    for (const x of (r.productListSuggestion && r.productListSuggestion.ids) || []) if (x.productId) ids.push(x.productId);
  }
  if (!ids.length) return; // no product suggestions for this keyword is a valid answer
  request(s, { name: NAMES.predictiveProducts, path: '/products', query: { ids: ids.join(',') }, checks: { 'returns products': (j) => Array.isArray(j) }, data: { ids: ids.join(',') } });
}

// ---- stores ----

// Store finder list (GET /stores, accept-version v2). Store details open from this response,
// so the app makes no further call.
export function storesNearby(s, point) {
  request(s, {
    name: STORES.stores,
    path: '/stores',
    query: { lng: point.lng, lat: point.lat },
    headers: { 'Accept-Version': 'v2' },
    checks: { 'has stores': (j) => Array.isArray(j.stores) },
    data: point,
  });
}

// Store finder ZIP search: the same endpoint with q=<zip>; the app still sends the device location.
export function storesByZip(s, zip, point) {
  request(s, {
    name: NAMES.storesByZip,
    path: '/stores',
    query: { q: zip, lng: point.lng, lat: point.lat },
    headers: { 'Accept-Version': 'v2' },
    checks: { 'has stores': (j) => Array.isArray(j.stores) },
    data: { zip, ...point },
  });
}

// ---- web views ----

// Account-tab info pages (Shipping Options, Returns, Order Locator, About Us, Terms) are Pacsun
// storefront pages in a web view; Poq injects its CSS and JS into each. Only these two Poq calls are
// made — the storefront page itself is not Poq's and is not load-tested. Plain web-view requests.
export function webViewAssets(s) {
  const id = encodeURIComponent(s.poqUserId);
  const appId = s.cfg.env.appId;
  request(s, { name: NAMES.webViewCss, path: `/assets/web/css/${appId}/${id}`, plain: true });
  request(s, { name: NAMES.webViewJs, path: `/assets/web/js/${appId}/${id}`, plain: true });
}

