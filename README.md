# Mise - recipes & meal planning

A self-hosted recipe manager that keeps the whole food loop in one place: save recipes, plan the week on a calendar, and get one grocery list that already knows what's in your pantry.

## Features

* Recipes with a photo, structured ingredients (quantity / unit / name), and step-by-step instructions.
* Weekly meal planner: assign any recipe to breakfast, lunch, dinner, or snack on any day.
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

## Deployment

Pushes to `main` (and `v*` tags) run tests, then build and push multi-arch images to GHCR via `.github/workflows/build-images.yml`.
The home server deploys them with the stack in the sister repo: `home-server/stacks/recipes/compose.yaml`, reachable over the tailnet at `https://recipes.<tailnet>.ts.net`.
