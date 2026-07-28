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
  In-stock staples are skipped on the grocery list; out-of-stock ones are added to it.
  Checking a pantry item off the list marks it back in stock.

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
