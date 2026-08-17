# Mise - recipes & meal planning

A self-hosted recipe manager that keeps the whole food loop in one place: save recipes, plan the week on a calendar, and get one grocery list that already knows what's in your pantry.

## Features

* Recipes with a photo, structured ingredients (quantity / unit / name), and step-by-step instructions.
* Search for a dish and get a dozen real recipes for it, pulled from a curated set of cooking sites and shown side by side as tabs.
  Compare ingredient count, steps, total time, and servings, then pick the one you like and edit it before saving.
  Nothing is written to your recipe box until you save.
* Import a recipe from a URL: paste a link and the schema.org data most cooking sites embed fills in the form, photo included.
* Tags with one-tap filtering, and search that also matches ingredients ("what can I make with basil?").
* Weekly meal planner: assign any recipe to breakfast, lunch, dinner, or snack on any day, or copy last week's plan in one tap.
* Generated grocery list for a date range.
  Ingredients are merged across recipes ("2 cups" + "1 cup" flour becomes "3 cups"), with mixed units listed side by side.
* Pantry staples: items you always keep in stock.
  Out-of-stock staples are added to the grocery list, and checking a pantry item off the list marks it back in stock.
  When a planned recipe calls for a staple you already have, it is set aside under "already in your pantry" rather than put on the list - listed with the amount the week's meals need, so you can buy more anyway if the jar won't cover it.
* Optional grocery pricing from Kroger, off unless you supply an API key.
  Each line on the list carries a price and the product it came from, with a total that says how much of the list it actually covers - "est. $84.39, 26 of 26 priced" - because a total that quietly drops what it could not match reads exactly like a complete one.
  Items on offer show the saving, and a folded panel lists the things you cook with that are discounted this week.
  Tap any price to see the alternatives and pick a different product; a hand-picked choice is never overwritten.
* Send the list to a real Kroger cart, once you connect your Kroger account.
  You see exactly what will be ordered first - products and quantities both - because Kroger's cart cannot be read back or emptied by this app, so nothing goes without being reviewed.

## Architecture

| Piece | Tech | Image |
| --- | --- | --- |
| frontend | React + Vite SPA served by unprivileged nginx, which proxies `/api` | `ghcr.io/<owner>/recipes-frontend` |
| backend | FastAPI + SQLAlchemy (async), uvicorn | `ghcr.io/<owner>/recipes-backend` |
| database | Postgres 16 (SQLite fallback for bare local dev) | `postgres:16-alpine` |

Uploaded photos are stored on a volume at `DATA_DIR` (`/data` in the container) and served at `/api/images/<file>`.

Recipe search needs no API key or account.
Instead of a search engine, it queries the public WordPress search API (`/wp-json/wp/v2/search`) of each site on the allowlist in `backend/app/services/recipe_search.py`, then runs the results through the same parser the URL importer uses.
That keeps us on documented, publicly exposed endpoints of sites that have been vetted by hand rather than crawling the open web.
To add a site, confirm it publishes schema.org/Recipe JSON-LD - one that does not can be searched but never parsed, so it would only ever contribute failures.

## Grocery pricing

The one feature that needs an account, and the only one that is optional.
With no credentials set it does not exist: no Settings entry, no prices, and every other page behaves exactly as it did before it was written.

