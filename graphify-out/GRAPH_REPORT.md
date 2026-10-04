# Graph Report - Poq.Testing.k6.LoadTest  (2026-10-04)

## Corpus Check
- 72 files · ~494,153 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 2)

## Summary
- 456 nodes · 933 edges · 27 communities (22 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- TWC Test & Config
- Plan & Project Decisions
- Hot Topic Journeys
- Charles Capture Tools
- Hot Topic Endpoints
- Product Platform API
- App Content Platform API
- Pacsun Endpoints
- Product Validation Prep
- Validate Products Script
- HTTP Request Core
- Poq API Prep Client
- Hot Topic Test & Config
- Account Validation
- Run Wrapper
- TWC Endpoints
- Account Platform API
- Package Manifest
- Pacsun Test & Config
- Cart Platform API
- Hot Topic run.sh
- API Session Helpers
- Failing Products Report
- Register Curl Script
- Request Conventions
- capture_step Script
- Proxy Script

## God Nodes (most connected - your core abstractions)
1. `request()` - 104 edges
2. `productRefs()` - 27 edges
3. `correlationFailure()` - 23 edges
4. `randomItem()` - 19 edges
5. `think()` - 18 edges
6. `createTest()` - 16 edges
7. `JMeter to k6 Migration Plan` - 11 edges
8. `randomPoint()` - 10 edges
9. `makeHandleSummary()` - 10 edges
10. `Root README (Poq k6 load tests)` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Capture safety: dev/staging only, ask before external effects` --semantically_similar_to--> `Safety rules (no prod without explicit ask, rate cap)`  [INFERRED] [semantically similar]
  .claude/skills/app-traffic-capture/SKILL.md → CLAUDE.md
- `wishlistIds()` --calls--> `request()`  [EXTRACTED]
  clients/hot_topic/endpoints.js → lib/http.js
- `wishlistLanding()` --calls--> `request()`  [EXTRACTED]
  clients/hot_topic/endpoints.js → lib/http.js
- `updateProfile()` --calls--> `request()`  [EXTRACTED]
  clients/hot_topic/endpoints.js → lib/http.js
- `qas()` --calls--> `request()`  [EXTRACTED]
  clients/hot_topic/endpoints.js → lib/http.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Per-client READMEs under generic root README** — readme_root, clients_twc_readme_client, clients_hot_topic_readme_client, clients_pacsun_readme_client [EXTRACTED 1.00]
- **App traffic capture workflow** — claude_skills_app_traffic_capture_skill_md_maestro_mcp, claude_skills_app_traffic_capture_skill_md_charles_proxy, claude_skills_app_traffic_capture_skill_md_capture_scripts, claude_skills_app_traffic_capture_skill_md_app_traffic_capture [EXTRACTED 1.00]
- **Prod safety rules across docs** — claude_md_safety_rules, claude_k6_migration_plan_prod_guards, readme_prod_safety [INFERRED 0.85]

## Communities (27 total, 5 thin omitted)

### Community 0 - "TWC Test & Config"
Cohesion: 0.08
Nodes (42): giftBundles, guestBrowse(), guestShopper(), handleSummary, loggedInShopper(), options, sessionData(), setup() (+34 more)

### Community 1 - "Plan & Project Decisions"
Cohesion: 0.05
Nodes (37): Grafana Cloud k6 output, Hot Topic register scenario (Gen-2 Postman combination), Hot Topic scale profile shape, Legacy JMeter suites (Poq.Testing.LoadTest), Open Decisions for the Team, Migration Phases 0-7, JMeter to k6 Migration Plan, Platform findings to raise (+29 more)

### Community 2 - "Hot Topic Journeys"
Cohesion: 0.12
Nodes (35): account(), bagAndUpdate(), browser(), carousels(), endpointNames, openApp(), register(), searchSteps() (+27 more)

### Community 3 - "Charles Capture Tools"
Cohesion: 0.13
Nodes (11): body_text(), charles(), main(), mask(), mask_query(), body(), headers(), main() (+3 more)

### Community 4 - "Hot Topic Endpoints"
Cohesion: 0.12
Nodes (23): addressBody(), addressBook(), findKey(), getAddresses(), getProfile(), has(), login(), more() (+15 more)

### Community 5 - "Product Platform API"
Cohesion: 0.14
Nodes (18): addToBag(), NAMES, NAMES, productDetails(), productListings(), productRefs(), recentlyViewed(), recommendations() (+10 more)

### Community 6 - "App Content Platform API"
Cohesion: 0.16
Nodes (20): request(), appStories(), banners(), contentBlocks(), contentData(), globalBanners(), launch(), NAMES (+12 more)

### Community 7 - "Pacsun Endpoints"
Cohesion: 0.13
Nodes (19): addToBag(), deleteBagItem(), homeCarousels(), inBag(), NAMES, plpNextPage(), predictiveProducts(), searchNextPage() (+11 more)

### Community 8 - "Product Validation Prep"
Cohesion: 0.12
Nodes (14): api, bad, categories, check(), minItems, out, { positional, opts }, save() (+6 more)

### Community 9 - "Validate Products Script"
Cohesion: 0.14
Nodes (17): shuffle(), writeData(), allIds, api, countBy(), delay, doneIds, keepNewest() (+9 more)

### Community 10 - "HTTP Request Core"
Cohesion: 0.13
Nodes (16): apiUrl(), applyTweak(), endpointFailures, LOG_LIMIT, loggedCounts, mapToFns(), pace(), parseJson() (+8 more)

### Community 11 - "Poq API Prep Client"
Cohesion: 0.16
Nodes (14): between(), ENVIRONMENTS, loadClient(), parseArgs(), readIds(), sleep(), api, bundles (+6 more)

### Community 12 - "Hot Topic Test & Config"
Cohesion: 0.18
Nodes (13): NAMES, account(), browser(), handleSummary, options, readSecret(), register(), sessionData() (+5 more)

### Community 13 - "Account Validation"
Cohesion: 0.15
Nodes (12): all, api, check(), compact(), key, { positional, opts }, reasons, results (+4 more)

### Community 14 - "Run Wrapper"
Cohesion: 0.13
Nodes (10): argv, [clientName, profile], env, k6Args, result, runDir, script, secrets (+2 more)

### Community 15 - "TWC Endpoints"
Cohesion: 0.20
Nodes (12): dyHomeRecommendations(), dynamicYieldIdentifiers(), dyPdpRecommendations(), giftBox(), login(), loginOnce(), NAMES, RFC-7636 (+4 more)

### Community 16 - "Account Platform API"
Cohesion: 0.19
Nodes (12): correlationFailure(), accountContent(), accountPages(), guestToken(), logout(), NAMES, refreshToken(), applePay() (+4 more)

### Community 17 - "Package Manifest"
Cohesion: 0.18
Nodes (10): description, engines, node, name, private, scripts, twc:validate:bundles, twc:validate:products (+2 more)

### Community 18 - "Pacsun Test & Config"
Cohesion: 0.24
Nodes (6): guestBrowse(), guestShopper(), handleSummary, options, sessionData(), test

### Community 19 - "Cart Platform API"
Cohesion: 0.28
Nodes (8): addToBag(), cartItemFor(), clearCart(), deleteCartItem(), getCart(), NAMES, updateCartItem(), validateCart()

### Community 20 - "Hot Topic run.sh"
Cohesion: 0.40
Nodes (5): K6_WEB_DASHBOARD, K6_WEB_DASHBOARD_EXPORT, K6_WEB_DASHBOARD_PORT, run.sh script, usage()

### Community 21 - "API Session Helpers"
Cohesion: 0.70
Nodes (5): createApi(), addToCart(), newSession(), product(), send()

## Knowledge Gaps
- **109 isolated node(s):** `capture_step.sh script`, `proxy.sh script`, `WISHLIST_V3`, `endpointNames`, `K6_WEB_DASHBOARD` (+104 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 139 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `product()` connect `API Session Helpers` to `Product Platform API`?**
  _High betweenness centrality (0.355) - this node is a cross-community bridge._
- **Why does `createApi()` connect `API Session Helpers` to `Product Validation Prep`, `Validate Products Script`, `Poq API Prep Client`, `Account Validation`?**
  _High betweenness centrality (0.352) - this node is a cross-community bridge._
- **Why does `Hot Topic client (hot_topic)` connect `Plan & Project Decisions` to `Account Validation`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **What connects `capture_step.sh script`, `proxy.sh script`, `WISHLIST_V3` to the rest of the system?**
  _109 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `TWC Test & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.07764705882352942 - nodes in this community are weakly interconnected._
- **Should `Plan & Project Decisions` be split into smaller, more focused modules?**
  _Cohesion score 0.05272895467160037 - nodes in this community are weakly interconnected._
- **Should `Hot Topic Journeys` be split into smaller, more focused modules?**
  _Cohesion score 0.1178743961352657 - nodes in this community are weakly interconnected._