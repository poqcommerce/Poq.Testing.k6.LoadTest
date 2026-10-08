# CLAUDE.md — Poq k6 load tests

k6 load tests for Poq's client apps (The White Company, Hot Topic, …). The project replaces two legacy repos:
- JMeter suites in `../Poq.Testing.LoadTest`;
- Python data tools in `../Poq.Testing.Utilities`.

- **High-level plan:** [.claude/k6-migration-plan.md](.claude/k6-migration-plan.md). Read it before implementation work. Its "Where we are" section lists what's done and what's left. Record decisions and deviations as a new row in its revision table; don't diverge silently.
- **How to run things:** [README.md](README.md). All `-e` options, profiles, outputs, test data and adding a client are there. Keep it generic: anything specific to one client goes in `clients/<client>/README.md`.

## Commands

k6 is always run with the **`k6` command itself**. Never add npm scripts or other wrappers around k6.

```bash
# offline: resolve config, scenarios and thresholds; sends nothing (works for every ENV)
k6 inspect -e ENV=staging -e PROFILE=sanity clients/twc/test.js

# smoke on staging (staging test data is old, so ALLOW_STALE_DATA is needed there)
k6 run -e ENV=staging -e PROFILE=smoke -e ALLOW_STALE_DATA=true clients/twc/test.js

# low-impact paced run: 1 VU per scenario, each capped at MAX_RPM_PER_VU
k6 run -e ENV=prod -e ALLOW_PROD=true -e PROFILE=paced -e MAX_RPM_PER_VU=15 -e DURATION=5m \
       -e SCENARIOS=browser,shopper -e ABORT_DELAY=15s \
       --log-format raw --console-output results/<run>_failures.log clients/hot_topic/test.js

# validate products before a run (Node; writes clients/<client>/data/products_<env>.json)
node prep/validate-products.mjs <client> --env <env> [--allow-prod] [--max-valid 60] [--max-rpm 40]
node prep/validate-gift-bundles.mjs twc --env <env> [--allow-prod] [--max-rpm 40]
```

- **Profiles:** `smoke`, `sanity`, `warmup`, `load`, `paced`, `custom`.
- **Exit codes:** `0` = thresholds passed; `99` = thresholds breached; `108` = test aborted (guard, stale data, or a failed setup step).
- **Signed scenarios:** Hot Topic's `account` and `register` scenarios need `--secret-source=file=secrets/hot_topic.secrets` (every request is signed with `poq-auth`). Hot Topic targets `hottopic-perf`; `-e API_PATH=hottopic/v2` switches to the live client.
- **Optional wrapper:** `run.mjs` puts one run's outputs into a single folder. Nothing depends on it.
- **Discovering a client's endpoints from its app** (iOS/Android via Maestro MCP + Charles): use the project skill `.claude/skills/app-traffic-capture/`; its scripts capture per step and summarise the calls.

## Safety rules (non-negotiable)

- **Never run anything against prod unless the user explicitly asks for that specific run in the current conversation.** This covers `k6 run` with `ENV=prod` and any validator with `--allow-prod`. Approving a plan is not approval to run on prod.
- **Keep prod traffic under the rate the user sets** (so far: under 60 req/min in total):
  - use `PROFILE=paced` with `MAX_RPM_PER_VU`, or the validators' `--max-rpm`;
  - run tools one after another, never at the same time;
  - check the busiest 60-second window afterwards (`--out json` gives request timestamps);
  - use a short `ABORT_DELAY` for short prod runs.
- **Product data must be validated right before a run.** Poq can't check client catalogues at the source, so an unvalidated list fills the test with out-of-stock noise.
  - Load and performance runs: validate the full list.
  - Sanity runs: a validated subset (`--max-valid`) is fine.
  - Never replace validation with sampling or spot checks.
  - The test refuses data that is older than `maxDataAgeHours` or was made for another environment.
- **Prod guards live in `setup()`** (`assertRunAllowed` in `lib/config.js`), before any request:
  - a prod run needs `ALLOW_PROD=true`;
  - `ALLOW_STALE_DATA` is refused on prod;
  - prod aborts when failures exceed `ABORT_FAILED_RATE` (default 10%) after `ABORT_DELAY` (default 60 s).
  - Keep these guards when refactoring.
- **Secrets and credentials never go into git, code, logs or docs.**
  - `secrets/*.secrets` and `clients/*/data/accounts_*.json` are gitignored.
  - Read secrets through `k6/secrets`.
  - The failure log redacts tokens, `Authorization`, `poq-auth`, cookies, passwords and emails. Mark auth calls `sensitive: true`.