Create an app at [developer.kroger.com](https://developer.kroger.com) and put the pair in a `.env` beside `compose.dev.yaml` - see `.env.example`:

```sh
KROGER_CLIENT_ID=...
KROGER_CLIENT_SECRET=...
```

Then pick a store under **Settings**.
This is not a preference: Kroger returns no price at all without a store, so nothing can be priced until one is chosen.
Prices, offers and availability are all set store by store.

The bare hot-reload loop does not read that file, since the app has no `python-dotenv` dependency, so load it into the shell first:

```sh
cd backend && set -a && source ../.env && set +a
uv run uvicorn app.main:app --reload
```

A few things worth knowing about the numbers:

* They are estimates, and Kroger's data will not always agree with the register.
* A line's figure is what covering the week's requirement costs, which is not always the shelf price.
  Chicken sold at $4.49 a pound costs $6.74 for the pound and a half a recipe asks for, so the row shows both.
* Recipes measure by volume and shops sell by weight, so `backend/app/services/kroger/density.py` holds a hand-curated gram-per-cup table.
  An ingredient not in it still gets a price; it just cannot be size-matched to a package.
* The Products API allows 10,000 calls a day and Locations 1,600, which is ample: product matches are pinned once and re-priced in batches of up to 50, so a whole list costs one call.

## Sending the list to a Kroger cart

Optional again, and separate from pricing.
Prices are read with the server's own API key; a cart belongs to a person, so ordering needs you to sign in to Kroger once and allow it.

Two things have to line up, and Kroger compares them character for character.

1. Register a redirect URI on your app at [developer.kroger.com](https://developer.kroger.com).
   It is this app's callback path on the address you actually reach it at - `https://recipes.<tailnet>.ts.net/api/cart/callback` in production, or `http://localhost:8085/api/cart/callback` for the dev stack.
2. Set the same value as `KROGER_REDIRECT_URI`, then restart.

Then open **Settings** and connect your Kroger account.
You will be handed to Kroger's own sign-in and returned here afterwards.
Nothing is stored but the token Kroger issues, and **Disconnect** forgets it; the grant itself is on file at Kroger, and only you can withdraw it from your Kroger account.

With that done, the grocery list grows a **Send to cart** button.
It opens a review first, and that is deliberate: `PUT /v1/cart/add` is the whole of Kroger's Cart API.

* Nothing can be read back, so the app never claims to know what is in your cart - it links you to it.
* Nothing can be removed, so sending twice orders twice.
  The page says when a list last went, and says plainly that sending again adds to that cart rather than replacing it.
* Quantities are worked out from the week's meals and are not always one.
  Twelve pounds of flour against a five pound bag is three bags, which is right and is also worth seeing before it is bought.
* Ticked-off lines are left out, and anything with no matched product is named rather than counted, so you know what to buy the usual way.

Items land in whatever cart your Kroger account is pointed at, which is not necessarily the store this app prices against - the two are chosen in different places.
Check the cart on Kroger before you pick a time.

## Local development

Full stack (what production runs, built from source):

```sh
docker compose -f compose.dev.yaml up --build
# app on http://localhost:8085
```

Hot-reload loop:

```sh
cd backend && uv sync && uv run uvicorn app.main:app --reload   # API on :8000
cd frontend && npm install && npm run dev                        # UI on :5173, proxies /api
```

Tests:

```sh
cd backend && uv run pytest
cd frontend && npm run build   # includes typecheck
```

## Database migrations

Alembic owns the schema, and the backend runs `upgrade head` itself on startup, so a deploy needs no manual step.

After changing a model, generate the matching revision from the `backend/` directory:

```sh
uv run alembic revision --autogenerate -m "what changed"   # review the result before committing
uv run alembic upgrade head
uv run alembic check                                       # models and migrations agree
```

The URL comes from `DATABASE_URL`, the same variable the app reads, so the CLI and the app can never target different databases.
`tests/test_migrations.py` fails the build if a model change lands without its revision.

Databases created before Alembic was introduced have no `alembic_version` table.
Rather than rebuild them, startup stamps them at the revision whose schema they already match and upgrades forward from there, so existing recipes are left untouched - see `app/migrations.py`.

## Deployment

Pushes to `main` (and `v*` tags) run tests, then build and push multi-arch images to GHCR via `.github/workflows/build-images.yml`.
The home server deploys them with the stack in the sister repo: `home-server/stacks/recipes/compose.yaml`, reachable over the tailnet at `https://recipes.<tailnet>.ts.net`.

`KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` have to reach the backend service in that stack for pricing to appear in production.
Absent, the deploy is healthy and pricing is simply switched off, which is the same state the app shipped in before it existed - so a missing key is a quiet outcome rather than a loud one, and worth checking for deliberately.

`KROGER_REDIRECT_URI` is the third, and only sending a list to a Kroger cart needs it.
In production it is `https://recipes.<tailnet>.ts.net/api/cart/callback`, and the same string has to be registered on the Kroger app.
It cannot be derived from the request: nginx and TSDProxy both sit in front of the backend, so the host it sees is not the host Kroger was told about.
Absent, the sign-in is switched off and pricing carries on as usual - quiet in the same way, and worth the same deliberate check.
