# Kroger pricing: research and plan

Adding Kroger API keys to unlock price per recipe, sale-aware recommendations, and related features.
This document is the research behind the work, and it records the shape that was proposed.
Nothing here has been built.

Tracked in #1, broken into issues #2 through #14.

## Scope decisions taken after this document was written

Two sections below no longer describe what is being built, and are kept because the reasoning is still worth having.

- **Add to cart was out of scope, and has since been built.**
  Section 5 discusses it as a later stage, and this note used to say it was not being pursued.
  It shipped in August 2026, roughly in the shape section 5 sketches: the `authorization_code` grant, a registered redirect URI, and a refresh token in `app_settings`.
  Two things the plan did not anticipate are worth reading before changing it - see `docs/adr/0003` and `docs/adr/0004`.
  The Cart API is write-only, which is what forces a review step rather than a button; and the quantity to order is a second, separate answer from the cost to cover, because a rate can honestly be charged in fractions and an order cannot.
- **Price caching is out of scope.**
  Section 3 proposes a `product_price` cache with TTL and a `kroger_api_usage` budget counter.
  Neither is being built, because at single-user scale a 50 item grocery list costs about 3 batched Products calls per render against a 10,000 per day budget.
- **Product match persistence is still in scope.**
  The `ingredient_product_match` table in section 3 is not a cache and was mislabelled as one.
  `filter.term` is a fuzzy search whose result order changes between identical requests, so without a pinned match the same ingredient resolves to a different product, and a different price, on every page load.
- **Dropping price history has a consequence.**
  Price history was the thing that made "below average price" answerable in its temporal reading.
  Without it, only the cross-recipe reading is available.
  See #13.

## 1. What the API actually gives us

Verified against the Kroger Public API reference and the source of the `kroger-api` client library.
The developer portal itself is a client-rendered SPA that returns the same shell for every path, so it cannot be read by any non-browser client.
Some items below are therefore marked unverified and need a human with a logged-in developer account to confirm.

### Rate limits

Limits are per app, per day, enforced per endpoint rather than per operation.

| API | Limit | Relevance |
| --- | --- | --- |
| Authorization | no published limit | token minting is free |
| Products | 10,000 / day | the main budget |
| Locations | 1,600 / day per endpoint | store search only, used at setup |
| Cart | 5,000 / day | only if we add cart write |
| Identity | 5,000 / day | not needed |

The headline constraint is 10,000 Products calls per day.
Section 4 shows that this is comfortable under the proposed caching design and only becomes a problem if prices are fetched per page render.

### Auth

Two flows, and we only need the first for everything in scope.

- `client_credentials` with scope `product.compact` covers products and locations.
  No user interaction, no redirect URI, no browser.
  This is all that price per recipe and recommendations require.
- `authorization_code` with `cart.basic:write` (and `profile.compact` for identity) is needed only to write to a real customer's Kroger cart.
  It requires a registered redirect URI, a browser round trip, and a real Kroger account login.
  That is a separate piece of work, deliberately out of the first stages.

Tokens are short lived.
Read `expires_in` from the token response rather than hardcoding a lifetime, cache the token in process, and refresh reactively on a 401.

### Endpoints and parameters

Confirmed from the client library's source.

`GET /v1/products`

- `filter.term` - free text search
- `filter.locationId` - **required to get any price at all**
- `filter.productId` - comma separated, this is the batching lever
- `filter.brand` - pipe separated
- `filter.fulfillment` - comma separated
- `filter.start`, `filter.limit` - limit accepts 1 to 50

`GET /v1/products/{productId}?filter.locationId=`

`GET /v1/locations`

- `filter.zipCode.near`, `filter.latLong.near`, `filter.lat.near`, `filter.lon.near`
- `filter.radiusInMiles` (1 to 100), `filter.limit` (1 to 200)
- `filter.chain`, `filter.department`, `filter.locationId`

`GET /v1/locations/{locationId}`

`PUT /v1/cart/add` with `{"items": [{"upc", "quantity", "modality": "PICKUP" | "DELIVERY"}]}`

### The response shape that matters

Price lives on the item, not the product:

```
product.productId
product.upc
product.brand
product.description
product.categories[]
product.aisleLocations[]
product.items[0].size          # "5 lb", "16 oz", "12 ct"
product.items[0].soldBy
product.items[0].price.regular
product.items[0].price.promo
product.items[0].price.regularPerUnitEstimate
product.items[0].inventory.stockLevel
product.items[0].fulfillment
```

Three consequences drive the whole design:

