# Pacsun (`pacsun`)

Gen-3 Poq API (`/clients/pacsun/…`, guest token). There is no JMeter suite: the journeys follow
the dev apps' own calls, captured with Maestro + Charles on 2026-09-30 (Android: full walk; iOS: app
open) using the project skill `.claude/skills/app-traffic-capture/`. Only `dev` is configured so
far. Configuration: [config.js](config.js).

## Scenarios

| Scenario | Share | What it does |
|---|---|---|
| `guestBrowse` | 62% | **Read-only.** App start (guest token, launch, settings, splash, wishlist ids, banners, shop, stories, account content, wishlist, bag), home carousels, category PLP + next page, 6 sorts, a size filter and a price range, predictive search + suggested products, keyword search + next page, PDP, recently viewed |
| `guestCartAbandon` | 19% | `guestBrowse`, then add to bag, bag screen, quantity 2, Move to Wishlist (add to wishlist + remove the line), empty the wishlist (half the sessions delete the item, half use Clear All), store finder nearby + ZIP search, one Account-tab info page (Poq web view CSS/JS only) |
| `guestCheckout` | 9.5% | `guestBrowse`, add to bag, bag, **checkout start**, remove the line (no order is placed) |
| `loggedInCheckout` | 9.5% | guest token, login, app start, browse, add to bag, bag, **checkout start**, remove the line, logout. Needs `data/accounts_<env>.json` |
| `register` | opt-in | Guest token, account tab, register, loyalty rewards. Creates real accounts; `PROFILE=scale` runs a fixed 50 over the hold |
| `loggedInUser` | opt-in | Guest token, login, account tab, logout (login smoke only) |

- **One session type for both apps.** The backend treats iOS and Android the same; the only
  platform-specific calls are Android's `settings/config` and the iOS splash, and every session
  makes both. One header set (the Android app's) is used.
- **One `poq-user-id` per session**, generated at app start and used for every step; a new session
  gets a new id. The guest token's `externalUserId` does not replace it.
- **Common requests once per session:** shop, wishlist and bag are read once even where the app re-reads them.
- **Requests per session:** `guestBrowse` 28, `guestCartAbandon` 37, `guestCheckout` 31, `loggedInCheckout` 33.
- Mix and load target (585 req/s) come from Xceptance's web funnel scaled to the app (derivation in [config.js](config.js)); latency limits (1,500 ms), keywords and ZIP list are provisional placeholders.
- `loggedInCheckout` is capped at 120 live sessions, the size of the account list.

## Differences from the platform

- Declared as `config.js` tweaks: predictive search is `/search/predictive/v2`; `slot-content-id` on
  shop, banners (`home` + `labels=online`), search and account content; stories take `ids` from the
  banners' `storyIds`.
- In [endpoints.js](endpoints.js): add-to-bag body `{variantId, quantity, shipmentType}`; bag update
  and delete via `POST /cart` with `items[]`; wishlist add/delete with `[{productId, listingId}]`;
  Clear All (`DELETE /wishlist`); wishlist item ids; PLP/search next page (`skip=16`); home
  carousels; predictive product suggestions; stores (`GET /stores`, v2) and ZIP search (`q=`);
  web view assets (`/assets/web/css|js/523/<poqUserId>`).
- The app sends a `poq-auth` signature; dev does not enforce it on guest calls, so k6 does not sign.

## Left out

- **Checkout:** on dev, `POST /checkout/start` returns 403 (Pacsun's dev storefront refuses Poq's session call).
- **Dynamic Yield:** `dynamicyield/identifiers` is polled constantly by both apps; k6 calls it once per session at app start and sends the returned ids as `dy-user-id` / `dy-session-id`.
- **Sign-in / logged-in journey, promo code:** not captured yet (needs dev accounts and a code).
- **Storefront web views** (Shipping Options, Returns, …): Pacsun's own site; only the Poq assets they load are tested.

## Test data

```bash
node prep/validate-products.mjs pacsun --env dev [--max-valid 60] [--max-rpm 40]
```

- **Input:** `input/products_dev.json`, 1,045 ids crawled from the 33 dev category PLPs (3 pages each). It is a snapshot of dev, not a catalogue feed.
- **Validator rules:** body `{variantId, quantity: 1, shipmentType: 'direct'}`; success = the variant is in the returned `cartItems` (the response has no `quantityAdded`).
- **Keywords:** `data/keywords.json`, 25 generic Pacsun terms (provisional).

## Findings raised

- The apps send some calls before they have a token (401, then a retry).
- Choosing "Top Rated" in the Android app sends `sort=price-high`.
- The public splash/settings config contains credentials and other clients' URLs.
