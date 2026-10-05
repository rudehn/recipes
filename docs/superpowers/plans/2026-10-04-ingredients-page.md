# Ingredients Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page where each ingredient is seen whole, replacing the Pantry tab, with merges for two names of one thing, in-place fixes for broken recipe lines, and an importer that stops producing them.

**Architecture:** A merge is a row in `ingredient_merges`; every place that compares ingredients asks one `Identity` object, cached per database session, which applies `canonical_key` and then the merges.
A merge moves the state stored under the old key to the new one in the same transaction.
The page is a new route set (`/ingredients`, `/ingredients/:key`) fed by a new read-only API that never searches Kroger, and every change it makes goes through the existing pantry, product and food endpoints, plus new merge and line-edit endpoints.

**Tech Stack:** FastAPI, SQLAlchemy 2 (async), Alembic, Pydantic 2, pytest (backend, `uv`); React 19, React Router, TypeScript, Vite, Vitest, Testing Library (frontend, `npm`).

**Spec:** `docs/superpowers/specs/2026-10-04-ingredients-page-design.md` (read it before starting; this plan argues from it).

## Global Constraints

- Never use the em dash character anywhere (code, comments, docs, commit messages); use a plain "-".
- Comments explain *why* in full sentences, at the density of the surrounding code (see any docstring in `backend/app/services/`).
- Frontend styles use design tokens only: `npm run lint` fails on a colour or spacing value written outside `:root` in `frontend/src/styles.css`.
- Long Markdown docs (ADRs, CONTEXT.md, README) put each full sentence on its own line.
- Commit messages: an imperative summary line describing the user-visible change, a blank line, prose explaining why, wrapped near 72 columns. No `Co-Authored-By` or any attribution lines.
- Never touch `backend/data/recipes.db` or the production server; never call Kroger cart endpoints.
- Before every commit, all of these pass: `cd backend && uv run ruff check . && uv run pytest -q` and `cd frontend && npm run lint && npm test && npm run build`.
- A migration also passes `uv run alembic check` against a scratch database: `DATABASE_URL=sqlite+aiosqlite:////tmp/alembic-check.db uv run alembic upgrade head && DATABASE_URL=sqlite+aiosqlite:////tmp/alembic-check.db uv run alembic check` (use the scratchpad directory instead of `/tmp` if one is provided).
- Work in the worktree `/Users/nathanrude/Development/recipes/.claude/worktrees/ingredients` on branch `ingredients-page`; run `uv sync` in `backend/` and `npm ci` in `frontend/` once before Task 1.

## Review Focus

1. **Reversing a merge by merging the target into the old name** (`ground-cumin -> cumin` exists, then "merge cumin into ground cumin"): refused with a sentence telling the person to unmerge first; no cycle is ever stored. Pinned in Task 4.
2. **Merging mid-trip**: ticks on both grocery lines and a cart already sent for the merged-away one. After the merge the list shows one line carrying the target's tick, and the cart's sent record follows the line so a resend still holds back. Pinned in Task 4.
3. **Pricing off, or Kroger failing, while listing or previewing a merge**: the list and the preview still load; a picked product shows as picked without a price. Pinned in Tasks 5 and 7.
4. **Fixing a line to a blank name, to text that normalizes to nothing ("***"), or with a stale line id** after the recipe was re-saved through its form (which replaces line ids): a 422 or 404 with a sentence the page shows, and nothing in the batch is saved. Pinned in Task 14.
5. **Opening `/ingredients/<key>` for a key no longer in use, or one merged away**: a "not found" page with a way back, or the target's page; never a crash. Pinned in Tasks 5 and 10.

## File Structure

Backend, created:

- `backend/app/services/identity.py`: the `Identity` object; the only way ingredients are compared.
- `backend/app/services/merges.py`: merge, unmerge, the choices a merge needs, and its preview.
- `backend/app/services/merge_suggestions.py`: the pure rules that spot likely pairs.
- `backend/app/services/ingredients.py`: every ingredient seen whole, for the list and the detail page.
- `backend/app/routes/ingredients.py`: `/api/ingredients...`.
- `backend/app/routes/recipe_ingredients.py`: `/api/recipe-ingredients...`.
- `backend/alembic/versions/20261004_a7d3e1c9b2f4_ingredients_can_be_merged.py`.
- `backend/tests/test_identity.py`, `test_merged_names.py`, `test_merges.py`, `test_ingredients_api.py`, `test_merge_suggestions.py`, `test_recipe_ingredients.py`, and `tests/fixtures/real_ingredient_keys.txt`.
- `docs/adr/0010-merges-are-the-owners-corrections-on-top-of-one-key.md`, `CONTEXT.md`.

Backend, modified: `models.py`, `schemas.py`, `main.py`, `services/grocery.py`, `routes/grocery.py`, `services/kroger/costing.py`, `services/kroger/pricing.py`, `routes/pricing.py`, `services/nutrition/facts.py`, `services/attention.py`, `services/shopping_text.py`, `routes/cart.py`, `services/recipe_import.py`, `tests/test_shopping_text.py`, `tests/test_import.py`, ADRs 2, 7 and 8.

Frontend, created:

- `frontend/src/pages/IngredientsPage.tsx` (+ `.test.tsx`): the tab, its three views and search.
- `frontend/src/pages/IngredientPage.tsx` (+ `.test.tsx`): one ingredient's own page.
- `frontend/src/components/MergeDialog.tsx` (+ `.test.tsx`): choosing, previewing and confirming a merge.
- `frontend/src/components/LineFixer.tsx`: editing one recipe line in place.
- `frontend/src/ingredients.ts` (+ `.test.ts`): pure helpers shared by the two pages (summary line, problem labels, merge direction).

Frontend, modified: `App.tsx`, `api.ts`, `test/fixtures.ts`, `styles.css`, `components/Nutrition.tsx`, `components/ProductPicker.tsx`, `pages/RecipeDetailPage.tsx`, `pages/GroceryPage.tsx`, `pages/RecipesPage.tsx`, `pages/SettingsPage.tsx` (+ their tests).
Deleted: `frontend/src/pages/PantryPage.tsx` and `PantryPage.test.tsx` (their behaviour moves to the Staples view and its tests).

---

## Phase 1: Merges underneath

### Task 1: The two new tables

**Files:**
- Modify: `backend/app/models.py` (append after `CartSentLine`)
- Create: `backend/alembic/versions/20261004_a7d3e1c9b2f4_ingredients_can_be_merged.py`
- Test: `backend/tests/test_migrations.py` (existing; it fails when a model has no migration)

**Interfaces:**
- Produces: `models.IngredientMerge(from_key: str PK, to_key: str indexed, merged_at: datetime)`, `models.IngredientMergeDismissal(key_a: str PK, key_b: str PK, dismissed_at: datetime)`.

- [ ] **Step 1: Add the models**

Append to `backend/app/models.py`:

```python
class IngredientMerge(Base):
    """Two names the owner says are one ingredient: `from_key` now means `to_key`.

    Keys are `services.canonical.canonical_key` values. A `to_key` is never
    itself a `from_key`: merging the target onward later repoints every row
    at it, so looking a key up is one step and never follows a chain. See
    ADR 10, and `services.identity`, the only reader.
    """

    __tablename__ = "ingredient_merges"

    from_key: Mapped[str] = mapped_column(String(300), primary_key=True)
    to_key: Mapped[str] = mapped_column(String(300), index=True)
    merged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngredientMergeDismissal(Base):
    """A suggested merge the owner said was wrong, so it is not offered again.

    Stored as an ordered pair (`key_a` < `key_b`) so the same two names are
    one row whichever way round the suggestion pointed.
    """

    __tablename__ = "ingredient_merge_dismissals"

    key_a: Mapped[str] = mapped_column(String(300), primary_key=True)
    key_b: Mapped[str] = mapped_column(String(300), primary_key=True)
    dismissed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
```

- [ ] **Step 2: Run the migration test to see it fail**

Run: `cd backend && uv run pytest tests/test_migrations.py -q`
Expected: FAIL, reporting the two tables missing from the migrations.

- [ ] **Step 3: Write the migration**

Create `backend/alembic/versions/20261004_a7d3e1c9b2f4_ingredients_can_be_merged.py`:

```python
"""Two names can be one ingredient

The owner can say that "ground cumin" and "cumin" are the same thing to buy,
once, and every part of the app then treats them as one. Merges are kept
here rather than written into recipe text, so a recipe keeps its wording and
a merge can be taken back. Suggested merges the owner turned down are kept
too, so they are not offered again.

Nothing existing changes: both tables start empty.

Revision ID: a7d3e1c9b2f4
Revises: e0ff9c9020c3
Create Date: 2026-10-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d3e1c9b2f4"
down_revision: str | None = "e0ff9c9020c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingredient_merges",
        sa.Column("from_key", sa.String(length=300), nullable=False),
        sa.Column("to_key", sa.String(length=300), nullable=False),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("from_key"),
    )
    op.create_index(op.f("ix_ingredient_merges_to_key"), "ingredient_merges", ["to_key"])
    op.create_table(
        "ingredient_merge_dismissals",
        sa.Column("key_a", sa.String(length=300), nullable=False),
        sa.Column("key_b", sa.String(length=300), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key_a", "key_b"),
    )


def downgrade() -> None:
    op.drop_table("ingredient_merge_dismissals")
    op.drop_index(op.f("ix_ingredient_merges_to_key"), table_name="ingredient_merges")
    op.drop_table("ingredient_merges")
```

- [ ] **Step 4: Run the migration test and alembic check**

Run: `cd backend && uv run pytest tests/test_migrations.py -q`
Expected: PASS.
Run the `alembic check` command from Global Constraints.
Expected: `No new upgrade operations detected.`

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/20261004_a7d3e1c9b2f4_ingredients_can_be_merged.py
git commit -m "Add tables for merged ingredient names and turned-down suggestions" -m "Two names for one ingredient will be merged by the owner rather than
guessed, and kept apart from recipe text so a merge can be taken back.
Suggestions the owner turns down are remembered so they are not offered
again. Both tables start empty; nothing reads them yet."
```

### Task 2: The identity

**Files:**
- Create: `backend/app/services/identity.py`
- Test: `backend/tests/test_identity.py`

**Interfaces:**
- Consumes: `models.IngredientMerge` (Task 1).
- Produces:
  - `class Identity` (frozen dataclass) with `merges: Mapping[str, str]`.
  - `Identity.none() -> Identity`; `Identity.from_merges(merges: dict[str, str]) -> Identity`.
  - `async Identity.load(session) -> Identity`; `async Identity.of(session) -> Identity` (cached on `session.info`); `Identity.forget(session) -> None`.
  - `identity.resolve(key: str) -> str`; `identity.key(name: str) -> str` (`""` for a name with no key); `identity.nutrition_key(name: str) -> str`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_identity.py`:

```python
"""The one way ingredients are compared.

What is worth proving: without merges it is exactly `canonical_key`, so
nothing changes for a household that never merges; with one it answers the
target for every spelling of the merged name; nutrition keeps its state
words in front of the merged key, so "cooked" still separates two foods; and
the merges are read once per session until a merge says to read them again.
"""

from app.db import session_factory
from app.models import IngredientMerge
from app.services.canonical import canonical_key
from app.services.identity import Identity


def test_without_merges_it_is_the_canonical_key():
    identity = Identity.none()
    for name in ["Large eggs, at room temperature", "2 cups flour", "ground cumin", "***"]:
        assert identity.key(name) == canonical_key(name)


def test_a_merged_name_answers_its_target_however_it_is_spelled():
    identity = Identity.from_merges({"ground-cumin": "cumin"})
    assert identity.key("ground cumin") == "cumin"
    assert identity.key("Ground Cumin, toasted") == "cumin"
    assert identity.key("cumin") == "cumin"
    assert identity.resolve("ground-cumin") == "cumin"
    assert identity.resolve("paprika") == "paprika"


def test_a_name_with_no_key_has_no_identity_to_merge():
    assert Identity.from_merges({"": "cumin"}).key("***") == ""


def test_nutrition_keeps_state_words_in_front_of_the_merged_key():
    identity = Identity.from_merges({"ground-cumin": "cumin"})
    assert identity.nutrition_key("cooked ground cumin") == "cooked-cumin"
    assert identity.nutrition_key("ground cumin") == "cumin"
    # A merge never folds "cooked rice" into "rice": they are two foods.
    assert Identity.none().nutrition_key("2 cups cooked rice") == "cooked-rice"
    assert Identity.none().nutrition_key("rice") == "rice"


async def test_merges_are_read_once_per_session_until_forgotten():
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

        first = await Identity.of(session)
        assert first.key("ground cumin") == "cumin"

        session.add(IngredientMerge(from_key="yellow-onion", to_key="onion"))
        await session.commit()
        assert (await Identity.of(session)) is first
        assert (await Identity.of(session)).key("yellow onion") == "yellow-onion"

        Identity.forget(session)
        assert (await Identity.of(session)).key("yellow onion") == "onion"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_identity.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.identity'`.

- [ ] **Step 3: Write the module**

Create `backend/app/services/identity.py`:

```python
"""The one way ingredients are compared: their key, after the owner's merges.

`canonical_key` reduces a name to what is bought, and is the identity the
grocery list merges on, ticks and cart lines are stored under, products and
foods are chosen under, and staples are matched by (ADR 2). It cannot know
that "ground cumin" and "cumin" are one thing to buy, and nothing should
guess that, so the owner says so with a merge (ADR 10). This module applies
those merges, and every comparison of ingredients goes through it: a place
that called `canonical_key` directly would quietly disagree with the rest
of the app about what an ingredient is, and `tests/test_merged_names.py`
fails if one does.

Merges are read once per database session and kept on it, which is once per
request in the app, so a page that compares hundreds of names reads one
small table once. A merge or unmerge calls `forget` so the session's next
comparison sees it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import IngredientMerge
from .canonical import canonical_key
from .nutrition.defaults import STATE_WORDS
from .nutrition.foods import words

# Where a session keeps its merges. Sessions are per request, so this is the
# request's view of them.
_SESSION_KEY = "ingredient_identity"


@dataclass(frozen=True)
class Identity:
    """Merged-away key to the key it now means. One step: see IngredientMerge."""

    merges: Mapping[str, str]

    @classmethod
    def none(cls) -> "Identity":
        """No merges: exactly `canonical_key`, for pure code and tests."""
        return cls(MappingProxyType({}))

    @classmethod
    def from_merges(cls, merges: dict[str, str]) -> "Identity":
        return cls(MappingProxyType(dict(merges)))

    @classmethod
    async def load(cls, session: AsyncSession) -> "Identity":
        rows = await session.execute(select(IngredientMerge.from_key, IngredientMerge.to_key))
        return cls.from_merges(dict(rows.tuples().all()))

    @classmethod
    async def of(cls, session: AsyncSession) -> "Identity":
        """The session's merges, read on first use and kept for the rest of it."""
        cached = session.info.get(_SESSION_KEY)
        if cached is None:
            cached = await cls.load(session)
            session.info[_SESSION_KEY] = cached
        return cached

    @staticmethod
    def forget(session: AsyncSession) -> None:
        """Drop the session's merges, after a merge or unmerge changed them."""
        session.info.pop(_SESSION_KEY, None)

    def resolve(self, key: str) -> str:
        return self.merges.get(key, key)

    def key(self, name: str) -> str:
        """The ingredient a name means, or "" for a name that is not one."""
        key = canonical_key(name)
        return self.resolve(key) if key else ""

    def nutrition_key(self, name: str) -> str:
        """The identity a food is chosen under: state words, then `key`.

        Mirrors `nutrition.defaults.nutrition_key` with the merge applied to
        the part after the state words, so merging "ground cumin" into
        "cumin" carries "cooked ground cumin" to "cooked cumin", while
        "cooked rice" and "rice" stay two foods as ADR 8 requires.
        """
        raw = canonical_key(name)
        if not raw:
            return ""
        said = set(words(name))
        state = [w for w in STATE_WORDS if w in said and w not in raw.split("-")]
        return "-".join([*state, self.resolve(raw)])
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/test_identity.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/identity.py backend/tests/test_identity.py
git commit -m "Compare ingredients through one identity that knows about merges" -m "canonical_key cannot know that ground cumin and cumin are one thing to
buy. The identity applies the owner's merges on top of it, read once per
database session, and keeps nutrition's state words in front of the
merged key so cooked rice and rice stay two foods. Nothing uses it yet."
```

### Task 3: Every comparison goes through the identity

**Files:**
- Modify: `backend/app/services/grocery.py`, `backend/app/routes/grocery.py`, `backend/app/services/kroger/costing.py`, `backend/app/services/kroger/pricing.py`, `backend/app/routes/pricing.py`, `backend/app/services/nutrition/facts.py`, `backend/app/services/attention.py`, `backend/app/services/shopping_text.py`, `backend/app/routes/cart.py`, `backend/tests/test_shopping_text.py`
- Test: `backend/tests/test_merged_names.py`

**Interfaces:**
- Consumes: `Identity` (Task 2), `models.IngredientMerge` (Task 1).
- Produces (signature changes later tasks call):
  - `facts.recipe_keys(recipe: Recipe, identity: Identity) -> set[str]`
  - `facts.count_recipe(recipe: Recipe, picked: dict[str, int | None], identity: Identity) -> RecipeNutrition`
  - `shopping_text.read_shopping_text(text: str, identity: Identity) -> ShoppingText`
  - `costing._cost_recipe(recipe, found, factor=1.0, *, identity: Identity)`
  - `services.grocery.item_key` is removed.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_merged_names.py`:

```python
"""Merged names are one ingredient everywhere the app compares ingredients.

A merge is only as good as its weakest reader: a grocery list that merges
the two names while the pantry still tells them apart puts the spice that
is in the cupboard back on the list. So this proves the readers the owner
meets - the list, the pantry, the food a line counts as, "Needs a look" and
a pasted shopping list - and then that no code compares ingredients any
other way.
"""

import re
from pathlib import Path

from app import config
from app.db import session_factory
from app.models import AppSettings, IngredientFoodMatch, IngredientMerge, IngredientProductMatch
from app.services.identity import Identity
from app.services.shopping_text import read_shopping_text

WEEK = {"start": "2026-10-05", "end": "2026-10-11"}
LOCATION = "01400765"


async def merge(*pairs: tuple[str, str]) -> None:
    async with session_factory() as session:
        for from_key, to_key in pairs:
            session.add(IngredientMerge(from_key=from_key, to_key=to_key))
        await session.commit()


async def plan(client, title: str, ingredient: str, quantity: float, unit: str) -> int:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "servings": 4,
            "ingredients": [{"name": ingredient, "quantity": quantity, "unit": unit}],
        },
    )
    assert resp.status_code == 201, resp.text
    recipe_id = resp.json()["id"]
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": WEEK["start"], "meal": "dinner", "recipe_id": recipe_id},
    )
    assert resp.status_code == 201, resp.text
    return recipe_id


async def grocery_list(client) -> dict:
    resp = await client.get("/api/grocery-list", params=WEEK)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_merged_names_are_one_grocery_line(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    await plan(client, "Salsa", "cumin", 1, "tsp")
    await merge(("ground-cumin", "cumin"))

    items = (await grocery_list(client))["items"]

    assert [(i["key"], len(i["uses"])) for i in items] == [("cumin", 2)]


async def test_a_staple_covers_a_name_merged_into_it(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    resp = await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    assert resp.status_code == 201
    await merge(("ground-cumin", "cumin"))

    listing = await grocery_list(client)

    assert listing["items"] == []
    assert [i["key"] for i in listing["in_pantry"]] == ["cumin"]


async def test_a_tick_on_the_merged_line_restocks_the_staple(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    staple = (await client.post("/api/pantry", json={"name": "Cumin", "in_stock": False})).json()
    await merge(("ground-cumin", "cumin"))

    resp = await client.post("/api/grocery-list/mark", json={"key": "cumin", "status": "bought"})
    assert resp.status_code == 204

    stock = {i["id"]: i["in_stock"] for i in (await client.get("/api/pantry")).json()}
    assert stock[staple["id"]] is True


async def test_a_food_choice_on_the_target_reaches_the_merged_name(client):
    recipe_id = await plan(client, "Chili", "ground cumin", 2, "tsp")
    await merge(("ground-cumin", "cumin"))
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="cumin", fdc_id=None))
        await session.commit()

    lines = (await client.get(f"/api/recipes/{recipe_id}/nutrition")).json()["lines"]

    assert [(line["key"], line["skipped"]) for line in lines] == [("cumin", True)]


async def test_needs_a_look_reads_the_target_s_product(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    await merge(("ground-cumin", "cumin"))
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=LOCATION))
        session.add(IngredientProductMatch(canonical_key="cumin", location_id=LOCATION))
        await session.commit()

    entries = (await client.get("/api/recipes/attention")).json()

    issues = [(i["name"], i["issue"]) for e in entries for i in e["issues"]]
    assert ("ground cumin", "no_match") in issues


def test_a_pasted_list_reads_merged_names_as_one():
    read = read_shopping_text(
        "ground cumin\ncumin", Identity.from_merges({"ground-cumin": "cumin"})
    )
    assert [item.key for item in read.items] == ["cumin"]


# Files allowed to call the key functions directly: where they are defined,
# the identity itself, and lint, which inspects the words of one name rather
# than comparing two ingredients.
ALLOWED = {
    "services/canonical.py",
    "services/nutrition/defaults.py",
    "services/identity.py",
    "services/lint.py",
}
CALL = re.compile(r"\b(canonical_key|nutrition_key)\(")


def test_ingredients_are_only_compared_through_the_identity():
    app = Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for path in sorted(app.rglob("*.py")):
        rel = path.relative_to(app).as_posix()
        if rel in ALLOWED:
            continue
        for number, line in enumerate(path.read_text().splitlines(), start=1):
            code = line.split("#", 1)[0]
            if CALL.search(code) and not code.lstrip().startswith("def "):
                offenders.append(f"{rel}:{number}: {line.strip()}")
    assert offenders == []
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_merged_names.py -q`
Expected: FAIL. `read_shopping_text` rejects the second argument, the grocery tests see two lines, and the guard lists the call sites in the table of spec section 1.

- [ ] **Step 3: Move `services/grocery.py` onto the identity**

In `backend/app/services/grocery.py`:
- Replace `from .canonical import best_display, canonical_key` with `from .canonical import best_display` and add `from .identity import Identity`.
- Delete the `item_key = canonical_key` line and the two comment lines above it.
- In `build_grocery_list`, right after the `entries = ...` query, add `identity = await Identity.of(session)`, then make these three replacements:

```python
    pantry_by_key = {identity.key(p.name): p for p in pantry_items}
```

```python
            key = identity.key(ing.name)
```

```python
        key = identity.key(pantry.name)
```

In `backend/app/routes/grocery.py`:
- Replace `from ..services.grocery import build_grocery_list, item_key` with `from ..services.grocery import build_grocery_list` and add `from ..services.identity import Identity`.
- In `mark_item`, replace the pantry loop with:

```python
    identity = await Identity.of(session)
    result = await session.execute(select(PantryItem))
    for pantry in result.scalars().all():
        if identity.key(pantry.name) == data.key:
            pantry.in_stock = data.status != "to_buy"
```

- [ ] **Step 4: Move costing and pricing onto the identity**

In `backend/app/services/kroger/costing.py`:
- Remove `from ..canonical import canonical_key`; add `from ..identity import Identity`.
- `_products_for`: start the body with `identity = await Identity.of(session)` and build keys with `identity.key(ing.name)`:

```python
    identity = await Identity.of(session)
    keys = sorted({k for r in recipes for ing in r.ingredients if (k := identity.key(ing.name))})
```

- `_cost_recipe`: change the signature to `def _cost_recipe(recipe: Recipe, found: dict[str, Product], factor: float = 1.0, *, identity: Identity) -> tuple[list[CostLine], float, int]:` and its first loop line to `key = identity.key(ing.name)`.
- `recipe_cost`: after the `found = ...` try block add `identity = await Identity.of(session)` and call `_cost_recipe(recipe, found, identity=identity)`.
- `plan_cost`: add `identity = await Identity.of(session)` before the loop and call `_cost_recipe(entry.recipe, found, scale_factor(entry), identity=identity)`.
- `suggestions`: add `identity = await Identity.of(session)` as its first line; replace both `canonical_key(...)` calls with `identity.key(...)`; call `_cost_recipe(recipe, found, identity=identity)`.

In `backend/app/services/kroger/pricing.py`:
- Replace the `canonical_key` import with `from ..identity import Identity` (keep `best_display`).
- `recipes_on_sale`: add `identity = await Identity.of(session)` after `names = ...` and use `identity.key(ing.name)`.
- `_ingredient_names`: add `identity = await Identity.of(session)` as its first line and use `key = identity.key(name)`.

In `backend/app/routes/pricing.py`, in `alternatives`:
- Replace `rank_by = canonical_key(term) if term else key` with:

```python
    identity = await Identity.of(session)
    rank_by = identity.key(term) if term else key
```

- Replace the `canonical_key` import with `from ..services.identity import Identity`.

- [ ] **Step 5: Move nutrition and "Needs a look" onto the identity**

In `backend/app/services/nutrition/facts.py`:
- Change `from .defaults import default_for, nutrition_key` to `from .defaults import default_for` and add `from ..identity import Identity`.
- `recipes_using`: add `identity = await Identity.of(session)` before the comprehension and compare `identity.nutrition_key(name) == key`.
- Replace `recipe_keys`, `recipe_nutrition` and the first line of `count_recipe`:

```python
def recipe_keys(recipe: Recipe, identity: Identity) -> set[str]:
    """The nutrition keys a recipe's ingredients are chosen under."""
    return {key for ing in recipe.ingredients if (key := identity.nutrition_key(ing.name))}


async def recipe_nutrition(session: AsyncSession, recipe: Recipe) -> RecipeNutrition:
    identity = await Identity.of(session)
    picked = await hand_picks(session, recipe_keys(recipe, identity))
    return count_recipe(recipe, picked, identity)