1. **No `filter.locationId` means no price.**
   Store selection is not a nice-to-have setting, it is a hard precondition for the entire feature.
2. **`filter.term` is a fuzzy search whose result order changes between identical requests.**
   Taking "the first result" produces a different product, and therefore a different price, on every call.
   Matches must be pinned and stored, never recomputed per request.
3. **`regularPerUnitEstimate` and `size` are what make unit conversion possible at all.**
   Without them, mapping "2 cups flour" to a share of a 5 lb bag has nothing to anchor on.

## 2. The two hard problems

Everything else in this plan is routine.
These two are where the feature either works or quietly produces wrong numbers.

### Problem A: matching an ingredient to a product

`canonical_key` already reduces "Large eggs, at room temperature" to `egg`, and that key is already the grocery merge key and the `grocery_checks` primary key.
It is the natural identity to hang a product match on.

The risk is that fuzzy search silently returns something absurd.
"kosher salt" matching a decorative salt lamp corrupts a total with no visible symptom.
A wrong match is worse than a missing one, because a missing one is obvious and a wrong one is not.

Mitigations:

- Resolve a match once, store it, and never re-resolve implicitly.
- Make every match visible and user-correctable in the UI, with the product name, size, and price shown next to the ingredient.
- Prefer results whose `description` contains the canonical key's tokens, and apply a sanity filter on category and price magnitude.
- Treat "no confident match" as a first-class state that displays as unpriced, rather than guessing.

### Problem B: recipe units to package prices

A recipe says "2 cups all-purpose flour".
Kroger sells a 5 lb bag for $2.49.
The recipe uses roughly 11 percent of the bag, so about $0.27.

Getting there needs a volume to weight conversion that is ingredient specific.
A cup of flour is about 125 g, a cup of sugar about 200 g, a cup of water about 236 g.
There is no general rule, only a table.

This is the part that usually kills these features, so it should be scoped honestly:

- Same-dimension conversions are easy.
  Weight to weight and volume to volume need only the existing `UNIT_ALIASES` plus a parser for the `size` string.
- Count units are mostly easy.
  "2 eggs" against a "12 ct" package is arithmetic.
- Cross-dimension conversions need a curated density table of common ingredients in grams per cup.
  This is real work, but it is bounded, and it is exactly the kind of hand-curated table this codebase already uses for `UNIT_ALIASES`, `PREP_WORDS`, and `KNOWN_UNITS`.
- Some ingredients will never convert cleanly ("1 bunch parsley", "salt to taste").

The rule that follows: **never show a total that pretends to be complete.**
Show coverage explicitly, in the shape of "est. $8.40, 9 of 11 ingredients priced".
This matches the existing philosophy in `services/grocery.py`, where in-pantry items are set aside rather than dropped precisely because a silently missing ingredient is only discovered at the stove.

### The insight that reorders the roadmap

**The grocery list needs no unit conversion at all.**

The grocery list is already package shaped.
It says "buy flour", and the answer is "the 5 lb bag is $2.49".
Attaching a price to a grocery line is just the product's price, with no conversion in the path.

Recipe cost is the thing that needs conversion, because it needs a fraction of a package.

So the grocery list total is both the highest value feature and the one with none of the hard problem in it.
It should ship first, and it delivers value even if the conversion work never happens.

## 3. Proposed architecture

### Configuration and secrets

The project has no secret handling today, no settings framework, and `config.py` is 18 lines of `os.environ`.
The README currently advertises "Recipe search needs no API key or account" as a design property.

Adding keys should therefore be strictly additive and opt-in:

- `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` read in `config.py` in the existing style.
- When unset, the entire feature is invisible: no nav entry, no price columns, endpoints report disabled.
  The app keeps working exactly as it does now.
- The README claim needs a matching edit, scoped to recipe search rather than the whole app.
- The keys also need to reach the sister repo's `home-server/stacks/recipes/compose.yaml`.

### Store selection

There is no settings storage anywhere today, on either side, and no `localStorage` use in the frontend.
The store must live in the backend regardless, because the pricing service is what needs the `locationId`.

Proposal: a single-row `app_settings` table with typed columns, seeded on first migration.
It starts with the Kroger fields and gives future settings an obvious home.

```
app_settings
  id                     (constrained to 1)
  kroger_location_id     str | None
  kroger_location_name   str | None
  kroger_location_address str | None
  updated_at
```

The setup flow calls `GET /v1/locations` with a zip code exactly once, during an explicit user search, and stores the chosen store.
Given only 1,600 location calls per day, this endpoint must never be touched on a normal request path.

### Caching