- **Side effects:** journeys clean up what they add (bag lines, wishlist items, gift boxes). Keep it that way. Say so before running flows with external effects, e.g. Hot Topic `register` (opt-in, `-e SCENARIOS=register`) creates real accounts that the API cannot delete.

## Structure and where code goes

Customers are **clients**, never "brands".

```
lib/platform/      standard Poq API endpoints (Gen-3 contract), one file per area — shared by all clients
lib/http.js        request(): header contract, checks, failure logging, per-client endpoint tweaks
lib/test-kit.js    shared test.js plumbing (data, scenarios, options, baseSetup, session, summary)
clients/<client>/  config.js (data only) · endpoints.js (client-only calls) · journeys.js (step order) · test.js · data/ · input/
prep/              Node validators and reports (no dependencies)
```

- **Standard Poq endpoint:** goes in `lib/platform/<area>.js`. Every request passes a stable `key` (for tweaks) and a `name` (for reports).
- **Small per-client difference** (extra or dropped query parameter, path variant, extra checks, expected status): declare it in the client's `config.js` under `endpoints: { <key>: { path, query, headers, checks, expect } }`. `{appId}` and `{poqUserId}` are filled in; a query value of `undefined` drops that parameter.
  - Never put `if (client === …)` in shared code.
- **Structurally different call or client-only integration:** goes in `clients/<client>/endpoints.js`. Examples:
  - TWC: Dynamic Yield, the storefront PKCE login, the gift box.
  - Hot Topic: the Gen-2 bag, wishlist and stores calls, the member flow (bearer login, profile, address book, registration) and QAS.
  - Move a call into `lib/platform` once a second client needs it.
- **Journeys** are plain functions per client that call platform and client endpoints in the app's order. There is no journey DSL.
- **Request names** stay identical across clients for the same endpoint (e.g. "Search by keyword"), so reports and limits can be compared.
- **Identity:**
  - `session: 'guestToken'` (Gen-3) gives a new guest session each iteration.
  - `session: 'device'` (Gen-2) gives one persistent `poq-user-id` per VU.
  - Logged-in scenarios take accounts in turn by iteration number (`exec.scenario.iterationInTest % accounts.length`); k6 VU ids are global across scenarios, so they can't index the list. Keep the scenario's `maxVUs` below the account count so no two live sessions share an account. An empty list falls back to the guest journey and is counted as such.

## Conventions

- Plain JavaScript ES modules, k6 v2.3+ and Node 20+. **No npm dependencies, no k6 extensions, no build step.** Prefer native k6 features (`k6/crypto`, WebCrypto, `k6/secrets`, `SharedArray`, `handleSummary`).
- **Don't over-engineer.** No class hierarchies, plugin registries, config-driven flows, API-generation adapters, or one file per endpoint. Add an abstraction only when a second real use exists.
- **Every request goes through `request()`:**
  - declare the expected statuses (a 4xx is never a pass);
  - add 1–3 body checks based on evidence (a JMeter assertion or a known response shape);
  - add `data` references (`product_id`, `sku`, …) so failures can be traced.
  - When a value a later step needs is missing, call `correlationFailure` and end the iteration. Never send a placeholder.
- **Match the surrounding code:** short comments that explain *why* (JMeter parity or a deliberate difference); names like the existing ones.
- **Limits:** per-endpoint p95 limits and the traffic mix live in the client's `config.js`, with a note on where each value came from (baseline run, JMeter profile, or "provisional").

## Verifying changes

- **Offline first:** `k6 inspect …` for every client you touched.
- **Journeys, headers or request building:** run the journeys against a local mock (`-e BASE_URL=http://localhost:<port>`, `-e THINK_TIME=0`, `--http-debug=full`). Compare the requests sent before and after: method, path, query keys, headers and body structure. Refactors must produce identical requests.
- **Validators:** run against a mock with `BASE_URL=…` and `--env dev` (or back up the data file first), so real data files aren't overwritten.
- **Real-environment runs** only as described under Safety rules. Report faithfully: request counts, failures with their failure-log reason, and the busiest 60 s window on prod.

## Open decisions to respect

These are listed in the plan under "Decisions for the team". Implementation runs on the provisional defaults marked in each client's config:
- think time 1–3 s;
- `maxDataAgeHours` 12;
- provisional latency limits and traffic mix;
- keywords;
- Hot Topic voucher handling;
- registration runs (they create accounts on the target client).

Don't settle these silently; raise them with the user.
