// Pacsun. No JMeter suite exists: values come from the dev apps captured through Charles on
// 2026-09-30 — Android (com.july.pacsun.dev, app version 87: home, shop, PLP sort/filter, search,
// PDP, bag, wishlist, store finder, walked with Maestro) and iOS (9.0.0: app open only). App
// identifiers ship inside the mobile app — they are config, not secrets. Only dev is known so far
// (staging/prod app ids not captured).
//
// Gen-3 Poq API (/clients/pacsun/…, guest-token Bearer). The app also sends a poq-auth signature;
// dev does not enforce it on guest calls (checked 2026-09-30: PDP and add-to-bag return 200 without it).

// Body check helper: the response contains all these JSON keys.
const has = (...keys) => (j, res) => keys.every((k) => res.body.includes(`"${k}"`));

export default {
  name: 'pacsun',
  displayName: 'Pacsun',
  apiPath: 'pacsun', // → /clients/pacsun/…
  session: 'guestToken',
  locale: { currency: 'USD', country: 'US', acceptLanguage: 'en-US' },

  appVersion: '87', // /launch?appVersion=87 (Android app)

  // Static app headers, as captured from the Android app. The backend treats iOS and Android the
  // same, so one header set is used for every session (user decision, 2026-09-30).
  headers: {
    'Content-Type': 'application/json; charset=UTF-8',
    platform: 'Android',
    'Currency-Code': 'USD',
    'Poq-Currency-Identifier': 'USD',
    'Poq-Country-Identifier': 'US',
    'poq-slot-conditions': 'loggedIn=false&notifications=true&inStore=false',
  },

  validatorHeaders: {},
  // Validator add-to-cart proof: the app's body {variantId, quantity, shipmentType: 'direct'};
  // success = the variant is in the returned cartItems (customData comes back empty).
  validator: { addToCart: 'direct', success: 'inCart' },

  // Tweaks to shared platform endpoints (lib/platform/), as the app calls them.
  // Structural differences (bag update/delete via POST /cart, wishlist array bodies) are in ./endpoints.js.
  endpoints: {
    guestToken: { headers: { 'Content-Type': 'Application/Json' } },
    banners: { query: { 'slot-content-id': 'home', labels: 'online' }, checks: { 'is a list': (j) => Array.isArray(j) } },
    appStories: { checks: { 'has stories': has('stories') } },
    splash: { checks: { 'has config': has('config', 'localization') } },
    accountContent: { query: { 'slot-content-id': 'account' } },
    // The capture shows no logout response body; accept 200 or 204 until one is seen.
    logout: { expect: [200, 204] },
    shop: { query: { 'slot-content-id': 'shop' }, checks: { 'has categories': (j) => Array.isArray(j.categories) && j.categories.length > 0 } },
    search: { query: { 'slot-content-id': 'plp' }, checks: { 'has listings': (j) => Array.isArray(j.listings) } },
    predictive: { path: '/search/predictive/v2', checks: { 'has results': (j) => Array.isArray(j.results) } },
    plp: { checks: { 'has listings and pagination': (j) => Array.isArray(j.listings) && j.pagination } },
    getCart: { checks: { 'has cartItems': (j) => Array.isArray(j.cartItems) } },
    wishlistGet: { checks: { 'has ids': has('ids') } },
  },

  environments: {
    dev: {
      baseUrl: 'https://dev.poq.io',
      appId: 523,
      appIdentifier: '901c5f95-80e8-450a-bfd6-c7dd4983a824',
      versionCode: '1.1',
      userAgent: 'PoqApp/87',
    },
    // The isolated perf client on the platform host (platform.poq.io/clients/pacsun-perf). That is the
    // prod host, so it is ENV=prod and the prod guards apply. appIdentifier matches the backend's
    // WestUSPerformance settings; appId/versionCode are copied from dev: provisional until confirmed.
    prod: {
      baseUrl: 'https://platform.poq.io',
      apiPath: 'pacsun-perf',
      // Not ideal (user, 2026-10-19): banners for app 523 return 424 on pacsun-perf, so the path takes the live
      // app's banners (349); the headers keep app 523. Remove once the backend fix lands.
      // App stories the same way (user, 2026-10-19): the 349 banners carry no story ids, so the app's call is
      // /appstories/apps/349/home without poqUserId or ids, made at every app start (storiesWithoutIds).
      endpoints: {
        banners: { path: '/banners/349' },
        appStories: { path: '/appstories/apps/349/home', query: { poqUserId: undefined, ids: undefined } },
      },
      storiesWithoutIds: true,
      // Works on pacsun-perf since the backend fix (user, 2026-10-20).
      voucherCodes: ['TEST-KNQSSCHB2TNR24ZF'],
      appId: 523,
      appIdentifier: '901c5f95-80e8-450a-bfd6-c7dd4983a824',
      versionCode: '1.1',
      userAgent: 'PoqApp/87',
    },
  },

  // Traffic mix (share of visits), derived from Xceptance's web peak-hour funnel (visits 209,000/h, orders
  // 19,800/h, checkout and cart abandonment 50% each, registered vs guest checkouts 50/50). Journeys stop at
  // checkout start, so: checkouts started = orders ÷ 0.5 → half guest, half registered (9.5% of visits each);
  // carts = checkouts ÷ 0.5, the rest abandon the cart (19%); everyone else only browses (62%).
  // `register` is opt-in only (0 = never in the default mix): it creates real accounts that cannot be deleted.
  // Run it with -e SCENARIOS=register, or with PROFILE=scale, which adds the fixed 50 registrations below.
  // `loggedInUser` (login/logout only) is opt-in too. Both log-in scenarios need data/accounts_<env>.json (gitignored).
  mix: { guestBrowse: 0.62, guestCartAbandon: 0.19, guestCheckout: 0.095, loggedInCheckout: 0.095, register: 0, loggedInUser: 0 },

  // Checkout start: switched off 2026-10-16 (424, Hybrid Auth / sfcc.session_bridge on the SLAS client), back on
  // 2026-10-19 after the backend fix (200 on pacsun-perf).
  checkoutStart: true,

  // Voucher on the logged-in checkout (Xceptance: 60% of registered orders): apply, checkout start, remove.
  // Each session picks one code; an empty list skips the step. Codes are per environment
  // (environments.<env>.voucherCodes); dev has none: both dev codes were rejected on 2026-10-15 (400 "Invalid
  // Coupon Code" from Salesforce Commerce Cloud).
  voucherCodes: [],
  voucherShare: 0.6,

  // Provisional (plan §13, §16; rev 41): the app is taken as 32.5% of Xceptance's web peak (user: cut web by 65-70%),
  // i.e. ~68,000 visits/h ≈ 575 req/s at ~30.5 requests per visit, plus Xceptance's bot traffic (10% of visits,
  // 5 requests each ≈ 9 req/s) → 585 req/s. For comparison the GA4 dashboard (B20 2025) puts the app at ~17% of sessions.
  load: {
    targetRps: 585,
    rampUp: '5m',
    hold: '25m',
    // PROFILE=scale: the same ramp and hold as `load`, plus 50 registrations spread over the hold (as Hot Topic).
    shape: {
      stages: [[5, 1], [25, 1]],
      fixed: { register: { count: 50, startAfter: 5, over: 25 } },
      // Sanity covers the same scenarios as the real run (user, 2026-10-20): 1 registration in the 4-minute hold.
      fixedInSanity: true,
    },
  },

  thinkTimeSeconds: [1, 3], // provisional (plan §16)
  maxDataAgeHours: 12, // proposed default (plan §16)

  // Contiguous US, for the store finder (the app sent the device location: lat/lng).
  storeSearchBox: { lat: [24.5, 49.4], lng: [-124.8, -66.9] },
  // Store finder ZIP searches (the capture searched 90210). Provisional list of US ZIPs with stores nearby.
  storeSearchZips: ['90210', '92627', '10001', '60611', '94102', '33139', '85004', '98101'],

  // Registration (POST /account/register, shape from an iOS 9.0.0 dev capture): a throwaway person per call.
  // Provisional: byom.de is the team's disposable-inbox test domain (as for Hot Topic), not yet confirmed to be accepted by Pacsun; names are letters only.
  registration: {
    firstNames: ['Kay', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Avery'],
    lastNames: ['Loadtest', 'Sample', 'Probe', 'Capture'],
    emailPattern: 'k6reg.{id}@byom.de', // {id} = random hex; prep/create-accounts.mjs --email-pattern overrides it
    zips: ['78704', '90210', '10001', '60611', '98101'],
  },

  // Sort and filter values the app sent on a PLP (2026-09-30). Sort ids come from the response's
  // sortOptions. "Top Rated" is offered but the app sent sort=price-high when it was picked — raised
  // as an app finding; k6 sends the offered id.
  plpVariants: [
    { name: 'PLP sort: newest', query: { sort: 'newest' } },
    { name: 'PLP sort: best sellers', query: { sort: 'Best Sellers' } },
    { name: 'PLP sort: price low-high', query: { sort: 'price-low' } },
    { name: 'PLP sort: price high-low', query: { sort: 'price-high' } },
    { name: 'PLP sort: top rated', query: { sort: 'Top Rated' } },
    { name: 'PLP sort: most reviewed', query: { sort: 'Most Reviewed' } },
    { name: 'PLP filter: size M', query: { sort: 'Featured', c_size: 'M' } },
    // Price slider: whole dollars inside the category's price range ($15–$225 on the captured PLP).
    { name: 'PLP filter: price range', query: { minPrice: 20, maxPrice: 100 } },
  ],

  // Provisional regression guards until SLOs are agreed (plan §14.1, §16 item 3). No baseline yet.
  limits: {
    maxFailedRate: 0.01,
    minChecksRate: 0.99,
    prodAbortFailedRate: 0.1,
    prodAbortDelay: '60s',
    p95Ms: {
      default: 3000, // user, 2026-10-20 (was 1500): pacsun-perf sanity runs put search/PLP p95 at 2.2-2.8 s
      Login: 4000, // provisional: one dev call took 2.3 s (2026-10-15); no baseline yet
      Register: 6000, // provisional: one dev call took 4.2 s (2026-10-15); no baseline yet
    },
  },
};