def count_recipe(
    recipe: Recipe, picked: dict[str, int | None], identity: Identity
) -> RecipeNutrition:
```

and inside `count_recipe`: `keys = [identity.nutrition_key(ing.name) for ing in recipe.ingredients]`.

In `backend/app/services/attention.py`:
- Replace `from .canonical import canonical_key` with `from .identity import Identity`.
- `_issues` gains a last parameter `identity: Identity` and uses `identity.key(ing.name) in unmatched`.
- `recipes_needing_a_look`: add `identity = await Identity.of(session)` after `recipes = ...`, pass it to `facts.recipe_keys(recipe, identity)`, `facts.count_recipe(recipe, picked, identity)` and `_issues(recipe, nutrition, unmatched, identity)`.

- [ ] **Step 6: Move the pasted shopping list onto the identity**

In `backend/app/services/shopping_text.py`:
- Replace the `canonical_key` import with `from .identity import Identity`.
- `def read_shopping_text(text: str, identity: Identity) -> ShoppingText:` and inside it `key = identity.key(line.name)`.
- Add a sentence to its docstring: "Names are compared through `identity`, so a merged name pastes as its target."

In `backend/app/routes/cart.py`, at both calls (around lines 220 and 242):

```python
    read = read_shopping_text(data.text, await Identity.of(session))
```

and add `from ..services.identity import Identity`. Both routes (`paste_preview`, `paste_add`) already take `session`.

In `backend/tests/test_shopping_text.py`, add `from app.services.identity import Identity` and change every `read_shopping_text(x)` call to `read_shopping_text(x, Identity.none())`.

- [ ] **Step 7: Run the new tests, then the whole suite**

Run: `cd backend && uv run pytest tests/test_merged_names.py -q`
Expected: PASS (7 tests).
Run: `cd backend && uv run ruff check . && uv run pytest -q`
Expected: all pass. A failure elsewhere means a caller of a changed signature was missed; fix the caller, not the test.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "Compare ingredients through the identity everywhere" -m "The grocery list, ticks, pantry matching, product and food choices,
costs, suggestions, Needs a look and pasted shopping lists all ask the
identity now, so a merged name is one ingredient in every one of them.
A test fails if any code compares ingredients by the raw key instead."
```

### Task 4: Merging and unmerging, and ADR 10

**Files:**
- Create: `backend/app/services/merges.py`, `docs/adr/0010-merges-are-the-owners-corrections-on-top-of-one-key.md`, `CONTEXT.md`
- Modify: `backend/app/schemas.py`, `docs/adr/0002-canonical-key-is-the-identity-for-three-things.md`
- Test: `backend/tests/test_merges.py`

**Interfaces:**
- Consumes: `Identity` (Task 2), models.
- Produces:
  - `schemas.MergeSide = Literal["from", "to"]`, `schemas.MergeNeed = Literal["product", "food", "staple"]`, `schemas.MergeChoices(product: MergeSide | None, food: MergeSide | None, staple: MergeSide | None)` (all default `None`).
  - `merges.MergeRefused(Exception)` (message is a sentence for the page), `merges.MergeUnknown(MergeRefused)`, `merges.MergeNeedsChoice(Exception)` with `.needs: list[MergeNeed]`.
  - `async merges.keys_in_use(session, identity) -> set[str]`
  - `async merges.needs(session, from_key, to_key) -> list[MergeNeed]`
  - `async merges.merge(session, from_key, to_key, choices: MergeChoices) -> None`
  - `async merges.unmerge(session, from_key) -> None`

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas.py`:

```python
# Which side of a merge keeps a thing both sides have: the name being merged
# away ("from") or the one it is merged into ("to").
MergeSide = Literal["from", "to"]
MergeNeed = Literal["product", "food", "staple"]


class MergeChoices(BaseModel):
    """What to keep where both names have one and no rule can decide.

    Only asked for when both sides hold a hand-picked product (or food) and
    they differ, or both are staples. See services.merges.
    """

    product: MergeSide | None = None
    food: MergeSide | None = None
    staple: MergeSide | None = None
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_merges.py`:

```python
"""Merging two names into one ingredient, and taking a merge back.

A merge has to carry what was decided about the merged-away name to the
name that survives - its product at each store, its food, its staple, and
this trip's ticks and cart lines - or the owner's earlier work is lost the
moment they tidy up. Where both names had a decision and no rule can choose,
the merge asks rather than guessing. And a merge that would make a cycle or
point at nothing is refused with a sentence the page can show.
"""

import pytest
from sqlalchemy import select

from app.db import session_factory
from app.models import (
    CartSentLine,
    GroceryCheck,
    IngredientFoodMatch,
    IngredientMerge,
    IngredientProductMatch,
    PantryItem,
)
from app.schemas import MergeChoices
from app.services import merges
from app.services.identity import Identity

STORE = "01400765"
OTHER_STORE = "01400999"


async def recipe(client, *names: str) -> None:
    resp = await client.post(
        "/api/recipes",
        json={"title": names[0], "ingredients": [{"name": n, "quantity": 1, "unit": "tsp"} for n in names]},
    )
    assert resp.status_code == 201, resp.text


async def add(*rows) -> None:
    async with session_factory() as session:
        session.add_all(rows)
        await session.commit()


async def do_merge(from_key: str, to_key: str, **choices) -> None:
    async with session_factory() as session:
        await merges.merge(session, from_key, to_key, MergeChoices(**choices))


async def rows(model) -> list:
    async with session_factory() as session:
        return list((await session.execute(select(model))).scalars())


def product(key: str, product_id: str | None, hand: bool, store: str = STORE):
    return IngredientProductMatch(
        canonical_key=key, location_id=store, product_id=product_id, user_confirmed=hand
    )


async def test_a_product_moves_to_a_target_that_has_none(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=False))

    await do_merge("ground-cumin", "cumin")

    assert [(r.canonical_key, r.product_id) for r in await rows(IngredientProductMatch)] == [
        ("cumin", "111")
    ]


async def test_a_hand_pick_beats_an_automatic_one_at_each_store(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        product("ground-cumin", "111", hand=True),
        product("cumin", "222", hand=False),
        product("ground-cumin", "333", hand=False, store=OTHER_STORE),
        product("cumin", "444", hand=True, store=OTHER_STORE),
    )

    await do_merge("ground-cumin", "cumin")

    found = {(r.canonical_key, r.location_id): r.product_id for r in await rows(IngredientProductMatch)}
    assert found == {("cumin", STORE): "111", ("cumin", OTHER_STORE): "444"}


async def test_two_different_hand_picks_need_a_choice(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=True), product("cumin", "222", hand=True))

    with pytest.raises(merges.MergeNeedsChoice) as refused:
        await do_merge("ground-cumin", "cumin")
    assert refused.value.needs == ["product"]
    assert await rows(IngredientMerge) == []

    await do_merge("ground-cumin", "cumin", product="from")
    assert [r.product_id for r in await rows(IngredientProductMatch)] == ["111"]


async def test_foods_move_with_their_state_words(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        IngredientFoodMatch(key="ground-cumin", fdc_id=170923),
        IngredientFoodMatch(key="cooked-ground-cumin", fdc_id=None),
    )

    await do_merge("ground-cumin", "cumin")

    assert {(r.key, r.fdc_id) for r in await rows(IngredientFoodMatch)} == {
        ("cumin", 170923),
        ("cooked-cumin", None),
    }


async def test_two_staples_become_the_one_chosen(client):
    await recipe(client, "ground cumin", "cumin")
    await add(PantryItem(name="Ground Cumin", in_stock=False), PantryItem(name="Cumin", in_stock=True))

    with pytest.raises(merges.MergeNeedsChoice) as refused:
        await do_merge("ground-cumin", "cumin")
    assert refused.value.needs == ["staple"]

    await do_merge("ground-cumin", "cumin", staple="from")
    assert [(p.name, p.in_stock) for p in await rows(PantryItem)] == [("Ground Cumin", False)]


async def test_one_staple_is_left_alone_and_now_covers_both(client):
    await recipe(client, "ground cumin", "cumin")
    await add(PantryItem(name="Ground Cumin", in_stock=True))

    await do_merge("ground-cumin", "cumin")

    assert [p.name for p in await rows(PantryItem)] == ["Ground Cumin"]
    async with session_factory() as session:
        assert (await Identity.of(session)).key("Ground Cumin") == "cumin"


async def test_ticks_and_cart_lines_follow_mid_trip(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        GroceryCheck(key="ground-cumin", status="bought"),
        GroceryCheck(key="cumin", status="have"),
        CartSentLine(key="ground-cumin", upc="0001", description="Ground Cumin", quantity=1),
    )

    await do_merge("ground-cumin", "cumin")

    assert [(c.key, c.status) for c in await rows(GroceryCheck)] == [("cumin", "have")]
    assert [(c.key, c.upc) for c in await rows(CartSentLine)] == [("cumin", "0001")]


async def test_merging_onward_repoints_earlier_merges(client):
    await recipe(client, "ground cumin", "cumin", "cumin seed")
    await do_merge("ground-cumin", "cumin")

    await do_merge("cumin", "cumin-seed")

    assert {(m.from_key, m.to_key) for m in await rows(IngredientMerge)} == {
        ("ground-cumin", "cumin-seed"),
        ("cumin", "cumin-seed"),
    }


@pytest.mark.parametrize(
    "from_key, to_key, message",
    [
        ("cumin", "cumin", "cannot be merged into itself"),
        ("ground-cumin", "paprika", "already merged"),
        ("cumin", "ground-cumin", "already merged"),
    ],
)
async def test_refusals(client, from_key, to_key, message):
    await recipe(client, "ground cumin", "cumin", "paprika")
    await do_merge("ground-cumin", "cumin")

    with pytest.raises(merges.MergeRefused, match=message):
        await do_merge(from_key, to_key)


async def test_an_unknown_name_cannot_be_merged(client):
    await recipe(client, "cumin")

    with pytest.raises(merges.MergeUnknown):
        await do_merge("saffron", "cumin")


async def test_unmerge_deletes_the_merge_and_nothing_else(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=True))
    await do_merge("ground-cumin", "cumin")

    async with session_factory() as session:
        await merges.unmerge(session, "ground-cumin")
        assert (await Identity.of(session)).key("ground cumin") == "ground-cumin"

    assert await rows(IngredientMerge) == []
    assert [(r.canonical_key, r.product_id) for r in await rows(IngredientProductMatch)] == [
        ("cumin", "111")
    ]


async def test_unmerging_what_is_not_merged_is_unknown(client):
    async with session_factory() as session:
        with pytest.raises(merges.MergeUnknown):
            await merges.unmerge(session, "cumin")
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_merges.py -q`
Expected: FAIL with `ImportError: cannot import name 'merges'`.

- [ ] **Step 4: Write the service**

Create `backend/app/services/merges.py`:

```python
"""Merging two names for one ingredient, and taking a merge back.

A merge says "ground cumin" is "cumin" from now on (ADR 10). Recipe text is
never touched; `services.identity` applies the merge wherever ingredients are
compared. What has to happen here is the rest: everything decided about the
merged-away name moves to the name that survives, in the same transaction
as the merge itself, so nothing the owner chose is lost by tidying up.

Where both names hold a decision, a hand pick beats an automatic one. Where
both hold different hand picks, or both are staples, nothing here can know
which the owner meant, so the merge is refused until they say
(`MergeNeedsChoice`), and the page asks before it sends.

Unmerging deletes the merge and nothing else. What moved stays with the
target, and the old name starts fresh: an automatic product on its next use
and its default food, if it has one.
"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    CartSentLine,
    GroceryCheck,
    Ingredient,
    IngredientFoodMatch,
    IngredientMerge,
    IngredientProductMatch,
    PantryItem,
)
from ..schemas import MergeChoices, MergeNeed, MergeSide
from .identity import Identity
from .nutrition.defaults import STATE_WORDS


class MergeRefused(Exception):
    """A merge that cannot be made. The message is a sentence for the page."""


class MergeUnknown(MergeRefused):
    """A name nothing uses, or a merge that does not exist."""


class MergeNeedsChoice(Exception):
    """Both names hold something only the owner can choose between."""

    def __init__(self, needs: list[MergeNeed]):
        super().__init__(f"Choose which {', '.join(needs)} to keep.")
        self.needs = needs


def _spoken(key: str) -> str:
    return key.replace("-", " ")


async def keys_in_use(session: AsyncSession, identity: Identity) -> set[str]:
    """Every ingredient a recipe line or a staple stands for."""
    names = (await session.execute(select(Ingredient.name))).scalars().all()
    staples = (await session.execute(select(PantryItem.name))).scalars().all()
    return {key for name in [*names, *staples] if (key := identity.key(name))}


async def _check(session: AsyncSession, identity: Identity, from_key: str, to_key: str) -> None:
    if from_key == to_key:
        raise MergeRefused("An ingredient cannot be merged into itself.")
    for key in (from_key, to_key):
        if key in identity.merges:
            raise MergeRefused(
                f"“{_spoken(key)}” is already merged into “{_spoken(identity.merges[key])}”; "
                "unmerge it first."
            )
    in_use = await keys_in_use(session, identity)
    for key in (from_key, to_key):
        if key not in in_use:
            raise MergeUnknown(f"No ingredient called “{_spoken(key)}”.")


def _food_keys(key: str) -> list[str]:
    """A key and its state-word variants, as foods are chosen under them."""
    return [key, *(f"{word}-{key}" for word in STATE_WORDS)]


async def _staples(
    session: AsyncSession, identity: Identity, from_key: str, to_key: str
) -> tuple[list[PantryItem], list[PantryItem]]:
    pantry = (await session.execute(select(PantryItem))).scalars().all()
    return (
        [p for p in pantry if identity.key(p.name) == from_key],
        [p for p in pantry if identity.key(p.name) == to_key],
    )


async def _products(session: AsyncSession, keys: list[str]) -> dict[tuple[str, str], IngredientProductMatch]:
    found = await session.execute(
        select(IngredientProductMatch).where(IngredientProductMatch.canonical_key.in_(keys))
    )
    return {(row.canonical_key, row.location_id): row for row in found.scalars()}


async def _needs(
    session: AsyncSession,
    from_key: str,
    to_key: str,
    from_staples: list[PantryItem],
    to_staples: list[PantryItem],
) -> list[MergeNeed]:
    found: list[MergeNeed] = []
    products = await _products(session, [from_key, to_key])
    for (key, location), old in products.items():
        new = products.get((to_key, location))
        if (
            key == from_key
            and new is not None
            and old.user_confirmed
            and new.user_confirmed
            and old.product_id != new.product_id
        ):
            found.append("product")
            break
    for old_key, new_key in zip(_food_keys(from_key), _food_keys(to_key), strict=True):
        old = await session.get(IngredientFoodMatch, old_key)
        new = await session.get(IngredientFoodMatch, new_key)
        if old is not None and new is not None and old.fdc_id != new.fdc_id:
            found.append("food")
            break
    if from_staples and to_staples:
        found.append("staple")
    return found


async def needs(session: AsyncSession, from_key: str, to_key: str) -> list[MergeNeed]:
    """The choices merging `from_key` into `to_key` would ask for."""
    identity = await Identity.of(session)
    await _check(session, identity, from_key, to_key)
    from_staples, to_staples = await _staples(session, identity, from_key, to_key)
    return await _needs(session, from_key, to_key, from_staples, to_staples)


async def _move_products(
    session: AsyncSession, from_key: str, to_key: str, choice: MergeSide | None
) -> None:
    products = await _products(session, [from_key, to_key])
    for (key, location), old in list(products.items()):
        if key != from_key:
            continue
        new = products.get((to_key, location))
        if new is None:
            take = True
        elif old.user_confirmed and not new.user_confirmed:
            take = True
        elif old.user_confirmed and new.user_confirmed and old.product_id != new.product_id:
            take = choice == "from"
        else:
            take = False
        if take:
            if new is None:
                new = IngredientProductMatch(canonical_key=to_key, location_id=location)
                session.add(new)
            new.product_id = old.product_id
            new.user_confirmed = old.user_confirmed
            new.matcher_version = old.matcher_version
            new.resolved_at = old.resolved_at
        await session.delete(old)


async def _move_foods(
    session: AsyncSession, from_key: str, to_key: str, choice: MergeSide | None
) -> None:
    # Every stored food is a person's choice; the target's code default is
    # not a row and loses to it, as an automatic product loses to a hand pick.
    for old_key, new_key in zip(_food_keys(from_key), _food_keys(to_key), strict=True):
        old = await session.get(IngredientFoodMatch, old_key)
        if old is None:
            continue
        new = await session.get(IngredientFoodMatch, new_key)
        if new is None or (old.fdc_id != new.fdc_id and choice == "from"):
            if new is None:
                new = IngredientFoodMatch(key=new_key)
                session.add(new)
            new.fdc_id = old.fdc_id
        await session.delete(old)


async def _join_staples(
    session: AsyncSession,
    from_staples: list[PantryItem],
    to_staples: list[PantryItem],
    choice: MergeSide | None,
) -> None:
    # One staple needs nothing: once merged, its name means the target.
    if not (from_staples and to_staples):
        return
    keep = from_staples[0] if choice == "from" else to_staples[0]
    for staple in [*from_staples, *to_staples]:
        if staple is not keep:
            await session.delete(staple)


async def _move_mark(session: AsyncSession, model, from_key: str, to_key: str) -> None:
    """Re-key this trip's row for the line, unless the target has its own."""
    old = await session.get(model, from_key)
    if old is None:
        return
    if await session.get(model, to_key) is None:
        values = {column.key: getattr(old, column.key) for column in model.__table__.columns}
        session.add(model(**{**values, "key": to_key}))
    await session.delete(old)


async def merge(
    session: AsyncSession, from_key: str, to_key: str, choices: MergeChoices
) -> None:
    """Make `from_key` mean `to_key`, moving everything decided about it."""
    identity = await Identity.of(session)
    await _check(session, identity, from_key, to_key)
    from_staples, to_staples = await _staples(session, identity, from_key, to_key)
    wanted = await _needs(session, from_key, to_key, from_staples, to_staples)
    missing = [need for need in wanted if getattr(choices, need) is None]
    if missing:
        raise MergeNeedsChoice(missing)

    await _move_products(session, from_key, to_key, choices.product)
    await _move_foods(session, from_key, to_key, choices.food)
    await _join_staples(session, from_staples, to_staples, choices.staple)
    await _move_mark(session, GroceryCheck, from_key, to_key)
    await _move_mark(session, CartSentLine, from_key, to_key)
    # Names already merged into the one going away now mean the target, so
    # a lookup stays one step.
    await session.execute(
        update(IngredientMerge).where(IngredientMerge.to_key == from_key).values(to_key=to_key)
    )
    session.add(IngredientMerge(from_key=from_key, to_key=to_key))
    await session.commit()
    Identity.forget(session)


async def unmerge(session: AsyncSession, from_key: str) -> None:
    """Take a merge back. What moved stays with the target."""
    row = await session.get(IngredientMerge, from_key)
    if row is None:
        raise MergeUnknown(f"“{_spoken(from_key)}” is not merged into anything.")
    await session.delete(row)
    await session.commit()
    Identity.forget(session)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest tests/test_merges.py -q`
Expected: PASS (13 tests, counting each parametrized refusal).

- [ ] **Step 6: Write ADR 10, the ADR 2 note, and CONTEXT.md**

Create `docs/adr/0010-merges-are-the-owners-corrections-on-top-of-one-key.md`:

```markdown
# 10. Merges are the owner's corrections on top of one key

Accepted, October 2026.

## Context

ADR 2 made `canonical_key` the one identity for "is this the same thing to buy".
It cannot know that "ground cumin" and "cumin" are the same thing, or "mayo" and "mayonnaise", and the real recipe box had about ten such pairs among 92 ingredients.
Each pair cost something: two grocery lines, a staple that did not cover its own spice, and two remembered products for one jar.

## Decision

The owner merges two names, and the merge is stored as a row (`ingredient_merges`) rather than written into recipe text.
`services.identity` applies `canonical_key` and then the merges, and is the only way ingredients are compared; a test fails if code calls the key functions directly.
A merge moves what was decided about the merged-away name to the target in the same transaction: products at every store, foods, staples, this trip's ticks and cart lines.
A hand pick beats an automatic one, and two different hand picks, or two staples, need the owner's choice.
Unmerging deletes the row and nothing else.

## Why

**One notion of sameness, corrected.**
ADR 2's argument holds: two keys that must never disagree are worse than one that is occasionally wrong.
A merge does not add a second notion; it corrects the one there is, in the one place it is read.

**Recipe text is the author's.**
"2 tsp ground cumin" is what the cook reads at the stove, and a merge that rewrote it would be impossible to undo and would split again on the next import.

**Never guessed.**
Merges are suggested, never applied, for the reason ADR 8 gives for foods: a wrong merge is plausible and invisible, while a missing one is only untidy.

## Consequences

- A change to `canonical_key` still invalidates stored state, merges included: a merge whose `from_key` no longer occurs is inert, and one whose `to_key` moved needs the same migration that moves the rest.
- The merges table is read once per database session, so one request reads it once.
- An unmerged name loses what moved to the target; the unmerge confirmation says so.
```

Append to `docs/adr/0002-canonical-key-is-the-identity-for-three-things.md`:

```markdown

## Note, October 2026

The owner can now correct this key where it is wrong, by merging two names; see ADR 10.
Code no longer calls `canonical_key` to compare ingredients, but `services.identity`, which applies the merges on top of it.
```

Create `CONTEXT.md` at the repo root:

```markdown
# Mise

The words this codebase uses for its domain, and what they mean here.

## Ingredients

**Ingredient**: what a recipe line or a staple stands for, identified by its key after merges (`services.identity`).
"2 large eggs" and "eggs, beaten" are one ingredient, `egg`.
Avoid: item, product (a product is what a store sells).

**Staple**: an ingredient the household keeps in stock, recorded as a pantry item with an in-stock flag.
Avoid: pantry item, in user-facing text.

**Merge**: the owner saying two names are one ingredient, stored apart from recipe text and reversible (ADR 10).

**Suggested merge**: a pair the app thinks might be one ingredient, offered for the owner to merge or turn down, never applied by itself.
```

- [ ] **Step 7: Run all checks and commit**

Run the backend checks from Global Constraints.
Expected: all pass.

```bash
git add backend docs/adr CONTEXT.md
git commit -m "Merge two names into one ingredient, carrying what was decided" -m "A merge moves the merged-away name's products, foods, staple, ticks
and cart lines to the name that survives, asks when both had a hand
pick or both were staples, and refuses a cycle with a sentence. Unmerge
deletes the merge only. ADR 10 records why merges sit on top of the
single key, and CONTEXT.md starts the glossary."
```

---

## Phase 2: The ingredients API

### Task 5: Every ingredient, seen whole

**Files:**
- Create: `backend/app/services/ingredients.py`, `backend/app/routes/ingredients.py`
- Modify: `backend/app/schemas.py`, `backend/app/main.py`
- Test: `backend/tests/test_ingredients_api.py`

**Interfaces:**
- Consumes: `Identity`, `facts.hand_picks`, `facts.recipe_keys`, `facts.count_recipe`, `facts.food_choice`, `defaults.default_for`, `foods.food`, `matching.stored_picks`, `products.by_ids`, `pricing.as_item_price`, `settings_service.selected_store`, `kroger.client.enabled`, `canonical.best_display`.
- Produces (schemas):
  - `ProductStatus = Literal["picked", "auto", "not_priced", "no_match", "unseen"]`
  - `FoodStatus = Literal["default", "picked", "skipped", "none"]`
  - `IngredientProblem = Literal["merge", "no_match", "no_food", "fix_line"]`
  - `IngredientStaple(id: int, name: str, in_stock: bool)`
  - `IngredientProduct(status: ProductStatus, product: ItemPrice | None = None)`
  - `IngredientFood(status: FoodStatus, food: FoodChoice | None = None)`
  - `IngredientSummary(key, name, also_called: list[str], recipe_count: int, staple: IngredientStaple | None, product: IngredientProduct | None, food: IngredientFood, problems: list[IngredientProblem])`
  - `IngredientLine(ingredient_id, recipe_id, recipe_title, name, quantity: float | None, unit: str | None, source_line: str | None, issue: LineIssue | None)`
  - `MergeReason = Literal["describing", "counting", "synonym", "spacing"]`, `MergeSuggestion(from_key, from_name, to_key, to_name, reason: MergeReason)`
  - `MergedName(key: str, name: str)`
  - `IngredientDetail(IngredientSummary)` plus `lines: list[IngredientLine]`, `merged: list[MergedName]`, `suggestions: list[MergeSuggestion]`, `redirected_from: str | None = None`
  - `IngredientList(ingredients: list[IngredientSummary], suggestions: list[MergeSuggestion])`
- Produces (service): `async ingredients.list_ingredients(session) -> IngredientList`, `async ingredients.ingredient(session, key) -> IngredientDetail | None`.
- Produces (routes): `GET /api/ingredients`, `GET /api/ingredients/{key}` (404 `{"detail": "No ingredient called that."}`).

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas.py`:

```python
# How an ingredient stands at the chosen store, read from the picks already
# made - never a search (ADR 6). "unseen" is an ingredient no list has
# priced yet; "no_match" is one a search found nothing for; "not_priced" is
# a person saying it is not to be priced, which is a decision, not a fault.
ProductStatus = Literal["picked", "auto", "not_priced", "no_match", "unseen"]
# How an ingredient is counted: its code default, a person's pick, a person
# saying it does not count, or no food at all.
FoodStatus = Literal["default", "picked", "skipped", "none"]
# What the Needs a look view groups an ingredient under.
IngredientProblem = Literal["merge", "no_match", "no_food", "fix_line"]
MergeReason = Literal["describing", "counting", "synonym", "spacing"]


class IngredientStaple(BaseModel):
    id: int
    name: str
    in_stock: bool


class IngredientProduct(BaseModel):
    status: ProductStatus
    # Absent when Kroger could not be asked; the status still says whether
    # a product is picked.
    product: ItemPrice | None = None


class IngredientFood(BaseModel):
    status: FoodStatus
    food: FoodChoice | None = None


class IngredientSummary(BaseModel):
    """One ingredient, as the list shows it."""

    key: str
    name: str
    # Names merged into this one, as their recipes write them.
    also_called: list[str] = []
    recipe_count: int
    staple: IngredientStaple | None = None
    # Null when pricing is off or no store is chosen: there is nothing to say.
    product: IngredientProduct | None = None
    food: IngredientFood
    problems: list[IngredientProblem] = []


class IngredientLine(BaseModel):
    """A recipe line that stands for the ingredient, as the recipe writes it."""

    ingredient_id: int
    recipe_id: int
    recipe_title: str
    name: str
    quantity: float | None
    unit: str | None
    source_line: str | None
    issue: LineIssue | None = None


class MergeSuggestion(BaseModel):
    from_key: str
    from_name: str
    to_key: str
    to_name: str
    reason: MergeReason


class MergedName(BaseModel):
    key: str
    name: str


class IngredientDetail(IngredientSummary):
    """One ingredient's own page."""

    lines: list[IngredientLine]
    merged: list[MergedName] = []
    suggestions: list[MergeSuggestion] = []
    # Set when the page was asked for under a name merged into this one, so
    # the client can show the target's address instead.
    redirected_from: str | None = None


class IngredientList(BaseModel):
    ingredients: list[IngredientSummary]
    suggestions: list[MergeSuggestion] = []
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_ingredients_api.py`:

