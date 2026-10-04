# JMeter → k6 Migration Plan: Poq Load Testing

| | |
|---|---|
| Status | **In progress.** TWC is through Phase 4 (JMeter parity shown); Hot Topic is built and sanity-run on prod. See "Where we are" below. |
| Date | Plan 2026-09-28; status updated 2026-09-29 |
| Sources analysed | `Poq.Testing.LoadTest`: all 13 JMX plans on the checked-out branch, plus branch-only suites (`twc`, `office`, `elf`, `hobbycraft` and ~10 triaged). `Poq.Testing.Utilities`: the `new_gen/` tool on branch `twc`, plus the legacy per-brand branches. Committed run reports. |
| Verified locally (k6 v2.3.0) | Native PBKDF2 (WebCrypto `deriveBits`); `k6/crypto` HMAC-SHA256; global `crypto.randomUUID()`; `k6/secrets` with `--secret-source=file=…`, which redacts values in logs; native TypeScript; web-dashboard HTML export; `--console-output` to a file. |

### Revision history

| Rev | Change |
|---|---|
| 34 | **Category extractor made stricter (user request, 2026-10-04) — after the Hot Topic prod warmup.** That run had 77 HTTP 500s: 13 categories (all sorts and the plain PLP together) plus the keyword `zach bryan` (8×). The 8 failing categories had all passed a single check on 2026-10-01 (7 of 8 with only 2–6 products), and the run used a 69 h old categories file (k6 accepts it up to `maxCategoryAgeHours` 168). Changes in `prep/extract-categories.mjs`: **(a)** confirm pass — after the first pass every category that passed is checked again (`--no-confirm` to skip), a flaky one is marked `unstable`; **(b)** `--min-items` default 1 → 7 (drops 93 of the 869 earlier valid ones; provisional); **(c)** `--max-age` default 24 → 12 h (= `maxDataAgeHours`); earlier passes with fewer products than `--min-items` are checked again. Not changed (raise with the team): `maxCategoryAgeHours` is still 168 in k6, and keywords are not validated by any script (`zach bryan` answers 500 — drop it from `keywords.json`). |
| 33 | **TWC keywords replaced (user request, 2026-10-02: "all keywords should be realistic").** The 108 generic fashion phrases from JMeter ("Fashion forward", "Handmade", …; one line was corrupted) are replaced by a curated list of realistic The White Company searches. Pacsun's 25 terms were already realistic and are unchanged. **Provisional:** not validated against the API and not weighted by real search volume. |
| 32 | **Hot Topic keywords replaced (user request, 2026-10-02).** The 9,890 random dictionary words from JMeter are gone: `Search by keyword` returned 500 for some of them (`ursae`, request `41e012fb2f1af86a19e4593f849eeea3`), which are not searches a shopper makes. `data/keywords.json` is now a curated list of realistic terms (bands, licences, apparel, gifts). **Provisional:** not validated against the API and not weighted by real search volume — settles the "keywords" open decision for Hot Topic only provisionally. |
| 31 | **Hot Topic: `PLP filter: price range` removed (user request, 2026-10-02).** The app's filter screen (License, Gender, Product Type, Band, Size, Color, Brand, Clearance, Customer Rating) has no price filter, so the call was never made by the real app. It came from the JMeter plan (`min_max_values.csv`) and returned 500 on many categories in the sanity run. **Deliberate difference from JMeter.** Also removed: the `priceRange` config value and the request's limit entry. Pacsun keeps its own price-range variant (not checked against the app). |
| 30 | **Sanity on `hottopic-perf` (run 3, 2026-10-01; `PROFILE=sanity`, `ABORT_DELAY=3m`, 869 validated categories) and a fix for the guest-token 411.** <br>• **Run 3:** completed the 5 min: 1,846 requests (browser 39, shopper 12, account 4 iterations). Failures: `Add voucher` 422 ×41 of 51 (`InvalidCouponCodeException` for `ACCESS13`: the code is invalid on perf now, or already used by that device; needs a valid code from the client or the step removed), `Guest token` 411 ×3, `Splash` request timeout ×2, `Search by keyword` 500 ×2 (random dictionary words, e.g. `lomilomi`). No PLP 500s: the validated categories removed the broken one. Many p95 limits (set from the 2025 live baseline) are breached at 1% load, e.g. Shop categories 1.4 s, Splash, PLP sorts, Product details: the limits are provisional. <br>• **411 root cause:** k6 sends a request whose body is the empty string chunked, with no `Content-Length`; the perf front end answers `411 Length Required` for it (3 of the 4 logged-in iterations lost their login, earlier attempts too). `Content-Length` set as a header has no effect. **Fix:** `lib/http.js` sends an empty body as no body (`Content-Length: 0`); the signature still covers the empty string. Mock: header seen, 40 of 40 signatures valid; TWC resolves. On `hottopic-perf`: 3 of 3 logged-in iterations passed (42 requests, 0 failures, checks 100%). <br>• **Open:** the voucher code; accounts beyond the first still unchecked on perf (`prep/validate-accounts.mjs`); latency limits; the Splash timeouts. |
| 29 | **`prep/validate-accounts.mjs` (user request, 2026-10-01) — verified against a local mock only; not run on any real environment.** Checks the login accounts of Hot Topic on the targeted client before a run (the lists were made for the live client): for each account a guest token and a bearer login, both signed with `poq-auth` (key from `secrets/hot_topic.secrets`), 2 requests per account, `--max-rpm` default 40 (about 50 min for 978 accounts). A prep script, not a k6 profile, so the `sanity` profile is untouched. Files in `clients/hot_topic/data/` (gitignored): `accounts_<env>.all.json` (the candidate list, copied from the existing file the first time), `accounts_<env>.checked.json` (result per account, for resuming; `--max-age` 24 h, `--fresh`) and `accounts_<env>.json` (what k6 reads: everything except accounts known to fail, so a partial check never shrinks the list to the checked ones). Credentials are never printed (masked address only). Mock result: 331 of 496 accepted (every third login rejected on purpose), all requests correctly signed. Only Hot Topic is implemented (TWC logs in through its storefront). |
| 28 | **`prep/extract-categories.mjs` (user request, 2026-10-01) — verified against a local mock only.** Node port of the Python `category_id_extractor` (Poq.Testing.Utilities): walks the `/shop` tree recursively, splits each category URL into a clean URL plus filter (pipes → semicolons), and writes `clients/<client>/data/categories_<env>.{json,csv}`. New: every leaf category is opened as a PLP with the plain call and each of the client's sort orders (`plpVariants`); a category that answers non-200 or returns no products (`--min-items`, default 1; it was 3 in the first version) is marked not usable and left out of `validIds` (motivation: `band-merch-shop-by-artist-morgan-wallen` returned 500 for every sort on `hottopic-perf`). Options: `--allow-prod`, `--base-only`, `--no-validate`, `--min-items`, `--max-rpm` (default 40), `--limit`. **k6 uses the file:** `lib/test-kit.js` `chooseCategories()` replaces the live `/shop` list with `validIds` when `categories_<env>.json` matches the environment and API path and is at most `maxCategoryAgeHours` (default 168) old; otherwise it falls back to the live list and adds a warning to the report. Checked on the mock: no file, good file, wrong path and old file. The default check is the plain list plus the first sort order (`--all-sorts` for every sort): the full tree on `hottopic-perf` has 1,130 leaf categories, about 6,800 requests with all sorts. The script resumes (per-category `checkedAt`, `--max-age` 24 h, `--fresh`). **Result on `hottopic-perf` (2026-10-01, resumed by the user, `--min-items` 1):** all 1,130 leaf categories checked: 869 usable, 243 empty, 18 answer 500 (including `band-merch-shop-by-artist-morgan-wallen`, the one that stopped the sanity run). Checked offline: `setup()` prints `869 validated categories (categories_prod.json, …)`. |
| 27 | **Sanity and login checks on `hottopic-perf` (user request, 2026-10-01).** <br>• **Account pick fixed:** `clients/hot_topic/test.js` takes the login account by iteration number (`iterationInTest % accounts`), not by VU id: global VU ids would have put the logged-in VUs past the end of the 978-account list in a mixed run. <br>• **Sanity (`PROFILE=sanity`, run 1):** stopped by the prod abort guard after about 1 min. 6 of 51 browser requests failed (11.8% > 10%): every `PLP` sort and the price filter for the random category `band-merch-shop-by-artist-morgan-wallen` answered 500 `InternalServerError`. The guard judges a tiny sample at `ABORT_DELAY=60s`; use a longer delay (3 min) for sanity or a minimum request count. The logged-in scenario had made no request yet (1 iteration/min). Browser/shopper latency breached several provisional limits (Splash 1.8 s p95, Shop categories 1 s). <br>• **Logged-in scenario alone (smoke, 1 iteration):** first attempt failed at `Guest token` with HTTP 411 "Length Required" (an HTML error page from the front end, not the API); the repeat passed: 42 requests, 0 failures, checks 100%, login, profile update and revert, address add, edit, delete, bag and logout. The 411 is intermittent (the same call worked earlier). Watch it; if it recurs, send an explicit `Content-Length: 0` on empty-body POSTs. <br>• **Open:** is the category 500 specific to that category on `hottopic-perf` (the other categories worked); the full sanity rerun; limits for the provisional endpoints. |
| 26 | **Hot Topic rehearsal plan and run settings (user request, 2026-10-01) — `k6 inspect` only, nothing run.** <br>• **Warm-up** now follows the scale shape when a client defines `load.shape`: the same stages, start offsets and fixed-count windows compressed to 15 min at 10% (peak about 87 req/s, about 50,000 requests, 5 registrations). Clients without a shape keep the flat 3 + 12 min profile. `lib/profiles.js` (`warmupShape`, `activeShape`) and `lib/test-kit.js` (fixed scenarios also for `warmup`). <br>• **Sequence proposed:** sanity (`PROFILE=sanity`, 5 min, 1%, about 1 day before; the registration checked separately with one smoke iteration) → warm-up (15 min) → scale (85 min), with commands, abort delays, data-freshness rules and VU sizing in `clients/hot_topic/README.md` ("Scale test: run settings"). <br>• **Client page:** the plan page for the client now lists the three runs, the endpoints covered and the scenarios (an artifact, shared inside the organisation by the owner; the client has not been given access by me). <br>• **Not agreed:** the rate approval and window, the load generator, valid accounts and the full product list on `hottopic-perf`. |
| 25 | **`scale` profile for Hot Topic (user request, 2026-10-01) — verified with `k6 inspect` only, never run.** <br>• `lib/profiles.js` adds `PROFILE=scale`, driven by the client's `load.shape` (minutes × factor of `targetRps`; optional `startAfter` per scenario and `fixed` iteration counts); `lib/test-kit.js` adds the fixed scenarios unless `SCENARIOS` is set; VU sizing uses the peak factor. Other profiles are unchanged. <br>• Hot Topic shape (provisional, retuned after the client brief "same scale as last year, ~3,000 users / ~2.5M requests per hour"; user decision: the hourly volume matters, concurrency may differ): 20 min ramp (10% → 80%), 60 min around 90% with three surges (125%, 115%, 125%), 5 min ramp-down: 85 min, about 2.9M requests, **2.5M in the busiest hour** (average 694 req/s), highest rate about 870 req/s, about 740 sessions in flight at the plateau and about 1,000 in a surge. Last year's JMeter run was three staggered groups (1,600 + 900 + 500 threads, starts at minutes 0, 10, 20) capped by a throughput timer at 41,667 req/min, 2.43M requests in total; concurrency can be raised toward 3,000 with longer think times if the client asks. Logged-in `account` users start at minute 15; `register` runs 50 times over minutes 20–75. <br>• Not agreed yet: the shape itself, the rate approval, and the load generator. |
| 24 | **Hot Topic `register` fixed with the team's Postman combination (user supplied the suite, 2026-10-01) — confirmed on `hottopic-perf` with curl (`prep/register-curl.sh`) and with k6 (`-e SCENARIOS=register`, smoke, 12 req/min, run by the user): 12 requests, 0 failed, checks 100%.** <br>• **Cause of the 403 / 400:** the Gen-3 `POST /account/register` captured from app 26.2.0 was refused with 403 on `hottopic-perf`; the Gen-2 call from Postman gets through. The 400 that followed was `Not acceptable email` for `example.com` (lookup and `epsilon/create` accept it; only register checks the domain). `byom.de`, the team's test-inbox domain, works. Signing, the user agent and the password policy were not the cause. <br>• **Journey change:** register is `POST /account/register/{appId}/{poqUserId}` with the Gen-2 body (`profile.encryptedPassword`, `allowDataSharing`, `isPromotion`, `birthDate` MM/DD/YYYY, `customData` only `{cardNumber, profileId}`), sent without `poq-auth` and without a bearer; the response carries `encryptedPassword` and `accountId` (no token). The default address is Gen-2 `POST /account/address/{appId}/{poqUserId}` with Basic auth (email + `encryptedPassword`). `registration.emailDomain` is `byom.de`. Previous version: `results/backup_pre_gen3_2026-10-01/hot_topic/endpoints.pre_postman_register.js`. <br>• **Also:** `lib/http.js` now logs the redacted body of 4xx/5xx responses on `sensitive` calls (success bodies stay omitted). <br>• **Latency (1 sample, provisional):** Register lookup 2.5 s, Register 3.3 s against the 1.5 s default limit, so both breach it; set real limits after a larger run. <br>• **Open:** whether perf's CRM is separate from the live one (each run creates a loyalty profile); `byom.de` receives real welcome mail. |
| 23 | **Product validator can resume (user request, 2026-10-01) — tested against a local mock only.** <br>• **Problem:** a stopped run lost its progress beyond the `.partial` file, which the next run ignored, so it started again from the first product. <br>• **Change (`prep/validate-products.mjs`):** every product gets `validatedAt` (rejections `checkedAt`). A new run reads the final file and its `.partial`, keeps entries younger than `--max-age` (default `maxDataAgeHours`, 12 h) that are still on the input list, and checks only the others; Ctrl+C saves the partial (exit 130); `--fresh` starts over. Files made for another environment or `apiPath` are ignored. The file records `apiPath` and `savedAt`, and its `generatedAt` is the age of its **oldest** product, so k6's freshness check stays honest. Rerunning with `--max-valid <n>` over a partial finishes without requests and writes the final file. <br>• **Legacy files** (no stamps, no `apiPath`, e.g. the 30 products copied by hand on 2026-10-01) are accepted, with the file's `generatedAt` as the stamp. <br>• **Tests (mock, staging data file restored afterwards):** fresh then resume with no duplicates; a no-op resume sent 0 requests; Ctrl+C then resume; a legacy file 1 h old kept and 20 h old re-checked; a file for another `apiPath` ignored. The validator's rules and requests are unchanged. |
| 22 | **Hot Topic moved to `hottopic-perf` and updated to the prod iOS app 26.2.0 (user decisions, 2026-10-01) — verified offline against a local mock only.** <br>• **Client path:** `apiPath` is now `hottopic-perf/v2` (same host and app id); `-e API_PATH=hottopic/v2` switches back. This settles the open "`hottopic` vs `hottopic-perf`" decision for now. The validators read the same config, so product lists and accounts need re-validating on `hottopic-perf` before a run. <br>• **Discovery (prod `hottopic`, app 26.2.0 iOS, Maestro + Charles, test account + one registration):** the app now uses the Gen-3-style flow on the same `/clients/hottopic/v2` path. Evidence is in `results/captures/hottopic_prod_ios/` (gitignored; unmasked). Of the 17 endpoints in the team's list, 12 were exercised and 5 never appeared: `refresh-token`, `cookies`, `migrate`, `GET addresses/{id}` and lookbooks. <br>• **New calls added:** `GET wishlist/item-ids` (v3), `POST account/login` (bearer), profile `GET`/`PUT`, addresses `GET`/`POST`(trailing slash)/`PUT`/`DELETE`, `POST address/validate`, and the registration chain `POST Account/register/lookup/{appId}` → `address/validate` → `POST epsilon/create` → `POST account/register`. `GET launch` is now part of the app start. <br>• **Updated calls:** app start is splash → launch → stories → wishlist ids → banners (`settings/config` is no longer called); banners send `slot-content-id=home&labels=online`; predictive search is `/search/predictive/v2`; account content sends `slot-content-id=account`; the splash and banners body checks follow the new shapes; two headers added (`poq-country-identifier`, `poq-slot-conditions` loggedIn false→true). <br>• **`poq-auth` on every request:** the app signs all calls. The scheme reproduced the captured value on 22 calls, but the whitespace is removed only *outside* JSON strings, so `lib/auth.js` `poqAuth` was corrected (`compactJson`); bodies without spaces in values give identical signatures to before. `lib/http.js` signs every request of a session that has `s.authKey` (only the Hot Topic member scenarios set it), so all other requests are unchanged. The salt is the configured secret; the `settings/config` `fragmentSuffix` lookup in `setup()` was dropped. <br>• **Scenarios:** `account` rebuilt (guest token → login → landing reads → profile edit and revert → address add, edit, delete → QAS and the shopping path → logout); the Gen-2 login, forgot-password, account-details and cart-wishlist calls were removed because the app does not make them (**forgot-password emails are gone**, closing that open decision). New opt-in scenario `register` (`-e SCENARIOS=register`, share 0 in the mix): it creates accounts that cannot be deleted. A CRM match in the lookup stops the iteration (counted under `correlation`), as the app refuses to continue. The previous Hot Topic files are in `results/backup_pre_gen3_2026-10-01/`. <br>• **Offline verification:** `k6 inspect` for Hot Topic (staging, prod) and TWC/Pacsun (unaffected); smoke of `account`, `register`, the partial-match stop, and `browser`/`shopper` against a local mock that checks every `poq-auth` with an independent Node implementation: all signatures valid. Measured 38 requests per `account` iteration and 12 per `register`; the guest scenarios send no signature and no bearer, as before. <br>• **Findings for the Hot Topic / app team:** one `register/lookup` call on the live client was answered 403 with a DataDome captcha page; the lookup reports `epsilonPartial: true` for some phone numbers and the app then blocks the sign-up although `epsilonExists` is false; a birth date making the user 12 was accepted; `account/content` is sent without a token first (401) and retried after the guest token. <br>• **Not verified (needs a `hottopic-perf` run, which has not been done):** whether the perf client serves the new endpoints and accepts the unsigned guest calls; whether the Gen-2 bag, stores and PLP calls work with a bearer token; whether the account list works on perf; the limits and traffic mix for the new calls (provisional). The perf client is reachable (`launch` 200, same response as live). |
| 21 | **Optional Grafana Cloud k6 output (user decision, 2026-10-01) — verified offline with `k6 inspect`.** <br>• Run with `k6 run --out cloud` (token from `K6_CLOUD_TOKEN`, never in git); requests still come from the local machine, so the rate caps hold. `k6 cloud run` is not used. <br>• `lib/test-kit.js` adds `options.tags` (`client`, `env`, `profile`) and `options.cloud.name` (`<client>_<env>_<profile>`); both are ignored without `--out cloud`. <br>• Local reports and the failure log are unchanged. README has a short section. <br>• Not done: a run against Grafana Cloud (needs a token). |
| 20 | **User decisions (2026-09-30), implemented.** <br>1. **One session type for iOS and Android.** The backend treats them the same. Pacsun no longer splits sessions or headers by platform (the `platforms` block and `-e PLATFORM` are removed). The app start makes the common calls once plus both platform-only calls: Android `settings/config` and the iOS splash. <br>2. **`poq-user-id` is one id per session.** It is generated at app start (`newSession`) and used for every step; a new session gets a new id. Pacsun keeps it after the guest token, where it previously switched to `externalUserId`. Dev smoke confirmed one id per session for all 28 / 37 requests; the web-view asset URLs carry it too. TWC and Hot Topic are unchanged for JMeter parity: TWC still switches to `externalUserId`, and Hot Topic keeps one id per VU. <br>3. **README is generic.** Client-specific content moved to `clients/<client>/README.md` for twc, hot_topic and pacsun; the root README links to them. `CLAUDE.md` and the capture skill follow the same rules. <br>• Pacsun requests per session are now 28 / 37 (browse / shopper); 0 failed, checks 100%. |
| 19 | **Project skill `app-traffic-capture` added (2026-09-30).** It lives at `.claude/skills/app-traffic-capture/` and bundles its own copy of `charles_capture.py`, plus `capture_step.sh`, `proxy.sh` and `summarize_capture.py`. It covers the Maestro + Charles discovery workflow for iOS and Android, and `CLAUDE.md` points to it. <br>• **Test:** an analysis-only run on the iOS app-open export, with and without the skill. Both answers were correct with no secrets leaked. The run with the skill also reported the credentials in the public splash config, using the bundled summariser. <br>• **Known deviation, not yet decided:** both apps keep their device UUID as `poq-user-id` (and as the stories `poqUserId`) after the guest token. k6 switches to the token's `externalUserId` in shared `account.guestToken()`. Keeping the device id would need a shared-code option, so it is left for the user. <br>• **Minor:** iOS sends no `Content-Type`, while k6 sends one for both apps. |
| 18 | **Pacsun: remaining guest screens captured (Android, 2026-09-30).** <br>• **Move to Wishlist:** `POST /wishlist/items` then `POST /cart` with `deleted: true`. There is no new endpoint; the shopper journey now uses this button flow. <br>• **Clear All:** `DELETE /wishlist` (v3, 204), then the app re-reads the wishlist. Sessions empty the wishlist with either the single delete or Clear All, 50/50, so both get load. <br>• **Store finder ZIP search:** `GET /stores?q=<zip>&lng&lat`. It uses a provisional list of US ZIPs (`storeSearchZips`). <br>• **Price filter:** `/search?…&minPrice=&maxPrice=`, a new PLP variant with 20–100. <br>• **Account-tab info pages** (Shipping Options, Returns, Order Locator, About Us, Terms): these are web views of Pacsun's storefront (`www.pacsun.com` / `dev.pacsun.com`) with about 45 third-party trackers. The only Poq calls are `GET /assets/web/css/523/<poqUserId>` and `/assets/web/js/523/<poqUserId>`, plain web-view requests with placeholder bodies. k6 sends only those two; the storefront is not Poq's and is not load-tested. <br>• **Requests per session:** Android 26 / 36, iOS 25 / 35. Dev smoke per app: 0 failed, checks 100%. <br>• **Still not covered:** sign-in and the logged-in journey (needs dev accounts), promo code, checkout (dev 403), Dynamic Yield (dev 404), and the iOS journey after app start. |
| 17 | **Pacsun: common requests once per session (user decision, 2026-09-30).** The apps re-read some calls: Android reads `/shop` at start and again on the Shop tab, and `/wishlist` at start and after an add; iOS reads `/cart` at start and on the bag screen. k6 now sends each of `shop`, `wishlist` and `cart` once per session, and takes the bag line id from the add-to-bag response (`cartItems`). Requests per session: Android 25 / 32, iOS 24 / 31 (browse / shopper). Dev smoke per app: 0 failed, checks 100%. The setup reads of guest token and `/shop` categories are once per test and not counted. |
| 16 | **Pacsun: iOS app start added (2026-09-30).** The user shared an iOS dev app capture (9.0.0, app open). Each session is now one app, iOS or Android: config `platforms` holds each app's headers, `appVersion` and endpoint tweaks, and the session picks one (provisional 50/50; `-e PLATFORM=ios\|android` forces one). Only the app start differs; the rest of the journey was captured on Android and is shared. <br>• **iOS start:** splash `/splash/ios/523/3` (it carries the settings, so there is no `settings/config` call) and wishlist item ids go out before the guest token; then launch (`appVersion=9.0.0`), get bag, banners, and stories with `poqUserId` + `ids`. There is no shop, account content or wishlist at start. <br>• **iOS headers:** `platform: iphone`, `user-agent: PoqApp/9.0.0 Pacsun`, `version-code: 1.0`, `Accept-Language: en-US` (the device sent its own locale, `tr-TR`). <br>• **Dev smoke per app:** iOS 24 / 32 requests, Android 26 / 34; both **0 failed, checks 100%**. The only breaches are the provisional latency limits on dev (e.g. search p95 9.3 s). <br>• **Dynamic Yield still left out:** `dynamicyield/identifiers` returns 404 on dev for both apps. iOS sent it 4 times in 3 s at app open, with and without a token. TWC's DY call expects 200 with `userId`/`sessionId`; Pacsun has no DY data on dev to correlate. <br>• **Findings:** the iOS app sends `GET /cart` before it has a token (401, then a retry). The public splash/settings config holds a `passWord` / `userName` pair and other clients' URLs (House of Fraser, Belk); raise with the platform team. <br>• **Validator** keeps the Android identity (`validatorHeaders`). |
| 15 | **New client: Pacsun (`clients/pacsun/`), discovered from the app (2026-09-30).** There is no JMeter suite, so the reference is the Android dev app (`com.july.pacsun.dev`, app version 87) driven with Maestro MCP on the emulator. Its traffic was captured through Charles and filtered with `jira-qa-companion/scripts/charles_capture.py`. <br>• **Gen-3 API** on `dev.poq.io`, `/clients/pacsun/…`, app id 523. It uses a guest token. The app also sends `poq-auth`, but dev doesn't enforce it on guest calls: a PDP and an add-to-bag both returned 200 without it. Only `dev` is configured; the staging and prod app ids are unknown. <br>• **Scenarios:** `guestBrowse` (read-only) and `guestShopper`. **Checkout is left out for now (user decision, 2026-09-30):** on dev, `POST /checkout/start` returns 403 because Poq's call to Pacsun's dev storefront (`dev.pacsun.com …/dw/shop/v25_6/sessions`) is refused, so no checkout URL comes back. An app relaunch also showed `POST /account/refresh-token`. <br>• **Differences from the platform:** <br>&nbsp;&nbsp;– Declared as `config.js` tweaks: predictive search is `/search/predictive/v2`; `slot-content-id` is added to shop, banners (`home` + `labels=online`), search and account content; app stories take `ids` from the banners' `storyIds` instead of `poqUserId`. <br>&nbsp;&nbsp;– In `endpoints.js`: the add-to-bag body is `{variantId, quantity, shipmentType}`; bag update and delete use `POST /cart` with `items[]`; wishlist add and delete take `[{productId, listingId}]`; also wishlist item ids, PLP and search next page (`skip=16`), home carousels (banners with `contentType: productCarousel`), predictive product suggestions, and stores via `GET /stores` (v2) with no detail call. <br>• **Shared-code changes, with identical requests for TWC and Hot Topic:** `app.banners` and `catalog.predictiveSearch` now return their JSON; `app.appStories` takes an optional `ids`; `account.accountContent` was split out of `accountPages`. <br>• **Validator:** new `addToCart: 'direct'` body and `success: 'inCart'` rule, because Pacsun returns `customData: {}` with no `quantityAdded`. The input `input/products_dev.txt` holds 1,045 ids crawled from the 33 dev category PLPs (3 pages each). <br>• **`.gitignore`** still listed `brands/*/data/accounts*.json`; it now lists `clients/*/data/accounts*.json`. <br>• **Provisional placeholders, for team decision:** mix 70/30, load target 50 req/s, p95 1,500 ms, keywords (25 generic terms), think time, `maxDataAgeHours`. <br>• **App findings (raise with the app team):** <br>&nbsp;&nbsp;– `dynamicyield/identifiers` is polled about 80 times in 10 minutes and always returns 404. It is left out of the journeys. <br>&nbsp;&nbsp;– The `products`, `predictive` and `stores` calls are sent without the bearer token first; they get a 401, then are retried with it. <br>&nbsp;&nbsp;– Picking "Top Rated" sends `sort=price-high`. <br>&nbsp;&nbsp;– Dev `/search?categories=mens-pants&skip=32` returned 424. <br>• **Dev validation and smoke, 2026-09-30:** <br>&nbsp;&nbsp;– Validator: sanity subset `--max-valid 60`. 64 checked, 60 valid, 4 low stock; 131 requests at 40/min. <br>&nbsp;&nbsp;– Smoke: 1 iteration per scenario. `guestBrowse` 26 requests, `guestShopper` 34. **0 failed, checks 100%**; cleanup (bag line and wishlist) succeeded. <br>&nbsp;&nbsp;– 9 provisional p95 limits were breached at n = 2 on dev: keyword search about 10 s and its next page about 13 s, predictive product suggestions 9.5 s, PLP sort price low-high 6.6 s and top rated 5.0 s, recently viewed 1.9 s, home carousel 1.6 s. Dev latency; not meaningful for limits. |
| 14 | **Prod guards moved from script load to the start of `setup()`** (`assertRunAllowed` in `lib/config.js`, called first by `test-kit.baseSetup()`). `k6 inspect` now works for prod without flags. A run against prod without `ALLOW_PROD=true`, or with `ALLOW_STALE_DATA` on prod, stops with a one-line `test aborted: …` (exit code 108). Verified against a counting mock: 0 requests sent by the blocked runs (TWC and Hot Topic). npm scripts that wrapped k6 were removed; k6 is always run with the `k6` command. |
| 13 | **Prod abort is configurable.** Default: abort when the failure rate goes above **10%, evaluated from 60 s** into the run. This replaces the hard-coded 15 s from rev 4 and matches the README. <br>• **Order of precedence:** `-e ABORT_FAILED_RATE` / `-e ABORT_DELAY` → client `limits.prodAbortFailedRate` / `prodAbortDelay` → defaults. <br>• **Validation:** a rate must be a fraction in (0, 1]; a delay must be a k6 duration. <br>• **Scope:** prod only, as before. |
| 12 | **Structure revision (user decision, 2026-09-29) — implemented and verified.** A before/after capture of every offline request (names, methods, paths, query keys, headers, body structure) was **identical** for all TWC and Hot Topic journeys and setup; the gift-box path had identical request shapes. The validators and `run.mjs` were re-checked against their mocks. Data files now carry `"client"` instead of `"brand"`. <br> "brand" is renamed to **client**, and standard Poq endpoints are shared, without duplication. <br>• **Folders:** `brands/` → `clients/`. `lib/poq-client.js` → `lib/http.js`, so "client" means only the customer. The config key `clientPath` → `apiPath`, and env `CLIENT_PATH` → `API_PATH`. <br>• **`lib/platform/`** holds the standard Poq API endpoints (Gen-3 contract), one file per area: `app`, `catalog`, `product`, `cart`, `wishlist`, `stores`, `checkout`, `account`. One file per endpoint was rejected as too fragmented. <br>• **Small per-client differences** (extra query params, a path variant, extra checks) are declared in the client's `config.js` under `endpoints: { <key>: {...} }` and merged by the shared function, with no client `if`s in shared code. <br>• **Structural differences and client-only integrations** live in `clients/<client>/endpoints.js`. TWC: Dynamic Yield, storefront PKCE login, gift box. Hot Topic: the Gen-2 bag, wishlist and stores calls, signed login, QAS. <br>• **Journeys** stay plain code per client. `lib/test-kit.js` shares the `test.js` plumbing (data loading, options, base setup, summary). <br>• **Explicitly not built:** a journey DSL, plugin registry, class hierarchy, per-endpoint files or API-generation adapters. <br>• **Proof:** the offline requests sent (method, path, query keys, headers, body structure) must be identical before and after. |
| 11 | **First real Hot Topic runs, on prod `hottopic` client (2026-09-29, user-approved).** <br>• **Validator, sanity subset:** 389 checked, 60 valid; rejected 284 out of stock, 40 PDP HTTP 500 (product-specific platform errors, IDs in the file's `rejected` list) and 5 low stock. 449 requests, capped at 40/min. Only about 15% of the listed catalogue is purchasable. <br>• **Paced sanity, `browser` + `shopper`** (account scenario left out on purpose: forgot-password emails), 30 req/min for 5 min: 167 requests, busiest 60 s = 32. <br>&nbsp;&nbsp;– Every endpoint worked, including live `/shop` categories (1,259) and bag add/update/remove. <br>&nbsp;&nbsp;– Only failures: `Add voucher` 422 ×2, `InvalidCouponCodeException` on the second iteration of the same device. The voucher is never removed, so a persistent device can't re-apply it. Needs a decision: remove the voucher, apply once per device, or drop it. <br>&nbsp;&nbsp;– Latency breached 22 baseline limits (e.g. PLP sorts p95 1.4–3.1 s, splash 1.2 s, shop 1.2 s). The 2025 baseline ran on the isolated `hottopic-perf` client, so the limits may not transfer to the real `hottopic` client. Samples are tiny (n = 3–6). <br>&nbsp;&nbsp;– The req/iter figure (41.5) is inflated by the requests of iterations still running when the time ran out. |
| 10 | **Phase 5 (Hot Topic) built; verified offline only.** Reference: working-tree `hot_topic/hot_topic.jmx` (2026-09-28, including the user's uncommitted edits). <br>• **Shared-layer changes:** static app headers now live in brand config (`headers`, `validatorHeaders`) instead of being built from the locale; TWC's headers were checked unchanged. There is also a `CLIENT_PATH` override (e.g. `hottopic-perf/v2`) and a persistent device id option for `newSession`. <br>• **Validators are brand-driven:** `validator.session` is `guestToken` or `device`; `addToCart` is `full` or `minimal`; `success` is `quantityAdded` or `status200`. They use per-env input lists (`input/products_<env>.txt`). <br>• **`poq-auth`:** `lib/auth.js` derives the PBKDF2 key once in `setup()` and signs each call with HMAC-SHA256; the output matches a standard reference computation. Secrets are in gitignored `secrets/hot_topic.secrets`. The salt comes from settings `fragmentSuffix`, with the secret as the fallback. <br>• **Scenarios** `browser` / `shopper` / `account` = the JMeter groups. The mix is 70/21/9, taken from 2025 iteration counts. The load target is 694 req/s, with 30 min ramp and 30 min hold. Latency limits are 1.5 × the 2025 p95, with a 500 ms floor. <br>• **Deliberate differences from JMeter:** <br>&nbsp;&nbsp;– `browser` removes its bag line at the end (+1 request); the device is persistent, so the cart would otherwise grow. <br>&nbsp;&nbsp;– Bag lines are matched by SKU; JMeter used `cartItems[0]`. <br>&nbsp;&nbsp;– Wishlist single-delete uses the product id; JMeter sent an undefined `${clientId}`. <br>&nbsp;&nbsp;– Update-bag has a real cart item id; JMeter's `${cart_item_id}` was never set, which caused 100% 424s. <br>&nbsp;&nbsp;– Store coordinates come from a US bounding box, not random global points. <br>&nbsp;&nbsp;– Categories are fetched live from `/shop`, not the CSV. <br>• **Kept for parity, flagged for decision:** forgot-password (sends reset emails to test accounts every account session); voucher added and never removed; random-dictionary keywords (9,890); JMeter `browser` calls reviews only, not the PDP. |
| 9 | **Phase 4 side-by-side for TWC, on prod, both tools at 36 req/min, one after the other (2026-09-28).** <br>• **Parity:** identical endpoint coverage (62 endpoints, none unique to either tool); 43.6 vs 45.2 requests per session. <br>• **Failures:** JMeter 4, all its stale `Global Banners` 200 assertion (prod returns 204); k6 0. <br>• **Latency:** comparable at this sample size. `Recently viewed products` is slow in both (JMeter p95 4.3 s), so it's a platform finding. <br>• **Known JMeter script bug:** the login-retry `While` condition parses an unset counter (Groovy `NumberFormatException`). <br>• **Busiest 60 s windows:** JMeter 39, k6 38. <br>• **New `paced` profile:** 1 VU per scenario for `DURATION`, capped by `MAX_RPM_PER_VU`. <br>• **Plain `k6 run` is the primary way to run:** reports are written to `results/` without the wrapper (`results/.gitkeep`); `run.mjs` is optional. <br>• **Plan doc location:** this file is now at `.claude/k6-migration-plan.md` (moved by the user from `.claude/docs/`). |
| 8 | **Node validators compared with Python on TWC prod; Python retired for TWC data prep.** The run was capped at 40 req/min. <br>• **Products:** the same 60 IDs → 60/60 valid, with every field identical. <br>• **Gift bundles:** 17/21 ok, the same bundles as Python's 2026-09-21 run and the same 4 rejected. Only 2 chosen sizes differed, because the highest-stock size has changed since then. <br>• `prep/import-python-products.mjs` removed. |
| 7 | **Phase 3 (Node validators) built; verified offline only.** <br>• **`prep/validate-products.mjs` and `prep/validate-gift-bundles.mjs`** are ports of the Python validators with the same rules. <br>&nbsp;&nbsp;– Products: default variant first, stock ≥ 5, add-to-cart proof, a new guest cart every 10 products, 2–5 s pause. <br>&nbsp;&nbsp;– Bundles: `ctaStatus` resolution, highest stock first, size fallback on stock rejection, a guest cart per bundle, bulk add recorded only. <br>&nbsp;&nbsp;– They write the k6 JSON directly, including rejection reasons, which Python didn't record. <br>• **Shared helper `prep/lib/poq-api.mjs`** reads the same brand config as k6, handles `--allow-prod`, and offers a `--max-rpm` cap and atomic `.partial` writes. <br>• **Input lists** are in `brands/<brand>/input/*.txt`: TWC has 2,354 products and 21 bundles, taken from Utilities `new_gen/input`. <br>• **Deferred:** `prep/create-accounts.mjs`. Existing accounts cover TWC (staging 337, dev 326, prod 20); build it when a brand needs new accounts. <br>• Categories are already fetched in `setup()` (Phase 1). Keywords are still an open decision. |
| 6 | **First real Phase 2 run: TWC prod smoke, paced under the 60 req/min cap the user set (2026-09-28).** <br>• **Pacing:** new `--max-rpm` flag (`MAX_RPM_PER_VU`). Each VU waits between requests; a smoke run uses 1 VU per scenario. <br>• **Gift-bundle data is only freshness-checked when the gift box can run.** This run used `GIFT_BOX_SHARE=0`, because the prod gift data is stale and re-validating it would exceed the rate cap. |
| 5 | **Phase 2 (TWC full journeys) built; verified offline only.** Decisions made while building: <br>• **Accounts are mapped per VU (VU n → account n).** k6 assigns VU ids to scenarios unpredictably and has no shared state, so a checkout pool can't be exclusive. A VU without an account runs the guest journey and is counted in `failures.csv`. Consequence: prod (20 accounts) only supports small logged-in concurrency. <br>• **One logged-in session = one iteration**, ending with logout, the same as the JMeter single pass per thread. <br>• **Gift box on 3% of logged-in sessions**, set in config (`GIFT_BOX_SHARE`). The bag is emptied afterwards. The wishlist is emptied at the end of every logged-in session, because accounts persist. <br>• **Non-prod storefront origin comes from the API's authorization URL.** Login refuses to send credentials if a non-prod run is pointed at the prod storefront. <br>• **Logged-in sessions send `poq-slot-conditions: loggedIn=true`.** JMeter sent the singular `poq-slot-condition`, which looks like a typo. <br>• **The checkout URL is opened like a webview:** user agent plus the checkout `Authorization` header only, with no Poq headers. JMeter sent all Poq headers. <br>• **Gift-box bulk add checks status only** (known no-op). **Add to bag also checks `quantityAdded > 0`**, the same success rule as the validator. <br>• **Failed logins fail the `checks` threshold** (one "logged in" check per session). <br>• **Scenario selection:** `-e SCENARIOS` / `--scenarios`, with shares renormalised. `guestBrowse` (read-only) sits outside the default mix. <br>• **`prep/import-python-products.mjs --gift-bundles`** imports gift-bundle validator output. |
| 4 | **First real run: TWC prod.** <br>• **Sanity runs may use a validated subset.** The user confirmed that for sanity only, validating a small subset (e.g. the first 60 products that pass) is acceptable. Full validation remains the rule for load and performance runs. Subset files carry a `scope` note, which is printed in the run report. <br>• **Temporary import bridge.** `prep/import-python-products.mjs` converts Python validator output into the k6 JSON until Phase 3. <br>• **New `custom` profile** (`--rps`, `--duration`, `--ramp`) for ad-hoc absolute rates. <br>• **Faster prod abort.** Evaluation delay is now 15 s instead of 60 s, so short runs are protected. <br>• **`Global banners` accepts 200 or 204.** 204 means no banners are configured. |
| 3 | **Phase 1 implementation started** (see "Implementation status" below). Decisions made while building: <br>• **`run.mjs` launcher** added at the root. It creates the run folder and runs k6 with the standard outputs. <br>• **`failures.log`** uses k6 `--log-format raw`, so each failure is one clean JSON line. <br>• **`failures.csv`** counts a fixed list of statuses per request, plus `other`, `check` and `correlation`. <br>• **TWC guest identity is per iteration.** Each iteration is one arriving app session with its own guest token and `externalUserId`, the same as the JMeter guest group. §5.3's "per VU" wording applies to logged-in users. <br>• **Missing Dynamic Yield IDs** are logged, but the journey continues, because no later path or body needs them. <br>• **No store near the random point** skips the store-detail call. It is not counted as a failure. <br>• **Guest-token calls use the selected environment's host.** JMeter hard-coded the prod host even for staging runs. |
| 2 | **Product validation:** every product in the list is fully validated before each run, keeping the current rules. The `setup()` spot-check proposed in rev 1 was removed (§10, §11). **Failure logging:** added logging for every request that doesn't return the expected result, plus a failing-product report (§14.2). |
| 1 | Initial plan. |

### Where we are (2026-09-29)

#### Done

| Area | What exists and how it was verified |
|---|---|
| **Project skeleton** (Phase 1) | `lib/` (config, request wrapper with failure logging and endpoint tweaks, `platform/` shared endpoints, test kit, auth, data, profiles, reports), `clients/<client>/`, `prep/` (rev 12 structure). <br>• **Runs with plain `k6 run -e …`**; `run.mjs` is optional. <br>• **Profiles:** smoke, sanity, warmup, load, custom and paced. <br>• **Safety:** prod guard (`ALLOW_PROD`), stale-data guard, 15 s abort on prod at > 10% errors, and a per-VU rate cap (`MAX_RPM_PER_VU`). <br>• **Reports:** `summary.json`, `endpoints.csv`, `failures.csv`, a JSON-lines failure log with redaction, and the HTML dashboard. |
| **TWC** (Phases 1–4) | **Scenarios:** `guestBrowse` (read-only), `guestShopper` and `loggedInShopper`. The logged-in one uses storefront OAuth PKCE login, with one account per VU. <br>• **Prod runs:** smoke per scenario; 60 req/s read-only for 1 min with 0 failures. <br>• **JMeter vs k6 on prod** at 36 req/min: identical endpoint coverage, requests per session within 4%, k6 0 failures. JMeter's 4 failures were its own stale assertion. |
| **Data prep** (Phase 3) | **Node validators** `prep/validate-products.mjs` and `prep/validate-gift-bundles.mjs`: brand-driven rules, rejection reasons recorded, `--max-valid`, `--max-rpm`, atomic writes. <br>• **Checked against Python on TWC prod: identical results.** Python is retired for TWC. <br>• Categories are fetched live in `setup()`. |
| **Pacsun** (new, rev 15) | **Discovered from the Android dev app** (Maestro + Charles). <br>• **Scenarios:** `guestBrowse` and `guestShopper`, on dev only. <br>• **Verified on dev:** 60 products validated (sanity subset); smoke with 0 failures. <br>• **Not built:** checkout and logged-in journeys. |
| **Hot Topic** (Phase 5, partly) | **Scenarios:** `browser`, `shopper` and `account`. `account` does `poq-auth` signed login and Basic auth. <br>• **Setup:** limits come from the 2025 baseline; the mix is 70/21/9. <br>• **Offline:** all three journeys passed against a mock that verifies signatures. <br>• **Prod:** 60 products validated; paced sanity of `browser` + `shopper` at 30 req/min, where every endpoint worked except `Add voucher` (see Left). |

#### Current test data

| File | Content | Usable until |
|---|---|---|
| `clients/hot_topic/data/products_prod.json` | 60 valid (sanity subset, 389 checked) | 2026-09-29 22:49 UTC |
| `clients/twc/data/products_prod.json` | 60 valid (sanity subset) | expired; re-validate before the next run |
| `clients/twc/data/gift_bundles_prod.json` | 17 bundles | expired |
| `clients/pacsun/data/products_dev.json` | 60 valid (sanity subset, 64 checked) | 2026-09-30 about 24:20 UTC |
| `*/products_staging.json` | converted legacy lists (TWC 2024-02, HT 2024-08) | stale; staging runs need `ALLOW_STALE_DATA` or a fresh validation |
| `*/accounts_*.json` (gitignored) | TWC prod 20 / staging 337 / dev 326; HT prod 978 / staging 496 | — |
| `secrets/hot_topic.secrets` (gitignored) | `poq-auth` key and salt | — |

#### Left

**Decisions for the team (Phase 0, still open).** Everything runs on provisional defaults:
1. Brands in scope beyond TWC and Hot Topic.
2. Prod vs isolated clients. Hot Topic: real `hottopic` or `hottopic-perf`.
3. SLOs and latency limits. The Hot Topic limits came from the 2025 run on `hottopic-perf` and 22 of them were breached on `hottopic`.
4. Think time (1–3 s today) and the traffic mix (TWC 95/5 is provisional; Hot Topic 70/21/9 comes from 2025).
5. `maxDataAgeHours` (12).
6. Whether the validator should clear guest carts after its add-to-cart proof.
7. Registration journeys (none built).
8. Keywords: TWC's 108 generic terms and Hot Topic's 9,890 random words produce mostly empty searches.
9. Whether smoke runs should skip latency limits (n = 1 makes them noise).
10. Separate, looser limits for TWC storefront pages.
11. Hot Topic `forgot-password`: it emails every test account on every account session.
12. Hot Topic voucher handling (next section).
13. Where results are archived; CI or scheduled runs.

**Hot Topic, to finish Phase 5:**
- **Voucher:** fix `Add voucher`. The second apply on the same device gets `InvalidCouponCodeException`, because the voucher is never removed. Options: remove it after applying, apply it once per device, or drop the step.
- **Account scenario:** run it once on prod, paced. It sends one forgot-password email. This confirms signed login, `fragmentSuffix` salt, account details and cart wishlist against the real API.
- **Same sanity on `hottopic-perf`:** validate its products first, then run, to find out whether the latency gap comes from the client.
- **Phase 4 gate:** JMeter vs k6 side by side, as done for TWC.
- **Full validation** of all 2,253 products (about 2 h; about 15% purchasable) before any load or performance run.
- **Commit the reference:** commit or pin the working-tree `hot_topic/` JMeter changes the k6 port was built from.

**TWC, open items:**
- Gift box not yet run on a real environment (prod gift data needs re-validating).
- Full product validation (about 2.3 h) before a load run.
- Optional: a larger-sample JMeter comparison before team sign-off.
- Unknown: whether `/account/v2/login` returns the user's `externalUserId`; where the staging storefront lives.

**Later phases:**
- **Phase 6:** Office/Offspring, Elf, Hobbycraft, one at a time through the same parity gate.
- **Phase 7:** archive both legacy repos read-only with their baseline reports; rotate the legacy secrets committed in JMX/CSV files; remove the dead submodule links.
- **Deferred:** `prep/create-accounts.mjs` (existing accounts are enough for now).

**Platform findings to raise** (from these runs, not test problems):
- TWC `Recently viewed products` (`GET /products?ids=<10 ids>`) is slow in both JMeter and k6: p95 about 4 s.
- Hot Topic: 40 of 389 checked products return HTTP 500 on the PDP (IDs in `products_prod.json` → `rejected`). Only about 15% of the listed catalogue is purchasable.
- Hot Topic on the real `hottopic` client: PLP sort/filter p95 1.4–3.1 s, search 2.1 s, splash and shop 1.2 s. Low sample count, but well above the 2025 `hottopic-perf` baseline.

### Implementation status by phase

| Phase | Status |
|---|---|
| 0 — Decisions | **Open** (list above). Implementation proceeds on the proposed defaults, each marked in the brand config. |
| 1 — Skeleton + TWC smoke | **Built; first real runs on TWC prod, 2026-09-28.** <br>• **Data:** 60-product sanity subset, freshly validated with the Python validator (60 checked, 60 passed). <br>• **Smoke:** 1 iteration, all body checks passed against real responses. <br>• **Custom run, 60 req/s for 1 min:** 120 iterations, 3,929 requests, **0 failures**, checks 100%, 32.7 req/iter, at most 57 VUs, no dropped iterations. The only breach is `Recently viewed products` (`GET /products?ids=<10 ids>`): p95 4.5 s, p99 11.4 s, max 12.9 s; all other endpoints are p95 ≤ 822 ms. <br>• **Failure-log headers:** the allowlist captures `Poq-Request-Id`. <br>• **Earlier offline verification** against a local mock: prod guard, stale-data guard, per-endpoint thresholds, failure logging and redaction, reports, exit codes. Journey: guest `guestBrowse` (guest token → open app → content data → shop → search → PLP + 5 sort/filter → PDP), read-only. Data: TWC product files converted once from the Python validator output (prod 2026-09-21, staging 2024-02-14). |
| 2 — TWC full parity | **Built; verified offline only** against a local mock that enforces the storefront OAuth rules. <br>• **Scenarios:** `guestBrowse`, `guestShopper` (95%) and `loggedInShopper` (5%), all three passing. <br>• **Login:** PKCE login worked. Retries stop at 3, and the prod-storefront guard held. <br>• **Log hygiene:** no credentials in the logs. <br>• **Mixed run:** 20 req/s for 1 min with correct shares and no bag cross-talk. <br>• **Prod smoke, 2026-09-28:** three sequential 1-iteration runs, capped at 25 req/min each. <br>&nbsp;&nbsp;– `guestBrowse`: 32 requests. `guestShopper`: 50. `loggedInShopper`: 47, account #1, with a real PKCE login. <br>&nbsp;&nbsp;– **0 failed requests, 100% checks. Cleanup (delete bag line, wishlist, logout) succeeded.** <br>&nbsp;&nbsp;– Busiest 60 s window: 27 requests. <br>&nbsp;&nbsp;– Single-sample p95 breaches (not meaningful at n=1): recently viewed 2.0 s, DY PDP recs 2.1 s, Apple Pay address 2.2 s, checkout URL 1.6 s and storefront authorize 2.3 s. The last two are TWC storefront pages, not Poq endpoints. <br>&nbsp;&nbsp;– Gift box not yet exercised on a real environment. <br>• Prod runs happen only on explicit request. Open: whether `/account/v2/login` returns `externalUserId`; the staging storefront location. |
| 3 — Data-prep consolidation | **Validators built; verified offline** against a mock covering every rejection path. <br>• **Products:** 404/empty → `notFound`, `outOfStock`, `lowStock`, `addToCartFailed`; a default variant rejected with 412 falls back to the next variant; duplicates removed. <br>• **Options:** `--max-valid` subset; `--max-rpm` pacing. <br>• **Bundles:** one-size and sized entries, `ctaStatus` filter, size fallback, `not_found`, `not_a_bundle`. <br>• **Headers:** same as Python. <br>• **Compared with Python on TWC prod, 2026-09-28: identical results** (see rev 8). **Python retired for TWC.** <br>• **Current prod data:** `products_prod.json` holds 60 products (the comparison input) and `gift_bundles_prod.json` holds 17 bundles, both validated 2026-09-28 around 16:40 UTC. |
| 4 — Side-by-side validation | **TWC done at low load on prod** (rev 9). Same endpoints, requests per session within 4%, the only JMeter failures are its stale assertion, and comparable latency. Still to decide: whether a larger-sample comparison (staging, or prod with a higher cap) is wanted before team sign-off. |
| 5 — Hot Topic | **Built; prod sanity run (browser + shopper) done** (revs 10–11). Left: voucher fix, account scenario on prod, `hottopic-perf` comparison, JMeter side-by-side, full validation. |
| 6 — Other brands | Not started. |
| 7 — Decommission | Not started. |

> **Note.** The Hot Topic port was built from the working-tree `hot_topic/hot_topic.jmx` as it was on 2026-09-28, which includes uncommitted edits. Commit or pin that version so the parity reference can't drift.

---

## 1. Current-state assessment

### The real test estate is on branches

`origin/dev` is the integration branch (`origin/HEAD`). Its last change was in January 2023, and it holds 13 suites written between 2020 and 2023. The suites that were actually used recently were never merged into it:

| Branch (LoadTest) | Last commit | Suite |
|---|---|---|
| `twc` | 2026-09-22 | The White Company: `twc/twc.jmx`, 4,991 lines |
| `serhat_hottopic_temp` (checked out) | 2025-09-24, plus uncommitted edits today | Hot Topic: `hot_topic/hot_topic.jmx` |
| `office` | 2025-10-22 | Office and Offspring |
| `elf` | 2025-04-22 | e.l.f. US |
| `hobbycraft` | 2024-09-17 | Hobbycraft |
| others | 2023–2024 | Hotel Chocolat, WHBM, Yours Clothing, Ardene (2023), Sosandar, Eco Modern, AKS internal APIs |

### Three generations of the Poq API are in use

| Generation | Style | Suites |
|---|---|---|
| **Gen 1** (legacy v1) | `/products/filter/{appId}`, `/BagItems/{app}/{user}`, `/CartTransfer`, `/wishlist/{app}/{user}` | Radley, Missguided, `aus_region`/`us_region`, part of platform |
| **Gen 2** | `/search`, `/cart`, `/checkout/start`, wishlist v2, `/account/login/{appId}/{user}` with Basic `email:encryptedPassword` | Snipes, Cotton On, Orsay, Ardene (2020), M&Co, DemoApp, Hot Topic (`/clients/hottopic/v2/…`) |
| **Gen 3** (current) | `/clients/{c}/…`, guest-token Bearer, `/account/login` or OAuth2 PKCE, wishlist v3, `slot-content-id` | TWC, Office, Elf, Hobbycraft |

### Other key facts

- **Utilities.** Only the Utilities `twc` branch has the unified `new_gen/` tool. Its outputs match TWC's load-test CSVs byte for byte (md5). Every other brand's data was produced by older copy-paste scripts, each on its own branch.
- **Baselines available:**
  - Hot Topic prod, 2025-09-24: 2.43M samples, about 674 req/s, 0.03% errors, 46 labelled endpoints. Source: `hot_topic/report_prod_2025-09-24-11-32-26/statistics.json`.
  - TWC prod sanity check, 2026-09-21: 932 samples, 0% errors. Source: git history `4263237:twc/report_prod_2026-09-21-21-46-37.jtl`.
  - Elf warmup, 2025-04-17: about 60 req/s, 0.5% errors.
  - Hobbycraft, 2023-07-06: about 125 req/s, p95 4.4 s.
- **The existing k6 folder is a placeholder.** `src/tests/*.test.js` call `/health` on hosts that don't exist (`config/environments.js`). It should be replaced, not extended.

---

## 2. JMeter project assessment

### Shared skeleton (every suite)

- `com.tag.jmeter.ext.config.PropertyReader` loads two files:
  - `<module>.properties`: thread counts.
  - `<env>.properties`: host, appId, appIdentifier, versionCode, user agent.
- One Test Fragment holds the journeys, and `ModuleController`s pull them into thread groups.
- `kg.apc` ParameterizedControllers inject per-group variables.
- There are 2–3 standard ThreadGroups: "Concurrent", "Ramp Up", and "Account"/"Logged-in".
- `run-tests.sh <module> <env>` runs `jmeter -n -t <plan>.jmx -Jenvironment -Jmodule -l report_<env>_<ts>.jtl -e -o report_<env>_<ts>`.

### Traffic model

There are no Throughput, Random or Switch controllers and no Transaction Controllers in any suite. Every thread runs its whole journey in a fixed order on every iteration, so the mix comes only from how many threads each group has. Pacing differs by suite:

| Pacing | Where |
|---|---|
| Flat 300–600 ms Constant Timer before every sampler | older suites |
| CTTs 41,667/min (performance), 5,100/min (warmup), 60/min (sanity), switched by hand-toggling `enabled` in the JMX | Hot Topic (`hot_topic.jmx` L291–314) |
| Every throttle disabled ("enable manually in the GUI"), so CLI runs are unthrottled with zero think time | TWC (`twc.jmx` L267–292) |
| A hardcoded 400/min CTT that is always on, so even `load` is capped at about 6.7 req/s | Office (`office.jmx` L277) |

### Auth patterns (real requirements)

| Pattern | Where |
|---|---|
| Anonymous `poq-user-id` only | older suites |
| Guest token → Bearer, plus refresh | TWC, Office, Elf, Hobbycraft, Studio |
| `/account/login` → Bearer `accessToken` | Office, Elf, Hobbycraft |
| OAuth2 authorization code + PKCE through the storefront: CSRF, form login, 302 `code=`, then `/account/v2/login` | TWC (`twc.jmx` L2828–3280) |
| `poq-auth` = Base64(HMAC-SHA256(PBKDF2(secretKey, salt, 1000 iterations, 256 bits), bodyWithoutWhitespace + poqUserId)) | Hot Topic L2896, Elf L2834, Hobbycraft L4365, Missguided |
| Basic `email:encryptedPassword` taken from the login response | Hot Topic account calls, M&Co, Orsay |
| setUp credential pool: one exclusive account per thread, guest fallback when the pool is empty | TWC (`twc.jmx` L297/L4172) |

### Correlation, assertions, reporting, plugins

- **Correlation:** guest/access/refresh tokens and `externalUserId`; cart item IDs; wishlist item IDs; store IDs; checkout URL and checkout auth header; the `fragmentSuffix` salt from splash/settings (Hot Topic); Dynamic Yield user/session IDs (TWC); the `phash` header chain (Elf); gift-bundle entries (TWC).
- **Assertions:** mostly response-code checks, plus body "contains key" or JSONPath "exists" checks.
  - Several accept 400/404 as a pass (Ardene PDP and bag; Card Factory add and update).
  - None check latency.
- **Reporting:** the JMeter HTML dashboard only. GUI listeners stay enabled during CLI runs, and there is no backend listener.
  - **Failed requests are not logged anywhere readable.** Diagnosing a failure means opening a JTL. Hot Topic had to add a temporary JSR223 just to log failing product IDs (`hot_topic.jmx` L1301–1322, "TEMP – Log failing product_id/sku").
- **Plugins:** jpgc ParameterizedController, jpgc functions (`__base64Encode`), testautomationguru PropertyReader, jpgc Shaping Timer (disabled everywhere).

---

## 3. Test-data utilities project assessment

`Poq.Testing.Utilities/new_gen` (branch `twc`) is an interactive menu, `start.py`, over 10 modules (about 9.4k lines). All HTTP calls are sequential `requests` calls with a 2–5 s sleep between them. There is no concurrency and no faker.

| Module | Generates | Calls | When | Consumer | Status |
|---|---|---|---|---|---|
| `poq_user_generator` | TSV of UUIDs | none | before | every `poq_user_id*.csv` | active, trivial |
| `max_min_csv` (also identical copies at `LoadTest/MandCo/max_min_csv.py` and `snipes/max_min_csv.py`) | `min,max` pairs | none | before | 7 brands' `min_max_values.csv` | trivial |
| `coordinates_range_generator` | lat/lng inside a country bounding box | none | before | TWC, Hot Topic, Orsay `coordinates.csv` | trivial |
| `create_accounts` (CSV mode) | email/password/name rows | none | before | TWC `registration_data.csv` | **column-order bug**: JMeter's `firstName` receives the password (`create_accounts/main.py:318-320` vs `:259-280`) |
| `create_accounts` (API mode) | real accounts on the brand | `POST /clients/{c}/account/register` on **prod** | occasionally, before | login CSVs | required |
| `products_availability_validator` (`validate_products.py`) | 8-column purchasable-product list | guest token → PDP GET → variant stock ≥ 5 → **live guest `POST /cart/items`** proving the product can be added | **before every run** (stock drifts) | TWC `products_{env}.csv` | **required**; about 3.5 s per product, about 2.7 h for 2.8k products |
| `gift_bundle_validator` | 12-column validated bundles | PDP GETs, `cart/items/bulk`, `cart/items` | before every run | TWC `gift_products_{env}.csv` | required; about 1–2 min |
| `category_id_extractor` | flattened category tree with filter keys | one `GET /shop` | before | TWC `categories_prod.csv` (identical file) | required |
| `add_to_wishlist` | — | hardcoded `/clients/hottopic/…`; guest token never applied | — | none | obsolete |
| `report_reader` | per-endpoint p95 CSV, optional GPT-4 commentary | OpenAI | after | manual | replaceable |
| `curl_config_generator` | — | — | — | — | broken (KeyError, `utilities.py:372`) |

**Hygiene problems:**
- `openai`, `tabulate` and `lxml` are imported at menu start but are missing from `requirements.txt`.
- `curlify` and `tkmacosx` are listed but never used.
- About 10 files are dead or duplicate: `main_clean.py`, `config_manager.py`, `categories_id_extractor/`, `Extractor_checker.py`, `remove_dublicates.py`, the 9-argument path in `main.py`, and others.

---

## 4. Dependencies between LoadTest and Utilities

- **The only link is manual file copying.** Someone runs a menu option, then copies `out/*.csv` into `LoadTest/<brand>/csv_files/`. Nothing is automated.
- **The Git submodule link is dead.** `missguided/python_utility_scripts` was never initialized. The orphan gitlink `MandCo/python_utility_scripts` breaks `git submodule status`.
- **Brand config is duplicated.** It lives in both `new_gen/config/app.*.properties` and `<brand>/<env>.properties`.
- **CSV contracts are implicit, and have already drifted:** Snipes accounts, TWC registration data, and TWC stg/dev products all have columns that don't line up with the variables that read them.

---

## 5. Existing load-test behaviours that must be preserved

1. **Per-brand header contract:**
   - `poq-app-id`, `poq-app-identifier`, `version-code`, `poq-user-id`, `user-agent`, `platform`
   - `currency-code` / `poq-currency-identifier`, `poq-country-identifier`, `poq-locale`, `accept-language`
   - `poq-slot-conditions` and `accept-version` (v2/v3) where used
2. **Allowlist markers in the user agent.**
   - Hot Topic's user agent ends in `POQQAALLOW`. The first prod trial today got about 85% HTTP 403s before the user agent was changed.
   - Office uses a `poq-bfc-api` user-agent key.
3. **Identity.**
   - Each virtual user keeps one `poq-user-id` across iterations.
   - Logged-in users send their own `externalUserId`. TWC currently falls back to the guest ID, which is a bug.
4. **All auth flows in §2**, including exclusive credentials per logged-in user with a guest fallback.
5. **Journeys:**
   - open app, content, categories, search and predictive search
   - PLP with sort/filter; PDP with reviews, recommendations and availability
   - wishlist; cart add/update/validate/remove
   - checkout start and the checkout URL; Apple Pay
   - stores and account
   - brand extras: TWC gift bundles, Hot Topic store stock, QAS and universal links, Elf AdeptMind and loyalty
6. **Traffic mix.** The only measured mix is Hot Topic 2025:

   | Journey | Share of requests |
   |---|---|
   | PLP sort/filter | 12.7% |
   | Store availability | 12.5% |
   | Open app | 11.2% |
   | Wishlist | 10.9% |
   | Cart | 10.3% |
   | Search | 6.3% |
   | Stores | 5.4% |
   | Carousels | 5.4% |
   | Account | 1.1% |
   | Checkout | 1.0% |

7. **Throughput targets:** Hot Topic about 694 req/s; TWC load 5,225/min (about 87 req/s); Office 6,000/min; Elf 3,000/min.
8. **Profile ladder:** sanitycheck → sanityload → warmup → load → performance.
9. **Cleanup:** delete bag, delete gift-box cart items, delete wishlist.
10. **Test-data quality: every product used by a test has been validated immediately before that run.**
    - Stock is available at quantity ≥ 5.
    - The product is proven addable to a cart.
    - Bundles are validated per entry.
    - Poq cannot validate client product data at source: there is no DB access, and client feeds can't be relied on. Validating every product in the file before each run is the only protection against out-of-stock noise in results.
11. **Target isolation.** Hot Topic historically targeted the isolated `hottopic-perf` client. Today's local edit switched it to the real `hottopic` client.

---

## 6. Problems and technical debt

### LoadTest

- **Wiring bugs that silently change the test:**
  - M&Co, `us_region` and Studio ignore `-J` flags because their property paths are hardcoded. Every M&Co CLI run is a 1-user test against prod.
  - Snipes ModuleControllers call the whole Test Fragment, so it runs 2–3 times per iteration.
  - `__P()` defaults to "1" when a property is missing, which spawns stray threads (`aus_region` groups 4–6).
- **Undefined variables sent as literal text:**
  - Hot Topic `${cart_item_id}`: Update Cart fails 100% with 424 in today's runs.
  - Hot Topic `${clientId}` and `${phoneNumber}`; Studio `${clientid}`; Radley and `aus_region` `${productId}`/`${sku}`.
- **Invalid JSON bodies:** Orsay add-to-bag, Office add-to-bag (trailing comma), `aus_region` checkout.
- **Data problems:**
  - Git merge-conflict markers in three `poq_user_id.csv` files.
  - Header rows read as data (Hot Topic sends `categories=category_id`).
  - About half of `us_region/products.csv` is junk rows.
  - Keywords that are double URL-encoded, random dictionary words, or copied from another client.
  - Registration emails recycled, so the same email is registered repeatedly.
- **Weak assertions:** 4xx accepted as a pass; the string "200" searched for in response headers; `(.*)` existence checks; TWC asserts a known bulk-add bug as the expected result.
- **Secrets in git:**
  - `poq_salt`/`secretKey`: Hot Topic L37/L43, Missguided, Elf, Hobbycraft.
  - Storefront Basic credentials: Hot Topic L1620, Hobbycraft L2667.
  - Cotton On static `poq-auth`; Card Factory static Basic header.
  - Plaintext account passwords in CSVs.
- **TWC auth hosts are hardcoded to production**, so stg/dev runs still log in against prod TWC.
- **Operational debt:**
  - About 30% of Hot Topic's fragment is disabled or unreferenced.
  - TWC's login-retry `While` loop can spin forever, because a preprocessor resets the retry counter.
  - PBKDF2 is recomputed on every signed request.
  - GUI listeners run during load tests.
  - READMEs are copy-pasted and show wrong commands.

### Utilities

- Interactive only, and must be run from `new_gen/`.
- Dependencies are undeclared, and `sys.exit()` inside modules kills the menu.
- Brand logic is forked across about 15 branches.
- Bearer tokens are committed on `ecomodern`, `studio` and `hobbycraft`; a signing key and salt are committed on `hobbycraft`.

---

## 7. Proposed k6 architecture and folder structure

### Principles

- Plain JavaScript ES modules. No npm runtime dependencies and no k6 extensions.
- One entry script per brand, composing shared journey functions. Brands genuinely differ (PKCE vs HMAC, v2 vs v3 wishlist), so explicit per-brand composition is clearer than a generic config-driven engine.
- Test data is JSON, loaded with `JSON.parse(open())` inside `SharedArray`, so no CSV parser is needed.
- k6 v2.3 runs TypeScript natively, so adopting it later is cheap. It isn't needed to start.

### Folder structure

As built, after the structure revision in rev 12:

```
Poq.Testing.k6.LoadTest/
├── README.md                  run commands, options, profiles, prod safety, data refresh, adding a client
├── package.json               npm scripts only (no dependencies)
├── .gitignore                 results/* (except .gitkeep), secrets/, clients/*/data/accounts*.json
├── lib/
│   ├── platform/              standard Poq API endpoints (Gen-3 contract), one file per area:
│   │   ├── app.js             splash, settings, launch, banners, app stories, content blocks/data, universal links
│   │   ├── catalog.js         shop + categories, search, predictive, PLP (+ variants), barcode
│   │   ├── product.js         PDP, recently viewed, product listings, reviews, UGC, recommendations
│   │   ├── cart.js            add, validate, get, update, delete, clear
│   │   ├── wishlist.js        v3 add / get / delete
│   │   ├── stores.js          stores, store availability
│   │   ├── checkout.js        checkout start + URL, cart sign, Apple Pay express checkout
│   │   ├── account.js         guest token, refresh, account pages, logout
│   │   └── index.js           exports the modules + every platform request name
│   ├── http.js                request wrapper: header contract, checks, failure logging (§14.2), per-client endpoint tweaks
│   ├── test-kit.js            shared test.js plumbing: data, scenarios, options, base setup, session, summary
│   ├── config.js              reads ENV/PROFILE/…, validates, fails fast; prod guard
│   ├── auth.js                PKCE pair; poq-auth key derivation (once) + signing
│   ├── data.js                SharedArray loaders, validated-data freshness check, random helpers, think time
│   ├── profiles.js            smoke/sanity/warmup/load/paced/custom → k6 scenarios from client targets
│   └── summary.js             thresholds + handleSummary → summary.json, endpoints.csv, failures.csv
├── clients/
│   ├── twc/
│   │   ├── config.js          environments, headers, session, mix, load target, limits, endpoint tweaks (data only)
│   │   ├── endpoints.js       TWC-only: Dynamic Yield, gift box, storefront PKCE login
│   │   ├── journeys.js        step order: guestBrowse, guestShopper, loggedInShopper
│   │   ├── test.js            createTest(…) + one exported function per scenario
│   │   ├── input/             product-ID and bundle-ID lists (the validator's input)
│   │   └── data/              validated products/bundles JSON; keywords; accounts_<env>.json (gitignored)
│   └── hot_topic/             same shape; endpoints.js holds the Gen-2 bag/wishlist/stores calls, signed login, QAS
├── prep/                      Node 20, no dependencies; reads clients/<client>/config.js
│   ├── lib/poq-api.mjs
│   ├── validate-products.mjs
│   ├── validate-gift-bundles.mjs
│   └── report-failing-products.mjs   a run's failures.log → product-level failure list (§14.2)
├── run.mjs                    optional launcher: one results folder per run
├── secrets/                   gitignored: <client>.secrets (key=value) for --secret-source
└── results/                   gitignored run outputs
```

**Rules:**
- A standard Poq endpoint goes in `lib/platform/`.
- Small per-client differences (query parameters, a path variant, extra checks) go in the client's `config.js` under `endpoints`.
- Structural differences and client-only integrations go in `clients/<client>/endpoints.js`.
- Journeys stay plain code per client.
- Request names stay the same across clients.

### Typical run

```bash
# 1. Validate all products for this run (hours for large lists; see §10)
node prep/validate-products.mjs --brand twc --env staging
node prep/validate-gift-bundles.mjs --brand twc --env staging

# 2. Run the test
RUN=results/twc_staging_$(date +%Y%m%d-%H%M%S); mkdir -p $RUN
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=$RUN/report.html \
k6 run -e ENV=staging -e PROFILE=sanity -e RUN_DIR=$RUN \
       --secret-source=file=secrets/twc.secrets \
       --console-output=$RUN/failures.log \
       clients/twc/test.js

# 3. Optional: product-level failure report
node prep/report-failing-products.mjs $RUN/failures.log
```

Package steps 1–3 behind npm scripts, e.g. `npm run twc:sanity -- --env staging`, so nobody has to type them by hand.

---

## 8. JMeter → k6 concept mapping

| JMeter | k6 |
|---|---|
| PropertyReader + `__P()` + `<env>/<module>.properties` | `clients/<client>/config.js` + `-e ENV/PROFILE`; fail on missing keys (no silent "1") |
| ThreadGroup (users, ramp, duration, delay) | `scenarios` using `ramping-arrival-rate` (primary) or `ramping-vus`; `startTime` replaces delay |
| Constant Throughput / Shaping Timer | arrival-rate executor stages (open model), no GUI toggles |
| Constant Timer 300 ms | randomized `sleep()` think time between journey steps, where realistic |
| Test Fragment + ModuleController | plain JS functions in `journeys.js` |
| ParameterizedController / UDV | function arguments, per-VU state, config |
| HeaderManager scopes | one `poqHeaders(ctx)` builder plus per-call overrides |
| CSV Data Set (shareMode.all, recycle) | `SharedArray` with explicit indexing: per VU (`exec.vu.idInTest`) for accounts, random for catalogue |
| setUp thread group / credential pool | `setup()` for cheap shared data; per-VU account allocation in `data.js` |
| JSON/Regex extractors | `res.json('path')`; if the value is missing, the check fails, the failure is logged and the iteration stops (never send a literal `${var}`) |
| Response/JSONPath assertions | `check()` on status and key fields; thresholds on the `checks` rate |
| JSR223 PBKDF2/HMAC | `crypto.subtle.deriveBits` (PBKDF2, verified) once per salt, then `k6/crypto` `hmac('sha256', …)` |
| JSR223 PKCE | `crypto.getRandomValues` + `crypto.subtle.digest('SHA-256')`; `redirects: 0` to capture the 302 `Location` |
| CookieManager (TWC login) | per-VU cookie jar, cleared per login |
| If / ForEach / While controllers | plain JS `if` / `for`, with bounded retries |
| Transaction Controller (never used) | `group()` or a journey tag, for per-journey timings |
| Sampler label | `tags: { name: 'PDP' }` (also prevents URL-cardinality blow-up) |
| Temporary JSR223 file-logging post-processor | built-in failure logging in `poq-client.js` (§14.2) |
| `-e -o` HTML dashboard | built-in web dashboard export + `handleSummary` JSON/CSV |
| `run-tests.sh` | npm scripts, or the documented `k6 run` line |

### Needs redesign, not translation

- **Traffic model:** closed, fixed sequences become weighted arrival-rate scenarios.
- **TWC credential pool:** becomes deterministic per-VU allocation.
- **Hot Topic salt handling:** G3 never opens the app, so it signs with the hardcoded salt.
- **Bulk-add assertion:** today it asserts the known bug as correct; it becomes a tagged informational check.
- **Office per-sample `product_pattern.csv` read:** becomes a validator filter.

---

## 9. Scenario-by-scenario migration approach

### TWC (`origin/twc:twc/twc.jmx`), the reference suite

| Current JMeter | Required behaviour | Proposed k6 |
|---|---|---|
| **G1 Guest:** 48–50 requests per iteration. Guest token → open app → content → search → PLP ×6 → PDP ×10 → bag → update → cart sign → checkout → Apple Pay → delete bag → wishlist → stores. Unthrottled. | Guest shopping with cleanup | `guestShopper` scenario on an arrival rate |
| **G2 Logged-in:** loops=1 (one pass per thread). PKCE login with a 3-retry While loop, then the gift-box bundle with per-entry adds and cart cleanup. | One exclusive account per VU; log in once and reuse the token; bundle flow on a share of iterations | `loggedInShopper` scenario. Login on the VU's first iteration or when the token expires. Gift box on about 3% of iterations (this makes the dead `giftbox.percent_executions=3` property real). Bounded login retries. |
| **Registration:** disabled | Unknown | Not built until needed (§16) |
| **Profiles:** load 1,265 guest + 25 logged-in users, target 5,225 rpm; sanity/warmup/performance | Same ladder | `profiles.js` stages derived from `rateTarget` in config |

### Hot Topic (`hot_topic/hot_topic.jmx`)

| Current JMeter | Required behaviour | Proposed k6 |
|---|---|---|
| **G1 Concurrent:** 33 requests. The PDP module only calls Reviews. | Browse-heavy | `browser` scenario with the full PDP (confirm this was the intent) |
| **G2 Ramp-up:** 34 requests, including checkout start and remove | Shopper | `shopper` scenario |
| **G3 Account:** forgot password, signed login, Basic account details, QAS, cart wishlist | Signed login + account | `account` scenario. Salt comes from `/settings/config` in `setup()`; PBKDF2 key cached. |
| **Pacing:** 41,667/min CTT; 1,600 / 900 / 500 users | About 674 req/s peak | Arrival rates calibrated to the 2025 per-endpoint mix |
| **Bugs:** `${cart_item_id}` never set; `${clientId}` in wishlist delete; category header row sent as data; dead SKUs | Correct correlation, valid data | Correlate from `GET /cart`; fully validated product data (§10) |

### Office/Offspring, Elf, Hobbycraft

Each becomes a new `clients/<client>/` built on the shared journeys, with its client-specific parts:

- **Office:** product-restriction filter moved into the validator; vouchers.
- **Elf:** `phash` header chaining, AdeptMind, loyalty, and register-then-shop.
- **Hobbycraft:** ideas and bundles, multi-add, and the richest body assertions of any suite.

Port each only once the brand is confirmed in scope.

### Gen-1/Gen-2 suites on `dev`

M&Co, Snipes, Cotton On, Card Factory, Orsay, Ardene 2020, Radley, DemoApp, `aus_region`/`us_region`, Missguided, Studio.

**Do not port these.** Several are broken as committed and use retired API shapes. If any of these brands is still active, rebuild it on the shared Gen-3 journeys from the current app's traffic.

---

## 10. Test-data generation migration strategy

| Current utility | Why it exists | Still required? | Proposed implementation / location |
|---|---|---|---|
| `poq_user_generator` (40k–880k-row CSVs) | unique `poq-user-id` per thread | the behaviour, not the file | `crypto.randomUUID()` once per VU (`lib/data.js`) |
| `max_min_csv` (3 copies) | price-filter ranges | the behaviour, not the file | random range at runtime |
| `coordinates_range_generator` | store-locator lat/lng | the behaviour, not the file | per-brand bounding box in `config.js`, random point at runtime |
| `create_accounts`, CSV mode | registration payloads | only if registration is in scope | unique email per iteration at runtime |
| `create_accounts`, API mode | login accounts must exist | **yes** | `prep/create-accounts.mjs`, run rarely; gitignored `accounts_<env>.json` |
| **`products_availability_validator`** | **only products that are in stock and can be added to a cart** | **yes, full validation before every run** | **`prep/validate-products.mjs`** (see §10.1) |
| `gift_bundle_validator` | valid TWC bundles with chosen variants | **yes, before every run** | `prep/validate-gift-bundles.mjs`, full list, same rules as today |
| `category_id_extractor` | categories and filter keys | yes | k6 `setup()`: one `GET /shop`, flatten, pass to VUs; no file |
| keywords (branch word generators) | search terms | yes, but today's data is unrealistic | curated `keywords.txt` per brand, or `setup()` from `/search/popular-terms` where it exists (TWC) |
| `add_to_wishlist` | seed one user's wishlist | no | drop |
| `report_reader` (+ OpenAI) | per-endpoint p95 table and commentary | the table, yes; the LLM is optional | `handleSummary` `endpoints.csv`; any LLM step later, outside the test runtime |
| `curl_config_generator`, `launch_product`, `remove_dublicates`, `main_clean`, `Extractor_checker`, legacy extractor dir | — | no | drop. A Hot Topic launch-product filter can become a validator flag if needed. |

### 10.1 Product validation: every product, every run

**Decision:** keep today's practice. Before each test run, fully validate **every** product in the brand's source list. There is no sampling and no spot-check in its place. The reason: Poq cannot validate client product data at source (no DB access, and client feeds can't be relied on), so without full validation the test would fill up with out-of-stock errors that say nothing about platform performance.

**Rules** (ported from `new_gen/modules/products_availability_validator/validate_products.py`):

1. Get a guest token (`POST /clients/{c}/account/guest-token`) and use its `externalUserId` as `poq-user-id`. Renew the token every 10 products.
2. `GET /products?ids={id}&slot-content-id=pdp`.
3. Try the default variant first, then the others. A variant is valid only if the stock is available **and** the quantity is ≥ 5. The threshold is configurable per brand; the default is 5, as today.
4. **Prove it can be added:** `POST /cart/items` on the guest cart must return 200 with `customData.quantityAdded > 0`.
5. Capture the metadata the test needs: `product_id`, `external_product_id`, `sku`, `categoryId`, `productType`, `product_listings`, `colour_swatch`, `recentlyViewedIds`.
6. Keep the pacing: a configurable delay between products (default 2–5 s, as today), to avoid load spikes on client production outside the test itself.
7. Save progress incrementally, as today (every 10 products), so a long run that dies part way loses little.

**Output:** `clients/<client>/data/products_<env>.json`.

```json
{
  "brand": "twc", "env": "prod",
  "generatedAt": "2026-09-28T09:12:00Z",
  "rules": { "minStock": 5, "addToCartProof": true },
  "summary": { "checked": 2804, "valid": 2137, "rejected": 667,
               "rejectedBy": { "outOfStock": 512, "lowStock": 71, "addToCartFailed": 60, "notFound": 24 } },
  "products": [ { "product_id": "A17501", "sku": "A17501000AIB", "...": "..." } ],
  "rejected": [ { "product_id": "A10233", "reason": "outOfStock", "detail": "all variants quantity 0" } ]
}
```

The rejected list and the per-reason counts show the team how healthy the brand's catalogue is before the test even starts.

**How the test uses it:**
- k6 loads only `products[]`. In `setup()` it checks that the file's `env` matches the run and that `generatedAt` is within `maxDataAgeHours` (a per-brand config value; see §16). If either check fails, the run stops with a clear message telling the operator to re-run the validator.
- k6 does **not** re-validate products during the test.
- Stock that runs out during the test is caught by the failure logging in §14.2, which records `product_id`/`sku` for every add-to-bag failure.

**Time cost:** about 3.5 s per product, roughly 2.7 h for 2.8k products. This is accepted. The runbook schedules validation immediately before the test window.

**Gift bundles:** same principle. `validate-gift-bundles.mjs` validates every bundle and every entry before every run, keeping the current statuses (`ok`, `partial`, `no_stock`, …). Only `ok` bundles are used.

### Where each kind of preparation runs

- **Dedicated `prep/` commands, before the run:** anything slow, or anything that changes live state (validators, account creation). Their output is reviewable and carries its generation time.
- **`setup()`:** only cheap, read-only or tiny work (categories, popular terms, salt, data-freshness check). These requests are tagged `phase:setup` and excluded from thresholds.
- **Never inside VU iterations:** nothing expensive.

---

## 11. Python vs JavaScript/k6 recommendation

**Recommendation:** consolidate on k6 (runtime logic and `setup()`) plus Node for the four `prep/` scripts, then retire the Python project.

**Why:**
- The remaining logic is sequential HTTP plus JSON reshaping. Node 20 is already installed and has native `fetch`, so no dependencies are needed.
- `pandas` is only used for `to_csv`.
- With one language, `prep/` and the k6 tests read the same `clients/<client>/config.js`. That removes the duplicated client config and the implicit CSV contracts that caused the column bugs.
- It also removes the `.venv`, the undeclared dependencies, and the branch-per-brand forks.

**Transition (the validator is critical, so be careful):**
- Keep the Python validator as the reference until `validate-products.mjs` has run on the same input as the Python version and produced the same valid/rejected split. Small differences caused by stock moving between the two runs are acceptable only if explained.
- Only then retire the Python validator.

**No case was found where Python remains the better tool.**

---

## 12. Configuration, environments and secrets

- **Committed, not secret:** `clients/<client>/config.js`, per environment.
  - hosts, including the storefront/auth hosts
  - app IDs, app identifiers, versionCode
  - user agent, including the allowlist suffix
  - currency and locale
  - rate targets, scenario weights, thresholds
  - validator settings: `minStock`, delay, `maxDataAgeHours`
- **Standard environment names:** `dev | staging | prod`. TWC's `stg` maps to `staging`.
- **Secrets** (`poq_salt`/`secretKey`, storefront Basic credentials, account passwords, future API keys):
  - Supplied with `--secret-source=file=secrets/<brand>.secrets` and read via `k6/secrets`. Values are redacted in k6 logs (verified).
  - `prep/` scripts read the same file.
  - Account lists are gitignored data files.
- **Prod guard:**
  - `ENV=prod` requires `-e ALLOW_PROD=true`.
  - A prod-only `abortOnFail` threshold (e.g. error rate above 10% after 60 s) stops a runaway run like today's 403 storm.
  - Storefront hosts come from config, so staging runs never touch prod.
- **Legacy secrets:** rotate everything that was committed. Do not copy any of it into the new repo. Purge git history only if Security requires it.

---

## 13. Load-profile and throughput strategy

- **Open model by default.** Use `ramping-arrival-rate` for each journey scenario. Targets are throughput-based, and an open model keeps up the load even when the system slows down; JMeter's closed model hid that.
  - Formula: `iterations/s = target_req/s × journey_share ÷ requests_per_iteration`.
  - Example: TWC at 87 req/s with about 48 requests per iteration is about 1.8 guest iterations/s.
- **Weights.**
  - Hot Topic starts from the measured 2025 mix.
  - TWC starts from its thread-group ratio until analytics data is available.
  - After each first run, compare actual req/s per endpoint against the target and adjust.
- **Think time.** Add short randomized pauses between steps (value to be confirmed, e.g. 1–3 s). This doesn't change throughput under arrival-rate executors, but it makes session and connection concurrency realistic. Size `preAllocatedVUs` and `maxVUs` to match.
- **Profiles.** One table in `profiles.js`, expressed as multipliers of the brand's load target. The values below are for approval:

  | Profile | Load level | Duration |
  |---|---|---|
  | smoke | 1 iteration per scenario | — |
  | sanity | about 1% | 5 min |
  | warmup | about 10% | 15 min |
  | load | 100%, ramp then hold | about 30–60 min |
  | performance | peak, from the committed Hot Topic full profile | about 60 min |

  Stress and soak profiles are added only when someone asks for them.
- **Load generation:** one machine comfortably covers Hot Topic scale (about 3,000 concurrent users, about 700 req/s). No new infrastructure until proven necessary.

---

## 14. Validation, thresholds and reporting strategy

### 14.1 Checks, thresholds, reports

- **Checks.** Every request declares its expected result: the expected status or statuses (e.g. wishlist add `204`, checkout URL `302`) plus 1–3 key body fields (e.g. `cartItems` present, `accessToken` non-empty).
  - A 400 or 404 is never a pass.
  - A missing correlated value ends the iteration.
- **Thresholds, per brand:**
  - Global: `http_req_failed < 1%` and `checks > 99%`.
  - Per endpoint: `http_req_duration{name:X}`, starting from baselines (about 1.5× the 2025 Hot Topic p95):
    - most catalogue calls: under 500 ms
    - login: about 1.2 s
    - add to bag: about 850 ms
    - TWC bag/validate calls: separate, higher values (they are 2–5 s at p95 even at sanity load)
  - These are regression guards until real SLOs are agreed.
- **Reports**, one folder per run under `results/`:
  - `report.html`: the k6 web-dashboard export, the equivalent of the JMeter dashboard.
  - `summary.json` and `endpoints.csv` (name, count, error %, avg, p90/p95/p99), written by `handleSummary`. These replace `report_reader`.
  - `failures.log` and `failures.csv` (§14.2).
  - Use `--out json` only when raw samples are needed.
- Grafana Cloud k6 is an optional extra output (rev 21); no InfluxDB or Prometheus. Results are gitignored and archived outside the repo.

### 14.2 Failure logging: every request that doesn't return the expected result

**Goal:** when an endpoint does not return the expected result, the run leaves a readable record of what was sent, what came back, and which test data was involved. Nobody should need to open a JTL, add a temporary script, or re-run to find out why. Today this only exists as the temporary Hot Topic JSR223 at `hot_topic.jmx` L1301–1322.

**Where:** in one place, the request wrapper in `lib/poq-client.js`. Every request in every brand goes through it, so journeys contain no logging code.

**When a failure is logged:**

1. The status is not in that request's expected set.
2. A body check fails, e.g. `quantityAdded == 0`, missing `accessToken`, empty `cartItems`.
3. A value needed by a later step could not be extracted (correlation failure).
4. Transport errors: timeout, connection reset, DNS. k6 reports these as status `0` with an `error_code`.

**What is logged:** one JSON line per failure, at `console.error` level.

```json
{"ts":"2026-09-28T14:03:11.482Z","brand":"twc","env":"staging","profile":"load",
 "scenario":"guestShopper","vu":412,"iter":37,"request":"Add to bag",
 "method":"POST","url":"https://staging.poq.io/clients/twc/cart/items",
 "expected":{"status":[200],"checks":["quantityAdded>0"]},
 "actual":{"status":422,"errorCode":null,"durationMs":618,
           "failedChecks":["status is 200","quantityAdded>0"],
           "headers":{"content-type":"application/json"},
           "body":"{\"errors\":[{\"code\":\"InsufficientQuantity\",...}]}"},
 "data":{"product_id":"A17501","sku":"A17501000AIB","account":"#14"}}
```

Contents of each line:
- **Context:** timestamp, brand, environment, profile, scenario, VU, iteration, and the request name tag.
- **Request:** method and URL.
- **Expected:** the statuses and checks.
- **Actual:** status, k6 error code, duration, and which checks failed.
- **Response headers:** a small allowlist (content type, plus any correlation/trace ID headers the platform returns; which exist is to be confirmed).
- **Response body:** truncated to 1 KB.
- **Test-data references:** `product_id`, `sku`, `category_id`, `bundle_id`, and the account index. Never emails or passwords.

**Redaction (always applied):**
- Never logged: `Authorization`, `poq-auth`, cookies, tokens, OAuth `code`/`codeVerifier`, passwords, and request bodies of login/register/token calls.
- Emails in URLs or bodies are masked.
- Secrets loaded through `k6/secrets` are also redacted by k6 itself.

**Where it goes:**
- `k6 run --console-output=$RUN/failures.log` writes the log to a file (native k6 flag). The terminal stays readable, showing the progress summary only.
- Every failure is also counted in a custom `Counter`, `endpoint_failures`, tagged with `name` and `status`. `handleSummary` writes these counts to `failures.csv` (request name, status, count) and adds a "failures by status" column to `endpoints.csv`.
- **The counts are always complete, even when detail logging is capped.**

**Volume control:**
- Full detail is logged for the first `FAILURE_LOG_LIMIT` failures per VU for each request name + status combination (default 10, set with `-e`). After that, failures are only counted.
- This keeps the file useful during an error storm (e.g. today's 403 run) while every failure still shows in the counts.
- `FAILURE_LOG_LIMIT=0` logs everything, for small diagnostic runs.

**Product-level failure report:**
- `prep/report-failing-products.mjs <run>/failures.log` groups failures by `product_id`/`sku`, request and status. For example: "A10233 / Add to bag / 422 ×14".
- This separates catalogue problems (stock sold out during the run, products delisted since validation) from platform problems.
- It feeds the next validation run and replaces the Hot Topic `failing_products_temp.csv` workaround.

---

## 15. Migration phases, in recommended order

0. **Decisions (no code).** Brands in scope, target environments per brand, prod-testing rules, SLOs, `maxDataAgeHours`, and the Node-for-prep confirmation (§16).
1. **Skeleton + TWC smoke.**
   - Replace the placeholder scaffold.
   - Build `lib/config`, `poq-client` (including failure logging, §14.2), `data`, `profiles` and `summary`.
   - Implement guest token → open app → search → PLP → PDP against TWC staging, using the existing validated TWC files converted to JSON once.
   - Exit criteria: smoke run green, thresholds evaluated, HTML report produced, and a deliberately broken request appears correctly (and redacted) in `failures.log` and `failures.csv`.
2. **TWC full parity.** PKCE login with per-VU accounts; cart add/validate/PATCH/delete; wishlist v3; gift bundles; checkout and checkout URL; Apple Pay; cart sign; stores; account and logout; cleanup; all profiles.
3. **Product and bundle validators in Node.**
   - Port `validate-products.mjs` and `validate-gift-bundles.mjs` with full-list validation and today's rules (§10.1).
   - Run them against the same input as the Python versions and compare the valid/rejected splits.
   - Add the data-freshness check in `setup()`.
   - Move categories and keywords into `setup()`.
   - Port `create-accounts.mjs`.
4. **Side-by-side validation.**
   - Run JMeter sanityload and the k6 sanity profile against the same environment on the same validated data.
   - Compare endpoint coverage, requests per iteration, error rate and p95. Differences must be explained (some are intentional JMeter bug fixes).
   - Team sign-off.
   - Then retire Python for TWC.
5. **Hot Topic.** `poq-auth` signing, Basic account auth, store stock, QAS, universal links, vouchers. Calibrate against the 2025 baseline.
6. **Other in-scope brands**, one at a time, each through the same parity gate.
7. **Decommission.**
   - Archive both legacy repos read-only.
   - Keep the 2025/2026 baseline reports in the k6 repo docs.
   - Rotate legacy secrets.
   - Remove the dead submodule links.

---

## 16. Risks, unknowns and decisions requiring clarification

### Decisions for the team

1. **Brands in scope.** The repositories cannot say which clients are active. Assumed order: TWC and Hot Topic first; then Office/Offspring, Elf and Hobbycraft as confirmed.
2. **Prod vs isolated targets.** Hot Topic moved from `hottopic-perf` to real prod today. Should k6 default to an isolated perf client wherever one exists?
3. **SLOs.** None are defined anywhere. Are baseline-derived thresholds acceptable as a starting point?
4. **`maxDataAgeHours`.** How old may the validated product file be at test start? Proposed default: 12 h.
5. **Guest-cart cleanup during validation.** Should the validator remove the item it added after the add-to-cart proof? The current Python script does not. Guest carts are presumably temporary; confirm with the platform team.
6. **Registration on prod.** It creates real customer records, and it is disabled today in TWC and Hot Topic. Include it or not?
7. **Think-time values,** and whether journey weights should come from app analytics. The Poq Analytics connector could supply real journey frequencies.
8. **Node for `prep/`,** replacing Python (§11).
9. **Failure-log retention.** Truncated response bodies could contain customer data even after masking. Agree where run folders are archived and for how long.
10. **Results archive location,** and whether CI or scheduled runs are wanted. Neither is assumed.

### Unknowns (not determinable from the repositories)

- Whether `poq-auth` is still enforced server-side. Hot Topic's G3 signs with a hardcoded salt, yet login errors were only 0.01% in 2025.
- Ownership and behaviour of the `POQQAALLOW` / `poq-bfc-api` allowlist mechanisms, including on staging.
- Whether TWC's bulk-add endpoint is still a known bug.
- Whether Hot Topic G1 skipping PDP details was intentional.
- Which correlation or trace ID response headers the platform returns (these would go in the failure log).
- The 2025 Hot Topic overall p95 (3.2 s) does not reconcile with its per-endpoint p95s (all ≤ 1.25 s). Use the per-endpoint values as baselines.

### Risks

| Risk | Mitigation |
|---|---|
| Validation takes hours, and stock moves between validation and test | Schedule validation immediately before the test; freshness check in `setup()`; failing-product report after the run |
| The validator adds load and cart writes to client production | Keep today's sequential pacing; run inside agreed windows |
| Prod side effects (carts, wishlists, accounts) | Cleanup steps in journeys, prod guard, abort threshold |
| The account pool runs out at high logged-in concurrency | Per-VU allocation with an explicit guest fallback, reported in the summary |
| The WAF blocks a new user agent or source IP | User agent from config; smoke test on the target first |
| The Hot Topic JMX changes during migration | Pin a reference commit |

---

## 17. Items that should intentionally NOT be migrated

- **JMeter plumbing:** PropertyReader, ParameterizedController, ModuleControllers, GUI listeners, `run-tests.sh`, `.properties` files.
- **Bulk generated CSVs:** UUID, min/max, coordinates and registration files, including the 880k-row user-ID files.
- **Legacy suites:** the Gen-1/Gen-2 `dev`-branch suites and the AKS internal-API suites, unless explicitly requested. Studio, which is broken and work in progress.
- **Disabled Hot Topic blocks:** BOPIS, Apple Pay with the doubled path, the address book on the staging Azure host, NPE, and the wishlist v2 remnants.
- **Bad practices:**
  - assertions that treat 4xx as success or treat a known bug as correct
  - hardcoded hosts, appIds or credentials
  - PBKDF2 on every request
  - file I/O inside VU code
  - temporary logging scripts (replaced by §14.2)
  - committed JTL/report folders
- **Utilities to drop:** `curl_config_generator`, `add_to_wishlist`, `report_reader`'s JMX parsing, OpenAI calls inside the test runtime, and all dead or duplicate Python files and per-brand branches.
- **The placeholder k6 scaffold:** the `/health` tests and the stress/soak stubs.

---

## 18. Definition of Done for the migration

1. **Runnable clients.** Every in-scope client has a `clients/<client>/` folder that runs every approved profile from a clean checkout. It needs only k6 and Node, uses documented commands, and requires no manual file edits or GUI steps.
2. **Full validation.** Product and bundle validation covers **every** product and bundle in the brand's list before each run, with today's rules (stock ≥ 5, add-to-cart proof). Its output records when it was generated, the valid count, and rejected counts by reason. A test refuses to start on stale data or data from the wrong environment.
3. **Documented parity.** Side-by-side parity with JMeter is documented per brand (endpoint coverage, requests per iteration, error rate, p95), with intentional differences listed and signed off by the team.
4. **Automatic pass/fail.** Thresholds and checks are defined per brand, and a run's pass/fail result comes from its exit code.
5. **Failure logging.** Every request that doesn't return its expected result is counted in `failures.csv`, and logged in `failures.log` up to the configured limit, with context, response detail and test-data references. Secrets and credentials never appear. A failing-product report can be produced from any run.
6. **Self-contained data.** All test data is generated at runtime, fetched in `setup()`, or produced by a documented `prep/` command. Nothing depends on `Poq.Testing.Utilities` or Python.
7. **Secrets handled.** No secrets in git; secrets are loaded via `k6/secrets`; the prod guard and abort threshold are active; legacy secrets have been rotated.
8. **Reports.** Every run produces `report.html`, `summary.json`, `endpoints.csv`, `failures.csv` and `failures.log`.
9. **Handover-tested README.** The README covers running tests, profiles, prod-safety rules, the validate-then-test runbook, reading failure logs, and adding a brand. A second QA engineer has run a brand end to end using only the README.
10. **Legacy archived.** Both legacy repos are archived read-only, with their baseline reports preserved.

---

## Recommended next step

Approve the Phase 0 decisions (§16, items 1–5). Phase 1 can then start: the skeleton with failure logging, plus a TWC smoke run on staging.
