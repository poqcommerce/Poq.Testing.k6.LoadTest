# Hot Topic (`hot_topic`)

Targets the isolated **`hottopic-perf`** client: `/clients/hottopic-perf/v2/…` on the same host and
app id as the live client (user decision, 2026-10-01). `-e API_PATH=hottopic/v2` points a run at the
live client instead. Each VU is one device with a persistent `poq-user-id`, which the member
scenarios keep after the guest token, as the app does. Reference suite: `hot_topic/hot_topic.jmx`
(working tree, 2026-09-28) for the shopping calls, and the prod iOS app 26.2.0 capture
(2026-10-01) for the app start and the member flow. Configuration: [config.js](config.js).

## Scenarios

| Scenario | Share | What it does |
|---|---|---|
| `browser` | 70% | App start, categories, search, PLP with 5 sort variants, reviews, store stock, bag (add, quantity 2, removed at the end), wishlist v3, barcode, stores, more, universal link, carousels, voucher |
| `shopper` | 21% | App start, categories, search, PLP, full PDP with 3 recommendation calls, store stock, bag, checkout start, remove, barcode, wishlist, stores, more, carousels, universal link |
| `account` | 9% | App start, guest token, **bearer login**, cart / wishlist / account content, profile (edit the last name, put it back), address book (validate, add, edit, delete), QAS, search, PLP, store stock, PDP, bag, checkout start, remove, more, logout. **Every request is signed** (`poq-auth`) |
| `register` | opt-in | App start, guest token, registration lookup, address validate, loyalty profile create, register, default address (the Gen-2 calls from the team's Postman suite; register refuses `example.com`, so the domain is `byom.de`). **Creates real accounts that cannot be deleted** |

- **`register` is not in the default mix.** Run it with `-e SCENARIOS=register`. Each iteration creates a
  throwaway person (`k6reg.<id>@byom.de`, a random phone, a generated password that is never
  logged). The lookup reports numbers the CRM already knows; the iteration then stops (counted under
  `correlation`) instead of retrying. On the live client one lookup was answered with a DataDome
  captcha page (HTTP 403), so expect 403s under load.
- **App start** (all scenarios) is the order of app 26.2.0: splash, launch, app stories, wishlist item ids,
  banners. The app no longer calls `settings/config`.
- **Search** uses `/search/predictive/v2` (the keyword, as before).
- **Not recaptured with the new app:** the Gen-2 bag, stores, PLP, PDP and recommendation calls. They keep
  the JMeter shapes. A real run on `hottopic-perf` is needed to confirm they still work with a bearer
  token on the `account` scenario.
- **Load target:** about 694 req/s; `load` profile: 30 min ramp-up + 30 min hold.
- **Latency limits** are 1.5 × each endpoint's 2025 prod p95, with a 500 ms floor. The calls added in
  2026-10-01 have no baseline and use the 1,500 ms default (provisional).
- **Client-only calls** ([endpoints.js](endpoints.js)): the Gen-2 bag, wishlist and stores calls, the voucher
  and More screen, QAS, the member flow (login, profile, addresses) and registration.

## Scale test: run settings (proposed, provisional)

Target: about 2.5M requests in the busiest hour (last year), 85 min, shape in [config.js](config.js) `load.shape`.
Nothing here has been run. Every prod-host run needs the user's explicit go-ahead; the scale run also needs the
rate approved by the client (far above the 60 req/min cap).

Common flags for all three runs (`<run>` = `sanity`, `warmup` or `scale`, plus the date):

```
-e ENV=prod -e ALLOW_PROD=true --secret-source=file=secrets/hot_topic.secrets \
--log-format raw --console-output results/ht_<run>_failures.log --out json=results/ht_<run>.json \
clients/hot_topic/test.js
```

| Run | When | Profile | Extra flags | Load | Requests |
|---|---|---|---|---|---|
| Sanity | about 1 day before | `PROFILE=sanity`: 1% of 694 req/s, 1 min ramp + 4 min | `-e ABORT_DELAY=60s` | about 7 req/s; browser 9, shopper 3, account 1 iterations/min | about 2,000 |
| Warm-up | the day of the scale run, before it | `PROFILE=warmup`: the scale shape compressed to 15 min at 10% | `-e ABORT_DELAY=90s` | up to about 87 req/s; browser up to 108, shopper 33, account 13 iterations/min; 5 registrations | about 50,000 |
| Scale | the agreed window | `PROFILE=scale`: 85 min | `-e ABORT_DELAY=3m` | busiest hour 2.5M requests (694 req/s average), up to about 870 req/s in a surge | about 2.9M |

- **Sanity** runs browser, shopper and account (the default mix). Check the new registration separately the same day with one
  iteration: `-e PROFILE=smoke -e SCENARIOS=register -e MAX_RPM_PER_VU=12`. A validated product subset is enough
  (`node prep/validate-products.mjs hot_topic --env prod --allow-prod --max-valid 60`).
- **Warm-up and scale** need the full product list validated within `maxDataAgeHours` (12 h) of the run start, and valid
  accounts for `account` on `hottopic-perf` (978 are on file; the logged-in scenario takes them in turn by iteration number, so a list of about 300 or more is enough for the peak and every account is used more than once in the full run). Run the warm-up first, then
  the scale run on the same day, and re-validate if the data is older than 12 h.
- **Abort guard:** all three stop on more than 10% failures after `ABORT_DELAY` (default `ABORT_FAILED_RATE=0.1`).
- **Warm-up check before the scale run:** the measured req/iter and total req/s match the plan (browser and shopper 34 req/iter,
  account 39, register 12); correct `requestsPerIteration` in `test.js` if not. Look at the busiest 60 s window afterwards.
- **VUs:** scale pre-allocates about 1,030 VUs and can grow to about 3,100 (surge headroom). Run it from a machine with enough CPU, memory
  and network for that (a cloud VM, not a laptop), and watch k6 for dropped iterations.
- **Registrations** create accounts and loyalty profiles that cannot be deleted: 1 (sanity) + 5 (warm-up) + 50 (scale).

- **Logged-in users are existing test accounts** (`data/accounts_<env>.json`), never the accounts created by `register`. Those are not reused. Check the list on the targeted client before the warm-up: `node prep/validate-accounts.mjs hot_topic --env prod --allow-prod [--max-rpm 40] [--limit n]` does a guest token and a login for each account (signed like the app, 2 requests per account, about 50 min for 978 accounts at 40 requests/min), keeps the original list in `data/accounts_<env>.all.json`, the result per account in `accounts_<env>.checked.json`, and rewrites `accounts_<env>.json` without the accounts that failed. It resumes like the other validators (`--max-age`, `--fresh`). Credentials are never printed.

## Running

- **Secrets.** `account` and `register` sign every request and need the key and salt in
  `secrets/hot_topic.secrets` (gitignored), with `poq-secret-key=` and `poq-salt=` lines:
  `k6 run --secret-source=file=secrets/hot_topic.secrets …`
  - The key is derived once in `setup()`; the salt is the configured secret.
  - The signature is `HMAC(key, body + poq-user-id)` with the whitespace removed *outside* JSON strings.
    It reproduced the app's `poq-auth` on 22 captured prod calls.
- **Accounts for `account`:** `data/accounts_<env>.json` must hold accounts that exist on the targeted
  client. The existing lists were made for the live `hottopic` client; check them against `hottopic-perf`.
- **Products:** validate on the targeted client before a run. The validators read the same config, so
  they now go to `hottopic-perf` as well.
- **Run script** ([scripts/run.sh](scripts/run.sh)): a thin bash wrapper (Linux and macOS) that builds the plain `k6 run`
  command for the three runs above, prints it, and names the outputs. Run it from anywhere:
  ```bash
  clients/hot_topic/scripts/run.sh <sanity|warmup|load> [--env prod|staging] [--max-data-age <hours>] [--save-output] [--prom] [--yes] [--dry-run] [-- extra k6 args]
  ```
  - `load` is `PROFILE=scale`. `ABORT_DELAY` is 60 s, 90 s and 3 min for sanity, warm-up and load.
  - On prod it asks you to type `PROD` first (`--yes` skips it). `--dry-run` prints the command and sends nothing.
  - It does not validate products; do that first (see above). `--max-data-age 72` overrides the 12 h data
    limit (sanity only).
  - It writes one folder per run, `results/hot_topic_<env>_<run>_<timestamp>/`, with `report.html`, `failures.log`,
    `summary.json`, `endpoints.csv`, `endpoints.html` and `failures.csv`. The dashboard is on `localhost:5665`; the HTML
    report is the saved copy of it, written when the run ends.
  - `--prom` also streams the metrics to Prometheus for the Grafana dashboard (see the main README).
  - `--save-output` also keeps the console output in `<run folder>/output.txt`. Piping the output into a file stops k6
    drawing its live progress bar (it prints a new text block every second instead), so it is off by default.
  - Use `tmux` on a VM for the 15 and 85 minute runs, so a dropped SSH session does not stop the test.

## Test data

- **Categories:** `node prep/extract-categories.mjs hot_topic --env <env> [--allow-prod] [--max-rpm 40]` walks the `/shop` tree and opens every
  leaf category as a product list (the plain call and the first sort order; `--all-sorts` for every one). It resumes where it stopped (results younger than `--max-age`, default 24 h, are kept; `--fresh` starts over). It writes `data/categories_<env>.json` (all categories, the check result
  of each, and `validIds`) and a CSV. Categories answering 500 or returning no products are marked not usable (any category with at least one product is kept; `--min-items` changes that) (the sanity run on `hottopic-perf`
  hit `band-merch-shop-by-artist-morgan-wallen`, which returned 500 for every sort). k6 reads it in `setup()`: when `categories_<env>.json` exists for the same environment and API path and is at most `maxCategoryAgeHours` old (default 168), its `validIds` replace the live `/shop` list, and the run prints `N validated categories`; otherwise the live list is used and a warning is added to the report.
- **Inputs:** `input/products_prod.json`, `input/products_staging.json` (per-environment lists).
- **Validator rules:** a fresh device id per cart session; add-to-bag body `{quantity, variantId, productId}`; success = HTTP 200.
- **Accounts** (`data/accounts_<env>.json`, gitignored): prod 978, staging 496.
- **Keywords:** `data/keywords.json`, a curated list of realistic Hot Topic searches (bands, licences, apparel types, gifts). It replaced the 9,890 random JMeter dictionary words, some of which made the search return 500 (e.g. `ursae`). Provisional: the list is not yet checked against the API and not weighted by real search volume. `data/universal_links.json` holds the universal links.
- Only about 15% of the listed prod catalogue is purchasable on the live client; 40 of 389 checked products return HTTP 500 on the PDP.

## Open items

- `Remove voucher` (`DELETE /vouchers/{appId}/{coupon_item_id}`, id from the add response) is taken from the card_factory JMeter suite and has not yet been seen against the Hot Topic API: check its status and body on the first run.
- The old Gen-2 login, forgot-password, account-details and cart-wishlist calls were removed: the app
  no longer makes them. The previous version is in `results/backup_pre_gen3_2026-10-01/`.
- The app accepted a birth date that makes the user 12 years old at registration (live client).
