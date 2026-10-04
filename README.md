# Poq k6 load tests

k6 load tests for Poq client apps. This project replaces the JMeter suites in `Poq.Testing.LoadTest` and the Python data utilities in `Poq.Testing.Utilities`.
The migration plan, including decisions still open and the phase each part belongs to, is in [.claude/k6-migration-plan.md](.claude/k6-migration-plan.md).

## Clients

Each client has its own folder under `clients/`, with a `README.md` for everything specific to it:
scenarios, traffic mix, load target, client-only calls and options, test data, and open items.

| Client | Folder |
|---|---|
| The White Company | [clients/twc](clients/twc/README.md) |
| Hot Topic | [clients/hot_topic](clients/hot_topic/README.md) |
| Pacsun | [clients/pacsun](clients/pacsun/README.md) |

**Test data** is refreshed with the Node validators in `prep/`, which replace the Python utilities.

## Requirements

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) v2.3 or later
- Node.js 20 or later, used only for `run.mjs` and the `prep/` scripts. There are no npm dependencies.

## Running a test

Run from the project root with plain `k6 run`, passing options as `-e NAME=value`:

```bash
# smoke on staging
k6 run -e ENV=staging -e PROFILE=smoke clients/<client>/test.js

# paced prod check: 2 scenarios × 18 req/min = 36 req/min total, for 6 minutes
k6 run -e ENV=prod -e ALLOW_PROD=true -e PROFILE=paced \
       -e SCENARIOS=<scenarioA>,<scenarioB> -e MAX_RPM_PER_VU=18 -e DURATION=6m \
       clients/<client>/test.js

# add the failure log and the HTML dashboard (k6's own flags and env vars)
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/report.html \
k6 run --log-format raw --console-output results/failures.log -e ENV=staging -e PROFILE=sanity clients/<client>/test.js
```

