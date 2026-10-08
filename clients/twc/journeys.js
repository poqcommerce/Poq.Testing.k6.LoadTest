// TWC journeys: the order of steps. Step order follows twc.jmx:
// "Concurrent Users (Guest)" → guestShopper, "Ramp Up Users (Logged in)" → loggedInShopper.
// Standard Poq endpoints come from lib/platform/; TWC-only ones from ./endpoints.js.

import exec from 'k6/execution';
import { correlationFailure } from '../../lib/http.js';
import { account, app, catalog, product as pdp, cart, wishlist, stores, checkout, NAMES as PLATFORM_NAMES } from '../../lib/platform/index.js';
import { randomItem, randomPoint, think } from '../../lib/data.js';
import * as twc from './endpoints.js';
import client from './config.js';

// -e GIFT_BOX_SHARE=1 forces the gift box flow (e.g. to exercise it in a sanity run).
export const giftBoxShare = __ENV.GIFT_BOX_SHARE !== undefined ? Number(__ENV.GIFT_BOX_SHARE) : client.giftBoxShare;

export const endpointNames = [...PLATFORM_NAMES, ...Object.values(twc.NAMES), ...client.plpVariants.map((v) => v.name)];

// ---- guest browse: read-only (no bag, wishlist or checkout writes) ----

export function guestBrowse(s, data) {
  if (!startGuestSession(s)) return;
  app.contentData(s);
  think(s.cfg);
  return browse(s, data, { sortAndFilter: true });
}

// ---- guest shopper: browse, then bag → checkout → cleanup ----

export function guestShopper(s, data) {
  const product = guestBrowse(s, data);
  if (!product) return;
  think(s.cfg);

  const cartItemId = bagAndUpdate(s, product);
  think(s.cfg);

  checkout.cartSign(s, `perf-${crypto.randomUUID().slice(0, 12)}@${client.testEmailDomain}`);
  checkout.openCheckoutUrl(s, checkout.checkoutStart(s));
  checkout.applePay(s, client.applePayAddress);
  if (cartItemId) cart.deleteCartItem(s, cartItemId, pdp.productRefs(product));
  think(s.cfg);

  wishlist.wishlistAdd(s, product);
  wishlist.wishlistGet(s);
  think(s.cfg);

  stores.stores(s, randomPoint(client.storeSearchBox));
}

// ---- logged-in shopper: one exclusive account per VU; full session ending in logout ----

export function loggedInShopper(s, data) {
  // Accounts are taken in turn by iteration number, as in Hot Topic. k6 VU ids are global, so in a mixed run the
  // logged-in VUs started beyond the list (ids 77+ on a prod load run with 20 accounts) and all ran as guests.
  // Two iterations share an account only when they are a whole list apart, long after the first has logged out
  // (the scenario's maxVUs stays below the list size: 15 vs 20 on prod load). An empty list runs the guest journey.
  const acct = data.accounts[exec.scenario.iterationInTest % data.accounts.length];
  if (!acct) {
    correlationFailure(s, twc.NAMES.loginNoAccount, 'account (the account list is empty)');
    return guestShopper(s, data);
  }

  if (!account.guestToken(s)) return;
  account.refreshToken(s);
  if (!twc.login(s, acct)) return;
  s.headers['poq-slot-conditions'] = 'loggedIn=true';
  think(s.cfg);

  openApp(s);
  account.accountPages(s);
  think(s.cfg);

  const product = browse(s, data, { sortAndFilter: false });
  if (!product) return account.logout(s);
  think(s.cfg);

  const cartItemId = bagAndUpdate(s, product);
  checkout.openCheckoutUrl(s, checkout.checkoutStart(s));
  if (cartItemId) cart.deleteCartItem(s, cartItemId, pdp.productRefs(product));
  think(s.cfg);

  wishlist.wishlistAdd(s, product);
  if (data.giftBundles.length && Math.random() < giftBoxShare) {
    twc.giftBox(s, randomItem(data.giftBundles));
    cart.clearCart(s);
  }
  for (const id of wishlist.wishlistGet(s)) wishlist.wishlistDelete(s, id); // accounts persist: leave the wishlist empty
  think(s.cfg);

  stores.stores(s, randomPoint(client.storeSearchBox));
  account.logout(s);
}

// ---- steps ----

function startGuestSession(s) {
  s.headers['poq-slot-conditions'] = 'loggedIn=false';
  if (!account.guestToken(s)) return false;
  account.refreshToken(s);
  think(s.cfg);
  openApp(s);
  think(s.cfg);
  return true;
}

function openApp(s) {
  app.splash(s);
  app.settings(s);
  app.launch(s, client.appVersion);
  twc.dynamicYieldIdentifiers(s);
  app.banners(s);
  app.contentBlocks(s);
  twc.dyHomeRecommendations(s);
}

// shop → search → PLP (+ sort/filter) → PDP. Returns the product viewed.
function browse(s, data, { sortAndFilter }) {
  catalog.shop(s);
  think(s.cfg);

  const keyword = randomItem(data.keywords);
  catalog.popularTerms(s);
  catalog.search(s, keyword);
  catalog.predictiveSearch(s, typedPrefix(keyword));
  think(s.cfg);

  const categoryId = randomItem(data.categories);
  catalog.plp(s, categoryId);
  think(s.cfg);

  if (sortAndFilter) {
    for (const variant of client.plpVariants) catalog.plp(s, categoryId, variant);
    think(s.cfg);
  }

  const product = randomItem(data.products);
  viewPdp(s, product);
  return product;
}

// The app queries predictive search with the first characters typed.
function typedPrefix(keyword) {
  return !keyword || keyword.trim().length < 3 || keyword.includes(' ') ? 'hat' : keyword.slice(0, 5);
}

function viewPdp(s, product) {
  app.globalBanners(s);
  pdp.productDetails(s, product);
  pdp.recentlyViewed(s, product);
  pdp.productListings(s, product);
  twc.dyPdpRecommendations(s, product);
  pdp.userGeneratedContent(s, product);
  pdp.reviews(s, product);
  stores.storeAvailability(s, product, randomPoint(client.storeSearchBox));
}

// Add → validate → get bag → update qty 2 → validate → get bag. Returns the bag line id (or null).
function bagAndUpdate(s, product) {
  if (!cart.addToBag(s, product)) return null;
  cart.validateCart(s);
  const item = cart.cartItemFor(s, cart.getCart(s), product);
  if (!item) return null;
  cart.updateCartItem(s, item.id, product, 2);
  cart.validateCart(s);
  const updated = cart.cartItemFor(s, cart.getCart(s), product);
  return updated ? updated.id : item.id;
}
