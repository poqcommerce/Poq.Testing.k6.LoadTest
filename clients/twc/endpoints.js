// TWC-only integrations: Dynamic Yield, gift box bundles, storefront OAuth2 PKCE login.
// Standard Poq endpoints come from lib/platform/.

import { check } from 'k6';
import { request, correlationFailure, stepBlocked } from '../../lib/http.js';
import { pkcePair } from '../../lib/auth.js';
import { productRefs } from '../../lib/platform/product.js';
import client from './config.js';

export const NAMES = {
  dyIdentifiers: 'Dynamic Yield identifiers',
  dyHome: 'Dynamic Yield home recommendations',
  dyPdp: 'Dynamic Yield PDP recommendations',
  dyRecentlyViewed: 'Dynamic Yield recently viewed',
  giftBoxPdp: 'Gift box: bundle PDP',
  giftBoxBulkAdd: 'Gift box: bulk add',
  giftBoxEntryAdd: 'Gift box: add entry',
  loginNoAccount: 'Login: no account',
  authUrl: 'Login: authorization URL',
  authorizePre: 'Login: authorize (pre-login)',
  csrf: 'Login: CSRF',
  storefrontLogin: 'Login: storefront login',
  authorizePost: 'Login: authorize (post-login)',
  tokenExchange: 'Login: token exchange',
};

// ---- Dynamic Yield ----

// DY ids personalise later calls through headers. Missing ids are logged, but the journey
// continues without them — no later request path or body depends on them.
export function dynamicYieldIdentifiers(s) {
  const { json } = request(s, { name: NAMES.dyIdentifiers, path: '/dynamicyield/identifiers' });
  if (!json || !json.userId || !json.sessionId) {
    correlationFailure(s, NAMES.dyIdentifiers, 'userId/sessionId');
    return;
  }
  s.headers['dy-user-id'] = json.userId;
  s.headers['dy-session-id'] = json.sessionId;
}

export function dyHomeRecommendations(s) {
  request(s, { name: NAMES.dyHome, path: '/dynamicyield/recommendations', query: { slotContentId: 'homepage', selector: 'home' } });
}

export function dyPdpRecommendations(s, product) {
  request(s, {
    name: NAMES.dyPdp,
    path: '/dynamicyield/recommendations',
    query: { slotContentId: 'pdp', selector: 'productsidejson_ip', productSku: product.sku },
    data: productRefs(product),
  });
  request(s, {
    name: NAMES.dyRecentlyViewed,
    path: '/dynamicyield/recommendations',
    query: { slotContentId: 'pdp', selector: 'productCustomerViewed' },
    data: productRefs(product),
  });
}

// ---- gift box bundle ----
// Bundle PDP → bulk add (known no-op on TWC: returns 200 with quantityAdded 0, so only its
// status is checked) → add each validated entry individually.
export function giftBox(s, bundle) {
  const refs = { bundle_id: bundle.bundleId };
  request(s, {
    name: NAMES.giftBoxPdp,
    path: '/products',
    query: { ids: bundle.bundleId, 'slot-content-id': 'pdp' },
    checks: { 'is a MultiVariantBundle with entries': (j, res) => /"productType":"MultiVariantBundle"/.test(res.body) && /"entries":/.test(res.body) },
    data: refs,
  });
  request(s, {
    name: NAMES.giftBoxBulkAdd,
    method: 'POST',
    path: '/cart/items/bulk',
    query: { showConfirmationOverlay: 'true' },
    body: { items: bundle.entries.map((e) => ({ quantity: 1, variantId: e.variantId })) },
    data: refs,
  });
  for (const e of bundle.entries) {
    request(s, {
      name: NAMES.giftBoxEntryAdd,
      method: 'POST',
      path: '/cart/items',
      body: {
        productId: e.code,
        deleted: false,
        variantId: e.variantId,
        customData: { productId: e.code, categoryId: 'gift-bundle-entry', productType: 'Standard' },
        quantity: 1,
      },
      checks: { 'quantityAdded > 0': (j) => j.customData.quantityAdded > 0 },
      data: { ...refs, product_id: e.code, sku: e.variantId },
    });
  }
}

// ---- login: OAuth2 authorization code + PKCE through the TWC storefront ----
// authorization-url (Poq) → authorize → CSRF → form login → authorize again (302 with code=)
// → token exchange (Poq). Storefront calls carry no Poq headers or token. Bounded retries.
// Records one "logged in" check per session, so failed logins fail the checks threshold
// even though the rest of the journey is skipped.
export function login(s, acct) {
  let ok = false;
  for (let attempt = 1; attempt <= client.loginAttempts && !ok; attempt++) ok = loginOnce(s, acct);
  check(null, { [`${NAMES.tokenExchange}: logged in within ${client.loginAttempts} attempts`]: () => ok }, { name: NAMES.tokenExchange });
  return ok;
}

function loginOnce(s, acct) {
  const pkce = pkcePair();
  const { json } = request(s, {
    name: NAMES.authUrl,
    path: '/account/authorization-url',
    query: { codeChallenge: pkce.challenge, codeChallengeMethod: 'S256' },
    checks: { 'has webviewUrl': (j) => j.webviewUrl },
    sensitive: true,
  });
  if (!json || !json.webviewUrl) return false;

  const authorizeUrl = json.webviewUrl;
  const origin = s.cfg.env.storefrontOrigin || authorizeUrl.match(/^https?:\/\/[^/]+/)[0];
  if (s.cfg.envName !== 'prod' && client.prodStorefrontOrigins.some((o) => authorizeUrl.startsWith(o) || origin === o)) {
    stepBlocked(s, NAMES.authUrl, `non-prod login pointed at the prod storefront (${origin}) — credentials not sent`);
    return false;
  }

  request(s, { name: NAMES.authorizePre, url: authorizeUrl, plain: true, redirects: 0, expect: [200, 302], sensitive: true });

  const csrf = request(s, {
    name: NAMES.csrf,
    url: `${origin}/authorizationserver/csrf`,
    query: { client_id: client.oauthClientId },
    plain: true,
    checks: { 'has token': (j) => j.token },
    sensitive: true,
  }).json;
  if (!csrf || !csrf.token) return false;

  request(s, {
    name: NAMES.storefrontLogin,
    method: 'POST',
    url: `${origin}/authorizationserver/login`,
    plain: true,
    form: true,
    body: { username: acct.email, password: acct.password, _csrf: csrf.token },
    redirects: 0,
    expect: [200, 302],
    sensitive: true,
  });

  const { res } = request(s, {
    name: NAMES.authorizePost,
    url: authorizeUrl,
    plain: true,
    redirects: 0,
    expect: [302],
    checks: { 'redirect carries code': (j, r) => /[?&]code=/.test(r.headers.Location || '') },
    sensitive: true,
  });
  const code = ((res.headers.Location || '').match(/[?&]code=([^&]+)/) || [])[1];
  if (!code) return false;

  const token = request(s, {
    name: NAMES.tokenExchange,
    method: 'POST',
    path: '/account/v2/login',
    body: { codeVerifier: pkce.verifier, code: decodeURIComponent(code) },
    checks: { 'has accessToken': (j) => j.accessToken },
    sensitive: true,
  }).json;
  if (!token || !token.accessToken) return false;

  s.token = token.accessToken;
  if (token.externalUserId) s.poqUserId = token.externalUserId; // else keep the guest id (as the app does)
  return true;
}