```python
"""The ingredients list and one ingredient's page.

Proves what each row says - its recipes, staple, product and food - and that
saying it never searches Kroger: products come from picks already made, and
a Kroger that fails costs the prices, not the page. Also proves the edges a
person meets: a name merged away opens its target, and a name nothing uses
any more is "not found" rather than an error.
"""

from app import config
from app.db import session_factory
from app.models import AppSettings, IngredientFoodMatch, IngredientMerge, IngredientProductMatch
from app.services.kroger import client as kroger_client
from app.services.kroger import products

STORE = "01400765"


async def recipe(client, title: str, lines: list[tuple]) -> int:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "servings": 4,
            "ingredients": [{"name": n, "quantity": q, "unit": u} for n, q, u in lines],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def listing(client) -> dict[str, dict]:
    resp = await client.get("/api/ingredients")
    assert resp.status_code == 200, resp.text
    return {i["key"]: i for i in resp.json()["ingredients"]}


async def test_every_recipe_ingredient_and_staple_is_listed_once(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("onion", 1, None)])
    await recipe(client, "Salsa", [("diced onion", 1, None)])
    await client.post("/api/pantry", json={"name": "Bread", "in_stock": False})

    found = await listing(client)

    assert sorted(found) == ["bread", "ground-cumin", "onion"]
    assert found["onion"]["recipe_count"] == 2
    assert found["bread"]["recipe_count"] == 0
    assert found["bread"]["staple"]["in_stock"] is False
    assert found["bread"]["name"] == "Bread"


async def test_a_merged_name_is_one_row_that_says_what_it_is_also_called(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    found = await listing(client)

    assert sorted(found) == ["cumin"]
    assert found["cumin"]["also_called"] == ["ground cumin"]
    assert found["cumin"]["recipe_count"] == 1


async def test_foods_are_default_picked_skipped_or_none(client):
    await recipe(
        client,
        "Box",
        [("cumin", 1, "tsp"), ("paprika", 1, "tsp"), ("basil", 1, "tsp"), ("dragonfruit dust", 1, "tsp")],
    )
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="paprika", fdc_id=170923))
        session.add(IngredientFoodMatch(key="basil", fdc_id=None))
        await session.commit()

    found = await listing(client)

    assert found["cumin"]["food"]["status"] == "default"
    assert found["paprika"]["food"]["status"] == "picked"
    assert found["basil"]["food"]["status"] == "skipped"
    assert found["dragonfruit-dust"]["food"]["status"] == "none"
    assert "no_food" in found["dragonfruit-dust"]["problems"]


async def test_a_broken_line_is_a_line_to_fix(client):
    await recipe(client, "Chili", [("22-ounce bag frozen waffle fries", 1, None)])

    found = await listing(client)

    (only,) = found.values()
    assert only["problems"] == ["fix_line"]


async def test_pricing_off_says_nothing_about_products(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    assert (await listing(client))["cumin"]["product"] is None


async def test_products_come_from_picks_and_survive_kroger_failing(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await recipe(client, "Chili", [("cumin", 1, "tsp"), ("salt", 1, "tsp"), ("paprika", 1, "tsp"), ("thyme", 1, "tsp")])
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=STORE))
        session.add(IngredientProductMatch(canonical_key="cumin", location_id=STORE, product_id="111", user_confirmed=True))
        session.add(IngredientProductMatch(canonical_key="salt", location_id=STORE, product_id=None, user_confirmed=True))
        session.add(IngredientProductMatch(canonical_key="paprika", location_id=STORE, product_id=None))
        await session.commit()

    async def no_kroger(*args, **kwargs):
        raise kroger_client.KrogerError("down")

    async def no_search(*args, **kwargs):
        raise AssertionError("listing ingredients must never search Kroger")

    monkeypatch.setattr(products, "by_ids", no_kroger)
    monkeypatch.setattr(products, "search", no_search)

    found = await listing(client)

    assert {k: v["product"]["status"] for k, v in found.items()} == {
        "cumin": "picked",
        "salt": "not_priced",
        "paprika": "no_match",
        "thyme": "unseen",
    }
    assert found["cumin"]["product"]["product"] is None
    assert found["paprika"]["problems"] == ["no_match"]


async def test_one_ingredient_lists_its_lines_as_written(client):
    chili = await recipe(client, "Chili", [("ground cumin", 2, "tsp")])
    salsa = await recipe(client, "Salsa", [("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    resp = await client.get("/api/ingredients/cumin")
    assert resp.status_code == 200, resp.text
    detail = resp.json()

    assert [(line["recipe_id"], line["name"]) for line in detail["lines"]] == [
        (chili, "ground cumin"),
        (salsa, "cumin"),
    ]
    assert detail["merged"] == [{"key": "ground-cumin", "name": "ground cumin"}]
    assert detail["redirected_from"] is None


async def test_a_merged_away_name_opens_its_target(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    detail = (await client.get("/api/ingredients/ground-cumin")).json()

    assert detail["key"] == "cumin"
    assert detail["redirected_from"] == "ground-cumin"


async def test_a_name_nothing_uses_is_not_found(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    resp = await client.get("/api/ingredients/saffron")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No ingredient called that."
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_ingredients_api.py -q`
Expected: FAIL with 404s for `/api/ingredients`.

- [ ] **Step 4: Write the service**

Create `backend/app/services/ingredients.py`:

```python
"""Every ingredient seen whole: its recipes, staple, product and food.

The app has always treated an ingredient as one thing in four places - the
grocery line, the staple, the product, the food - but kept them on three
screens. This puts them together for the Ingredients page, worked out from
the recipe lines, the staples, the picks already made and the bundled
nutrition data.

Nothing here searches Kroger, for the reason ADR 6 gives for anything that
merely lists: products come from the stored picks and one batched lookup
for their prices, and a Kroger that fails costs the prices, not the page.
Changes are made through the endpoints that already make them (pantry,
product match, food match), so there is no second way to change one thing.
"""

import logging
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import PantryItem, Recipe
from ..schemas import (
    IngredientDetail,
    IngredientFood,
    IngredientLine,
    IngredientList,
    IngredientProblem,
    IngredientProduct,
    IngredientStaple,
    IngredientSummary,
    MergedName,
    MergeSuggestion,
)
from . import settings as settings_service
from .canonical import best_display
from .identity import Identity
from .kroger import matching, products
from .kroger.client import KrogerError, enabled
from .kroger.pricing import as_item_price
from .nutrition import facts, foods
from .nutrition.defaults import default_for

log = logging.getLogger(__name__)

# Keys as `canonical_key` makes them, before merges: what "also called" lists.
_RAW = Identity.none()


@dataclass
class _Seen:
    """Everything the ingredients are worked out from, read once."""

    identity: Identity
    lines: dict[str, list[IngredientLine]] = field(default_factory=lambda: defaultdict(list))
    variants: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    raw_names: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    staples: dict[str, PantryItem] = field(default_factory=dict)
    no_food: set[str] = field(default_factory=set)

    @property
    def keys(self) -> list[str]:
        return sorted({*self.lines, *self.staples})


async def _see(session: AsyncSession) -> _Seen:
    identity = await Identity.of(session)
    seen = _Seen(identity)
    recipes = (
        (await session.execute(select(Recipe).order_by(Recipe.title, Recipe.id))).scalars().unique().all()
    )
    picked = await facts.hand_picks(
        session, {key for recipe in recipes for key in facts.recipe_keys(recipe, identity)}
    )
    for recipe in recipes:
        nutrition = facts.count_recipe(recipe, picked, identity)
        for ing, counted in zip(recipe.ingredients, nutrition.lines, strict=True):
            key = identity.key(ing.name)
            if not key:
                continue
            seen.lines[key].append(
                IngredientLine(
                    ingredient_id=ing.id,
                    recipe_id=recipe.id,
                    recipe_title=recipe.title,
                    name=ing.name,
                    quantity=ing.quantity,
                    unit=ing.unit,
                    source_line=ing.source_line,
                    issue=ing.issue,
                )
            )
            seen.variants[key].append(ing.name.strip())
            seen.raw_names[_RAW.key(ing.name)].append(ing.name.strip())
            if counted.issue == "no_food":
                seen.no_food.add(key)
    for staple in (await session.execute(select(PantryItem))).scalars():
        key = identity.key(staple.name)
        if key:
            seen.staples.setdefault(key, staple)
            seen.raw_names[_RAW.key(staple.name)].append(staple.name)
    return seen


async def _products(session: AsyncSession, keys: list[str]) -> dict[str, IngredientProduct] | None:
    """Each key's standing at the chosen store, from stored picks only."""
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return None
    stored = await matching.stored_picks(session, keys, store.location_id)
    wanted = sorted({pick.product_id for pick in stored.values() if pick.product_id})
    try:
        found = await products.by_ids(wanted, store.location_id) if wanted else {}
    except KrogerError as exc:
        log.warning("Could not price the ingredients: %s", exc)
        found = {}
    standing: dict[str, IngredientProduct] = {}
    for key in keys:
        pick = stored.get(key)
        if pick is None:
            standing[key] = IngredientProduct(status="unseen")
            continue
        if pick.product_id:
            status = "picked" if pick.hand_picked else "auto"
        else:
            status = "not_priced" if pick.hand_picked else "no_match"
        product = found.get(pick.product_id) if pick.product_id else None
        standing[key] = IngredientProduct(
            status=status, product=as_item_price(product) if product is not None else None
        )
    return standing


def _food(key: str, picked: dict[str, int | None]) -> IngredientFood:
    """The food the ingredient itself counts as, before any state word."""
    if key in picked:
        if picked[key] is None:
            return IngredientFood(status="skipped")
        chosen = foods.food(picked[key])
        return IngredientFood(
            status="picked", food=facts.food_choice(chosen) if chosen is not None else None
        )
    default = default_for(key)
    chosen = foods.food(default.fdc_id) if default is not None else None
    if chosen is None:
        return IngredientFood(status="none")
    return IngredientFood(status="default", food=facts.food_choice(chosen))


def _name(key: str, seen: _Seen) -> str:
    staple = seen.staples.get(key)
    return staple.name if staple is not None else best_display(seen.variants[key])


def _merged(key: str, seen: _Seen) -> list[MergedName]:
    return sorted(
        (
            MergedName(
                key=raw,
                name=best_display(seen.raw_names[raw]) if raw in seen.raw_names else raw.replace("-", " "),
            )
            for raw, target in seen.identity.merges.items()
            if target == key
        ),
        key=lambda merged: merged.name.casefold(),
    )


def _summary(
    key: str,
    seen: _Seen,
    standing: dict[str, IngredientProduct] | None,
    picked: dict[str, int | None],
    suggested: set[str],
) -> IngredientSummary:
    staple = seen.staples.get(key)
    product = standing.get(key) if standing is not None else None
    problems: list[IngredientProblem] = []
    if key in suggested:
        problems.append("merge")
    if product is not None and product.status == "no_match":
        problems.append("no_match")
    if key in seen.no_food:
        problems.append("no_food")
    if any(line.issue is not None for line in seen.lines.get(key, [])):
        problems.append("fix_line")
    return IngredientSummary(
        key=key,
        name=_name(key, seen),
        also_called=[merged.name for merged in _merged(key, seen) if merged.key in seen.raw_names],
        recipe_count=len({line.recipe_id for line in seen.lines.get(key, [])}),
        staple=(
            IngredientStaple(id=staple.id, name=staple.name, in_stock=staple.in_stock)
            if staple is not None
            else None
        ),
        product=product,
        food=_food(key, picked),
        problems=problems,
    )


async def _suggestions(session: AsyncSession, seen: _Seen) -> list[MergeSuggestion]:
    """Likely pairs among the ingredients in use: none until the rules exist (Task 6)."""
    return []


async def _overview(
    session: AsyncSession,
) -> tuple[_Seen, list[IngredientSummary], list[MergeSuggestion]]:
    seen = await _see(session)
    keys = seen.keys
    standing = await _products(session, keys)
    picked = await facts.hand_picks(session, set(keys))
    suggestions = await _suggestions(session, seen)
    suggested = {s.from_key for s in suggestions} | {s.to_key for s in suggestions}
    summaries = [_summary(key, seen, standing, picked, suggested) for key in keys]
    summaries.sort(key=lambda s: s.name.casefold())
    return seen, summaries, suggestions


async def list_ingredients(session: AsyncSession) -> IngredientList:
    _, summaries, suggestions = await _overview(session)
    return IngredientList(ingredients=summaries, suggestions=suggestions)


async def ingredient(session: AsyncSession, key: str) -> IngredientDetail | None:
    """One ingredient's page, or None for a name nothing uses."""
    seen, summaries, suggestions = await _overview(session)
    target = seen.identity.resolve(key)
    summary = next((s for s in summaries if s.key == target), None)
    if summary is None:
        return None
    return IngredientDetail(
        **summary.model_dump(),
        lines=seen.lines.get(target, []),
        merged=_merged(target, seen),
        suggestions=[s for s in suggestions if target in (s.from_key, s.to_key)],
        redirected_from=key if key != target else None,
    )
```

- [ ] **Step 5: Write the routes and register them**

Create `backend/app/routes/ingredients.py`:

```python
"""Ingredients, each seen whole, for the Ingredients page.

Reading only: every change the page makes goes through the endpoint that
already makes it - pantry, product match, food match - and merges through
`/merges` below.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import IngredientDetail, IngredientList
from ..services import ingredients

router = APIRouter(prefix="/ingredients", tags=["ingredients"])


@router.get("", response_model=IngredientList)
async def list_ingredients(session: AsyncSession = Depends(get_session)):
    return await ingredients.list_ingredients(session)


@router.get("/{key}", response_model=IngredientDetail)
async def ingredient(key: str, session: AsyncSession = Depends(get_session)):
    """One ingredient. A name merged into another answers with the other."""
    found = await ingredients.ingredient(session, key)
    if found is None:
        raise HTTPException(status_code=404, detail="No ingredient called that.")
    return found
```

In `backend/app/main.py`, add `ingredients` to the `from .routes import (...)` list and `api.include_router(ingredients.router)` after the pantry router.

- [ ] **Step 6: Run the tests and the suite**

Run: `cd backend && uv run pytest tests/test_ingredients_api.py -q`
Expected: PASS (9 tests).
Run the backend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "Serve every ingredient with its recipes, staple, product and food" -m "GET /api/ingredients lists each ingredient once, merged names folded
in, with what it is called elsewhere, how many recipes use it, whether
it is a staple, its standing at the store and the food it counts as.
Products come from picks already made; Kroger failing costs the prices,
never the page. A merged-away name opens its target, and a name nothing
uses is not found."
```

### Task 6: Suggested merges

**Files:**
- Create: `backend/app/services/merge_suggestions.py`, `backend/tests/fixtures/real_ingredient_keys.txt`
- Modify: `backend/app/services/ingredients.py` (`_suggestions`)
- Test: `backend/tests/test_merge_suggestions.py`

**Interfaces:**
- Consumes: `IngredientMergeDismissal` (Task 1), `_Seen` (Task 5).
- Produces:
  - `merge_suggestions.Pair(specific: str, general: str, reason: MergeReason, directed: bool)` (frozen dataclass).
  - `merge_suggestions.find(keys: Collection[str]) -> list[Pair]`

- [ ] **Step 1: Save the real keys**

Create `backend/tests/fixtures/real_ingredient_keys.txt` with these 92 lines (the owner's real recipe box on 2026-10-04, one key per line):

```
1-ounce-packet-ranch-seasoning-mix
22-ounce-bag-frozen-waffle-fry
a-few-sprigs-of-herb
all-purpose-flour
ancho-chili-powder
avocado
bacon
baking-soda
banana
black-pepper
boneless-skinless-chicken-breast
broth-or-milk
brown-sugar
burger-pickle
burger-seasoning
butter
can-black-bean
can-kidney-bean
cheddar-cheese
chicken-broth
chili-powder
cooking-oil
corn-kernel
corn-starch
cream-cheese-or-sour-cream
cumin
double-pie-crust
dried-oregano
dried-thyme
egg
evaporated-milk
flour
fresh-cilantro
frozen-mango
frozen-mixed-vegetable
frozen-strawberry
garlic
garlic-clove
garlic-powder
gold-potato
green-bell-pepper
green-onion
ground-beef
ground-cumin
ground-ginger
ground-pepper
ground-pork-sausage
hash-brown
heavy-cream
hoisin-sauce
honey
horseradish
italian-seasoning
jalapeno
ketchup
kosher-salt
lean-ground-beef
lettuce
lime-juice
mayo
mayonnaise
milk
mustard
olive-oil
onion
paprika
parmesan-cheese
plain-greek-yogurt
potato
ramen-noodle
red-bell-pepper
red-onion
red-pepper
rice-vinegar
rubbed-sage
russet-potato
salt
sesame-oil
sour-cream
soy-sauce
strips-bacon
tomato
tomato-paste
tomato-sauce
tomatoes-and-green-chilis
unsweetened-almond-milk
vanilla-extract
vegetable-oil
white-wine-vinegar
whole-milk
worcestershire
yellow-onion
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_merge_suggestions.py`:

```python
"""The pairs offered as possible merges.

Pinned against the owner's real 92 ingredients, because the rules are only
as good as what they say about a real box: every pair here is one a person
would consider, and pairs that differ to buy (red onion and onion, whole
milk and milk, sweet potato and potato) are not offered at all.
"""

from pathlib import Path

from app.db import session_factory
from app.models import IngredientMergeDismissal
from app.services.merge_suggestions import Pair, find

REAL = (Path(__file__).parent / "fixtures" / "real_ingredient_keys.txt").read_text().split()


def test_the_real_box_gets_the_pairs_a_person_would_consider():
    assert sorted(find(REAL), key=lambda p: p.specific) == [
        Pair("all-purpose-flour", "flour", "describing", True),
        Pair("garlic-clove", "garlic", "counting", True),
        Pair("gold-potato", "potato", "describing", True),
        Pair("ground-cumin", "cumin", "describing", True),
        Pair("lean-ground-beef", "ground-beef", "describing", True),
        Pair("mayo", "mayonnaise", "synonym", False),
        Pair("russet-potato", "potato", "describing", True),
        Pair("strips-bacon", "bacon", "counting", True),
        Pair("yellow-onion", "onion", "describing", True),
    ]


def test_words_that_change_what_is_bought_are_never_dropped():
    assert find(["red-onion", "onion", "whole-milk", "milk", "sweet-potato", "potato", "green-onion"]) == []


def test_spacing_alone_is_a_pair():
    assert find(["corn-starch", "cornstarch"]) == [Pair("corn-starch", "cornstarch", "spacing", False)]


def test_the_closest_general_name_wins():
    assert find(["lean-ground-beef", "ground-beef", "beef"]) == [
        Pair("ground-beef", "beef", "describing", True),
        Pair("lean-ground-beef", "ground-beef", "describing", True),
    ]


async def recipe(client, *names: str) -> None:
    resp = await client.post(
        "/api/recipes",
        json={"title": names[0], "ingredients": [{"name": n, "quantity": 1, "unit": "tsp"} for n in names]},
    )
    assert resp.status_code == 201, resp.text


async def test_the_list_offers_suggestions_and_marks_both_sides(client):
    await recipe(client, "ground cumin", "cumin", "paprika")

    body = (await client.get("/api/ingredients")).json()

    assert body["suggestions"] == [
        {
            "from_key": "ground-cumin",
            "from_name": "ground cumin",
            "to_key": "cumin",
            "to_name": "cumin",
            "reason": "describing",
        }
    ]
    problems = {i["key"]: i["problems"] for i in body["ingredients"]}
    assert problems == {"cumin": ["merge"], "ground-cumin": ["merge"], "paprika": []}


async def test_an_undirected_pair_points_at_the_name_more_recipes_use(client):
    await recipe(client, "mayo")
    await recipe(client, "mayonnaise")
    await recipe(client, "mayonnaise", "salt")

    (suggestion,) = (await client.get("/api/ingredients")).json()["suggestions"]

    assert (suggestion["from_key"], suggestion["to_key"]) == ("mayo", "mayonnaise")


async def test_a_turned_down_pair_is_not_offered_again(client):
    await recipe(client, "ground cumin", "cumin")
    async with session_factory() as session:
        session.add(IngredientMergeDismissal(key_a="cumin", key_b="ground-cumin"))
        await session.commit()

    assert (await client.get("/api/ingredients")).json()["suggestions"] == []
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_merge_suggestions.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.merge_suggestions'`.

- [ ] **Step 4: Write the rules**

Create `backend/app/services/merge_suggestions.py`:

```python
"""Pairs of ingredients that might be one thing to buy, offered to the owner.

Never applied: a suggestion is a question with two answers, Merge and Not
the same (ADR 10). So the rules are tuned to be worth a glance rather than
to be right, with one hard line: a word that changes what is bought is
never dropped. "Red onion" is not "onion" at the shop, nor "whole milk"
"milk", nor "sweet potato" "potato", so those words are left off the list
below even where nutrition treats them as harmless.
"""

from collections import defaultdict
from collections.abc import Collection
from dataclasses import dataclass
from itertools import combinations

from ..schemas import MergeReason

# Words that describe an ingredient without changing what is bought, drawn
# from lint's DESCRIPTORS and nutrition's HARMLESS_WORDS and cut to the ones
# that hold at the shop as well as in the pan.
SAME_TO_BUY = frozenset({
    "ground", "fresh", "boneless", "skinless", "lean", "extra-lean", "organic",
    "all", "purpose", "unbleached", "bleached", "pure", "extra", "virgin",
    "yellow", "russet", "yukon", "gold", "idaho", "roma", "plum", "vine",
    "hass", "english", "persian", "seedless", "cremini", "button", "flat",
    "leaf", "curly", "plain", "jasmine", "basmati", "long", "grain",
})

# Words that count an ingredient rather than name it. `canonical_key` only
# singularizes the last word, so both forms are listed.
COUNTING = frozenset({
    "clove", "cloves", "strip", "strips", "slice", "slices", "sprig", "sprigs",
    "stalk", "stalks", "head", "heads",
})

# Two names for one thing that share no words.
SYNONYMS = frozenset(
    frozenset(pair)
    for pair in [
        ("mayo", "mayonnaise"),
        ("scallion", "green-onion"),
        ("garbanzo-bean", "chickpea"),
        ("powdered-sugar", "confectioners-sugar"),
        ("cilantro", "coriander-leaf"),
    ]
)


@dataclass(frozen=True)
class Pair:
    """`specific` might be `general`. `directed`: the rule says which way."""

    specific: str
    general: str
    reason: MergeReason
    directed: bool


def _closest_general(key: str, keyset: set[str]) -> tuple[str, MergeReason] | None:
    """The key left by dropping the fewest describing or counting words."""
    tokens = key.split("-")
    droppable = [i for i, t in enumerate(tokens) if t in SAME_TO_BUY or t in COUNTING]
    for size in range(1, len(droppable) + 1):
        for dropped in combinations(droppable, size):
            rest = [t for i, t in enumerate(tokens) if i not in dropped]
            candidate = "-".join(rest)
            if rest and candidate != key and candidate in keyset:
                counting = any(tokens[i] in COUNTING for i in dropped)
                return candidate, "counting" if counting else "describing"
    return None


def find(keys: Collection[str]) -> list[Pair]:
    """Every likely pair among `keys`, one per pair of names."""
    keyset = set(keys)
    found: dict[frozenset[str], Pair] = {}
    for key in sorted(keyset):
        closest = _closest_general(key, keyset)
        if closest is not None:
            general, reason = closest
            found[frozenset({key, general})] = Pair(key, general, reason, True)
    squashed: dict[str, list[str]] = defaultdict(list)
    for key in keyset:
        squashed[key.replace("-", "")].append(key)
    for group in squashed.values():
        for a, b in combinations(sorted(group), 2):
            found.setdefault(frozenset({a, b}), Pair(a, b, "spacing", False))
    for pair in SYNONYMS:
        if pair <= keyset:
            a, b = sorted(pair)
            found.setdefault(pair, Pair(a, b, "synonym", False))
    return sorted(found.values(), key=lambda p: (p.specific, p.general))
```

- [ ] **Step 5: Fill in `_suggestions` in the ingredients service**

In `backend/app/services/ingredients.py`, add `from . import merge_suggestions` and `from ..models import IngredientMergeDismissal` (keep it alongside `PantryItem, Recipe`), and replace `_suggestions` with:

```python
async def _suggestions(session: AsyncSession, seen: _Seen) -> list[MergeSuggestion]:
    """Likely pairs among the ingredients in use, less those turned down.

    A pair the rules leave undirected points at the name more recipes use,
    then at a staple, then at the alphabetically first, so the suggestion
    reads the way most of the box already does.
    """
    dismissed = {
        frozenset({row.key_a, row.key_b})
        for row in (await session.execute(select(IngredientMergeDismissal))).scalars()
    }

    def weight(key: str) -> tuple[int, bool, str]:
        return (len(seen.lines.get(key, [])), key in seen.staples, "".join(chr(0x10FFFF - ord(c)) for c in key))

    found: list[MergeSuggestion] = []
    for pair in merge_suggestions.find(seen.keys):
        if frozenset({pair.specific, pair.general}) in dismissed:
            continue
        source, target = pair.specific, pair.general
        if not pair.directed and weight(source) > weight(target):
            source, target = target, source
        found.append(
            MergeSuggestion(
                from_key=source,
                from_name=_name(source, seen),
                to_key=target,
                to_name=_name(target, seen),
                reason=pair.reason,
            )
        )
    return found
```

The third element of `weight` inverts the key so that, when counts and staples tie, the alphabetically first key weighs more and becomes the target.

- [ ] **Step 6: Run the tests and the suite**