Three caches with genuinely different lifetimes and invalidation rules.
Collapsing them into one would be a mistake, because a semantic match and a price expire for completely different reasons.

**1. Ingredient to product match.**
Semantic and near-permanent.
Only changes when the user corrects it.

```
ingredient_product_match
  canonical_key    # the existing canonical_key output
  location_id
  product_id
  upc
  description      # shown in the UI so a bad match is visible
  size             # raw string, e.g. "5 lb"
  size_magnitude   # parsed
  size_unit        # parsed
  confidence
  user_confirmed   # a hand correction is never overwritten
  resolved_at
  PRIMARY KEY (canonical_key, location_id)
```

**2. Product price.**
Volatile, TTL around 12 to 24 hours.
Kroger weekly ads run Wednesday to Tuesday, so a daily refresh is the natural cadence.

Prices should be **appended, not overwritten**.
This costs almost nothing and it is the only way to answer "below average", which is one of the stated goals.
You cannot compute "cheaper than usual" without history.

```
product_price
  location_id
  product_id
  regular
  promo
  per_unit_estimate
  stock_level
  fetched_at
  PRIMARY KEY (location_id, product_id, fetched_at)
```

**3. Daily call budget.**
A small counter table, so the budget survives restarts and is visible.

```
kroger_api_usage
  day
  endpoint
  count
  PRIMARY KEY (day, endpoint)
```

On exhaustion, serve stale prices with an "as of" timestamp rather than failing.
This mirrors the per-unit degradation already used in `recipe_search.py`, where a failing site logs a warning and returns an empty list rather than failing the whole request.

### Batching

`filter.productId` is comma separated, so refreshing N known products costs roughly N divided by the batch size, not N calls.
The maximum number of IDs per call is unverified and should be measured before relying on it.
Start conservative at around 20 per call.

### Backend layout

Following the existing `services/` conventions, with a per-operation `httpx.AsyncClient` rather than a shared singleton, matching `services/fetch.py`:

```
services/kroger/
  client.py     # auth, token cache, request, budget accounting
  locations.py  # store search
  pricing.py    # match resolution, price fetch and refresh
  units.py      # size parsing, density table, conversion
routes/
  pricing.py    # store settings, list pricing, match override
```

### On the Python client library

There is one real option, `kroger-api` (v0.3.1, released 2026-07-09, MIT, actively maintained).

**Recommendation: do not take the dependency, but use its source as the specification.**

- It is built on `requests`, which is synchronous.
  This backend is async end to end.
  Blocking calls inside the event loop would need a threadpool wrapper, which adds moving parts and gives up nothing in return.
- It persists tokens to files under XDG directories, which is the wrong model for a container.
- It pulls in `python-dotenv`, which this project does not use.
- We need three endpoints.
  A thin async httpx client is on the order of 150 lines and matches the existing `fetch.py` pattern exactly.

The library's value here is that it documents the exact parameter and response shapes, which is a genuine gift given the portal cannot be read.
That value has already been extracted into this document.

## 4. Does the budget actually work

Concrete numbers for a household, since this is what the caching design has to justify.

A week's meal plan touches roughly 50 distinct canonical ingredients, plus around 30 pantry staples, so about 80 tracked products.

- Daily price refresh of 80 products, batched at 20 per call: **4 calls per day.**
- The same refresh completely unbatched: 80 calls per day.
- Match resolution: one search per newly seen ingredient, only on first sight.


Against 10,000 per day, this is comfortable with a wide margin.

The budget only breaks under one specific mistake: pricing per page render without a cache.
A recipe index showing a price on every card would be 200 recipes times 10 ingredients, which is thousands of calls for one page view.
The cache is not an optimization here, it is the thing that makes the feature possible.

## 5. Staged delivery

Ordered by value delivered per unit of risk, not by the order the ideas were raised.

### Stage 1: foundation and grocery list pricing

The whole of the hard-problem-free value.

- Env keys, feature flag, disabled-by-default behavior.
- Async httpx client with token caching and budget accounting.
- Store search and selection UI, persisted in `app_settings`.
- Ingredient to product match resolution and storage.
- Price attached to each grocery line, plus a list total.
- A visible, correctable product match per line.
- Explicit coverage reporting, never a falsely complete total.

Ships real value with no unit conversion anywhere in the path.

### Stage 2: on sale now

Very cheap once stage 1 exists, since it is a query over data already cached.

- Flag any grocery line where `promo` is below `regular`.
- A view of "things you cook with that are on sale this week", driven by pantry staples and recipe ingredients.
- Once price history has accumulated, "cheaper than usual" becomes available from the same table.