| `-e` option | Meaning |
|---|---|
| `ENV=dev\|staging\|prod` | Target environment. Required. |
| `PROFILE=smoke\|sanity\|warmup\|load\|paced\|custom` | Load profile (see below). Default `smoke`. |
| `ALLOW_PROD=true` | Required to *run* against prod (checked at the start of setup; `k6 inspect` doesn't need it). |
| `SCENARIOS=a,b` | Run only these scenarios; shares are renormalised. A client's read-only scenario gives a read-only run. |
| `MAX_RPM_PER_VU=n` | Caps each VU at n requests per minute. Required for `paced`. |
| `DURATION=6m` | Run time for `paced`; hold time for `custom`. |
| `TARGET_RPS=n`, `RAMP_UP=10s` | Absolute request rate and ramp-up for `custom`. |
| `THINK_TIME=min,max` | Seconds between journey steps (`0` disables them). |
| `ALLOW_STALE_DATA=true` | Allows validated data older than the client's limit. Refused on prod. |
| `MAX_DATA_AGE_HOURS=n` | Overrides the client's data age limit for this run (e.g. `48`). Works on prod; the data must still be for the same environment. |
| `FAILURE_LOG_LIMIT=n` | Full-detail failure lines per VU, request and status (default 10; 0 = unlimited). |
| `ABORT_FAILED_RATE=0.1` | Prod only: abort the run above this failure rate (default 10%). |
| `ABORT_DELAY=60s` | Prod only: start evaluating the abort after this long (default 60 s). |
| `BASE_URL=…` | Overrides the client host, for example for a local mock. |
| `API_PATH=…` | Overrides the `/clients/<apiPath>` API segment, e.g. an isolated perf client. |

Client-specific options are listed in the client's own `README.md`.

Each run writes `results/<client>_<env>_<profile>_<timestamp>_{summary.json, endpoints.csv, failures.csv}`.

**Failure log.** The per-request failure log is k6's console output, so it only goes to a file with `--console-output <file>`.
- Add `--log-format raw` to get one clean JSON line per failure.
- k6 **appends** to that file, so give each run its own file name.

**Optional wrapper.** `node run.mjs <client> <profile> --env <env> [--allow-prod] [--scenarios a,b] [--max-rpm n] [--duration d] …` runs the same `k6 run` for you. It puts everything, including the failure log and `report.html`, into one folder per run.

### Profiles

| Profile | Load | Duration |
|---|---|---|
| `smoke` | 1 iteration per scenario | — |
| `sanity` | 1% of the client's load target | 5 min |
| `warmup` | 10% | 15 min (a client with a `load.shape` gets the same structure compressed to 15 min) |
| `load` | 100% | ramp-up, then hold (the client's `load` settings) |
| `paced` | 1 VU per scenario, `MAX_RPM_PER_VU` each | `DURATION` |
| `custom` | `TARGET_RPS` req/s | `RAMP_UP` + `DURATION` |
| `scale` | the client's `load.shape`: stages of minutes × a factor of the target rate, scenarios that start later (`startAfter`), scenarios with a fixed iteration count (`fixed`) | the sum of the stages |

For `custom`, the request rate reaches the target about one session length after the ramp ends. With sessions of about 30–50 s, for example, 60 req/s held for a full minute needs `-e RAMP_UP=30s -e DURATION=1m30s`.

`performance` is intentionally undefined until its level is agreed (plan §16).

Load is an open model (`ramping-arrival-rate`), derived from the client's target throughput (`load.targetRps` in `clients/<client>/config.js`; plan §13).

## Output

Each run writes `results/<client>_<env>_<profile>_<timestamp>/`:

| File | Content |
|---|---|
| `report.html` | k6 web dashboard export. It is skipped for very short runs such as `smoke`. |
| `summary.json` | Full k6 summary data. |
| `endpoints.csv` | Per request: count, failure %, avg / p90 / p95 / p99 / max, failures, p95 threshold. |
| `endpoints.html` | The endpoint, scenario and failure tables as one page you can open in a browser (click a column to sort; rows over their limit are shaded). The dashboard `report.html` has run-wide charts only. |
| `failures.csv` | Failures per request and status. This file holds the complete counts. |
| `failures.log` | One JSON line per request that did not return its expected result. Detail is capped per virtual user (see below). |

The terminal prints the same scenario and endpoint tables. It also shows **req/iter**, the measured number of requests per iteration; keep the scenario's `requestsPerIteration` in `test.js` in line with it.

**Exit codes:** `0` all thresholds passed; `99` thresholds breached; other codes mean k6 could not run (for example, stale data or a setup failure).

## Live Grafana dashboard (optional)

The k6 web dashboard (`K6_WEB_DASHBOARD=true`, port 5665) shows run-wide charts only. For per-endpoint charts, push the
metrics to Prometheus and view them in Grafana. Requests carry a `name` tag, so panels group by `name`.

1. Run Prometheus and Grafana once, on the machine that runs k6, e.g. with Docker Compose. Prometheus needs
   `--web.enable-remote-write-receiver`; bind both ports to `127.0.0.1` (ports 9090 and 3000). In Grafana add a Prometheus
   data source (`http://prometheus:9090` when both run in Compose) and import the "k6 Prometheus" dashboard (ID 19665).
2. Add k6's own Prometheus output to the run. Dropping the `url` system tag keeps the label count low:
   ```bash
   K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write K6_PROMETHEUS_RW_TREND_STATS="avg,p(95),p(99),max" \
   k6 run -o experimental-prometheus-rw --tag testid=<run name> \
     --system-tags=proto,subproto,status,method,scenario,expected_response,error,error_code,tls_version,group ...
   ```
3. Open Grafana, pick the `testid` in the dashboard and set the time range to the last 15 minutes with a 5 s refresh.

- **k6 on your own machine:** open http://localhost:3000 directly.
- **k6 on a VM:** nothing is exposed; tunnel the ports from your machine and open http://localhost:3000:
  `ssh -N -L 3000:localhost:3000 -L 5665:localhost:5665 <vm>`. (The k6 dashboard on 5665 works the same way.)
- Prometheus keeps the data (7 days with `--storage.tsdb.retention.time=7d`), so past runs stay visible after k6 ends.
  The dashboard from `K6_WEB_DASHBOARD` disappears with the run; keep its `report.html` export.

## Grafana Cloud k6 (optional)

Stream a run to Grafana Cloud k6 with k6's own cloud output. Nothing else changes.

```bash
export K6_CLOUD_TOKEN=<stack or project token>   # from your shell; never commit it
export K6_CLOUD_PROJECT_ID=<project id>          # optional; default project otherwise
k6 run --out cloud -e ENV=staging -e PROFILE=smoke -e ALLOW_STALE_DATA=true clients/twc/test.js
```

- The test is named `<client>_<env>_<profile>`, and every metric carries `client`, `env` and `profile` tags. Per-endpoint panels use the `name` tag (same names across clients).
- Use `--out cloud` together with the local outputs: the HTML report, `summary.json` and the failure log are still written locally.
- The prod rules still apply: explicit request, `ALLOW_PROD=true`, and a rate under the agreed cap.
- `k6 run --out cloud` sends the requests from your machine and only streams the metrics. Do not use `k6 cloud run`: it runs on Grafana's load generators, away from the rate caps.

## Failure logging

A request counts as a failure when any of these happens:
- the status is not one of the expected statuses for that request;
- a body check fails;
- a value that a later step needs is missing;
- a transport error occurs (timeout, connection error; logged as status `0`).

Each failure is:
- **counted** in `failures.csv`;
- **logged** to `failures.log` with the request, the expected vs actual result, response headers from an allowlist, the body truncated to 1 KB, and test-data references (`product_id`, `sku`, …).

Redaction:
- Tokens, `Authorization`, `poq-auth`, cookies and passwords are never logged.
- Response bodies of authentication calls are never logged.
- Emails are masked.

`FAILURE_LOG_LIMIT` (default `10`, `0` means unlimited) caps full-detail lines per virtual user, per request and status. Every failure is still counted in `failures.csv`.

```bash
FAILURE_LOG_LIMIT=0 node run.mjs <client> smoke --env staging     # log everything
node prep/report-failing-products.mjs results/<run>/failures.log  # failures grouped by product
```

## Test data

**Validated data** is `clients/<client>/data/products_<env>.json` (and, for clients with bundles, `gift_bundles_<env>.json`). It contains only in-stock products and bundles that can be added to the bag.

- **Before every run:** validate the product list (stock quantity ≥ 5 and an add-to-cart proof; plan §10.1).
  - For load and performance runs, validate the full list.
  - For a sanity run, a validated subset is fine; the file's `scope` says so, and the run report prints it.
- **A test refuses to start** when a file was made for a different environment, or is older than the client's `maxDataAgeHours`.
  - `-e ALLOW_STALE_DATA=true` overrides this outside prod only.
  - Optional data (such as gift bundles) can be missing; the step that needs it is then skipped.
- **Categories (optional):** if `clients/<client>/data/categories_<env>.json` exists (from `prep/extract-categories.mjs`) for the same environment and API path and is at most `maxCategoryAgeHours` old (default 168; set it in the client's `config.js`), `setup()` uses its validated category ids instead of the live `/shop` list. Otherwise the live list is used.
- **Refreshing the data:**

```bash
node prep/validate-products.mjs <client> --env staging                   # full list (~3.5 s per product)
node prep/validate-products.mjs <client> --env staging --max-valid 60    # sanity subset
node prep/validate-gift-bundles.mjs <client> --env staging               # clients with gift bundles
node prep/extract-categories.mjs <client> --env staging                    # category tree + which categories work (PLP and every sort order)
node prep/validate-accounts.mjs hot_topic --env staging                       # login accounts: guest token + login for each; keeps the ones that work
# prod needs --allow-prod; --max-rpm <n> caps the validator's request rate (e.g. 40)
# --input <file> uses another id list; --fresh ignores earlier results; --max-age <hours> sets the resume window
```

  - **Input lists:** `clients/<client>/input/products.json` (or `products_<env>.json`) and `gift_bundles.json`, each a JSON array of IDs.
  - **Rules** (ported from the Python validators):
    - Products: stock quantity ≥ 5 (`--min-stock`) and a guest-cart add-to-cart proof. The client config's `validator` picks the add-to-cart body and success rule (`quantityAdded > 0`, HTTP 200, or the variant present in the returned bag). The default variant is tried first; a new cart session is used every 10 products; there is a 2–5 s pause between products (`--delay`).
    - Bundles: each entry resolved by `ctaStatus == "AddToBag"`, highest stock first, with a size fallback on stock rejections; each bundle gets its own guest cart.
  - The output records why each product or bundle was rejected. Progress is saved to `…json.partial` and moved into place only when the run finishes, so a k6 run never picks up a half-written file.
  - **Products resume.** Each product records when it was validated (`validatedAt`; rejections: `checkedAt`). The partial file is written every 10 checks and on Ctrl+C. Starting the validator again with the same command keeps everything younger than `--max-age` (default: the client's `maxDataAgeHours`) from the final file and the partial, and checks only the rest. To finish with what is valid so far, rerun with `--max-valid <n>`: it needs no new requests and writes the final file. The file's `generatedAt` is the age of its **oldest** product, so k6's freshness check cannot be fooled by carried-over entries. Results made for another environment or `apiPath` are ignored.

**Accounts** for logged-in scenarios are in `clients/<client>/data/accounts_<env>.json`, as `[{ "email", "password" }]`.

- These files are **gitignored** and never committed or logged.
- VU *n* always uses account *n*, so no two sessions share an account; k6 has no shared state for an account pool. A VU with no matching account runs the guest journey instead, and is counted as a correlation failure in `failures.csv`.

**Fetched fresh every run** in `setup()`: categories (`/shop`).

**Generated at runtime:**
- user IDs (`poq-user-id`: one per session, or one per VU for device-based clients — see the client's README);
- store-search coordinates inside the client's bounding box;
- guest cart-sign emails (`perf-…@poq.performance.test.com`).

**Keywords** are in `clients/<client>/data/keywords.json`. Choosing realistic keywords is an open decision.

## Prod safety

- A run against prod needs `-e ALLOW_PROD=true`. The check is the first thing `setup()` does, so a run without it stops before any request is sent. `k6 inspect` (which sends nothing) works for prod without it.
- On prod, the run aborts if the failure rate goes above 10%, evaluated from 60 s into the run.
  - Change it per run with `-e ABORT_FAILED_RATE=0.05` (a fraction) and `-e ABORT_DELAY=30s`.
  - A client's defaults are in its `config.js` (`limits.prodAbortFailedRate`, `limits.prodAbortDelay`).
  - For short runs, a shorter delay protects sooner. With the 60 s default, a run that lasts about a minute is barely protected.
- `--allow-stale-data` is refused on prod.
- **Shopper journeys write to live carts and wishlists** (always cleaned up afterwards). For a read-only prod check, run only the client's read-only scenario (see its README).
- Client-specific prod notes are in the client's README.

## Project layout

```
lib/
  platform/          standard Poq API endpoints, one file per area (app, catalog, product, cart,
                     wishlist, stores, checkout, account) — shared by every client
  http.js            request wrapper: header contract, checks, failure logging, endpoint tweaks
  test-kit.js        the plumbing every clients/<client>/test.js shares
  config.js auth.js data.js profiles.js summary.js
clients/<client>/
  README.md          everything specific to this client
  config.js          environments, headers, mix, load target, limits, endpoint tweaks (data only)
  endpoints.js       only what this client alone has (integrations, structurally different calls)
  journeys.js        the order of steps, calling lib/platform + ./endpoints.js
  test.js            scenario list + one exported function per scenario
  data/  input/
prep/                Node scripts run outside k6 (data validation, reports)
run.mjs              optional launcher: one results folder per run
```

**Where an endpoint goes:**
- **A standard Poq endpoint** goes in `lib/platform/`.
- **Small per-client differences** go in the client's `config.js` under `endpoints`, keyed by the platform endpoint. For example:

  ```js
  endpoints: {
    search:  { query: { isBloomreachKeywordSearch: 'true' } },            // extra parameter
    plp:     { query: { 'slot-content-id': undefined } },                 // drop a parameter
    banners: { path: '/banners/{appId}/', query: { poqUserId: '{poqUserId}' } },
    getCart: { checks: { 'has cartId': (j) => j.cartId } },               // extra body check
  }
  ```

  `path`, `query`, `headers`, `checks` and `expect` can be tweaked. `{appId}` and `{poqUserId}` are filled in.
- **Structurally different calls and client-only integrations** go in `clients/<client>/endpoints.js` (for example a client's own login flow, or a bag API with a different shape). Each client's README lists its own.
- **Request names stay the same across clients**, so reports and limits can be compared between them.

## Adding a client

1. Create `clients/<client>/` with a `config.js`, starting from the closest existing client (a Gen-3 guest-token client, or a Gen-2 device-based one). To find the calls a client's app really makes, use the project skill `.claude/skills/app-traffic-capture/` (Maestro + Charles).
2. Fill in `config.js`:
   - environments (`baseUrl`, `appId`, `appIdentifier`, `versionCode`, `userAgent`);
   - `apiPath` and `session` (`guestToken` or `device`);
   - `headers`, `mix`, `load`, `limits`, `plpVariants`;
   - `endpoints` tweaks, only where the client differs from the platform.
3. Write `journeys.js` from `lib/platform` calls. Add an `endpoints.js` only for what the platform doesn't cover.
4. Write a short `test.js` with `createTest()`, modelled on an existing client's `test.js`.
5. Add `input/products.json`, then validate: `node prep/validate-products.mjs <client> --env staging`.
6. Run `smoke`, then `sanity`, and compare against the JMeter baseline if one exists (plan §15, phase 4).
7. Write `clients/<client>/README.md` with the client's scenarios, options, data and open items, and add it to the client table above.

## Checking a script without sending requests

```bash
k6 inspect -e ENV=staging -e PROFILE=sanity -e ALLOW_STALE_DATA=true clients/<client>/test.js
```

This resolves the config, scenarios and thresholds offline and sends nothing.

`BASE_URL=http://localhost:8787` overrides the client host. This is useful for running against a local mock or proxy.

npm scripts are only for the Node `prep/` validators. Everything k6 runs with the `k6` command.
# Poq.Testing.k6.LoadTest