Run: `cd backend && uv run pytest tests/test_merge_suggestions.py tests/test_ingredients_api.py -q`
Expected: PASS. If `test_the_real_box_gets_the_pairs_a_person_would_consider` lists an extra pair, look at it: if a person would not consider it, the word that caused it belongs off `SAME_TO_BUY`; do not edit the expected list to match.
Run the backend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "Suggest names that look like the same thing to buy" -m "Pairs that differ only by a describing word, a counting word, spacing,
or a known synonym are offered with the list, pointing the specific
name at the general one, or at the name most recipes use. Words that
change what is bought are never dropped, and a pair turned down is not
offered again. Pinned against the owner's real 92 ingredients."
```

### Task 7: Merge endpoints and the preview

**Files:**
- Modify: `backend/app/services/merges.py` (add `preview`), `backend/app/schemas.py`, `backend/app/routes/ingredients.py`
- Test: `backend/tests/test_ingredients_api.py` (append)

**Interfaces:**
- Consumes: `merges.merge/unmerge/needs/_check` (Task 4), `ingredients.list_ingredients`, `ingredients.ingredient` (Task 5).
- Produces (schemas):
  - `ProductSide(product: ItemPrice | None, hand_picked: bool, not_priced: bool)`
  - `FoodSide(food: FoodOut | None, hand_picked: bool, skipped: bool)`
  - `StapleSide(name: str, in_stock: bool)`
  - `ProductConflict / FoodConflict / StapleConflict(from_side: X | None, to_side: X | None, keeps: MergeSide | None)` where `keeps` is `None` exactly when the owner must choose.
  - `MergePreview(from_key, from_name, to_key, to_name, recipes: list[RecipeRef], product: ProductConflict | None, food: FoodConflict | None, staple: StapleConflict | None, needs: list[MergeNeed])`
  - `MergeRequest(from_key: str, to_key: str)`, `MergeIn(MergeRequest)` plus `choices: MergeChoices = MergeChoices()`, `DismissRequest(key_a: str, key_b: str)`
- Produces (routes):
  - `GET /api/ingredients/suggestions -> list[MergeSuggestion]`
  - `POST /api/ingredients/suggestions/dismiss` (204)
  - `POST /api/ingredients/merges/preview -> MergePreview` (404 unknown, 409 refused)
  - `POST /api/ingredients/merges` (204; 404 unknown; 409 refused or a choice missing)
  - `DELETE /api/ingredients/merges/{from_key}` (204; 404)

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas.py`:

```python
class ProductSide(BaseModel):
    product: ItemPrice | None = None
    hand_picked: bool
    not_priced: bool = False


class FoodSide(BaseModel):
    food: FoodOut | None = None
    hand_picked: bool
    skipped: bool = False


class StapleSide(BaseModel):
    name: str
    in_stock: bool


# Each side as it stands, and which side the merge keeps. `keeps` is null
# exactly when the owner has to choose, which is also when `needs` names it.
class ProductConflict(BaseModel):
    from_side: ProductSide | None = None
    to_side: ProductSide | None = None
    keeps: MergeSide | None = None


class FoodConflict(BaseModel):
    from_side: FoodSide | None = None
    to_side: FoodSide | None = None
    keeps: MergeSide | None = None


class StapleConflict(BaseModel):
    from_side: StapleSide | None = None
    to_side: StapleSide | None = None
    keeps: MergeSide | None = None


class MergePreview(BaseModel):
    """What merging one ingredient into another would change, before it does."""

    from_key: str
    from_name: str
    to_key: str
    to_name: str
    # Recipes with lines under the name going away. They keep their wording.
    recipes: list[RecipeRef]
    product: ProductConflict | None = None
    food: FoodConflict | None = None
    staple: StapleConflict | None = None
    needs: list[MergeNeed] = []


class MergeRequest(BaseModel):
    from_key: str = Field(min_length=1, max_length=300)
    to_key: str = Field(min_length=1, max_length=300)


class MergeIn(MergeRequest):
    choices: MergeChoices = MergeChoices()


class DismissRequest(BaseModel):
    key_a: str = Field(min_length=1, max_length=300)
    key_b: str = Field(min_length=1, max_length=300)
```

These must sit after `MergeChoices`, `MergeSide`, `MergeNeed`, `ItemPrice`, `FoodOut` and `RecipeRef` in the file.

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_ingredients_api.py`:

```python
async def test_preview_says_what_a_merge_would_change(client):
    chili = await recipe(client, "Chili", [("ground cumin", 2, "tsp")])
    await recipe(client, "Salsa", [("cumin", 1, "tsp")])
    await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="ground-cumin", fdc_id=None))
        await session.commit()

    resp = await client.post(
        "/api/ingredients/merges/preview", json={"from_key": "ground-cumin", "to_key": "cumin"}
    )
    assert resp.status_code == 200, resp.text
    preview = resp.json()

    assert preview["from_name"] == "ground cumin"
    assert preview["to_name"] == "Cumin"
    assert preview["recipes"] == [{"id": chili, "title": "Chili"}]
    assert preview["product"] is None
    assert preview["food"]["from_side"]["skipped"] is True
    assert preview["food"]["to_side"]["hand_picked"] is False
    assert preview["food"]["keeps"] == "from"
    assert preview["staple"] == {
        "from_side": None,
        "to_side": {"name": "Cumin", "in_stock": True},
        "keeps": "to",
    }
    assert preview["needs"] == []