High delight, no conversion, no new API cost.

### Stage 3: cost per recipe and per serving

This is where the conversion work lands.

- `size` string parser.
- Curated density table for cross-dimension conversion.
- Cost per recipe and cost per serving, with coverage always shown.
- Meal plan cost for a date range.

### Stage 4: price-aware recommendations

Depends on stage 3 being trustworthy, since a recommendation built on bad totals is worse than none.

Note that "price below average" has two readings, and they need different things:

- Below average **across recipes** needs no history, only stage 3.
- Below average **against its own past** needs the price history table, which stage 1 starts accumulating.

Worth deciding which is meant before building.

### Later, separate: add to Kroger cart

*Built, August 2026. See `docs/adr/0003` and `docs/adr/0004`.*

Genuinely useful, one tap from grocery list to a real Kroger order.
It is a distinct project because it needs the `authorization_code` flow, a real Kroger account login, a registered redirect URI, and an HTTPS callback.
The Tailscale hostname makes the callback feasible, but it is a second auth mode with its own storage and failure modes.

All of that held.
What the estimate missed is that "one tap" was the wrong target: the Cart API cannot be read back or emptied, so the flow is deliberately two steps, with a review of the exact products and quantities in between.

## 6. Other ideas worth considering

- **Sort the grocery list by aisle.**
  `aisleLocations` arrives free on the product lookups stage 1 already performs.
  It costs no extra API calls, it needs no conversion, and it fits the existing "one list for the whole trip" framing better than almost anything else here.
  This may be the best value-per-effort item in the entire document.
- **Unit price comparison** between package sizes of the same product, using `regularPerUnitEstimate`.
- **Stock awareness**, using `inventory.stockLevel` to warn before a trip.

## 7. Open questions and gates

**Confirmed against the live API while verifying #3:**

- `filter.productId` accepts **exactly 50** IDs.
  51 returns `400 Bad Request`.
  A 50 item grocery list is one call.
- The access token lifetime is **1800 seconds**.
- The default developer key reached production data immediately, with no separate access request.
- `regularPerUnitEstimate` is populated **only for `soldBy: WEIGHT` items**, and its denomination is inconsistent enough not to be trusted.
  See #10.
- **`soldBy` splits the conversion problem in two.**
  `WEIGHT` items (meat, produce) price per the `size` unit, so they need no density table at all.
  `UNIT` items (a 5 lb bag, an 18 ct carton) need the package fraction, and only those measured by volume need density.
  This narrows section 2's problem B considerably.
- `inventory` is absent on some items, so `stockLevel` cannot be assumed present.
- Search quality is better than feared.
  "boneless skinless chicken thighs" and "kosher salt" both returned the right product first.
- `promo` is **absent rather than zero** when there is no sale.
  See #8.
- `aisleLocations` **is** populated, at no extra cost.
  See #9.
- The Locations API returns non-retail entries, and results span every banner The Kroger Co. owns.
  See #4.

**Still unconfirmed, does not block:**

- Whether the three Locations endpoints each carry their own 1,600 per day allowance.

**Product decisions for the user:**

- ~~Which reading of "price below average" is intended.~~
  Settled by the policy: only the cross-recipe reading is available.
- Whether one store is enough, or whether comparing across **Kroger** stores matters.
  Comparing against **other retailers** is prohibited outright.
- How much visible precision is wanted, given every number is an estimate and Kroger's data will not always match the register.

## 8. Risks to keep in view

- **A wrong product match is invisible.**
  This is the main correctness risk and the reason matches must be shown and correctable rather than hidden behind a total.
- **Conversion coverage will never reach 100 percent.**
  The UI has to be honest about this from the first screen, not retrofitted later.
- **Prices are estimates.**
  Kroger's API data will diverge from the register, and the UI should not imply otherwise.
- **This introduces the project's first required API key.**
  It contradicts a documented selling point, which is why the feature must degrade to invisible when keys are absent.
- **`canonical_key` is load bearing in a new way.**
  It is already the grocery merge key and the `grocery_checks` primary key.
  Making it the product match key too means any future change to canonicalization silently orphans product matches as well as check state.
  That coupling should be a deliberate, documented decision rather than an accident.
- **The line between a stored preference and a stored catalog is a judgement call.**
  The match table is defensible as "this ingredient means this product", and indefensible as a copy of Kroger's catalog.
  The difference is only how many fields it holds and how they are refreshed, so it is easy to drift across the line during implementation without noticing.
  Keep the table minimal.
