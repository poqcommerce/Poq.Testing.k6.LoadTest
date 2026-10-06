// Hot Topic. Values come from Poq.Testing.LoadTest hot_topic/{prod,staging}.properties and
// hot_topic/hot_topic.jmx (working tree, 2026-09-28). App identifiers ship inside the mobile
// app — they are config, not secrets. The poq-auth signing key/salt are secrets:
// secrets/hot_topic.secrets (gitignored), see README.
//
// Targets the isolated perf client /clients/hottopic-perf/v2/… (user decision, 2026-10-01; same host
// and app id as the live client). -e API_PATH=hottopic/v2 points a run at the live client instead.
// Identity is the device's poq-user-id (one per VU), kept after the guest token like the app does.
// Shopping calls are still the Gen-2 shapes from the JMeter suite; the account flow and app start
// follow the prod iOS app 26.2.0 capture (plan rev 22).

// Body check helper: the response contains all these JSON keys (as the JMeter assertions did).
const has = (...keys) => (j, res) => keys.every((k) => res.body.includes(`"${k}"`));

export default {
  name: 'hot_topic',
  displayName: 'Hot Topic',
  apiPath: 'hottopic-perf/v2', // → /clients/hottopic-perf/v2/…
  session: 'device', // one persistent poq-user-id per VU; member scenarios add a guest token on top
  locale: { currency: 'USD', country: 'US', acceptLanguage: 'en-us' },

  // Static app headers (hot_topic.jmx global HeaderManager).
  headers: {
    'content-type': 'application/json',
    'accept-language': 'en-us',
    platform: 'iphone',
    appuseragent: 'Poq-Native-iOS-App',
    'currency-code': 'USD',
    'Poq-Currency-Identifier': 'USD',
    'poq-country-identifier': 'US', // sent by app 26.2.0 on every call
    'poq-slot-conditions': 'loggedIn=false', // becomes loggedIn=true after the login
  },
  validatorHeaders: {},
  // Same rules as the Hot Topic Python validator (Utilities origin/hottopic): a fresh device id per
  // cart session, add-to-bag body {quantity, variantId, productId}, success = HTTP 200.
  validator: { addToCart: 'minimal', success: 'status200' },

  // Tweaks to shared platform endpoints (lib/platform/): Gen-2 differences in query parameters and
  // paths, plus the body checks the JMeter suite asserted. Structural differences are in ./endpoints.js.
  endpoints: {
    splash: { checks: { 'has splash sections': has('localization', 'theme', 'config') } },
    launch: { checks: { 'has launch fields': has('forceUpdate', 'maintenance', 'onboarding') } },
    // App 26.2.0 sends slot-content-id and labels (no poqUserId, no trailing slash).
    banners: { query: { 'slot-content-id': 'home', labels: 'online' }, checks: { 'has banner fields': has('id', 'title', 'url') } },
    appStories: { checks: { 'has stories': has('stories', 'title', 'cards') } },
    accountContent: { query: { 'slot-content-id': 'account' } },
    shop: { checks: { 'has categories': has('id', 'name', 'parentCategoryId') } },
    shopCategories: { query: { 'slot-content-id': undefined } },
    search: { query: { isBloomreachKeywordSearch: 'true' }, checks: { 'has pagination': has('pagination', 'first', 'last', 'previous', 'filters', 'next') } },
    predictive: { path: '/search/predictive/v2', checks: { 'has results': (j) => Array.isArray(j.results) } },
    plp: { query: { 'slot-content-id': undefined }, checks: { 'has pagination': has('pagination', 'numberOfItems') } },
    productDetails: { query: { 'slot-content-id': undefined } },
    reviews: { query: { listingId: undefined, variantId: undefined, isCollection: undefined } },
    getCart: { query: { 'slot-content-id': undefined }, checks: { 'has cartId': (j) => j.cartId } },
    checkoutStart: { checks: { 'has order and orderId': has('order', 'orderId'), 'currency USD': (j) => j.order.currency === 'USD' } },
  },

  environments: {
    staging: {
      baseUrl: 'https://staging.poq.io',
      appId: 199,
      appIdentifier: '175974b4-c199-4d2f-98b5-eb373ec317f5',
      versionCode: '24.15',
      userAgent: 'iOS/17.6.1 poq.ios/19.1.16 com.hottopic.ios/24.5.1',
    },
    prod: {
      baseUrl: 'https://platform.poq.io',
      appId: 198,
      appIdentifier: '7114a2fb-b812-4d75-90b2-8f2c043caef2',
      versionCode: '25.5',
      // Exact string from prod.properties (2026-09-28). The first prod trial that day got ~85% 403s
      // until the user agent was changed to this; it ends with the POQQAALLOW allowlist marker.
      userAgent:
        'Hot Topic/1 (iPhone; iOS/26.7) CFNetwork/3860.700.2 Darwin/25.6.0 poq.ios/23.1.6 Hot Topic/1 (iPhone; iOS/26.7) CFNetwork/3860.700.2 Darwin/25.6.0 poq.ios/23.1.6 HotTopic-LIVE/26.2.0POQQAALLOW',
    },
  },

  // Traffic mix (share of requests), measured from the 2025-09-24 prod run (2.43M samples):
  // Concurrent ≈ 70%, Ramp Up ≈ 21%, Account ≈ 9%.
  // `register` is opt-in only (0 = never in the default mix): it creates real accounts that cannot be
  // deleted. Run it with -e SCENARIOS=register.
  mix: { browser: 0.7, shopper: 0.21, account: 0.09, register: 0 },

  // performance.properties (committed full-scale run) + the "Performans" throughput timer:
  // 41,667 req/min ≈ 694 req/s, ramp 1,800 s, hold 1,800 s. Provisional (plan §13, §16).
  load: {
    targetRps: 694,
    rampUp: '30m',
    hold: '30m',
    // PROFILE=scale (provisional, user request 2026-10-06): 65 minutes holding about 2.5M requests in total, ramp
    // included (last year's ~2.5M requests/hour). stages = [minutes, factor of targetRps], ramped linearly:
    // 15 min gradual ramp, 45 min at about 103% with three surges (125%, 115%, 125%), 5 min ramp-down.
    // Logged-in users start 15 min in; about 50 registrations over minutes 15-60.
    shape: {
      stages: [
        [5, 0.4], [5, 0.7], [5, 0.95], // ramp-up
        [12, 1.03], [3, 1.25], [8, 1.03], [3, 1.15], [8, 1.03], [3, 1.25], [8, 1.03], // peak with surges
        [5, 0.2], // ramp-down
      ],
      startAfter: { account: 15 },
      fixed: { register: { count: 50, startAfter: 15, over: 45 } },
    },
  },

  appVersion: '26.2.0', // /launch?appVersion= (iOS app, prod capture 2026-10-01)

  thinkTimeSeconds: [1, 3],
  maxDataAgeHours: 12,

  // Contiguous US, for store stock / store search by coordinates (JMeter used random global points).
  storeSearchBox: { lat: [24.5, 49.4], lng: [-124.8, -66.9] },
  storeSearchZip: '92020',
  voucherCode: 'ACCESS13',
  // Address book (app 26.2.0): the address added, edited (apartment) and deleted by the account scenario.
  addressBook: { address1: '801 University Blvd', address2: 'Apt 2', city: 'Tuscaloosa', stateCode: 'AL', postCode: '35401' },
  // Registration: a throwaway person on byom.de (the team's disposable-inbox test domain; register refuses
  // example.com with "Not acceptable email") with a US address that passes address validation. Names are letters only: the app rejects digits in a first name.
  registration: {
    firstNames: ['Kay', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Avery'],
    lastNames: ['Capture', 'Loadtest', 'Sample', 'Probe'],
    emailDomain: 'byom.de',
    address: { addressLine1: '3485 29th St', city: 'Tuscaloosa', stateCode: 'AL', postalCode: '35401' },
    birthYears: [1980, 1999],
  },
  qasCustomer: { firstName: 'Joakin', lastName: 'Klmuk', birthDate: '2005-05-23' },
  qasSuggestAddress: { addressLine1: '3855 E octillo rd', city: 'Phoenix', stateCode: 'AZ', postalCode: '85000' },
  qasValidAddress: { addressLine1: '27 Lenox Ave', city: 'New York', stateCode: 'NY', postalCode: '10009' },

  plpVariants: [
    { name: 'PLP sort: best seller', query: { sort: 'bestSeller' }, checks: { 'has paging links': has('next', 'first') } },
    { name: 'PLP sort: new arrivals', query: { sort: 'newArrival' }, checks: { 'has paging links': has('next', 'first') } },
    { name: 'PLP sort: top rated', query: { sort: 'topRated' }, checks: { 'has paging links': has('next', 'first') } },
    { name: 'PLP sort: price low-high', query: { sort: 'priceLowToHigh' }, checks: { 'has paging links': has('next', 'first') } },
    { name: 'PLP sort: price high-low', query: { sort: 'priceHighToLow' }, checks: { 'has paging links': has('next', 'first') } },
  ],

  // Per-endpoint p95 limits. Relaxed on 2026-10-02 (user request: "no need to be so aggressive"). The first
  // values were 1.5 × the 2025-09-24 JMeter baseline (floor 500 ms); a paced prod run from a laptop breached 26
  // of them. Now: every endpoint without its own entry uses `default`, and the slower ones are listed below.
  // All provisional until SLOs are agreed (plan §14.1, §16).
  limits: {
    maxFailedRate: 0.20, // was 0.01: one failed call in a short run breached it
    minChecksRate: 0.95,
    prodAbortFailedRate: 0.1, // prod safety stop above this failure rate…
    prodAbortDelay: '60s', // …evaluated from this point (override per run: -e ABORT_FAILED_RATE / -e ABORT_DELAY)
    p95Ms: {
      default: 3000,
      Login: 3000,
      Register: 4000, // paced run: p95 3.4 s over 3 samples
      'Search by keyword': 2500, // paced run: p95 2.0 s over 6 samples
      'Add to bag': 2500,
      'PLP sort: new arrivals': 4000,
      'PLP sort: top rated': 4000,
      'PLP sort: price low-high': 4000,
      'PLP sort: price high-low': 4000,
      'Product details': 4000, // paced run: p95 3.4 s over 3 samples
      'PLP sort: best seller': 4000, // was 6000 (paced run, 3 samples); 4000 for all PLP sorts, user request 2026-10-06
    },
  },
};