async def test_preview_and_merge_ask_when_both_are_staples(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    await client.post("/api/pantry", json={"name": "Ground Cumin", "in_stock": False})
    await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    pair = {"from_key": "ground-cumin", "to_key": "cumin"}

    preview = (await client.post("/api/ingredients/merges/preview", json=pair)).json()
    assert preview["needs"] == ["staple"]
    assert preview["staple"]["keeps"] is None

    refused = await client.post("/api/ingredients/merges", json=pair)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Choose which staple to keep."

    done = await client.post("/api/ingredients/merges", json={**pair, "choices": {"staple": "to"}})
    assert done.status_code == 204
    assert [i["name"] for i in (await client.get("/api/pantry")).json()] == ["Cumin"]


async def test_merge_then_unmerge_through_the_api(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    pair = {"from_key": "ground-cumin", "to_key": "cumin"}

    assert (await client.post("/api/ingredients/merges", json=pair)).status_code == 204
    assert sorted(await listing(client)) == ["cumin"]

    assert (await client.delete("/api/ingredients/merges/ground-cumin")).status_code == 204
    assert sorted(await listing(client)) == ["cumin", "ground-cumin"]
    assert (await client.delete("/api/ingredients/merges/ground-cumin")).status_code == 404


async def test_a_reversed_merge_is_refused_with_a_sentence(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    await client.post("/api/ingredients/merges", json={"from_key": "ground-cumin", "to_key": "cumin"})

    resp = await client.post(
        "/api/ingredients/merges", json={"from_key": "cumin", "to_key": "ground-cumin"}
    )

    assert resp.status_code == 409
    assert "unmerge it first" in resp.json()["detail"]


async def test_merging_an_unknown_name_is_not_found(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    resp = await client.post(
        "/api/ingredients/merges/preview", json={"from_key": "saffron", "to_key": "cumin"}
    )

    assert resp.status_code == 404


async def test_preview_loads_with_kroger_failing(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=STORE))
        session.add(IngredientProductMatch(canonical_key="ground-cumin", location_id=STORE, product_id="111", user_confirmed=True))
        await session.commit()

    async def no_kroger(*args, **kwargs):
        raise kroger_client.KrogerError("down")

    monkeypatch.setattr(products, "by_ids", no_kroger)

    preview = (
        await client.post(
            "/api/ingredients/merges/preview", json={"from_key": "ground-cumin", "to_key": "cumin"}
        )
    ).json()

    assert preview["product"]["from_side"] == {"product": None, "hand_picked": True, "not_priced": False}
    assert preview["product"]["keeps"] == "from"


async def test_suggestions_can_be_listed_and_turned_down(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])

    assert len((await client.get("/api/ingredients/suggestions")).json()) == 1
    resp = await client.post(
        "/api/ingredients/suggestions/dismiss", json={"key_a": "ground-cumin", "key_b": "cumin"}
    )
    assert resp.status_code == 204
    # Saying it twice is the same as once.
    await client.post(
        "/api/ingredients/suggestions/dismiss", json={"key_a": "cumin", "key_b": "ground-cumin"}
    )
    assert (await client.get("/api/ingredients/suggestions")).json() == []
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_ingredients_api.py -q`
Expected: the new tests FAIL with 404/405 from the missing routes.

- [ ] **Step 4: Add `preview` to the merges service**

Append to `backend/app/services/merges.py`, and add the imports it needs (`from ..schemas import FoodConflict, FoodSide, MergePreview, ProductConflict, ProductSide, RecipeRef, StapleConflict, StapleSide` and `from . import ingredients`):

```python
def _keeps(from_side, to_side, from_wins: bool, chosen: bool) -> MergeSide | None:
    """Which side a merge keeps, or None when the owner has to choose."""
    if chosen:
        return None
    if from_side is not None and (to_side is None or from_wins):
        return "from"
    return "to"


async def preview(session: AsyncSession, from_key: str, to_key: str) -> MergePreview:
    """What merging `from_key` into `to_key` would change, at the chosen store.

    Products are shown as they stand at the store prices are quoted against;
    a choice made here applies at every store where both names hold a
    different hand pick, which is what `needs` reports.
    """
    wanted = await needs(session, from_key, to_key)
    listing = {s.key: s for s in (await ingredients.list_ingredients(session)).ingredients}
    source, target = listing[from_key], listing[to_key]
    going = await ingredients.ingredient(session, from_key)

    def product_side(summary) -> ProductSide | None:
        standing = summary.product
        if standing is None or standing.status in ("unseen", "no_match"):
            return None
        return ProductSide(
            product=standing.product,
            hand_picked=standing.status in ("picked", "not_priced"),
            not_priced=standing.status == "not_priced",
        )

    def food_side(summary) -> FoodSide | None:
        food = summary.food
        if food.status == "none":
            return None
        return FoodSide(
            food=food.food,
            hand_picked=food.status in ("picked", "skipped"),
            skipped=food.status == "skipped",
        )

    def staple_side(summary) -> StapleSide | None:
        staple = summary.staple
        return StapleSide(name=staple.name, in_stock=staple.in_stock) if staple else None

    product = None
    p_from, p_to = product_side(source), product_side(target)
    if p_from or p_to:
        from_wins = bool(p_from and p_from.hand_picked and not (p_to and p_to.hand_picked))
        product = ProductConflict(
            from_side=p_from, to_side=p_to, keeps=_keeps(p_from, p_to, from_wins, "product" in wanted)
        )
    food = None
    f_from, f_to = food_side(source), food_side(target)
    if f_from or f_to:
        from_wins = bool(f_from and f_from.hand_picked and not (f_to and f_to.hand_picked))
        food = FoodConflict(
            from_side=f_from, to_side=f_to, keeps=_keeps(f_from, f_to, from_wins, "food" in wanted)
        )
    staple = None
    s_from, s_to = staple_side(source), staple_side(target)
    if s_from or s_to:
        # One staple is kept whichever side it is on; two need a choice.
        staple = StapleConflict(
            from_side=s_from,
            to_side=s_to,
            keeps=None if "staple" in wanted else ("to" if s_to else "from"),
        )

    recipes = {line.recipe_id: line.recipe_title for line in (going.lines if going else [])}
    return MergePreview(
        from_key=from_key,
        from_name=source.name,
        to_key=to_key,
        to_name=target.name,
        recipes=[RecipeRef(id=rid, title=title) for rid, title in recipes.items()],
        product=product,
        food=food,
        staple=staple,
        needs=wanted,
    )
```

Note the import cycle: `ingredients` does not import `merges`, so `merges` importing `ingredients` is safe.

- [ ] **Step 5: Add the routes**

In `backend/app/routes/ingredients.py`, add these above `@router.get("/{key}")`, with the imports `from sqlalchemy import select`, `from ..models import IngredientMergeDismissal`, `from ..schemas import DismissRequest, MergeIn, MergePreview, MergeRequest, MergeSuggestion` and `from ..services import merges`:

```python
def _refused(exc: merges.MergeRefused) -> HTTPException:
    status = 404 if isinstance(exc, merges.MergeUnknown) else 409
    return HTTPException(status_code=status, detail=str(exc))


@router.get("/suggestions", response_model=list[MergeSuggestion])
async def suggestions(session: AsyncSession = Depends(get_session)):
    """Declared above /{key} so that path does not swallow it."""
    return (await ingredients.list_ingredients(session)).suggestions


@router.post("/suggestions/dismiss", status_code=204)
async def dismiss(data: DismissRequest, session: AsyncSession = Depends(get_session)):
    """"Not the same": this pair is never suggested again."""
    key_a, key_b = sorted((data.key_a, data.key_b))
    if await session.get(IngredientMergeDismissal, (key_a, key_b)) is None:
        session.add(IngredientMergeDismissal(key_a=key_a, key_b=key_b))
        await session.commit()


@router.post("/merges/preview", response_model=MergePreview)
async def preview_merge(data: MergeRequest, session: AsyncSession = Depends(get_session)):
    try:
        return await merges.preview(session, data.from_key, data.to_key)
    except merges.MergeRefused as exc:
        raise _refused(exc)


@router.post("/merges", status_code=204)
async def merge(data: MergeIn, session: AsyncSession = Depends(get_session)):
    try:
        await merges.merge(session, data.from_key, data.to_key, data.choices)
    except merges.MergeRefused as exc:
        raise _refused(exc)
    except merges.MergeNeedsChoice as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/merges/{from_key}", status_code=204)
async def unmerge(from_key: str, session: AsyncSession = Depends(get_session)):
    try:
        await merges.unmerge(session, from_key)
    except merges.MergeRefused as exc:
        raise _refused(exc)
```

- [ ] **Step 6: Run the tests and the suite**

Run: `cd backend && uv run pytest tests/test_ingredients_api.py -q`
Expected: PASS (16 tests).
Run the backend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "Preview, make and take back merges through the API" -m "A preview says which recipes keep their wording and which product,
food and staple each side holds and the merge keeps, and names the
choices only the owner can make. A merge without them is refused with
the sentence the page shows, as is a cycle; turning a suggestion down
is remembered. The preview loads with Kroger down."
```

---

## Phase 3: The page, replacing Pantry

### Task 8: The Ingredients tab, opening on Staples

**Files:**
- Create: `frontend/src/pages/IngredientsPage.tsx`, `frontend/src/pages/IngredientsPage.test.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/test/fixtures.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/styles.css`
- Delete: `frontend/src/pages/PantryPage.tsx`, `frontend/src/pages/PantryPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/ingredients` (Task 5); existing `api.addPantryItem`, `api.updatePantryItem`.
- Produces:
  - TS types `ProductStatus`, `FoodStatus`, `IngredientProblem`, `MergeReason`, `IngredientStaple`, `IngredientProduct`, `IngredientFood`, `IngredientSummary`, `IngredientLine`, `MergeSuggestion`, `MergedName`, `IngredientDetail`, `IngredientList` (same field names as the backend schemas in Task 5).
  - `api.listIngredients(): Promise<IngredientList>`, `api.ingredient(key: string): Promise<IngredientDetail>`.
  - Fixtures `ingredientSummary(o)`, `staple(name, inStock?, o?)`, `ingredientLine(o)`, `ingredientDetail(o)`, `mergeSuggestion(o)`.
  - Route `/ingredients`; `/pantry` redirects to it; the nav's Pantry entry becomes Ingredients with 🥕.

- [ ] **Step 1: Add the types, API calls and fixtures**

In `frontend/src/api.ts`, after the `PantryItem` interface, add:

```ts
/**
 * How an ingredient stands at the chosen store, read from picks already made.
 * "unseen": no list has priced it yet. "no_match": a search found nothing.
 * "not_priced": a person said not to price it, which is a decision, not a fault.
 */
export type ProductStatus = "picked" | "auto" | "not_priced" | "no_match" | "unseen";
/** Its code default, a person's pick, a person saying it does not count, or none. */
export type FoodStatus = "default" | "picked" | "skipped" | "none";
/** What the Needs a look view groups an ingredient under. */
export type IngredientProblem = "merge" | "no_match" | "no_food" | "fix_line";
export type MergeReason = "describing" | "counting" | "synonym" | "spacing";

export interface IngredientStaple {
  id: number;
  name: string;
  in_stock: boolean;
}

export interface IngredientProduct {
  status: ProductStatus;
  /** Null when Kroger could not be asked; the status still says what was picked. */
  product: ItemPrice | null;
}

export interface IngredientFood {
  status: FoodStatus;
  food: FoodChoice | null;
}

/** One ingredient, as the list shows it. */
export interface IngredientSummary {
  key: string;
  name: string;
  /** Names merged into this one, as their recipes write them. */
  also_called: string[];
  recipe_count: number;
  staple: IngredientStaple | null;
  /** Null when pricing is off or no store is chosen. */
  product: IngredientProduct | null;
  food: IngredientFood;
  problems: IngredientProblem[];
}

/** A recipe line that stands for the ingredient, as the recipe writes it. */
export interface IngredientLine {
  ingredient_id: number;
  recipe_id: number;
  recipe_title: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  source_line: string | null;
  issue: LineIssue | null;
}

export interface MergeSuggestion {
  from_key: string;
  from_name: string;
  to_key: string;
  to_name: string;
  reason: MergeReason;
}

export interface MergedName {
  key: string;
  name: string;
}

/** One ingredient's own page. */
export interface IngredientDetail extends IngredientSummary {
  lines: IngredientLine[];
  merged: MergedName[];
  suggestions: MergeSuggestion[];
  /** Set when the page was asked for under a name merged into this one. */
  redirected_from: string | null;
}

export interface IngredientList {
  ingredients: IngredientSummary[];
  suggestions: MergeSuggestion[];
}
```

In the `api` object, after `deletePantryItem`, add:

```ts
  /** Every ingredient seen whole. Never searches Kroger. */
  listIngredients: () => request<IngredientList>("/api/ingredients"),
  /** One ingredient; a name merged away answers with its target. */
  ingredient: (key: string) =>
    request<IngredientDetail>(`/api/ingredients/${encodeURIComponent(key)}`),
```

In `frontend/src/test/fixtures.ts`, import the new types and add:

```ts
export function ingredientSummary(overrides: Partial<IngredientSummary> = {}): IngredientSummary {
  return {
    key: "olive-oil",
    name: "olive oil",
    also_called: [],
    recipe_count: 1,
    staple: null,
    product: null,
    food: { status: "default", food: null },
    problems: [],
    ...overrides,
  };
}

/** A staple: an ingredient kept in stock, used by no recipe unless told. */
export function staple(
  name: string,
  inStock = true,
  overrides: Partial<IngredientSummary> = {},
): IngredientSummary {
  return ingredientSummary({
    key: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    recipe_count: 0,
    staple: { id: id(), name, in_stock: inStock },
    ...overrides,
  });
}

export function ingredientLine(overrides: Partial<IngredientLine> = {}): IngredientLine {
  return {
    ingredient_id: id(),
    recipe_id: 1,
    recipe_title: "Chili",
    name: "olive oil",
    quantity: 2,
    unit: "tbsp",
    source_line: null,
    issue: null,
    ...overrides,
  };
}

export function ingredientDetail(overrides: Partial<IngredientDetail> = {}): IngredientDetail {
  return {
    ...ingredientSummary(),
    lines: [ingredientLine()],
    merged: [],
    suggestions: [],
    redirected_from: null,
    ...overrides,
  };
}

export function mergeSuggestion(overrides: Partial<MergeSuggestion> = {}): MergeSuggestion {
  return {
    from_key: "ground-cumin",
    from_name: "ground cumin",
    to_key: "cumin",
    to_name: "cumin",
    reason: "describing",
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/pages/IngredientsPage.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IngredientSummary } from "../api";
import { HttpError, mockBackend } from "../test/backend";
import { staple } from "../test/fixtures";
import { renderApp } from "../test/render";

/** The list as the server sends it: already in name order. */
const list = (...ingredients: IngredientSummary[]) => ({ ingredients, suggestions: [] });

/** The row for a staple, whichever way it is stocked. */
function row(name: string): HTMLElement {
  return screen.getByRole("link", { name }).closest<HTMLElement>(".pantry-item")!;
}

describe("IngredientsPage: staples", () => {
  it("puts staples to restock first, then those in stock", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("coffee", false), staple("olive oil"), staple("rice", false)),
    });
    renderApp("/ingredients");

    expect(await screen.findByText("2 to restock")).toBeInTheDocument();
    const restock = screen.getByRole("region", { name: "To restock" });
    const stocked = screen.getByRole("region", { name: "In stock" });
    expect(within(restock).getAllByRole("link").map((l) => l.textContent)).toEqual(["coffee", "rice"]);
    expect(within(stocked).getAllByRole("link").map((l) => l.textContent)).toEqual(["olive oil"]);
  });

  it("says so when everything is stocked", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByText("Fully stocked")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To restock" })).not.toBeInTheDocument();
  });

  it("suggests what to add when there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": list() });
    renderApp("/ingredients");

    expect(await screen.findByText("No staples yet")).toBeInTheDocument();
  });

  it("links each staple to its ingredient's page", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByRole("link", { name: "rice" })).toHaveAttribute("href", "/ingredients/rice");
  });

  it("adds a staple in stock, then clears the box for the next one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients": list(),
      "POST /api/pantry": { id: 9, name: "olive oil", in_stock: true },
    });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    const box = screen.getByLabelText("Add a staple");
    await user.type(box, "  olive oil  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({ name: "olive oil", in_stock: true });
    expect(box).toHaveValue("");
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("does nothing when the name is blank", async () => {
    const backend = mockBackend({ "GET /api/ingredients": list() });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    await user.type(screen.getByLabelText("Add a staple"), "   ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(backend.requestsTo("POST /api/pantry")).toHaveLength(0);
  });

  it("flips the stock switch immediately, then saves it", async () => {
    const rice = staple("rice");
    let confirmSave: () => void = () => {};
    const backend = mockBackend({
      "GET /api/ingredients": list(rice),
      "PUT /api/pantry/:id": () =>
        new Promise((resolve) => {
          confirmSave = () => resolve({ ...rice.staple, in_stock: false });
        }),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toBeInTheDocument();
    const [request] = backend.requestsTo("PUT /api/pantry/:id");
    expect(request.path).toBe(`/api/pantry/${rice.staple!.id}`);
    expect(request.body).toEqual({ in_stock: false });
    confirmSave();
    await waitFor(() => expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2));
  });

  it("puts the switch back when the server refuses", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("rice")),
      "PUT /api/pantry/:id": new HttpError(500, "Database is down"),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText("Database is down")).toBeInTheDocument();
    expect(within(row("rice")).getByRole("button", { name: /in stock/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports a failed load instead of claiming there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": new HttpError(500, "Database is down") });
    renderApp("/ingredients");

    expect(await screen.findByText(/Couldn't load your ingredients/)).toBeInTheDocument();
    expect(screen.queryByText("No staples yet")).not.toBeInTheDocument();
  });

  it("is where the old pantry address goes", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/pantry");

    expect(await screen.findByRole("heading", { name: "Ingredients" })).toBeInTheDocument();
  });
});
```

In `frontend/src/App.test.tsx`: change `SECTIONS` to `["Recipes", "Planner", "Groceries", "Ingredients"]`; in the "marks the section being viewed" test, render `"/ingredients"` and expect the link named `"Ingredients"`; add `"GET /api/ingredients": { ingredients: [], suggestions: [] }` to `plainBackend` and `priced`.

- [ ] **Step 3: Run them to see them fail**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx src/App.test.tsx`
Expected: FAIL; `/ingredients` renders nothing and the nav still says Pantry.

- [ ] **Step 4: Write the page**

Create `frontend/src/pages/IngredientsPage.tsx`:

```tsx
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { api, type IngredientSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead, Switch } from "../components/ui";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

/**
 * The Ingredients tab: every ingredient seen whole, starting from the staples.
 *
 * It replaced Pantry, so its first screen is the pantry's job - restocking -
 * and stays one tap from the cupboard: staples that ran out come first, and
 * the switch is on the row. Everything else about an ingredient is on its
 * own page, which each name links to. See the spec in
 * docs/superpowers/specs/2026-10-04-ingredients-page-design.md.
 */
export default function IngredientsPage() {
  const { data, setData, error, reload } = useLoad(useCallback(() => api.listIngredients(), []));
  const action = useAction();

  const staples = (data?.ingredients ?? []).filter((i) => i.staple !== null);
  const toRestock = staples.filter((i) => !i.staple!.in_stock).length;

  function showStock(key: string, in_stock: boolean) {
    setData(
      (prev) =>
        prev && {
          ...prev,
          ingredients: prev.ingredients.map((i) =>
            i.key === key && i.staple ? { ...i, staple: { ...i.staple, in_stock } } : i,
          ),
        },
    );
  }

  async function setStock(item: IngredientSummary, in_stock: boolean) {
    const kept = item.staple!;
    // Flipped first, as the pantry always did: the switch is the whole
    // interaction, and a round trip before it moves feels broken. Put back
    // if the server disagrees, since a switch that lies sends the next
    // grocery list to the wrong section.
    showStock(item.key, in_stock);
    if (
      await action.run(
        () => api.updatePantryItem(kept.id, { in_stock }),
        () => showStock(item.key, kept.in_stock),
      )
    ) {
      reload();
    }
  }

  async function addStaple(name: string): Promise<boolean> {
    const added = await action.run(() => api.addPantryItem(name, true));
    if (added) reload();
    return added;
  }

  return (
    <div className="ingredients-layout">
      <PageHead
        title="Ingredients"
        sub={staples.length === 0 ? "" : toRestock > 0 ? `${toRestock} to restock` : "Fully stocked"}
      />

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {error && (
        <LoadFailure what="your ingredients" message={error} onRetry={reload} showing={data !== null} />
      )}

      {data && <StaplesView staples={staples} onToggle={setStock} onAdd={addStaple} />}
    </div>
  );
}

function StaplesView({
  staples,
  onToggle,
  onAdd,
}: {
  staples: IngredientSummary[];
  onToggle: (item: IngredientSummary, inStock: boolean) => void;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = name.trim();
    if (!typed) return;
    if (await onAdd(typed)) setName("");
  }

  return (
    <>
      <p className="page-note">
        Staples you always keep on hand. One that runs out goes on the grocery list by itself, and
        one in stock is set aside when a recipe calls for it - with the amount, so you can still
        buy more.
      </p>

      <form className="pantry-add" onSubmit={submit}>
        <input
          aria-label="Add a staple"
          placeholder="Add a staple, e.g. olive oil"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>

      {staples.length === 0 && (
        <EmptyState glyph="🫙" title="No staples yet">
          <p>Add the basics you always keep around, like salt, rice, or coffee.</p>
        </EmptyState>
      )}

      <StapleGroup
        title="To restock"
        items={staples.filter((i) => !i.staple!.in_stock)}
        onToggle={onToggle}
      />
      <StapleGroup
        title="In stock"
        items={staples.filter((i) => i.staple!.in_stock)}
        onToggle={onToggle}
      />
    </>
  );
}

function StapleGroup({
  title,
  items,
  onToggle,
}: {
  title: string;
  items: IngredientSummary[];
  onToggle: (item: IngredientSummary, inStock: boolean) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="ingredient-group" aria-label={title}>
      <h2>{title}</h2>
      {items.map((item) => {
        const kept = item.staple!;
        return (
          <div key={item.key} className={`pantry-item${kept.in_stock ? "" : " out"}`}>
            <Link className="name" to={`/ingredients/${item.key}`}>
              {kept.name}
            </Link>
            <Switch on={kept.in_stock} onToggle={() => onToggle(item, !kept.in_stock)}>
              {kept.in_stock ? "In stock" : "Out of stock"}
            </Switch>
          </div>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 5: Wire the route and the nav, and remove Pantry**

In `frontend/src/App.tsx`:
- Replace `import PantryPage from "./pages/PantryPage";` with `import IngredientsPage from "./pages/IngredientsPage";`.
- In `SECTIONS`, replace the Pantry entry with `{ to: "/ingredients", label: "Ingredients", glyph: "🥕" },`.
- Replace `<Route path="/pantry" element={<PantryPage />} />` with:

```tsx
        <Route path="/ingredients" element={<IngredientsPage />} />
        {/* Pantry's old address, kept for bookmarks and the installed app's
            shortcuts: its job is the Ingredients tab's Staples view now. */}
        <Route path="/pantry" element={<Navigate to="/ingredients" replace />} />
```

Delete `frontend/src/pages/PantryPage.tsx` and `frontend/src/pages/PantryPage.test.tsx` (`git rm`).

In `frontend/src/styles.css`:
- Rename the selector `.pantry-layout` to `.ingredients-layout`.
- After the `.pantry-item.out .name` rule, add:

```css
/* A staple's name opens its ingredient's page; quiet until it is pointed at,
   so the list still reads as a list of things in the cupboard. */
.pantry-item a.name:hover { text-decoration: underline; }

.ingredient-group h2 {
  font-family: var(--font-body);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--muted);
  margin: var(--space-20) 0 var(--space-8);
}
```


- [ ] **Step 6: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx src/App.test.tsx`
Expected: PASS.
Run the frontend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "Replace the Pantry tab with Ingredients, opening on staples" -m "The tab is called Ingredients and opens on the staples, with the ones
to restock first and the stock switch still on the row. Each name opens
its ingredient's page; removing a staple moves there, away from the
switch it sat beside. The old /pantry address redirects."
```

### Task 9: All, Needs a look, and search

**Files:**
- Create: `frontend/src/ingredients.ts`, `frontend/src/ingredients.test.ts`
- Modify: `frontend/src/pages/IngredientsPage.tsx`, `frontend/src/pages/IngredientsPage.test.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 8's page and types; `Segmented` from `components/ui`; `ISSUE_LABELS` from `issues.ts`.
- Produces:
  - `summaryLine(item: IngredientSummary): string`
  - `PROBLEM_LABELS: Record<IngredientProblem, string>`
  - `PROBLEM_GROUPS: readonly (readonly [IngredientProblem, string])[]` (the non-merge groups in order)
  - `matchesSearch(item: IngredientSummary, query: string): boolean`
  - The page reads `?view=staples|all|look`, falling back to the view remembered under `localStorage["ingredients-view"]`, then to `staples`.

- [ ] **Step 1: Write the failing helper tests**

Create `frontend/src/ingredients.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { matchesSearch, summaryLine } from "./ingredients";
import { ingredientSummary, itemPrice } from "./test/fixtures";

describe("summaryLine", () => {
  it("says how many recipes, which product at what price, and whether it is counted", () => {
    const cumin = ingredientSummary({
      recipe_count: 3,
      product: { status: "picked", product: itemPrice({ description: "McCormick Ground Cumin", regular: 3.49 }) },
      food: { status: "default", food: null },
    });
    expect(summaryLine(cumin)).toBe("3 recipes · McCormick Ground Cumin $3.49 · counted");
  });

  it("names the offer price when there is one", () => {
    const flour = ingredientSummary({
      product: { status: "auto", product: itemPrice({ description: "Flour", regular: 2.59, promo: 1.99 }) },
    });
    expect(summaryLine(flour)).toBe("1 recipe · Flour $1.99 · counted");
  });

  it("says what is missing rather than leaving it out", () => {
    const fries = ingredientSummary({
      recipe_count: 0,
      product: { status: "no_match", product: null },
      food: { status: "none", food: null },
    });
    expect(summaryLine(fries)).toBe("no recipes · no match · no food chosen");
  });

  it("says nothing about the store with pricing off", () => {
    expect(summaryLine(ingredientSummary({ product: null }))).toBe("1 recipe · counted");
  });

  it("keeps a picked product's standing when its price could not be fetched", () => {
    expect(summaryLine(ingredientSummary({ product: { status: "picked", product: null } }))).toBe(
      "1 recipe · product picked · counted",
    );
  });
});

describe("matchesSearch", () => {
  it("matches the name and every name merged into it", () => {
    const cumin = ingredientSummary({ name: "cumin", also_called: ["ground cumin"] });
    expect(matchesSearch(cumin, "CUM")).toBe(true);
    expect(matchesSearch(cumin, "ground")).toBe(true);
    expect(matchesSearch(cumin, "paprika")).toBe(false);
    expect(matchesSearch(cumin, "  ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/ingredients.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the helpers**

Create `frontend/src/ingredients.ts`:

```ts
/**
 * What the Ingredients pages say about an ingredient, in one place.
 *
 * The list and the ingredient's own page describe the same facts, and two
 * copies of the wording drift apart; the recipe-side reasons already did
 * once, which is why `issues.ts` exists. The words for what is wrong come
 * from there.
 */

import type { IngredientProblem, IngredientSummary } from "./api";
import { ISSUE_LABELS } from "./issues";

const money = (n: number) => `$${n.toFixed(2)}`;

/** The muted line under a name: its recipes, its standing at the store, its food. */
export function summaryLine(item: IngredientSummary): string {
  const count = item.recipe_count;
  const parts = [count === 0 ? "no recipes" : `${count} recipe${count === 1 ? "" : "s"}`];

  const standing = item.product;
  if (standing) {
    const picked = standing.status === "picked" || standing.status === "auto";
    if (picked && standing.product) {
      const p = standing.product;
      parts.push(`${p.description} ${money(p.promo ?? p.regular)}`);
    } else if (picked) {
      parts.push("product picked");
    } else if (standing.status === "not_priced") {
      parts.push("not priced");
    } else if (standing.status === "no_match") {
      parts.push(ISSUE_LABELS.no_match);
    }
  }

  const food = item.food.status;
  parts.push(food === "skipped" ? "doesn't count" : food === "none" ? ISSUE_LABELS.no_food : "counted");
  return parts.join(" · ");
}

export const PROBLEM_LABELS: Record<IngredientProblem, string> = {
  merge: "might be a duplicate",
  no_match: ISSUE_LABELS.no_match,
  no_food: ISSUE_LABELS.no_food,
  fix_line: "line to fix",
};

/**
 * The Needs a look groups an ingredient can fall under, in the order they are
 * worked through. Suggested merges come first and are listed from the
 * suggestions themselves, not from here.
 */
export const PROBLEM_GROUPS: readonly (readonly [IngredientProblem, string])[] = [
  ["no_match", "No product at your store"],
  ["no_food", "No food for nutrition"],
  ["fix_line", "Recipe lines to fix"],
];

/** Whether a search finds an ingredient, by its name or any merged into it. */
export function matchesSearch(item: IngredientSummary, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return true;
  return [item.name, ...item.also_called].some((name) => name.toLocaleLowerCase().includes(wanted));
}
```

- [ ] **Step 4: Run the helper tests**

Run: `cd frontend && npx vitest run src/ingredients.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing page tests**

Append to `frontend/src/pages/IngredientsPage.test.tsx` (add `ingredientSummary` and `itemPrice` to the fixtures import):

```tsx
describe("IngredientsPage: views", () => {
  const cumin = ingredientSummary({
    key: "cumin",
    name: "cumin",
    also_called: ["ground cumin"],
    recipe_count: 2,
    product: { status: "picked", product: itemPrice({ description: "McCormick Ground Cumin", regular: 3.49 }) },
  });
  const fries = ingredientSummary({
    key: "22-ounce-bag-frozen-waffle-fry",
    name: "22-ounce bag frozen waffle fries",
    product: { status: "no_match", product: null },
    food: { status: "none", food: null },
    problems: ["no_match", "no_food", "fix_line"],
  });

  it("opens on Staples and switches to All, remembering the choice", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, staple("rice")) });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });
    expect(screen.getByRole("button", { name: /Staples/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /All/ }));

    expect(screen.getByRole("link", { name: /cumin/ })).toHaveTextContent(
      "2 recipes · McCormick Ground Cumin $3.49 · counted",
    );
    expect(localStorage.getItem("ingredients-view")).toBe("all");
  });

  it("opens on the view remembered on this device", async () => {
    localStorage.setItem("ingredients-view", "all");
    mockBackend({ "GET /api/ingredients": list(cumin) });
    renderApp("/ingredients");

    expect(await screen.findByRole("button", { name: /All/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens on the view a link asks for", async () => {
    localStorage.setItem("ingredients-view", "staples");
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    renderApp("/ingredients?view=look");

    expect(await screen.findByRole("button", { name: /Needs a look/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("counts each view", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries, staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByRole("button", { name: "Staples 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs a look 1" })).toBeInTheDocument();
  });

  it("groups what needs a look by the job it needs", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    renderApp("/ingredients?view=look");

    for (const heading of ["No product at your store", "No food for nutrition", "Recipe lines to fix"]) {
      const group = await screen.findByRole("region", { name: heading });
      expect(within(group).getByRole("link", { name: /waffle fries/ })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: /cumin/ })).not.toBeInTheDocument();
  });

  it("says so when nothing needs a look", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin) });
    renderApp("/ingredients?view=look");

    expect(await screen.findByText("Nothing needs a look")).toBeInTheDocument();
  });

  it("searches the view on screen, by any name merged in", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    const { user } = renderApp("/ingredients?view=all");
    await screen.findByRole("link", { name: /cumin/ });

    await user.type(screen.getByLabelText("Search ingredients"), "ground");

    expect(screen.getByRole("link", { name: /cumin/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /waffle fries/ })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search ingredients"));
    await user.type(screen.getByLabelText("Search ingredients"), "saffron");
    expect(screen.getByText("No ingredients match “saffron”.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx`
Expected: the new tests FAIL; there is no switcher.

- [ ] **Step 7: Add the switcher, search and the two views**

In `frontend/src/pages/IngredientsPage.tsx`:
- Change the imports to:

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, type IngredientSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead, Segmented, Switch } from "../components/ui";
import { PROBLEM_GROUPS, PROBLEM_LABELS, matchesSearch, summaryLine } from "../ingredients";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";
```

- Above the component, add:

```tsx
type View = "staples" | "all" | "look";
const VIEWS: readonly View[] = ["staples", "all", "look"];
const VIEW_KEY = "ingredients-view";

const isView = (value: string | null): value is View => VIEWS.includes(value as View);

/** The view this device used last. A per-device convenience, lost harmlessly. */
function storedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return isView(stored) ? stored : "staples";
  } catch {
    return "staples";
  }
}

/** Whether anything about an ingredient needs a look, merges aside. */
const needsLook = (item: IngredientSummary) => item.problems.some((p) => p !== "merge");
```

- In `IngredientsPage`, after `const action = useAction();`, add:

```tsx
  const [params] = useSearchParams();
  // A link may ask for a view ("Needs a look" from the recipe box); otherwise
  // the page opens where this device left it.
  const [view, setView] = useState<View>(() => {
    const asked = params.get("view");
    return isView(asked) ? asked : storedView();
  });
  const [query, setQuery] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // A per-device convenience; nothing is lost if it cannot be kept.
    }
  }, [view]);

  const all = data?.ingredients ?? [];
  const look = all.filter(needsLook);
  const shown = (view === "staples" ? staples : view === "all" ? all : look).filter((i) =>
    matchesSearch(i, query),
  );
```

- Replace the line `{data && <StaplesView staples={staples} onToggle={setStock} onAdd={addStaple} />}` with:

```tsx
      {data && (
        <>
          <div className="ingredients-controls">
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: "staples", label: <>Staples <span className="count">{staples.length}</span></> },
                { value: "all", label: <>All <span className="count">{all.length}</span></> },
                { value: "look", label: <>Needs a look <span className="count">{look.length}</span></> },
              ]}
            />
            <input
              className="searchbar"
              type="search"
              aria-label="Search ingredients"
              placeholder="Search ingredients…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {query.trim() && shown.length === 0 && (
            <p className="list-status">No ingredients match “{query.trim()}”.</p>
          )}

          {view === "staples" && (
            <StaplesView staples={shown} query={query} onToggle={setStock} onAdd={addStaple} />
          )}
          {view === "all" && shown.map((item) => <IngredientRow key={item.key} item={item} />)}
          {view === "look" && <LookView items={shown} />}
        </>
      )}
```

- In `StaplesView`, show the empty state only when there is no search: change `{staples.length === 0 && (` to `{staples.length === 0 && !query && (` and pass `query` in as a prop (`query: string`) from the page.
- Add these components at the end of the file:

```tsx
function IngredientRow({ item }: { item: IngredientSummary }) {
  return (
    <Link to={`/ingredients/${item.key}`} className="ingredient-row">
      <span className="name">{item.name}</span>
      <span className="meta">{summaryLine(item)}</span>
      {item.problems.length > 0 && (
        <span className="tags">
          {item.problems.map((problem) => (
            <span key={problem} className="issue-tag">
              {PROBLEM_LABELS[problem]}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}

/**
 * Grouped by the job each needs, because the fixes differ: a product is
 * chosen at the store, a food from USDA's, a line is edited in its recipe.
 * An ingredient with two problems is in two groups, once for each fix.
 */
function LookView({ items }: { items: IngredientSummary[] }) {
  const groups = PROBLEM_GROUPS.map(
    ([problem, heading]) => [heading, items.filter((i) => i.problems.includes(problem))] as const,
  ).filter(([, found]) => found.length > 0);

  if (groups.length === 0) {
    return (
      <EmptyState glyph="✅" title="Nothing needs a look">
        <p>Every ingredient has a product, a food and a recipe line that reads right.</p>
      </EmptyState>
    );
  }
  return (
    <>
      {groups.map(([heading, found]) => (
        <section key={heading} className="ingredient-group" aria-label={heading}>
          <h2>{heading}</h2>
          {found.map((item) => (
            <IngredientRow key={item.key} item={item} />
          ))}
        </section>
      ))}
    </>
  );
}
```

In `frontend/src/styles.css`, after the `.ingredient-group h2` rule, add:

```css
.ingredients-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
  margin-bottom: var(--space-16);
}

.ingredients-controls .searchbar { flex: 1; min-width: 0; }

/* A row in All and Needs a look: the name, one muted line, then its tags. */
.ingredient-row {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-4);
  border-bottom: 1px solid var(--line);
}

.ingredient-row:hover { background: var(--surface-2); }

.ingredient-row .name { font-weight: var(--weight-semibold); }

.ingredient-row .meta {
  color: var(--muted);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.ingredient-row .tags { display: flex; flex-wrap: wrap; gap: var(--space-6); }
```

- [ ] **Step 8: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx src/ingredients.test.ts`
Expected: PASS.
Run the frontend checks from Global Constraints.

- [ ] **Step 9: Commit**

```bash
git add frontend
git commit -m "Show every ingredient, and the ones that need a look" -m "A switcher moves between Staples, All and Needs a look, each counted,
remembered per device, and open to a link that asks for one. Each row
says how many recipes use the ingredient, its product and price, and
whether it is counted, with a tag for anything wrong; Needs a look
groups them by the fix each needs. Search matches merged names too."
```

---

## Phase 4: The ingredient's own page

### Task 10: One ingredient, whole

**Files:**
- Create: `frontend/src/pages/IngredientPage.tsx`, `frontend/src/pages/IngredientPage.test.tsx`
- Modify: `frontend/src/api.ts` (`request` throws `ApiError` with a status), `frontend/src/components/Nutrition.tsx` (`FoodPickerModal` without a recipe), `frontend/src/App.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `api.ingredient` (Task 8); `ProductPickerModal`; `FoodPickerModal`; `api.setMatch`, `api.forgetMatch`, `api.chooseFood`, `api.forgetFood`, `api.addPantryItem`, `api.updatePantryItem`, `api.deletePantryItem`; `recipeIngredientPath`; `formatQuantity` from `quantity.ts`.
- Produces:
  - `export class ApiError extends Error { status: number }` in `api.ts`; `request` throws it for every non-2xx answer.
  - `FoodPickerModal` takes `line: Pick<NutritionLine, "key" | "name" | "food">` and an optional `recipeId?: number`.
  - Route `/ingredients/:key`.

- [ ] **Step 1: Make HTTP failures carry their status**

In `frontend/src/api.ts`, above `request`, add:

```ts
/**
 * The server answered, and the answer was no. Its status lets a page tell
 * "there is nothing here" (404) from "something went wrong", which a bare
 * message cannot. `message` is still the server's sentence, so every place
 * that shows `errorMessage(e)` reads the same as before.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}
```

and in `request` replace `throw new Error(detail);` with `throw new ApiError(resp.status, detail);`.

In `frontend/src/components/Nutrition.tsx`, change `FoodPickerModal`'s props to:

```tsx
  line: Pick<NutritionLine, "key" | "name" | "food">;
  /** The recipe the picker was opened from, which is not an "other" recipe. Absent on an ingredient's own page. */
  recipeId?: number;
```

The existing filter `others = (uses ?? []).filter((recipe) => recipe.id !== recipeId)` already keeps every recipe when `recipeId` is undefined. Opened from no recipe, none of them is "other", so replace the `modal-reach` paragraph's text with:

```tsx
          {others.length === 0
            ? `No ${recipeId === undefined ? "" : "other "}recipe uses “${line.name}” yet. A choice here holds for any that do later.`
            : `${recipeId === undefined ? "Changes" : "Also changes"} ${plural(
                others.length,
                recipeId === undefined ? "recipe" : "other recipe",
              )}: ${named.join(", ")}${unnamed > 0 ? ` and ${unnamed} more` : ""}.`}
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/pages/IngredientPage.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { ingredientDetail, ingredientLine, itemPrice } from "../test/fixtures";
import { renderApp } from "../test/render";

const cumin = ingredientDetail({
  key: "cumin",
  name: "cumin",
  also_called: ["ground cumin"],
  merged: [{ key: "ground-cumin", name: "ground cumin" }],
  recipe_count: 2,
  lines: [
    ingredientLine({ ingredient_id: 11, recipe_id: 4, recipe_title: "Chili", name: "ground cumin", quantity: 2, unit: "tsp" }),
    ingredientLine({ ingredient_id: 12, recipe_id: 5, recipe_title: "Salsa", name: "cumin", quantity: 0.75, unit: "tsp" }),
  ],
  product: { status: "picked", product: itemPrice({ product_id: "111", description: "McCormick Ground Cumin", regular: 3.49 }) },
  food: { status: "default", food: { fdc_id: 170923, description: "Spices, cumin seed", category: "Spices", per_100g: { kcal: 375, protein_g: 18, fat_g: 22, carbs_g: 44, sodium_mg: 168 } } },
});

describe("IngredientPage", () => {
  it("shows the ingredient whole: names, staple, product, food and lines", async () => {
    mockBackend({ "GET /api/ingredients/:key": cumin });
    renderApp("/ingredients/cumin");

    expect(await screen.findByRole("heading", { name: "cumin" })).toBeInTheDocument();
    expect(screen.getByText(/Also called/)).toHaveTextContent("ground cumin");
    expect(screen.getByText("McCormick Ground Cumin")).toBeInTheDocument();
    expect(screen.getByText(/your pick/)).toBeInTheDocument();
    expect(screen.getByText("Spices, cumin seed")).toBeInTheDocument();
    const used = screen.getByRole("region", { name: "Used in" });
    expect(within(used).getByRole("link", { name: /2 tsp ground cumin/ })).toHaveAttribute(
      "href",
      "/recipes/4?ingredient=11",
    );
    expect(within(used).getByText("Chili")).toBeInTheDocument();
  });

  it("keeps an ingredient stocked, and stops", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": () => cumin,
      "POST /api/pantry": { id: 7, name: "cumin", in_stock: true },
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: /Keep stocked/ }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({ name: "cumin", in_stock: true });
  });

  it("stops keeping a staple stocked", async () => {
    const stocked = { ...cumin, staple: { id: 7, name: "Cumin", in_stock: true } };
    const backend = mockBackend({
      "GET /api/ingredients/:key": stocked,
      "DELETE /api/pantry/:id": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Stop keeping stocked" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/pantry/:id")[0].path).toBe("/api/pantry/7"));
  });

  it("goes back to the automatic product", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "DELETE /api/pricing/match": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Back to automatic" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/pricing/match")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/pricing/match")[0].searchParams.get("key")).toBe("cumin");
  });

  it("says it does not count, for every recipe", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "PUT /api/nutrition/match": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "It doesn't count" }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/nutrition/match")[0].body).toEqual({ key: "cumin", fdc_id: null }),
    );
  });

  it("hides the store with pricing off", async () => {
    mockBackend({ "GET /api/ingredients/:key": { ...cumin, product: null } });
    renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    expect(screen.queryByRole("region", { name: "At your store" })).not.toBeInTheDocument();
  });

  it("moves to the target's address when opened under a merged name", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": ({ params }) =>
        params.key === "ground-cumin" ? { ...cumin, redirected_from: "ground-cumin" } : cumin,
    });
    renderApp("/ingredients/ground-cumin");

    expect(await screen.findByRole("heading", { name: "cumin" })).toBeInTheDocument();
    // Navigating to the target's address loads it under its own key.
    await waitFor(() =>
      expect(backend.requestsTo("GET /api/ingredients/:key").map((r) => r.path)).toContain(
        "/api/ingredients/cumin",
      ),
    );
  });

  it("says so when there is no such ingredient, with a way back", async () => {
    mockBackend({ "GET /api/ingredients/:key": new HttpError(404, "No ingredient called that.") });
    renderApp("/ingredients/saffron");

    expect(await screen.findByText("No ingredient called that")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All ingredients" })).toHaveAttribute("href", "/ingredients?view=all");
  });

  it("reports any other failure as a failed load", async () => {
    mockBackend({ "GET /api/ingredients/:key": new HttpError(500, "Database is down") });
    renderApp("/ingredients/cumin");

    expect(await screen.findByText("Database is down")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd frontend && npx vitest run src/pages/IngredientPage.test.tsx`
Expected: FAIL; the route does not exist.

- [ ] **Step 4: Write the page**

Create `frontend/src/pages/IngredientPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { ApiError, api, type IngredientDetail, type IngredientLine } from "../api";
import { LoadFailure } from "../components/LoadError";
import { FoodPickerModal } from "../components/Nutrition";
import { ProductPickerModal } from "../components/ProductPicker";
import { Banner, Button, EmptyState, LinkButton, PageHead, Panel, Switch } from "../components/ui";
import { formatQuantity } from "../quantity";
import { recipeIngredientPath } from "../recipeLink";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

const money = (n: number) => `$${n.toFixed(2)}`;

/** A recipe line as the cook reads it: "2 tsp ground cumin". */
function lineText(line: IngredientLine): string {
  const amount = formatQuantity(line.quantity, line.unit);
  return amount ? `${amount} ${line.name}` : line.name;
}

/**
 * One ingredient's own page: everything decided about it, in one place.
 *
 * The staple, the product and the food are each changed through the
 * endpoint that already changes them, so a choice made here is the same
 * choice the grocery list and the recipe pages see. A 404 is its own state,
 * not a failure: the ingredient's last recipe may simply have been deleted.
 */
export default function IngredientPage() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  const { data, error, reload } = useLoad<IngredientDetail | null>(
    useCallback(async () => {
      setMissing(false);
      try {
        return await api.ingredient(key);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) {
          setMissing(true);
          return null;
        }
        throw cause;
      }
    }, [key]),
  );
  const action = useAction();
  const [choosing, setChoosing] = useState<"product" | "food" | null>(null);

  // Opened under a merged-away name: show the target's address, so a link
  // copied from here is the one that keeps working.
  useEffect(() => {
    if (data?.redirected_from) navigate(`/ingredients/${data.key}`, { replace: true });
  }, [data, navigate]);

  async function change(write: () => Promise<unknown>) {
    setChoosing(null);
    if (await action.run(write)) reload();
  }

  if (missing) {
    return (
      <EmptyState glyph="🥕" title="No ingredient called that">
        <p>No recipe or staple uses it any more.</p>
        <LinkButton to="/ingredients?view=all">All ingredients</LinkButton>
      </EmptyState>
    );
  }
  if (error && !data) {
    return <LoadFailure what="this ingredient" message={error} onRetry={reload} showing={false} />;
  }
  if (!data) return null;

  const staple = data.staple;
  const standing = data.product;
  const food = data.food;

  return (
    <div className="ingredient-layout">
      <PageHead title={data.name} sub={`${data.recipe_count} recipe${data.recipe_count === 1 ? "" : "s"}`} />

      {data.also_called.length > 0 && (
        <p className="also-called">Also called {data.also_called.join(", ")}</p>
      )}

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      <section aria-label="Pantry">
        <Panel title="Pantry">
          <div className="ingredient-facts">
            {!staple && (
              <Button size="small" onClick={() => change(() => api.addPantryItem(data.name, true))}>
                Keep stocked
              </Button>
            )}
            {staple && (
              <Switch
                on={staple.in_stock}
                onToggle={() => change(() => api.updatePantryItem(staple.id, { in_stock: !staple.in_stock }))}
              >
                {staple.in_stock ? "In stock" : "Out of stock"}
              </Switch>
            )}
            {staple && (
              <Button size="small" variant="danger" onClick={() => change(() => api.deletePantryItem(staple.id))}>
                Stop keeping stocked
              </Button>
            )}
          </div>
        </Panel>
      </section>

      {standing && (
        <section aria-label="At your store">
          <Panel title="At your store">
            <div className="ingredient-facts">
              {standing.product ? (
                <p className="fact">
                  <span className="what">{standing.product.description}</span>
                  <span className="detail">
                    {standing.product.size} · {money(standing.product.promo ?? standing.product.regular)}
                    {standing.status === "picked" && <span className="chosen-by"> · your pick</span>}
                  </span>
                </p>
              ) : (
                <p className="fact muted">
                  {standing.status === "not_priced"
                    ? "Not priced, by your choice"
                    : standing.status === "no_match"
                      ? "Nothing at your store matched"
                      : standing.status === "unseen"
                        ? "Not priced yet: it is matched the first time a list needs it"
                        : "Product picked; its price could not be fetched"}
                </p>
              )}
              <div className="fact-actions">
                <Button size="small" onClick={() => setChoosing("product")}>
                  Change product
                </Button>
                {standing.status !== "not_priced" && (
                  <Button size="small" onClick={() => change(() => api.setMatch(data.key, null))}>
                    Don&rsquo;t price this
                  </Button>
                )}
                {(standing.status === "picked" || standing.status === "not_priced") && (
                  <Button size="small" onClick={() => change(() => api.forgetMatch(data.key))}>
                    Back to automatic
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        </section>
      )}

      <section aria-label="Nutrition">
        <Panel title="Nutrition">
          <div className="ingredient-facts">
            <p className={`fact${food.food ? "" : " muted"}`}>
              <span className="what">
                {food.status === "skipped" ? "Doesn't count" : food.food ? food.food.description : "No food chosen"}
              </span>
              {food.status === "picked" && <span className="chosen-by">your choice</span>}
            </p>
            <div className="fact-actions">
              <Button size="small" onClick={() => setChoosing("food")}>
                {food.food ? "Change food" : "Choose food"}
              </Button>
              {food.status !== "skipped" && (
                <Button size="small" onClick={() => change(() => api.chooseFood(data.key, null))}>
                  It doesn&rsquo;t count
                </Button>
              )}
              {(food.status === "picked" || food.status === "skipped") && (
                <Button size="small" onClick={() => change(() => api.forgetFood(data.key))}>
                  Back to default
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </section>

      <section aria-label="Used in">
        <Panel title="Used in">
          {data.lines.length === 0 ? (
            <p className="muted">No recipe uses it; it is here as a staple.</p>
          ) : (
            <ul className="ingredient-lines">
              {data.lines.map((line) => (
                <li key={line.ingredient_id}>
                  <span className="recipe">{line.recipe_title}</span>
                  <Link to={recipeIngredientPath(line.recipe_id, [line.ingredient_id])}>{lineText(line)}</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      {choosing === "product" && standing && (
        <ProductPickerModal
          line={{
            key: data.key,
            name: data.name,
            product: standing.product,
            hand_picked: standing.status === "picked" || standing.status === "not_priced",
          }}
          onPick={(productId) => change(() => api.setMatch(data.key, productId))}
          onForget={() => change(() => api.forgetMatch(data.key))}
          onClose={() => setChoosing(null)}
        />
      )}
      {choosing === "food" && (
        <FoodPickerModal
          line={{ key: data.key, name: data.name, food: food.food }}
          onPick={(chosen) => change(() => api.chooseFood(data.key, chosen?.fdc_id ?? null))}
          onClose={() => setChoosing(null)}
        />
      )}
    </div>
  );
}
```

`useLoad` must accept a generic type argument; it already does (`useLoad<T>`). If `LoadFailure` requires `showing`, `false` is correct here since nothing else is on screen.

In `frontend/src/App.tsx`, add `import IngredientPage from "./pages/IngredientPage";` and, after the `/ingredients` route, `<Route path="/ingredients/:key" element={<IngredientPage />} />`.

In `frontend/src/styles.css`, after the ingredient row rules, add:

```css
.ingredient-layout { max-width: var(--width-compact); }

.ingredient-layout section + section { margin-top: var(--space-16); }

.also-called { color: var(--muted); margin: 0 0 var(--space-16); }

.ingredient-facts { display: grid; gap: var(--space-12); }

.ingredient-facts .fact { display: grid; gap: var(--space-2); margin: 0; }

.ingredient-facts .fact .what { font-weight: var(--weight-semibold); }

.ingredient-facts .fact .detail,
.ingredient-facts .muted { color: var(--muted); }

.fact-actions { display: flex; flex-wrap: wrap; gap: var(--space-8); }

.ingredient-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-10); }

.ingredient-lines li { display: grid; gap: var(--space-2); }

.ingredient-lines .recipe { color: var(--muted); font-size: var(--text-sm); }
```

- [ ] **Step 5: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/pages/IngredientPage.test.tsx`
Expected: PASS.
Run the frontend checks from Global Constraints. Existing tests that asserted on `Error` instances from `request` keep passing, since `ApiError` is an `Error` with the same message.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "Give each ingredient its own page" -m "An ingredient's page shows the names merged into it, whether it is
kept stocked and in stock, its product at the store and the food it
counts as, each changeable where it is shown, and every recipe line
that uses it, linked to that line. A merged-away name moves to the
target's address, and a name nothing uses says so with a way back."
```

---

## Phase 5: Merging in the page

### Task 11: The merge dialog, unmerge, and the banner

**Files:**
- Create: `frontend/src/components/MergeDialog.tsx`, `frontend/src/components/MergeDialog.test.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/ingredients.ts`, `frontend/src/ingredients.test.ts`, `frontend/src/pages/IngredientPage.tsx`, `frontend/src/pages/IngredientPage.test.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `POST /api/ingredients/merges/preview`, `POST /api/ingredients/merges`, `DELETE /api/ingredients/merges/{from_key}` (Task 7); `api.listIngredients` (Task 8); `Modal` from `components/ui`.
- Produces:
  - TS types `MergeSide = "from" | "to"`, `MergeNeed = "product" | "food" | "staple"`, `MergeChoices`, `ProductSide`, `FoodSide`, `StapleSide`, `Conflict<T> { from_side: T | null; to_side: T | null; keeps: MergeSide | null }`, `MergePreview`.
  - `api.previewMerge(from_key, to_key): Promise<MergePreview>`, `api.merge(from_key, to_key, choices: MergeChoices): Promise<void>`, `api.unmerge(from_key): Promise<void>`.
  - `proposeDirection(a: IngredientSummary, b: IngredientSummary): [from: IngredientSummary, to: IngredientSummary]` in `ingredients.ts`.
  - `<MergeDialog ingredient={IngredientSummary} pair?={[fromKey, toKey]} onMerged={(merged: {fromKey, fromName, toKey, toName}) => void} onClose={() => void} />`.

- [ ] **Step 1: Add the types and calls**

In `frontend/src/api.ts`, after `IngredientList`, add:

```ts
/** Which side of a merge keeps a thing both sides have. */
export type MergeSide = "from" | "to";
export type MergeNeed = "product" | "food" | "staple";

export interface MergeChoices {
  product?: MergeSide;
  food?: MergeSide;
  staple?: MergeSide;
}

export interface ProductSide {
  product: ItemPrice | null;
  hand_picked: boolean;
  not_priced: boolean;
}

export interface FoodSide {
  food: Food | null;
  hand_picked: boolean;
  skipped: boolean;
}

export interface StapleSide {
  name: string;
  in_stock: boolean;
}

/** Each side as it stands, and which the merge keeps; null keeps means "you choose". */
export interface Conflict<T> {
  from_side: T | null;
  to_side: T | null;
  keeps: MergeSide | null;
}

export interface MergePreview {
  from_key: string;
  from_name: string;
  to_key: string;
  to_name: string;
  /** Recipes with lines under the name going away. They keep their wording. */
  recipes: RecipeRef[];
  product: Conflict<ProductSide> | null;
  food: Conflict<FoodSide> | null;
  staple: Conflict<StapleSide> | null;
  needs: MergeNeed[];
}
```

and in the `api` object:

```ts
  previewMerge: (from_key: string, to_key: string) =>
    request<MergePreview>("/api/ingredients/merges/preview", {
      method: "POST",
      body: JSON.stringify({ from_key, to_key }),
    }),
  merge: (from_key: string, to_key: string, choices: MergeChoices) =>
    request<void>("/api/ingredients/merges", {
      method: "POST",
      body: JSON.stringify({ from_key, to_key, choices }),
    }),
  unmerge: (from_key: string) =>
    request<void>(`/api/ingredients/merges/${encodeURIComponent(from_key)}`, { method: "DELETE" }),
```

`Food` is the existing exported type that `FoodChoice` extends.

- [ ] **Step 2: Write the failing direction test**

Append to `frontend/src/ingredients.test.ts` (import `proposeDirection` and `staple`):

```ts
describe("proposeDirection", () => {
  const cumin = ingredientSummary({ key: "cumin", name: "cumin", recipe_count: 1 });
  const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", recipe_count: 3 });

  it("merges the more specific name into the more general one", () => {
    expect(proposeDirection(cumin, ground).map((i) => i.key)).toEqual(["ground-cumin", "cumin"]);
    expect(proposeDirection(ground, cumin).map((i) => i.key)).toEqual(["ground-cumin", "cumin"]);
  });

  it("prefers a staple as the one that survives", () => {
    const kept = staple("Ground Cumin", true, { key: "ground-cumin" });
    expect(proposeDirection(cumin, kept).map((i) => i.key)).toEqual(["cumin", "ground-cumin"]);
  });

  it("prefers the name with a hand-picked product next", () => {
    const picked = { ...ground, product: { status: "picked" as const, product: null } };
    expect(proposeDirection(cumin, picked).map((i) => i.key)).toEqual(["cumin", "ground-cumin"]);
  });
});
```

- [ ] **Step 3: Write `proposeDirection`**

Append to `frontend/src/ingredients.ts`:

```ts
/**
 * Which way to propose a merge: [the name going away, the one that survives].
 *
 * A staple survives first, because its name is the one on the shopping list
 * and in the cupboard; then a hand-picked product, because that choice is
 * the owner's work; then the name with fewer words, the more general one
 * ("cumin" over "ground cumin"); then the one more recipes use. The dialog
 * offers Swap whatever this proposes.
 */
export function proposeDirection(
  a: IngredientSummary,
  b: IngredientSummary,
): [IngredientSummary, IngredientSummary] {
  const weight = (i: IngredientSummary) =>
    [
      i.staple ? 1 : 0,
      i.product?.status === "picked" ? 1 : 0,
      -i.key.split("-").length,
      i.recipe_count,
    ] as const;
  const [wa, wb] = [weight(a), weight(b)];
  for (let n = 0; n < wa.length; n++) {
    if (wa[n] !== wb[n]) return wa[n] > wb[n] ? [b, a] : [a, b];
  }
  return a.key < b.key ? [b, a] : [a, b];
}
```

Run: `cd frontend && npx vitest run src/ingredients.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing dialog tests**

Create `frontend/src/components/MergeDialog.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MergePreview } from "../api";
import { mockBackend } from "../test/backend";
import { ingredientDetail, ingredientSummary } from "../test/fixtures";
import { renderApp } from "../test/render";

const cumin = ingredientSummary({ key: "cumin", name: "cumin" });
const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", recipe_count: 1 });

function preview(overrides: Partial<MergePreview> = {}): MergePreview {
  return {
    from_key: "ground-cumin",
    from_name: "ground cumin",
    to_key: "cumin",
    to_name: "cumin",
    recipes: [{ id: 4, title: "Chili" }],
    product: null,
    food: null,
    staple: null,
    needs: [],
    ...overrides,
  };
}

/** The page the dialog opens from, with the list it searches. */
function backendFor(previewed: MergePreview) {
  return mockBackend({
    "GET /api/ingredients/:key": ({ params }) =>
      params.key === "cumin"
        ? ingredientDetail({ ...cumin, lines: [] })
        : ingredientDetail({ ...ground, lines: [] }),
    "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [] },
    "POST /api/ingredients/merges/preview": previewed,
    "POST /api/ingredients/merges": undefined,
  });
}

describe("MergeDialog", () => {
  it("finds the other name, proposes a direction, previews, and merges", async () => {
    const backend = backendFor(preview());
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });

    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.type(screen.getByLabelText("Find the ingredient"), "cum");
    await user.click(screen.getByRole("button", { name: "cumin" }));

    expect(await screen.findByText("Merge ground cumin into cumin")).toBeInTheDocument();
    expect(screen.getByText(/Chili keeps saying “ground cumin”, and shops as cumin/)).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[0].body).toEqual({
      from_key: "ground-cumin",
      to_key: "cumin",
    });

    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/ingredients/merges")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toEqual({
      from_key: "ground-cumin",
      to_key: "cumin",
      choices: {},
    });
    expect(await screen.findByText(/Merged ground cumin into cumin/)).toBeInTheDocument();
  });

  it("swaps the direction and previews again", async () => {
    const backend = backendFor(preview());
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Merge ground cumin into cumin");

    await user.click(screen.getByRole("button", { name: "Swap" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/ingredients/merges/preview")).toHaveLength(2));
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[1].body).toEqual({
      from_key: "cumin",
      to_key: "ground-cumin",
    });
  });

  it("asks which staple to keep, and will not merge until it is chosen", async () => {
    const backend = backendFor(
      preview({
        staple: {
          from_side: { name: "Ground Cumin", in_stock: false },
          to_side: { name: "Cumin", in_stock: true },
          keeps: null,
        },
        needs: ["staple"],
      }),
    );
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Which staple to keep?");

    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Cumin, in stock/ }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toEqual({
        from_key: "ground-cumin",
        to_key: "cumin",
        choices: { staple: "to" },
      }),
    );
  });
});
```

Append to `frontend/src/pages/IngredientPage.test.tsx`:

```tsx
describe("IngredientPage: unmerging", () => {
  it("confirms, says what the old name loses, and unmerges", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "DELETE /api/ingredients/merges/:key": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Unmerge ground cumin" }));
    expect(screen.getByText(/starts fresh/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unmerge" }));

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")[0].path).toBe(
        "/api/ingredients/merges/ground-cumin",
      ),
    );
    expect(backend.requestsTo("GET /api/ingredients/:key").length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `cd frontend && npx vitest run src/components/MergeDialog.test.tsx src/pages/IngredientPage.test.tsx`
Expected: FAIL; there is no merge button or Unmerge.

- [ ] **Step 6: Write the dialog**

Create `frontend/src/components/MergeDialog.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type Conflict,
  type FoodSide,
  type IngredientSummary,
  type MergeChoices,
  type MergeNeed,
  type MergePreview,
  type MergeSide,
  type ProductSide,
  type StapleSide,
} from "../api";
import { matchesSearch, proposeDirection } from "../ingredients";
import { useLoad } from "../useLoad";
import { Banner, Button, Modal } from "./ui";

export interface Merged {
  fromKey: string;
  fromName: string;
  toKey: string;
  toName: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Saying two names are one ingredient: find the other, see what changes, merge.
 *
 * Nothing changes until Merge is pressed. The preview is the server's, so
 * what it says will move is what the merge moves, and the choices it asks
 * for are exactly the ones the merge would refuse without (ADR 10).
 */
export function MergeDialog({
  ingredient,
  pair,
  onMerged,
  onClose,
}: {
  /** The ingredient whose page the dialog was opened from. */
  ingredient: IngredientSummary;
  /** A suggested pair to preview straight away, [from, to]. */
  pair?: readonly [string, string];
  onMerged: (merged: Merged) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<readonly [string, string] | null>(pair ?? null);
  const [query, setQuery] = useState("");
  const { data: listing } = useLoad(useCallback(() => api.listIngredients(), []));

  const candidates = useMemo(
    () =>
      (listing?.ingredients ?? []).filter(
        (i) => i.key !== ingredient.key && matchesSearch(i, query),
      ),
    [listing, ingredient.key, query],
  );

  function pick(other: IngredientSummary) {
    const [from, to] = proposeDirection(ingredient, other);
    setChosen([from.key, to.key]);
  }

  return (
    <Modal title={chosen ? "Merge" : "Same as another ingredient"} onClose={onClose}>
      {chosen ? (
        <MergePreviewPanel
          pair={chosen}
          onSwap={() => setChosen([chosen[1], chosen[0]])}
          onMerged={onMerged}
          onCancel={onClose}
        />
      ) : (
        <>
          <div className="modal-search">
            <input
              autoFocus
              aria-label="Find the ingredient"
              placeholder={`What else is “${ingredient.name}” called?`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="modal-list">
            {candidates.map((other) => (
              <button key={other.key} type="button" className="modal-food" onClick={() => pick(other)}>
                <span className="description">{other.name}</span>
              </button>
            ))}
            {listing && candidates.length === 0 && <p className="modal-note">No other ingredient matches that.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

function MergePreviewPanel({
  pair,
  onSwap,
  onMerged,
  onCancel,
}: {
  pair: readonly [string, string];
  onSwap: () => void;
  onMerged: (merged: Merged) => void;
  onCancel: () => void;
}) {
  const [from, to] = pair;
  const { data: preview, error } = useLoad(useCallback(() => api.previewMerge(from, to), [from, to]));
  const [choices, setChoices] = useState<MergeChoices>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  // A new direction is a new question; answers to the old one do not carry.
  useEffect(() => setChoices({}), [from, to]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!preview) return <p className="modal-note">Looking…</p>;

  const ready = preview.needs.every((need) => choices[need] !== undefined);

  async function merge() {
    setMerging(true);
    setFailure(null);
    try {
      await api.merge(from, to, choices);
      onMerged({ fromKey: from, fromName: preview!.from_name, toKey: to, toName: preview!.to_name });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "That did not go through.");
      setMerging(false);
    }
  }

  return (
    <div className="merge-preview">
      <p className="merge-title">
        Merge {preview.from_name} into {preview.to_name}
      </p>
      <Button size="small" onClick={onSwap}>
        Swap
      </Button>

      <ul className="merge-changes">
        {preview.recipes.length > 0 && (
          <li>
            {preview.recipes.map((r) => r.title).join(", ")}{" "}
            {preview.recipes.length === 1 ? "keeps" : "keep"} saying “{preview.from_name}”, and{" "}
            {preview.recipes.length === 1 ? "shops" : "shop"} as {preview.to_name}.
          </li>
        )}
        <li>
          One grocery line, {preview.to_name}, instead of two.
        </li>
        <ConflictLine label="Product" need="product" preview={preview} describe={describeProduct} choices={choices} setChoices={setChoices} />
        <ConflictLine label="Food" need="food" preview={preview} describe={describeFood} choices={choices} setChoices={setChoices} />
        <ConflictLine label="Staple" need="staple" preview={preview} describe={describeStaple} choices={choices} setChoices={setChoices} />
      </ul>

      {failure && <Banner tone="error">{failure}</Banner>}

      <div className="modal-actions">
        <Button variant="primary" onClick={merge} disabled={!ready || merging}>
          Merge
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

type Describe<T> = (side: T) => string;

const describeProduct: Describe<ProductSide> = (side) =>
  side.not_priced
    ? "not priced"
    : `${side.product ? `${side.product.description} ${money(side.product.promo ?? side.product.regular)}` : "a product"}${side.hand_picked ? " (your pick)" : ""}`;

const describeFood: Describe<FoodSide> = (side) =>
  side.skipped ? "doesn't count" : `${side.food?.description ?? "a food"}${side.hand_picked ? " (your choice)" : ""}`;

const describeStaple: Describe<StapleSide> = (side) =>
  `${side.name}, ${side.in_stock ? "in stock" : "out of stock"}`;

function ConflictLine<T>({
  label,
  need,
  preview,
  describe,
  choices,
  setChoices,
}: {
  label: string;
  need: MergeNeed;
  preview: MergePreview;
  describe: Describe<T>;
  choices: MergeChoices;
  setChoices: (next: MergeChoices) => void;
}) {
  const conflict = preview[need] as Conflict<T> | null;
  if (!conflict) return null;
  const sides: [MergeSide, T | null][] = [
    ["from", conflict.from_side],
    ["to", conflict.to_side],
  ];

  if (conflict.keeps === null) {
    return (
      <li>
        <fieldset className="merge-choice">
          <legend>Which {need} to keep?</legend>
          {sides.map(([side, value]) =>
            value === null ? null : (
              <label key={side}>
                <input
                  type="radio"
                  name={need}
                  checked={choices[need] === side}
                  onChange={() => setChoices({ ...choices, [need]: side })}
                />
                {describe(value)}
              </label>
            ),
          )}
        </fieldset>
      </li>
    );
  }
  const kept = conflict.keeps === "from" ? conflict.from_side : conflict.to_side;
  return kept === null ? null : (
    <li>
      {label}: {describe(kept)}
    </li>
  );
}
```


- [ ] **Step 7: Open it from the ingredient page, add Unmerge and the banner**

In `frontend/src/pages/IngredientPage.tsx`:
- Add imports: `useLocation` from `react-router-dom`, `MergeDialog, type Merged` from `../components/MergeDialog`, `Modal` from `../components/ui`.
- Add state after `choosing`: 

```tsx
  const location = useLocation();
  const [merging, setMerging] = useState<readonly [string, string] | "pick" | null>(null);
  const [unmerging, setUnmerging] = useState<{ key: string; name: string } | null>(null);
  // Set by the merge that brought the owner here, so the banner can offer
  // to take it back.
  const merged = (location.state as { merged?: Merged } | null)?.merged ?? null;
```

- Replace the `also-called` paragraph with a list that can unmerge:

```tsx
      {data.merged.length > 0 && (
        <div className="also-called">
          Also called{" "}
          {data.merged.map((m) => (
            <span key={m.key} className="merged-name">
              {m.name}
              <Button size="small" aria-label={`Unmerge ${m.name}`} onClick={() => setUnmerging(m)}>
                Unmerge
              </Button>
            </span>
          ))}
        </div>
      )}

      {merged && merged.toKey === data.key && (
        <Banner tone="notice" spaced>
          Merged {merged.fromName} into {merged.toName}.{" "}
          <Button
            size="small"
            onClick={() =>
              change(async () => {
                await api.unmerge(merged.fromKey);
                navigate(location.pathname, { replace: true, state: null });
              })
            }
          >
            Unmerge
          </Button>
        </Banner>
      )}
```

  The first test in Task 10 looks for `getByText(/Also called/)` containing "ground cumin"; it still passes, since the names are inside that element.
- After the "Used in" section, add:

```tsx
      <div className="ingredient-merge">
        <Button onClick={() => setMerging("pick")}>Same as another ingredient…</Button>
      </div>
```

- With the other modals at the end, add:

```tsx
      {merging && (
        <MergeDialog
          ingredient={data}
          pair={merging === "pick" ? undefined : merging}
          onClose={() => setMerging(null)}
          onMerged={(done) => {
            setMerging(null);
            navigate(`/ingredients/${done.toKey}`, { state: { merged: done } });
          }}
        />
      )}
      {unmerging && (
        <Modal title={`Unmerge ${unmerging.name}?`} onClose={() => setUnmerging(null)}>
          <p>
            “{unmerging.name}” goes back to being its own ingredient, with its own grocery line. It
            starts fresh: an automatic product, and its default food if it has one. What moved to{" "}
            {data.name} stays with it.
          </p>
          <div className="modal-actions">
            <Button
              variant="primary"
              onClick={() => {
                const going = unmerging;
                setUnmerging(null);
                void change(() => api.unmerge(going.key));
              }}
            >
              Unmerge
            </Button>
            <Button onClick={() => setUnmerging(null)}>Cancel</Button>
          </div>
        </Modal>
      )}
```

The confirming button is named "Unmerge" and the per-name button "Unmerge ground cumin", so the test can tell them apart.

In `frontend/src/styles.css`, add:

```css
.merged-name { display: inline-flex; align-items: center; gap: var(--space-6); margin-right: var(--space-8); }

/* The answer buttons at the foot of a dialog: the merge, the unmerge, the
   saving of lines read again. */
.modal-actions { display: flex; flex-wrap: wrap; gap: var(--space-8); margin-top: var(--space-16); }

.ingredient-merge { margin-top: var(--space-20); }

.merge-preview { display: grid; gap: var(--space-12); }

.merge-title { font-weight: var(--weight-semibold); margin: 0; }

.merge-changes { margin: 0; padding-left: var(--space-20); display: grid; gap: var(--space-8); }

.merge-choice { border: 0; margin: 0; padding: 0; display: grid; gap: var(--space-6); }

.merge-choice legend { font-weight: var(--weight-semibold); padding: 0; margin-bottom: var(--space-4); }

.merge-choice label { display: flex; gap: var(--space-8); align-items: center; }
```

- [ ] **Step 8: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/components/MergeDialog.test.tsx src/pages/IngredientPage.test.tsx src/ingredients.test.ts`
Expected: PASS.
Run the frontend checks from Global Constraints.

- [ ] **Step 9: Commit**

```bash
git add frontend
git commit -m "Merge ingredients from their page, and take a merge back" -m "Same as another ingredient finds the other name, proposes which way to
merge, and shows the server's preview: which recipes keep their wording
and which product, food and staple survive, asking only where the merge
would refuse without an answer. After merging, the target's page says
so and offers Unmerge, which confirms what the old name loses."
```

### Task 12: Suggested merges in the page

**Files:**
- Create: `frontend/src/components/SuggestionRow.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/pages/IngredientsPage.tsx`, `frontend/src/pages/IngredientsPage.test.tsx`, `frontend/src/pages/IngredientPage.tsx`, `frontend/src/pages/IngredientPage.test.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `POST /api/ingredients/suggestions/dismiss` (Task 7); `MergeDialog` (Task 11).
- Produces:
  - `api.dismissSuggestion(key_a: string, key_b: string): Promise<void>`
  - `<SuggestionRow suggestion={MergeSuggestion} merge={ReactNode} onDismiss={() => void} />`, where `merge` is the control that starts the merge (a link from the list, a button on the page).
  - Needs a look counts suggestions and lists them first under "Might be the same"; the ingredient page lists its own under "Might be the same as".

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/pages/IngredientsPage.test.tsx` (import `mergeSuggestion`):

```tsx
describe("IngredientsPage: suggested merges", () => {
  const cumin = ingredientSummary({ key: "cumin", name: "cumin", problems: ["merge"] });
  const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", problems: ["merge"] });
  const suggestion = mergeSuggestion();

  it("lists them first in Needs a look, and counts them", async () => {
    mockBackend({ "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] } });
    renderApp("/ingredients?view=look");

    const group = await screen.findByRole("region", { name: "Might be the same" });
    expect(within(group).getByText("Ground cumin and cumin look like the same thing to buy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs a look 1" })).toBeInTheDocument();
  });

  it("turns one down, and asks the server never to offer it again", async () => {
    const backend = mockBackend({
      "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] },
      "POST /api/ingredients/suggestions/dismiss": undefined,
    });
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "Might be the same" });

    await user.click(screen.getByRole("button", { name: "Not the same" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/suggestions/dismiss")[0].body).toEqual({
        key_a: "ground-cumin",
        key_b: "cumin",
      }),
    );
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("merges one through the ingredient's page", async () => {
    mockBackend({ "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] } });
    renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "Might be the same" });

    expect(screen.getByRole("link", { name: "Merge" })).toHaveAttribute(
      "href",
      "/ingredients/ground-cumin?merge=cumin",
    );
  });
});
```

Append to `frontend/src/pages/IngredientPage.test.tsx` (import `mergeSuggestion`):

```tsx
describe("IngredientPage: suggested merges", () => {
  it("lists what it might be the same as, and opens the preview for one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": { ...cumin, merged: [], also_called: [], suggestions: [mergeSuggestion({ from_key: "cumin-seed", from_name: "cumin seed" })] },
      "GET /api/ingredients": { ingredients: [], suggestions: [] },
      "POST /api/ingredients/merges/preview": {
        from_key: "cumin-seed", from_name: "cumin seed", to_key: "cumin", to_name: "cumin",
        recipes: [], product: null, food: null, staple: null, needs: [],
      },
    });
    const { user } = renderApp("/ingredients/cumin");

    const group = await screen.findByRole("region", { name: "Might be the same as" });
    await user.click(within(group).getByRole("button", { name: "Merge" }));

    expect(await screen.findByText("Merge cumin seed into cumin")).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[0].body).toEqual({
      from_key: "cumin-seed",
      to_key: "cumin",
    });
  });

  it("opens the preview straight away when a link asks for a merge", async () => {
    mockBackend({
      "GET /api/ingredients/:key": { ...ingredientDetail({ key: "ground-cumin", name: "ground cumin" }) },
      "GET /api/ingredients": { ingredients: [], suggestions: [] },
      "POST /api/ingredients/merges/preview": {
        from_key: "ground-cumin", from_name: "ground cumin", to_key: "cumin", to_name: "cumin",
        recipes: [], product: null, food: null, staple: null, needs: [],
      },
    });
    renderApp("/ingredients/ground-cumin?merge=cumin");

    expect(await screen.findByText("Merge ground cumin into cumin")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx src/pages/IngredientPage.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Add the call and the row**

In `frontend/src/api.ts`, in the `api` object:

```ts
  /** "Not the same": the pair is never suggested again. */
  dismissSuggestion: (key_a: string, key_b: string) =>
    request<void>("/api/ingredients/suggestions/dismiss", {
      method: "POST",
      body: JSON.stringify({ key_a, key_b }),
    }),
```

Create `frontend/src/components/SuggestionRow.tsx`:

```tsx
import type { ReactNode } from "react";

import type { MergeSuggestion } from "../api";
import { Button } from "./ui";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A suggested merge, put as a question with its two answers.
 *
 * The app never merges by itself (ADR 10); turning a pair down costs one
 * tap and is remembered, which is the price of never guessing silently.
 * `merge` is the control that starts the merge: a link from the list, which
 * opens the ingredient's page with the preview, or a button on the page.
 */
export function SuggestionRow({
  suggestion,
  merge,
  onDismiss,
}: {
  suggestion: MergeSuggestion;
  merge: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="suggestion-row">
      <span className="question">
        {capitalized(suggestion.from_name)} and {suggestion.to_name} look like the same thing to buy.
      </span>
      <span className="answers">
        {merge}
        <Button size="small" onClick={onDismiss}>
          Not the same
        </Button>
      </span>
    </div>
  );
}
```

In `frontend/src/styles.css`, add:

```css
.suggestion-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8) var(--space-12);
  padding: var(--space-12) var(--space-4);
  border-bottom: 1px solid var(--line);
}

.suggestion-row .answers { display: flex; gap: var(--space-8); }
```

- [ ] **Step 4: Show them in Needs a look**

In `frontend/src/pages/IngredientsPage.tsx`:
- Import `LinkButton` from `../components/ui` and `SuggestionRow` from `../components/SuggestionRow`.
- Change the look count to include suggestions: `const lookCount = look.length + (data?.suggestions.length ?? 0);` and use `lookCount` in the switcher label.
- Add to `IngredientsPage`:

```tsx
  async function dismiss(from: string, to: string) {
    if (await action.run(() => api.dismissSuggestion(from, to))) reload();
  }
```

- Render `LookView` as `<LookView items={shown} suggestions={query.trim() ? [] : data.suggestions} onDismiss={dismiss} />`, and in `LookView` accept `suggestions: MergeSuggestion[]` and `onDismiss: (from: string, to: string) => void`, treat it as not empty when there are suggestions, and render this group before the others:

```tsx
      {suggestions.length > 0 && (
        <section className="ingredient-group" aria-label="Might be the same">
          <h2>Might be the same</h2>
          {suggestions.map((s) => (
            <SuggestionRow
              key={`${s.from_key}|${s.to_key}`}
              suggestion={s}
              merge={
                <LinkButton size="small" to={`/ingredients/${s.from_key}?merge=${encodeURIComponent(s.to_key)}`}>
                  Merge
                </LinkButton>
              }
              onDismiss={() => onDismiss(s.from_key, s.to_key)}
            />
          ))}
        </section>
      )}
```

- [ ] **Step 5: Show them on the ingredient page, and honour `?merge=`**

In `frontend/src/pages/IngredientPage.tsx`:
- Import `useSearchParams` and `SuggestionRow`.
- Open the dialog from the URL once the page has loaded:

```tsx
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const target = params.get("merge");
    if (data && target && !data.redirected_from) {
      setMerging([data.key, target]);
      setParams({}, { replace: true });
    }
  }, [data, params, setParams]);
```

- Before the merge button, add:

```tsx
      {data.suggestions.length > 0 && (
        <section aria-label="Might be the same as">
          <Panel title="Might be the same as">
            {data.suggestions.map((s) => (
              <SuggestionRow
                key={`${s.from_key}|${s.to_key}`}
                suggestion={s}
                merge={
                  <Button size="small" onClick={() => setMerging([s.from_key, s.to_key])}>
                    Merge
                  </Button>
                }
                onDismiss={() => change(() => api.dismissSuggestion(s.from_key, s.to_key))}
              />
            ))}
          </Panel>
        </section>
      )}
```

- [ ] **Step 6: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/pages/IngredientsPage.test.tsx src/pages/IngredientPage.test.tsx`
Expected: PASS.
Run the frontend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "Offer suggested merges as questions with two answers" -m "Needs a look lists pairs that look like the same thing to buy first,
and counts them; each ingredient's page lists its own. Merge opens the
preview, from a link or a button, and Not the same is remembered by the
server so the pair is never offered again."
```

---

## Phase 6: Fixing lines, and the importer

### Task 13: The importer reads the broken patterns

**Files:**
- Modify: `backend/app/services/recipe_import.py`, `backend/app/services/grocery.py` (`UNIT_ALIASES`, `PLURALIZABLE_UNITS`), `backend/tests/test_import.py`, `docs/adr/0007-the-list-is-served-before-its-prices-and-every-doubtful-number-says-why.md`, `docs/adr/0008-nutrition-is-counted-whole-from-bundled-usda-data-or-not-at-all.md`
- Test: `backend/tests/test_import.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parse_ingredient_line(line: str) -> IngredientIn` with the five rules below; `_package_size(tokens, index) -> tuple[int, tuple[float, str] | None]` replaces `_skip_package_size`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_import.py`:

```python
@pytest.mark.parametrize(
    "line, name, quantity, unit",
    [
        # Footnote marks point at a note the line lost.
        ("¼ teaspoon ancho chili powder**", "ancho chili powder", 0.25, "teaspoon"),
        ("1 double pie crust*", "double pie crust", 1, None),
        ("1 egg (optional)**", "egg (optional)", 1, None),
        # A bracket holding only a measure repeats the amount.
        ("⅓ cup all-purpose flour ((42 g))", "all-purpose flour", 1 / 3, "cup"),
        ("1 medium yellow onion (chopped (about 1.5 cup/200 g))", "medium yellow onion (chopped)", 1, None),
        ("1 1-ounce packet ranch seasoning mix (or 3 tablespoons)", "ranch seasoning mix", 1, "ounce"),
        # How it is measured is not what it is.
        ("¼ cup firmly packed brown sugar", "brown sugar", 0.25, "cup"),
        ("1 cup packed spinach", "spinach", 1, "cup"),
        # A package size is the amount wanted; its container is noise.
        ("15 oz can black beans, drained and rinsed", "black beans, drained and rinsed", 15, "oz"),
        ("1 (15 oz) can black beans", "black beans", 15, "oz"),
        ("2 (15 oz) cans black beans", "black beans", 30, "oz"),
        ("1 22-ounce bag frozen waffle fries", "frozen waffle fries", 22, "ounce"),
        # Counted pieces, with a note before the name moved after it.
        ("6 strips (uncooked) bacon (cut into small pieces)", "bacon (uncooked, cut into small pieces)", 6, "strips"),
        ("2 slices (thick) bread", "bread (thick)", 2, "slices"),
    ],
)
def test_the_broken_lines_from_a_real_box_read_right(line, name, quantity, unit):
    parsed = parse_ingredient_line(line)
    assert (parsed.name, parsed.unit) == (name, unit)
    assert parsed.quantity == pytest.approx(quantity)


def test_a_size_that_is_not_a_weight_stays_out_of_the_amount():
    parsed = parse_ingredient_line("2 (8 inch) flour tortillas")
    assert (parsed.name, parsed.quantity, parsed.unit) == ("flour tortillas", 2, None)


def test_a_bracket_that_is_not_a_measure_stays():
    parsed = parse_ingredient_line("1 cup rice (rinsed, see note)")
    assert parsed.name == "rice (rinsed, see note)"
```

In the existing cases near lines 101-106 and 137-140 of `backend/tests/test_import.py`, change the expectations to the new rule (a package size is the amount):

```python
            "3 (3-ounce) packets ramen noodles (seasoning discarded)",
            IngredientIn(name="ramen noodles (seasoning discarded)", quantity=9, unit="ounce"),
```

```python
            "2 (15 oz) cans black beans",
            IngredientIn(name="black beans", quantity=30, unit="oz"),
```

```python
            "1 22-ounce bag frozen waffle fries",
            IngredientIn(name="frozen waffle fries", quantity=22, unit="ounce"),
```

```python
        ("2 15 oz cans black beans", IngredientIn(name="black beans", quantity=30, unit="oz")),
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_import.py -q`
Expected: the new cases and the four changed ones FAIL.

- [ ] **Step 3: Teach the parser**

In `backend/app/services/recipe_import.py`:

- Add `"strip", "strips"` to the literal set inside `KNOWN_UNITS`.
- Below `_SIZE_UNIT`, add:

```python
# The units a package size is weighed or measured in. A size in inches - a
# tortilla, a pan - says nothing about how much to buy, and is left out of
# the amount.
_SIZE_UNITS = {"oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg", "ml", "l"}
_SIZE = re.compile(
    r"^\(?\s*(\d+(?:\.\d+)?)\s*-?\s*(oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l)\.?\s*\)?$",
    re.IGNORECASE,
)

# What a package size comes in. A weight right before one of these is the
# amount wanted - "1 (15 oz) can" is 15 oz - and the container word is then
# noise in the name.
CONTAINERS = {
    "can", "cans", "jar", "jars", "bag", "bags", "box", "boxes", "packet", "packets",
    "package", "packages", "pkg", "container", "containers", "carton", "cartons",
    "tub", "tubs", "bottle", "bottles",
}

# Words a bracket may hold and still be only a measure: "(42 g)", "(about 1.5
# cup/200 g)", "(or 3 tablespoons)".
_MEASURE_WORDS = {u.lower() for u in KNOWN_UNITS} | _SIZE_UNITS | {"about", "approximately", "approx", "or", "fl"}
```

- Replace `_skip_package_size` with:

```python
def _read_size(text: str) -> tuple[float, str] | None:
    """A weight or volume like "15 oz", "(15 oz)" or "22-ounce", or None."""
    match = _SIZE.match(text.strip())
    return (float(match.group(1)), match.group(2).lower()) if match else None


def _package_size(tokens: list[str], index: int) -> tuple[int, tuple[float, str] | None]:
    """Index past a package size right after the amount, and the size itself.

    "3 (3-ounce) packets ramen noodles" and "2 (15 oz) cans black beans" state
    the container size before the unit. Only a parenthetical that opens
    immediately after the number counts; trailing notes like "(optional)" are
    part of the name. The size comes back when it is a weight or volume, so
    the caller can make it the amount.
    """
    if index >= len(tokens):
        return index, None
    if tokens[index].startswith("("):
        for end in range(index, len(tokens)):
            if tokens[end].endswith(")"):
                return end + 1, _read_size(" ".join(tokens[index : end + 1]))
        return index, None  # Unclosed: leave the text alone.
    # The same size without its brackets: "22-ounce" or "15 oz".
    if _BARE_SIZE.match(tokens[index]):
        return index + 1, _read_size(tokens[index])
    if (
        index + 1 < len(tokens)
        and re.fullmatch(r"\d+(?:\.\d+)?", tokens[index])
        and _SIZE_UNIT.match(tokens[index + 1])
        and index + 2 < len(tokens)
        and tokens[index + 2].lower().rstrip(".,") in KNOWN_UNITS
    ):
        return index + 2, _read_size(f"{tokens[index]} {tokens[index + 1]}")
    return index, None


def _is_amount(word: str) -> bool:
    return _token_to_number(word) is not None or re.fullmatch(
        r"\d+(?:\.\d+)?(?:g|kg|ml|l|oz|lb)", word
    ) is not None


def _measure_only(text: str) -> bool:
    words = [w for w in re.split(r"[\s/,]+", text.strip().lower()) if w]
    return any(_is_amount(w) for w in words) and all(
        _is_amount(w) or w.rstrip(".") in _MEASURE_WORDS for w in words
    )


def _drop_repeated_measures(name: str) -> str:
    """Drop brackets that only repeat the amount, innermost first."""
    while True:
        cleaned = re.sub(
            r"\s*\(([^()]*)\)", lambda m: "" if _measure_only(m.group(1)) else m.group(0), name
        )
        cleaned = re.sub(r"\s*\(\s*\)", "", cleaned)
        if cleaned == name:
            return name
        name = cleaned


def _note_after_name(name: str) -> str:
    """A note before the name goes after it: "(uncooked) bacon" is bacon."""
    match = re.match(r"^\(([^()]*)\)\s*(.+)$", name)
    if not match:
        return name
    note, rest = match.group(1).strip(), match.group(2).strip()
    if rest.endswith(")") and "(" in rest:
        at = rest.rfind("(")
        return f"{rest[: at + 1]}{note}, {rest[at + 1 :]}"
    return f"{rest} ({note})"


def _clean_name(name: str) -> str:
    """The name with what is not the ingredient taken out of it."""
    # Footnote marks point at a note the line lost: "ancho chili powder**".
    name = name.replace("*", "")
    name = _drop_repeated_measures(name)
    # How it is measured, not what it is: "firmly packed brown sugar".
    name = re.sub(r"^(?:(?:firmly|loosely|lightly|tightly)\s+)?packed\s+", "", name, flags=re.I)
    return _note_after_name(name.strip())
```

- In `parse_ingredient_line`, replace the unit block with:

```python
    unit: str | None = None
    if quantity is not None:
        index, size = _package_size(tokens, index)
        # Step over any modifiers, but only commit to that if a unit follows.
        after_modifiers = index
        while (
            after_modifiers < len(tokens)
            and tokens[after_modifiers].lower().rstrip(".,") in UNIT_MODIFIERS
        ):
            after_modifiers += 1
        if after_modifiers < len(tokens):
            candidate = tokens[after_modifiers].lower().rstrip(".,")
            if candidate in KNOWN_UNITS:
                unit = candidate
                index = after_modifiers + 1
        # A package size before its container is the amount wanted: "2 (15 oz)
        # cans" is 30 oz, which a package can be matched against and nutrition
        # can weigh, where "2 cans" can be neither.
        if size is not None and unit in CONTAINERS:
            quantity, unit = quantity * size[0], size[1]
        # "15 oz can black beans": a container after a weight is noise.
        elif (
            unit in _SIZE_UNITS
            and index < len(tokens)
            and tokens[index].lower().rstrip(".,") in CONTAINERS
        ):
            index += 1
```

- After `name = re.sub(r"\(\s*\$[^)]*\)", "", name)`, add `name = _clean_name(name)`.

In `backend/app/services/grocery.py`, add `"strips": "strip",` to `UNIT_ALIASES` and `"strip"` to `PLURALIZABLE_UNITS`.

- [ ] **Step 4: Run the import tests, then the suite**

Run: `cd backend && uv run pytest tests/test_import.py -q`
Expected: PASS.
Run: `cd backend && uv run ruff check . && uv run pytest -q`
Expected: all pass. If an assertion elsewhere fails because a line fed through the importer now reads differently, check it against the five rules above. If it follows them, update that expectation and name it in the commit message. If it does not, the parser is wrong; fix the parser.

- [ ] **Step 5: Note the change on ADRs 7 and 8**

Append to `docs/adr/0007-the-list-is-served-before-its-prices-and-every-doubtful-number-says-why.md`:

```markdown

## Note, October 2026

A package size after the amount is now the amount, where it is a weight or volume: "2 (15 oz) cans black beans" reads as 30 oz rather than 2 cans.
The importer also drops footnote marks, brackets that only repeat the amount, and "packed" from a name, and moves a note before the name to after it.
See the ingredients page spec, section 4.
```

Append to `docs/adr/0008-nutrition-is-counted-whole-from-bundled-usda-data-or-not-at-all.md`:

```markdown

## Note, October 2026

The importer no longer drops "(15 oz)" from "1 (15 oz) can": the size becomes the amount, 15 oz, which can be weighed.
A line saved before this, or typed as "1 can", is still not weighed, and can be read again from its ingredient's page.
```

- [ ] **Step 6: Commit**

```bash
git add backend docs/adr
git commit -m "Read package sizes, repeated measures and footnotes out of imported lines" -m "A weight before its container is now the amount, so 2 (15 oz) cans of
beans is 30 oz that can be priced and weighed. Footnote marks, brackets
that only repeat the amount and \"packed\" leave the name, a note before
the name moves after it, and strips are counted. Every rule is pinned
to a line from the real recipe box."
```

### Task 14: Editing recipe lines in place

**Files:**
- Create: `backend/app/routes/recipe_ingredients.py`
- Modify: `backend/app/schemas.py`, `backend/app/main.py`
- Test: `backend/tests/test_recipe_ingredients.py`

**Interfaces:**
- Consumes: `Identity` (Task 2), `parse_ingredient_line` (Task 13), `services.quantity.format_quantity`.
- Produces (schemas): `LineEdit(id: int, name: str, quantity: float | None, unit: str | None)`, `LineEdits(lines: list[LineEdit])`, `EditedLine(LineEdit)` plus `recipe_id: int`, `issue: LineIssue | None`, `key: str`, `RereadRequest(ids: list[int])`, `Reread(id: int, before: LineEdit, after: LineEdit, from_source: bool)`.
- Produces (routes): `PATCH /api/recipe-ingredients -> list[EditedLine]`; `POST /api/recipe-ingredients/reread -> list[Reread]`.

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas.py`:

```python
class LineEdit(BaseModel):
    """A recipe line as it should read, addressed by its id."""

    id: int
    name: str = Field(min_length=1, max_length=200)
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)


class LineEdits(BaseModel):
    lines: list[LineEdit] = Field(min_length=1, max_length=200)


class EditedLine(LineEdit):
    recipe_id: int
    issue: LineIssue | None = None
    # The ingredient the line now stands for, so the page can say when it
    # moved to another one.
    key: str


class RereadRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class Reread(BaseModel):
    id: int
    before: LineEdit
    after: LineEdit
    # Whether the website's own line was read, or the line rebuilt from its
    # amount, unit and name because the original was never kept.
    from_source: bool
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_recipe_ingredients.py`:

```python
"""Editing recipe lines in place, from an ingredient's page.

Saving a whole recipe replaces every line with new ids, which would break
the links the grocery list and "Needs a look" make to a line. These edits
keep the id. They also refuse as a batch - a blank name, a name that is not
an ingredient, or a line that is no longer there - so a half-saved fix is
never left behind. Reading a line again never saves anything.
"""

from app.db import session_factory
from app.models import Ingredient


async def recipe(client, lines: list[dict]) -> dict:
    resp = await client.post("/api/recipes", json={"title": "Chili", "ingredients": lines})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_a_line_is_edited_in_place_and_keeps_its_id(client):
    chili = await recipe(client, [{"name": "can black beans, drained and rinsed", "quantity": 15, "unit": "oz"}])
    line_id = chili["ingredients"][0]["id"]

    resp = await client.patch(
        "/api/recipe-ingredients",
        json={"lines": [{"id": line_id, "name": "black beans, drained and rinsed", "quantity": 15, "unit": "oz"}]},
    )
    assert resp.status_code == 200, resp.text
    (edited,) = resp.json()

    assert edited["id"] == line_id
    assert edited["key"] == "black-bean"
    reread = (await client.get(f"/api/recipes/{chili['id']}")).json()["ingredients"][0]
    assert (reread["id"], reread["name"]) == (line_id, "black beans, drained and rinsed")


async def test_a_bad_name_refuses_the_whole_batch(client):
    chili = await recipe(
        client,
        [{"name": "cumin", "quantity": 1, "unit": "tsp"}, {"name": "paprika", "quantity": 1, "unit": "tsp"}],
    )
    first, second = (i["id"] for i in chili["ingredients"])

    for bad in ["   ", "***"]:
        resp = await client.patch(
            "/api/recipe-ingredients",
            json={
                "lines": [
                    {"id": first, "name": "ground cumin", "quantity": 1, "unit": "tsp"},
                    {"id": second, "name": bad, "quantity": 1, "unit": "tsp"},
                ]
            },
        )
        assert resp.status_code == 422, resp.text

    names = [i["name"] for i in (await client.get(f"/api/recipes/{chili['id']}")).json()["ingredients"]]
    assert names == ["cumin", "paprika"]


async def test_a_line_replaced_by_saving_its_recipe_is_not_found(client):
    chili = await recipe(client, [{"name": "cumin", "quantity": 1, "unit": "tsp"}])
    stale = chili["ingredients"][0]["id"]
    await client.put(
        f"/api/recipes/{chili['id']}",
        json={"title": "Chili", "ingredients": [{"name": "cumin", "quantity": 2, "unit": "tsp"}]},
    )

    resp = await client.patch(
        "/api/recipe-ingredients", json={"lines": [{"id": stale, "name": "cumin", "quantity": 1, "unit": "tsp"}]}
    )

    assert resp.status_code == 404
    assert "reload" in resp.json()["detail"]


async def test_a_line_cannot_be_edited_twice_in_one_batch(client):
    chili = await recipe(client, [{"name": "cumin", "quantity": 1, "unit": "tsp"}])
    line_id = chili["ingredients"][0]["id"]
    edit = {"id": line_id, "name": "cumin", "quantity": 1, "unit": "tsp"}

    resp = await client.patch("/api/recipe-ingredients", json={"lines": [edit, edit]})

    assert resp.status_code == 422


async def test_reading_again_uses_the_website_s_line_when_it_was_kept(client):
    chili = await recipe(
        client,
        [
            {"name": "black beans", "quantity": 1, "unit": "can", "source_line": "1 (15 oz) can black beans"},
            {"name": "can kidney beans, drained and rinsed", "quantity": 15, "unit": "oz"},
        ],
    )
    kept, rebuilt = (i["id"] for i in chili["ingredients"])

    resp = await client.post("/api/recipe-ingredients/reread", json={"ids": [kept, rebuilt]})
    assert resp.status_code == 200, resp.text
    first, second = resp.json()

    assert first["from_source"] is True
    assert (first["after"]["name"], first["after"]["quantity"], first["after"]["unit"]) == ("black beans", 15, "oz")
    assert second["from_source"] is False
    assert (second["after"]["name"], second["after"]["quantity"], second["after"]["unit"]) == (
        "kidney beans, drained and rinsed",
        15,
        "oz",
    )
    async with session_factory() as session:
        assert (await session.get(Ingredient, rebuilt)).name == "can kidney beans, drained and rinsed"


async def test_reading_a_missing_line_again_is_not_found(client):
    resp = await client.post("/api/recipe-ingredients/reread", json={"ids": [999]})
    assert resp.status_code == 404
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_recipe_ingredients.py -q`
Expected: FAIL with 404/405 for the missing routes.

- [ ] **Step 4: Write the routes**

Create `backend/app/routes/recipe_ingredients.py`:

```python
"""Recipe lines edited one at a time, from an ingredient's page.

Saving a recipe replaces all its lines, and with them their ids, which the
grocery list and "Needs a look" link to. A line fixed from its ingredient's
page is edited where it is instead, so those links keep landing on it. A
batch is checked whole before anything is written: a fix is all or nothing.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Ingredient
from ..schemas import EditedLine, LineEdit, LineEdits, Reread, RereadRequest
from ..services.identity import Identity
from ..services.quantity import format_quantity
from ..services.recipe_import import parse_ingredient_line

router = APIRouter(prefix="/recipe-ingredients", tags=["recipe-ingredients"])

GONE = "That line is no longer in its recipe; reload to see the recipe as it is now."


async def _lines(session: AsyncSession, ids: list[int]) -> dict[int, Ingredient]:
    found = await session.execute(select(Ingredient).where(Ingredient.id.in_(ids)))
    lines = {row.id: row for row in found.scalars()}
    if any(i not in lines for i in ids):
        raise HTTPException(status_code=404, detail=GONE)
    return lines


def _as_edit(row: Ingredient) -> LineEdit:
    return LineEdit(id=row.id, name=row.name, quantity=row.quantity, unit=row.unit)


def _rebuilt(row: Ingredient) -> str:
    """The line as it reads now, for one whose original was never kept."""
    amount = format_quantity(row.quantity) if row.quantity is not None else ""
    return " ".join(part for part in (amount, row.unit or "", row.name) if part)


@router.patch("", response_model=list[EditedLine])
async def edit_lines(data: LineEdits, session: AsyncSession = Depends(get_session)):
    ids = [edit.id for edit in data.lines]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="Each line can be edited once at a time.")
    lines = await _lines(session, ids)
    identity = await Identity.of(session)
    for edit in data.lines:
        if not identity.key(edit.name):
            raise HTTPException(
                status_code=422, detail=f"“{edit.name.strip()}” is not the name of an ingredient."
            )
    for edit in data.lines:
        row = lines[edit.id]
        row.name = edit.name.strip()
        row.quantity = edit.quantity
        row.unit = (edit.unit or "").strip() or None
    await session.commit()
    return [
        EditedLine(
            **_as_edit(lines[i]).model_dump(),
            recipe_id=lines[i].recipe_id,
            issue=lines[i].issue,
            key=identity.key(lines[i].name),
        )
        for i in ids
    ]


@router.post("/reread", response_model=list[Reread])
async def reread(data: RereadRequest, session: AsyncSession = Depends(get_session)):
    """What today's importer makes of each line. Nothing is saved."""
    lines = await _lines(session, data.ids)
    found = []
    for i in data.ids:
        row = lines[i]
        parsed = parse_ingredient_line(row.source_line or _rebuilt(row))
        found.append(
            Reread(
                id=row.id,
                before=_as_edit(row),
                after=LineEdit(id=row.id, name=parsed.name, quantity=parsed.quantity, unit=parsed.unit),
                from_source=row.source_line is not None,
            )
        )
    return found
```

In `backend/app/main.py`, add `recipe_ingredients` to the routes import and `api.include_router(recipe_ingredients.router)`.

- [ ] **Step 5: Run the tests and the suite**

Run: `cd backend && uv run pytest tests/test_recipe_ingredients.py -q`
Expected: PASS (6 tests).
Run the backend checks from Global Constraints.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "Edit recipe lines in place, and read them again" -m "PATCH /api/recipe-ingredients edits lines by id without replacing the
recipe's other lines, so links to a line keep landing on it, and
refuses a whole batch for a blank name, a name that is not an
ingredient, or a line that is gone. Reading a line again runs today's
importer over the website's line, or the line rebuilt from its parts
when the original was never kept, and saves nothing."
```

### Task 15: Fix and Read it again on the ingredient's page

**Files:**
- Create: `frontend/src/components/LineFixer.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/pages/IngredientPage.tsx`, `frontend/src/pages/IngredientPage.test.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 14's endpoints; `parseQuantity`, `formatAmount` from `quantity.ts`; `errorMessage` from `useLoad.ts`; `ISSUE_LABELS` from `issues.ts`.
- Produces:
  - TS types `LineEdit`, `EditedLine`, `Reread`; `api.editLines(lines: LineEdit[]): Promise<EditedLine[]>`, `api.rereadLines(ids: number[]): Promise<Reread[]>`.
  - `<LineFixer line={IngredientLine} onSaved={(edited: EditedLine) => void} onCancel={() => void} />`.

- [ ] **Step 1: Add the types and calls**

In `frontend/src/api.ts`, after `MergePreview`, add:

```ts
/** A recipe line as it should read, addressed by its id. */
export interface LineEdit {
  id: number;
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface EditedLine extends LineEdit {
  recipe_id: number;
  issue: LineIssue | null;
  /** The ingredient the line now stands for. */
  key: string;
}

export interface Reread {
  id: number;
  before: LineEdit;
  after: LineEdit;
  /** True when the website's own line was read; false when rebuilt from its parts. */
  from_source: boolean;
}
```

and in the `api` object:

```ts
  /** Edit recipe lines in place, keeping their ids. All or nothing. */
  editLines: (lines: LineEdit[]) =>
    request<EditedLine[]>("/api/recipe-ingredients", {
      method: "PATCH",
      body: JSON.stringify({ lines }),
    }),
  /** What today's importer makes of each line. Saves nothing. */
  rereadLines: (ids: number[]) =>
    request<Reread[]>("/api/recipe-ingredients/reread", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
```

- [ ] **Step 2: Write the failing tests**

Append to `frontend/src/pages/IngredientPage.test.tsx`:

```tsx
describe("IngredientPage: fixing lines", () => {
  const beans = ingredientDetail({
    key: "can-black-bean",
    name: "can black beans, drained and rinsed",
    lines: [
      ingredientLine({
        ingredient_id: 31,
        recipe_id: 4,
        recipe_title: "Chili",
        name: "can black beans, drained and rinsed",
        quantity: 15,
        unit: "oz",
        issue: null,
      }),
    ],
  });

  it("edits a line in place, and says where it moved to", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": beans,
      "PATCH /api/recipe-ingredients": [
        { id: 31, recipe_id: 4, name: "black beans, drained and rinsed", quantity: 15, unit: "oz", issue: null, key: "black-bean" },
      ],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "black beans, drained and rinsed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(backend.requestsTo("PATCH /api/recipe-ingredients")).toHaveLength(1));
    expect(backend.requestsTo("PATCH /api/recipe-ingredients")[0].body).toEqual({
      lines: [{ id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }],
    });
  });

  it("reads a line again without saving it", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": beans,
      "POST /api/recipe-ingredients/reread": [
        {
          id: 31,
          before: { id: 31, name: "can black beans, drained and rinsed", quantity: 15, unit: "oz" },
          after: { id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" },
          from_source: false,
        },
      ],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    await user.click(screen.getByRole("button", { name: "Read it again" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("black beans, drained and rinsed"));
    expect(backend.requestsTo("PATCH /api/recipe-ingredients")).toHaveLength(0);
  });

  it("shows what the website wrote, when it was kept", async () => {
    mockBackend({
      "GET /api/ingredients/:key": {
        ...beans,
        lines: [{ ...beans.lines[0], source_line: "1 (15 oz) can black beans, drained and rinsed" }],
      },
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));

    expect(screen.getByText(/The website wrote: 1 \(15 oz\) can black beans/)).toBeInTheDocument();
  });

  it("reads all the lines again, and saves the ones that changed together", async () => {
    const two = {
      ...beans,
      lines: [beans.lines[0], ingredientLine({ ingredient_id: 32, recipe_id: 6, recipe_title: "Tacos", name: "black beans", quantity: 1, unit: "can" })],
    };
    const backend = mockBackend({
      "GET /api/ingredients/:key": two,
      "POST /api/recipe-ingredients/reread": [
        { id: 31, before: { id: 31, name: "can black beans, drained and rinsed", quantity: 15, unit: "oz" }, after: { id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }, from_source: false },
        { id: 32, before: { id: 32, name: "black beans", quantity: 1, unit: "can" }, after: { id: 32, name: "black beans", quantity: 1, unit: "can" }, from_source: false },
      ],
      "PATCH /api/recipe-ingredients": [],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Read all 2 lines again" }));
    expect(await screen.findByText("unchanged")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(backend.requestsTo("PATCH /api/recipe-ingredients")[0].body).toEqual({
        lines: [{ id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }],
      }),
    );
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd frontend && npx vitest run src/pages/IngredientPage.test.tsx`
Expected: the new tests FAIL; there is no Fix button.

- [ ] **Step 4: Write the fixer**

Create `frontend/src/components/LineFixer.tsx`:

```tsx
import { useState } from "react";

import { api, type EditedLine, type IngredientLine } from "../api";
import { formatAmount, parseQuantity } from "../quantity";
import { errorMessage } from "../useLoad";
import { Banner, Button } from "./ui";

/**
 * One recipe line, edited where it is shown.
 *
 * The same three fields as the recipe form, saved by id so the line keeps
 * its place and the links to it. "Read it again" asks the importer what it
 * makes of the line now and fills the fields with the answer, unsaved, so
 * the cook decides.
 */
export function LineFixer({
  line,
  onSaved,
  onCancel,
}: {
  line: IngredientLine;
  onSaved: (edited: EditedLine) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(line.quantity === null ? "" : formatAmount(line.quantity));
  const [unit, setUnit] = useState(line.unit ?? "");
  const [name, setName] = useState(line.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const typed = quantity.trim();
    const amount = typed === "" ? null : parseQuantity(typed);
    if (typed !== "" && amount === null) {
      setError("Quantities are numbers or fractions like 1 1/2.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [edited] = await api.editLines([
        { id: line.ingredient_id, name: name.trim(), quantity: amount, unit: unit.trim() || null },
      ]);
      onSaved(edited);
    } catch (cause) {
      setError(errorMessage(cause, "That did not save."));
      setBusy(false);
    }
  }

  async function readAgain() {
    setError(null);
    try {
      const [answer] = await api.rereadLines([line.ingredient_id]);
      setQuantity(answer.after.quantity === null ? "" : formatAmount(answer.after.quantity));
      setUnit(answer.after.unit ?? "");
      setName(answer.after.name);
    } catch (cause) {
      setError(errorMessage(cause, "Could not read the line again."));
    }
  }

  return (
    <form className="line-fixer" onSubmit={save} aria-label={`Fix ${line.name}`}>
      <div className="line-fixer-fields">
        <input aria-label="Quantity" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input aria-label="Unit" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {line.source_line && <p className="source-line">The website wrote: {line.source_line}</p>}
      {error && <Banner tone="error">{error}</Banner>}
      <div className="fact-actions">
        <Button type="submit" variant="primary" size="small" disabled={busy || !name.trim()}>
          Save
        </Button>
        <Button size="small" onClick={readAgain}>
          Read it again
        </Button>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
```


- [ ] **Step 5: Put Fix and Read all again on the page**

In `frontend/src/pages/IngredientPage.tsx`:
- Import `LineFixer`, `ISSUE_LABELS` from `../issues`, and the types `EditedLine`, `Reread`.
- Add state: `const [fixing, setFixing] = useState<number | null>(null);`, `const [moved, setMoved] = useState<{ name: string; key: string } | null>(null);`, `const [rereads, setRereads] = useState<Reread[] | null>(null);`.
- Add handlers:

```tsx
  function saved(edited: EditedLine) {
    setFixing(null);
    if (edited.key === data!.key) {
      reload();
      return;
    }
    // The line now stands for another ingredient. If it was this one's last
    // reason to exist, go to where it went; otherwise say where it went.
    if (data!.lines.length === 1 && !data!.staple) {
      navigate(`/ingredients/${edited.key}`);
    } else {
      setMoved({ name: edited.name, key: edited.key });
      reload();
    }
  }

  async function readAll() {
    if (await action.run(async () => setRereads(await api.rereadLines(data!.lines.map((l) => l.ingredient_id))))) {
      return;
    }
  }

  const changedReads = (rereads ?? []).filter(
    (r) =>
      r.after.name !== r.before.name || r.after.quantity !== r.before.quantity || r.after.unit !== r.before.unit,
  );
```

- In the "Used in" panel, give the panel an action when there are several lines, and render each line with its tag and Fix:

```tsx
        <Panel
          title="Used in"
          action={
            data.lines.length > 1 ? (
              <Button size="small" onClick={readAll}>
                Read all {data.lines.length} lines again
              </Button>
            ) : undefined
          }
        >
          {moved && (
            <Banner tone="notice" spaced>
              Now shops as <Link to={`/ingredients/${moved.key}`}>{moved.name}</Link>.
            </Banner>
          )}
          {data.lines.length === 0 ? (
            <p className="muted">No recipe uses it; it is here as a staple.</p>
          ) : (
            <ul className="ingredient-lines">
              {data.lines.map((line) =>
                fixing === line.ingredient_id ? (
                  <li key={line.ingredient_id}>
                    <span className="recipe">{line.recipe_title}</span>
                    <LineFixer line={line} onSaved={saved} onCancel={() => setFixing(null)} />
                  </li>
                ) : (
                  <li key={line.ingredient_id}>
                    <span className="recipe">{line.recipe_title}</span>
                    <span className="line">
                      <Link to={recipeIngredientPath(line.recipe_id, [line.ingredient_id])}>{lineText(line)}</Link>
                      {line.issue && <span className="issue-tag">{ISSUE_LABELS[line.issue]}</span>}
                      <Button
                        size="small"
                        variant={line.issue ? "primary" : undefined}
                        onClick={() => setFixing(line.ingredient_id)}
                      >
                        Fix
                      </Button>
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </Panel>
```

- With the other modals, add the read-all review:

```tsx
      {rereads && (
        <Modal title="Read the lines again" onClose={() => setRereads(null)}>
          <ul className="reread-list">
            {rereads.map((r) => {
              const changed = changedReads.includes(r);
              return (
                <li key={r.id}>
                  <span className="before">{lineText({ ...data.lines.find((l) => l.ingredient_id === r.id)!, ...r.before })}</span>
                  {changed ? (
                    <span className="after">→ {lineText({ ...data.lines.find((l) => l.ingredient_id === r.id)!, ...r.after })}</span>
                  ) : (
                    <span className="muted">unchanged</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="modal-actions">
            <Button
              variant="primary"
              disabled={changedReads.length === 0}
              onClick={() => {
                const edits = changedReads.map((r) => r.after);
                setRereads(null);
                void change(() => api.editLines(edits));
              }}
            >
              Save changes
            </Button>
            <Button onClick={() => setRereads(null)}>Cancel</Button>
          </div>
        </Modal>
      )}
```

In `frontend/src/styles.css`, add:

```css
.ingredient-lines .line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-8); }

.line-fixer { display: grid; gap: var(--space-8); }

/* The recipe form's row, in the space one line had. */
.line-fixer-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 3fr);
  gap: var(--space-8);
}

.line-fixer-fields input { min-width: 0; }

.source-line { color: var(--muted); font-size: var(--text-sm); margin: 0; }

.reread-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-10); }

.reread-list li { display: grid; gap: var(--space-2); }

.reread-list .before { color: var(--muted); }
```

- [ ] **Step 6: Run the tests and all frontend checks**

Run: `cd frontend && npx vitest run src/pages/IngredientPage.test.tsx`
Expected: PASS.
Run the frontend checks from Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "Fix a recipe line from its ingredient's page" -m "Every line under Used in has Fix, emphasised when the line is flagged,
which edits it in place with the recipe form's fields and shows what
the website wrote. Read it again fills the fields with today's
importer's reading, unsaved; Read all again shows before and after for
every line and saves the ones that changed together. A line that now
stands for another ingredient says where it went."
```

---

## Phase 7: Settings, and the links in

### Task 16: Remembered products leave Settings

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/SettingsPage.test.tsx`, `frontend/src/api.ts`, `backend/app/routes/pricing.py`, `backend/app/services/kroger/pricing.py`, `backend/app/schemas.py`
- Test: `frontend/src/pages/SettingsPage.test.tsx`, plus whichever backend tests cover `/api/pricing/matches`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/pricing/matches`, `pricing.remembered_picks`, `schemas.RememberedPick`, `api.rememberedPicks` and the `RememberedPick` TS type are removed. Settings shows "Products you've picked are on each ingredient's page" with a link to `/ingredients?view=all`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/pages/SettingsPage.test.tsx`, in the describe block that defines `PICKS` and `withPicks` (around line 200), delete `PICKS`, `withPicks` and every test that calls `withPicks`, and add in their place:

```tsx
    it("points to the ingredients for the products that have been picked", async () => {
      mockBackend({
        "GET /api/cart/status": cartStatus({ configured: false }),
        "GET /api/pricing/status": { enabled: true, store: riverside },
      });
      renderApp("/settings");

      const link = await screen.findByRole("link", { name: "Ingredients" });
      expect(link).toHaveAttribute("href", "/ingredients?view=all");
      expect(screen.queryByText("Remembered products")).not.toBeInTheDocument();
    });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/pages/SettingsPage.test.tsx`
Expected: FAIL; the panel is still there and there is no link.

- [ ] **Step 3: Remove the panel and add the pointer**

In `frontend/src/pages/SettingsPage.tsx`:
- Replace `{status?.enabled && store && <RememberedPicks />}` with:

```tsx
      {status?.enabled && store && (
        // Each pick lives with its ingredient now, beside its food and its
        // staple, so this page only says where to find them.
        <p className="page-note">
          Products you&rsquo;ve picked are on each ingredient&rsquo;s page.{" "}
          <Link to="/ingredients?view=all">Ingredients</Link>
        </p>
      )}
```

- Delete the `RememberedPicks` function and any imports only it used; add `Link` from `react-router-dom` if it is not imported.

In `frontend/src/api.ts`, delete `rememberedPicks` and the `RememberedPick` interface.

In the backend, delete the `remembered_picks` route from `routes/pricing.py`, `remembered_picks` from `services/kroger/pricing.py`, and `RememberedPick` from `schemas.py`. Then find the tests of the removed endpoint:

Run: `grep -rn "pricing/matches\|remembered_picks\|RememberedPick" backend frontend/src`
Delete each test function that exercised the removed endpoint; nothing else should match.

- [ ] **Step 4: Run all checks**

Run the backend and frontend checks from Global Constraints.
Expected: all pass, with the grep above returning nothing.

- [ ] **Step 5: Commit**

```bash
git add backend frontend
git commit -m "Move remembered products out of Settings, onto each ingredient" -m "Each picked product now sits on its ingredient's page with its food
and its staple, and the ones that matched nothing are under Needs a
look, so Settings keeps the store and the Kroger account and says where
the picks went. The endpoint that listed them all goes with the panel."
```

### Task 17: Links in from the grocery list, the recipe page and the recipe box

**Files:**
- Modify: `backend/app/schemas.py` (`NutritionLine.ingredient_key`), `backend/app/services/nutrition/facts.py`, `frontend/src/api.ts`, `frontend/src/components/ProductPicker.tsx`, `frontend/src/components/Nutrition.tsx`, `frontend/src/pages/RecipeDetailPage.tsx`, `frontend/src/pages/GroceryPage.tsx`, `frontend/src/pages/RecipesPage.tsx`, `README.md`
- Test: `backend/tests/test_nutrition.py`, `frontend/src/pages/RecipeNutrition.test.tsx`, `frontend/src/pages/GroceryPricing.test.tsx`, `frontend/src/pages/RecipesPage.test.tsx`

**Interfaces:**
- Consumes: the `/ingredients` routes (Tasks 8, 10).
- Produces:
  - `NutritionLine.ingredient_key: str` (backend and TS), the line's ingredient after merges, without state words.
  - `ProductPickerModal` and `FoodPickerModal` take an optional `ingredientKey?: string` and then show "Open <name>'s page".

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_nutrition.py`:

```python
async def test_each_line_says_which_ingredient_it_is(client):
    resp = await client.post(
        "/api/recipes",
        json={"title": "Rice", "servings": 2, "ingredients": [{"name": "cooked rice", "quantity": 2, "unit": "cup"}]},
    )
    recipe_id = resp.json()["id"]

    (line,) = (await client.get(f"/api/recipes/{recipe_id}/nutrition")).json()["lines"]

    assert (line["key"], line["ingredient_key"]) == ("cooked-rice", "rice")
```

In `frontend/src/pages/RecipeNutrition.test.tsx`, make the `line()` helper fill `ingredient_key` from `key` (`return { ingredient_id: 0, ..., issue: null, ingredient_key: overrides.key ?? "", ...overrides };`) and append to its describe block:

```tsx
  it("links each name in the breakdown to its ingredient's page", async () => {
    withNutrition(INCOMPLETE);
    renderApp("/recipes/1");
    await screen.findByText("Nutrition unavailable");

    const breakdown = document.querySelector<HTMLElement>(".nutrition-lines")!;
    expect(within(breakdown).getByRole("link", { name: "almond flour" })).toHaveAttribute(
      "href",
      "/ingredients/almond-flour",
    );
  });
```

Append to the first describe block of `frontend/src/pages/GroceryPricing.test.tsx`:

```tsx
  it("opens the ingredient's page from its product panel", async () => {
    pricedBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [onion],
        pricing: { store: STORE, total: 1.19, saved: 0, priced: 1, total_lines: 1 },
      }),
      "GET /api/pricing/alternatives": ALTERNATIVES,
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("onion");

    await user.click(screen.getByRole("button", { name: /Choose a different product/ }));

    const panel = await screen.findByRole("group", { name: "Products for onion" });
    expect(within(panel).getByRole("link", { name: "Open onion’s page" })).toHaveAttribute(
      "href",
      `/ingredients/${onion.key}`,
    );
  });
```

In `frontend/src/pages/RecipesPage.test.tsx`, inside the describe block that defines `needingALook` (around line 596), add:

```tsx
    it("links from Needs a look to the same view, ingredient by ingredient", async () => {
      needingALook([{ recipe: curry, issues: [], no_servings: true }]);
      renderApp("/recipes");

      const link = await screen.findByRole("link", { name: "See it ingredient by ingredient" });
      expect(link).toHaveAttribute("href", "/ingredients?view=look");
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_nutrition.py -q -k ingredient_it_is` and `cd frontend && npx vitest run src/pages/RecipeNutrition.test.tsx src/pages/GroceryPricing.test.tsx src/pages/RecipesPage.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Give nutrition lines their ingredient**

In `backend/app/schemas.py`, add to `NutritionLine` after `key`:

```python
    # The ingredient the line stands for, after merges and without state
    # words: what its Ingredients page is addressed by.
    ingredient_key: str = ""
```

In `backend/app/services/nutrition/facts.py`, in `count_recipe`, create each line with `NutritionLine(ingredient_id=ing.id, name=ing.name, key=key, ingredient_key=identity.key(ing.name))`.

In `frontend/src/api.ts`, add to `NutritionLine`: `/** The ingredient the line stands for; its Ingredients page's address. */ ingredient_key: string;`.

- [ ] **Step 4: Add the links**

In `frontend/src/components/ProductPicker.tsx`, add the prop `ingredientKey?: string` (documented: "Where the ingredient's own page is; absent where there is none, as for a pasted line.") and, after the "Back to the automatic pick" button inside `.modal-list`:

```tsx
        {ingredientKey && (
          <Link className="modal-food skip" to={`/ingredients/${ingredientKey}`}>
            Open {line.name}&rsquo;s page
          </Link>
        )}
```

In `frontend/src/components/Nutrition.tsx`:
- Give `FoodPickerModal` the same optional `ingredientKey` prop and the same link at the end of its list.
- In `NutritionBreakdown`, render the name as a link when there is a key. The link itself carries the `name` class, so the existing test helper that finds a row by `.nutrition-lines .name` still reads its text:

```tsx
                {line.ingredient_key ? (
                  <Link className="name" to={`/ingredients/${line.ingredient_key}`}>
                    {line.name}
                  </Link>
                ) : (
                  <span className="name">{line.name}</span>
                )}
```

In `frontend/src/pages/RecipeDetailPage.tsx`, pass `ingredientKey={pricingFor.key}` to `ProductPickerModal` and `ingredientKey={choosingFor.ingredient_key}` to `FoodPickerModal` (the page's state for the line being priced and the line being given a food).

In `frontend/src/pages/GroceryPage.tsx`, in the alternatives panel, after the "Don't price this" button:

```tsx
      <Link className="alternative skip" to={`/ingredients/${item.key}`}>
        Open {item.name}&rsquo;s page
      </Link>
```

In `frontend/src/pages/RecipesPage.tsx`, in `NeedsALook`, directly after `</summary>`:

```tsx
      <p className="attention-more">
        <Link to="/ingredients?view=look">See it ingredient by ingredient</Link>
      </p>
```

and in `styles.css`, `.attention-more { margin: var(--space-8) 0 var(--space-12); }`.

In `README.md`, replace the "Pantry staples" bullet with (one sentence per line):

```markdown
* Ingredients: one page per ingredient, with the recipes that use it, whether it is a staple, the product it is priced with and the food it counts as, each changeable where it is shown.
  Two names for one thing - "ground cumin" and "cumin" - can be merged once, and every part of the app then treats them as one, recipes keeping their wording; likely pairs are suggested, never merged without you.
  A broken recipe line can be fixed from its ingredient's page, or read again by today's importer.
  The Staples view is the pantry: items you always keep in stock, the ones that ran out first.
  Out-of-stock staples are added to the grocery list, and checking one off the list marks it back in stock.
  When a planned recipe calls for a staple you already have, it is set aside under "already in your pantry" rather than put on the list - listed with the amount the week's meals need, so you can buy more anyway if the jar won't cover it.
```


- [ ] **Step 5: Run the tests and all checks**

Run the backend and frontend checks from Global Constraints.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend frontend README.md
git commit -m "Link to an ingredient's page from wherever it is chosen" -m "The grocery list's product panel and the recipe page's product and food
pickers open the ingredient's page, each name in the nutrition breakdown
links to it, and the recipe box's Needs a look links to the same view
ingredient by ingredient. A line's name on the grocery list stays plain
so ticking in the shop never navigates away. The README describes the
Ingredients tab."
```

### Task 18: Verify it end to end

**Files:**
- None committed unless a defect is found (then fix it in its own commit with a test).

- [ ] **Step 1: Run every check**

Run the backend and frontend checks and the `alembic check` from Global Constraints.
Expected: all pass, no new upgrade operations.

- [ ] **Step 2: Run the app against a copy of the real data**

Use the seeded copy of the owner's production data at `/private/tmp/claude-503/-Users-nathanrude-Development-recipes/4e5d8881-4f10-4411-8e2a-4397e5c5ddbf/scratchpad/seed/` (`recipes.db`, `data/`, `run_backend.sh`), copied into a scratch dir of your own:
- Backend: `<seed>/run_backend.sh <worktree root> <your recipes.db> <your data dir> 8140` in the background; the migration to `a7d3e1c9b2f4` runs on startup.
- Frontend: an UNTRACKED `frontend/vite.e2e.config.ts` proxying `/api` to `http://localhost:8140`, then `npx vite --config vite.e2e.config.ts --port 5220 --strictPort`.

- [ ] **Step 3: Walk the four scenarios in a real browser, at phone width and desktop, light and dark**

With Playwright from the scratchpad (`chromium.launch({ channel: "chrome", headless: true })`; phone `{ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }`; desktop `{ viewport: { width: 1280, height: 900 } }`):

1. Open `/ingredients`, Needs a look: the suggestions include "Ground cumin and cumin". Merge it; confirm the preview, merge, see the banner on cumin's page. Open the grocery list for the week of 2026-09-07: one cumin line, covered by the Cumin staple (set aside under "already in your pantry").
2. Open the ingredient "can black beans, drained and rinsed", Fix its line, Read it again: the fields read 15 oz "black beans, drained and rinsed". Save: "Now shops as black beans" or the page moves to black beans.
3. On Chili's nutrition breakdown, choose a food for any remaining "no food chosen" line until the figure appears.
4. Unmerge ground cumin from cumin's page: the confirmation says it starts fresh; afterwards the grocery list shows two lines again.

Also check:
- `/pantry` lands on Ingredients.
- The phone tab bar fits "Ingredients" without clipping: measure in the page that each tab label's `scrollWidth <= clientWidth`, and that the page never scrolls sideways (`document.documentElement.scrollWidth === innerWidth`).
- Settings shows the pointer line and no Remembered products.

- [ ] **Step 4: Look at every screenshot critically**

Read each screenshot. Fix anything that looks off - alignment, wrapping, spacing, contrast in dark mode, a control too small to tap - in its own commit with a test or style guard where the existing patterns allow, then re-run the checks.

- [ ] **Step 5: Stop the servers and clean up**

Stop both servers and delete `frontend/vite.e2e.config.ts`. Confirm `git status` is clean.
