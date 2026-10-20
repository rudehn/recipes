# Search-first Recipes Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Recipes page's tag bar and four fold-out sections with one token search box, a quick row of most-searched tags, a sort menu and sale ribbons, and move "Needs a look" to the Ingredients page as a By recipe view.

**Architecture:** The server keeps doing the filtering and paging it does today, and gains three Python-side signals it folds into the SQL query as id sets or ordering: ingredient identity (merges respected), each recipe's sale percentage (from products already chosen, never a search), and the last past meal-plan date.
A new `recipe_searches` table records searches as an event log, which feeds the recent-searches dropdown and the quick row's tag order.
The frontend splits the page into a pure search model (`recipeSearch.ts`), a combobox (`RecipeSearchBox`), the quick row (`QuickRow`) and the page that wires them to the URL and the API.

**Tech Stack:** FastAPI, SQLAlchemy 2 (async), Alembic, pytest; React 18, React Router, TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-recipes-page-search-design.md`

## Global Constraints

- On sale: sale % = (regular total - sale total) / regular total, over the recipe's share of each package; on sale only at **15% or more**, and only when at least **80% of its ingredient lines are priced**. Ribbon text: `"{n}% off"`, n rounded **down**.
- Listing recipes never searches Kroger: products come from stored picks only (`resolve=False`).
- With pricing off, no store, or Kroger unreachable: no ribbons, no On sale chip, no Biggest sale sort, and the list still loads.
- Sorts, in this order and with these labels: `A-Z` (`title`), `Recently added` (`newest`), `Recently cooked` (`cooked`), `Biggest sale` (`sale`).
- History window: **60 days**. Quick row: up to **4** tags. Recent searches shown: **5**.
- The quick row is one line and never scrolls sideways; On sale and All tags always stay visible.
- Old `?q=` and `?tag=` URLs keep working.
- No cost per serving anywhere on the Recipes page; no pantry filter.
- Copy uses the plain hyphen "-", never an em dash.
- Commit messages carry no co-author line. Work on a branch `recipes-page-search`, merged to `main` at the end.
- Backend tests: `cd backend && uv run pytest <file> -q`. Frontend tests: `cd frontend && npx vitest run <file>`. Lint: `cd backend && uv run ruff check .` and `cd frontend && npm run lint`.

## Review Focus

1. **Kroger unreachable while listing recipes** - the list, facets and suggestions still answer 200 with no sale data; pinned in Task 1.
2. **A search history entry naming a merged-away ingredient or a tag no recipe carries any more** - it still opens, resolves the ingredient through merges, and lands on an empty state that offers a removal; pinned in Tasks 2 and 9.
3. **Typed text with LIKE wildcards or quotes ("100%", `"egg roll"`)** - matched literally, recorded and replayed literally; pinned in Tasks 3 and 6.
4. **A 375px phone with long tag names** - the row never overflows and On sale and All tags stay on screen; pinned in Task 8.
5. **Opening the page from an old bookmark (`/recipes?q=curry&tag=dinner`)** - the box shows a "curry" text token and a dinner token, and the list is filtered; pinned in Task 6.

---

### Task 1: Sale percentages on the recipe list

**Files:**
- Modify: `backend/app/services/kroger/costing.py`
- Modify: `backend/app/schemas.py` (`RecipeSummary`)
- Modify: `backend/app/routes/recipes.py` (`list_recipes`, `RecipeSort`, `_SORTS`, `_filtered_recipes`)
- Test: `backend/tests/test_grocery_pricing.py` (new section "sale percentages", beside the `catalog` fixture)

**Interfaces:**
- Produces: `costing.SALE_THRESHOLD = 0.15`; `costing.PRICED_COVERAGE = 0.8` (rename of `SUGGESTION_COVERAGE`).
- Produces: `async def sale_percentages(session: AsyncSession) -> dict[int, int]` in `costing.py` - recipe id to whole percent off, only for recipes on sale by the Global Constraints rule; `{}` when `not enabled()`, no store, or `KrogerError`.
- Produces: `RecipeSummary.sale_percent: int | None = None`.
- Produces: `GET /api/recipes` accepts `on_sale: bool = False`, and `RecipeSort` becomes `Literal["title", "newest", "sale"]` (Task 2 adds `"cooked"`).
- Produces: `_filtered_recipes(q: str, tags: list[str], only: set[int] | None = None) -> Select` - `only` restricts to those ids (an empty set matches nothing).

- [ ] **Step 1: Write the failing tests**

Using the existing `catalog` fixture and `seed`/`fetch` helpers (a list fetch creates the stored picks; sugar regular 3.99, promo 2.99):

```python
async def listing(client, **params) -> dict:
    resp = await client.get("/api/recipes", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()

async def test_a_recipe_mostly_on_offer_carries_its_sale_percent(client, catalog): ...
    # seed(["sugar"]); fetch; a recipe of only sugar -> sale_percent == 25 (floor of 25.06)
async def test_a_small_discount_does_not_make_a_recipe_on_sale(client, catalog): ...
    # recipe whose sugar share is under 15% of its cost -> sale_percent is None
async def test_a_recipe_mostly_unpriced_is_never_on_sale(client, catalog): ...
    # 1 priced discounted line of 2 (50% coverage) -> None
async def test_the_on_sale_filter_keeps_only_recipes_on_sale(client, catalog): ...
    # titles(on_sale=True) == ["Sugar cookies"]; total == 1
async def test_biggest_sale_sorts_by_percent_then_title(client, catalog): ...
    # sort="sale": on-sale recipes first by percent desc, the rest A-Z
async def test_the_list_answers_without_sale_data_when_kroger_is_down(client, catalog, monkeypatch): ...
    # products.by_ids raises KrogerError -> 200, every sale_percent None, on_sale=True gives total 0
async def test_no_store_means_nothing_is_on_sale(client, catalog): ...
```

Assertions use literal percentages worked out by hand from the catalog prices and the recipe amounts, never by calling `sale_percentages`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_grocery_pricing.py -q -k "sale_percent or on_sale or biggest_sale or without_sale or nothing_is_on_sale"`
Expected: FAIL (`sale_percent` missing from items, `on_sale` and `sort=sale` rejected with 422).

- [ ] **Step 3: Implement `sale_percentages` in `costing.py`**

Load recipes with ingredients, get `found = await _products_for(session, recipes, store.location_id, resolve=False)` inside a `KrogerError` guard, then cost every line twice through the same share arithmetic as `_line_cost` - once at `product.regular`, once at `product.price` - by giving `_line_cost` an explicit `price: float` parameter rather than reading `product.price` inside it.
A recipe qualifies when `priced / len(lines) >= PRICED_COVERAGE`, `regular_total > 0`, and `(regular_total - today_total) / regular_total >= SALE_THRESHOLD`; its value is `math.floor(ratio * 100)`.

- [ ] **Step 4: Wire it into `list_recipes`**

Compute `sales = await costing.sale_percentages(session)` once per request.
`on_sale=True` passes `only=set(sales)`.
`sort="sale"` orders by `case(sales, value=Recipe.id, else_=-1).desc()`, then title, then id; with `sales` empty, use the title order (an empty `case` mapping is invalid).
Build each item as `RecipeSummary.model_validate(r).model_copy(update={"sale_percent": sales.get(r.id)})`.

- [ ] **Step 5: Run the tests and the existing list tests**

Run: `cd backend && uv run pytest tests/test_grocery_pricing.py tests/test_recipe_list.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/kroger/costing.py backend/app/schemas.py backend/app/routes/recipes.py backend/tests/test_grocery_pricing.py
git commit -m "Say how much of a recipe is on sale, and filter and sort by it"
```

---

### Task 2: Ingredient filter and Recently cooked sort

**Files:**
- Create: `backend/app/services/recipe_filters.py`
- Modify: `backend/app/routes/recipes.py`
- Test: `backend/tests/test_recipe_list.py`

**Interfaces:**
- Consumes: `_filtered_recipes(q, tags, only)` from Task 1.
- Produces: `async def recipes_using(session: AsyncSession, keys: list[str]) -> set[int]` in `recipe_filters.py` - recipes that use **every** key; each key and each ingredient name resolved through `Identity.of(session)` (`identity.resolve(key)`, `identity.key(name)`).
- Produces: `def intersect(*sets: set[int] | None) -> set[int] | None` in `recipe_filters.py` - `None` means "no restriction".
- Produces: `GET /api/recipes` accepts `ingredient: list[str]` (max 20, each max 300 chars) and `sort="cooked"`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_an_ingredient_filter_matches_by_identity_not_substring(client): ...
    # "Curry" uses "chicken thighs", "Wings" uses "chicken wings":
    # titles(ingredient=["chicken-thigh"]) == ["Curry"]  (substring "chicken" would match both)
async def test_several_ingredients_must_all_be_used(client): ...
async def test_an_ingredient_filter_follows_a_merge(client): ...
    # merge "ground-cumin" into "cumin" via the merges API; ingredient=["ground-cumin"] and ["cumin"] both find the recipe using "ground cumin"
async def test_recently_cooked_puts_the_latest_past_plan_first(client): ...
    # plans: A yesterday, B three days ago, C tomorrow only, D never ->
    # titles(sort="cooked") == ["A", "B", "C", "D"]  (C's only plan is in the future, so it ranks with the never-cooked, A-Z)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_recipe_list.py -q`
Expected: FAIL (unknown params ignored, `sort=cooked` is 422).

- [ ] **Step 3: Implement `recipes_using` and `intersect`, and wire both into the route**

`recipes_using` reads `(Ingredient.recipe_id, Ingredient.name)` once and groups keys per recipe in Python; ingredient keys are not stored, so there is no SQL path.
`sort="cooked"` outer-joins `select(MealPlanEntry.recipe_id, func.max(MealPlanEntry.plan_date).label("last")).where(MealPlanEntry.plan_date <= date.today()).group_by(MealPlanEntry.recipe_id)` and orders by `last.desc().nulls_last()`, title, id.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/test_recipe_list.py tests/test_grocery_pricing.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/recipe_filters.py backend/app/routes/recipes.py backend/tests/test_recipe_list.py
git commit -m "Find recipes by the ingredients they use, and by when they were last cooked"
```

---

### Task 3: Search history

**Files:**
- Create: `backend/alembic/versions/20261019_<rev>_recipe_searches_are_remembered.py` (`down_revision = "a7d3e1c9b2f4"`, docstring in the style of the existing migrations)
- Modify: `backend/app/models.py` (`RecipeSearch`)
- Create: `backend/app/services/search_history.py`
- Modify: `backend/app/schemas.py`, `backend/app/routes/recipes.py`
- Test: `backend/tests/test_recipe_searches.py`

**Interfaces:**
- Produces: model `RecipeSearch`, table `recipe_searches`: `id`, `signature: str(1000) index`, `text: str(100)`, `tags: JSON list[str]`, `ingredients: JSON list[str]` (keys), `on_sale: bool`, `searched_at: datetime tz index`.
- Produces: schemas `SearchIn {text: str = Field("", max_length=100); tags: list[TagName] (max 20); ingredients: list[str] (max 20); on_sale: bool = False}`, `IngredientName {key: str; name: str}`, `RecentSearch {signature: str; text: str; tags: list[str]; ingredients: list[IngredientName]; on_sale: bool}`.
- Produces in `search_history.py`: `HISTORY_DAYS = 60`; `def signature(search: SearchIn, identity: Identity) -> str`; `async def record(session, search: SearchIn) -> None`; `async def recent(session, limit: int) -> list[RecentSearch]`; `async def forget(session, signature: str) -> None`; `async def tag_frequency(session) -> Counter[str]`.
- Produces routes: `POST /api/recipes/searches` (204), `GET /api/recipes/searches?limit=5` (`1 <= limit <= 8`), `DELETE /api/recipes/searches?signature=...` (204). All declared above `/{recipe_id}`.
- Produces: `async def ingredient_names(session) -> dict[str, str]` - today's `pricing._ingredient_names`, made public and moved to `app/services/recipe_filters.py`; `pricing` imports it from there.

- [ ] **Step 1: Write the failing tests**

```python
async def test_a_recorded_search_comes_back_as_recent(client): ...
async def test_the_same_search_twice_is_listed_once_at_the_top(client): ...
    # record A, B, A -> recent == [A, B]; tag order and case do not make a different search
async def test_an_empty_search_is_not_recorded(client): ...
async def test_forgetting_a_search_removes_every_time_it_was_made(client): ...
async def test_text_is_kept_exactly_as_typed(client): ...
    # text '100% "egg roll"' round-trips unchanged
async def test_recent_names_ingredients_and_follows_merges(client): ...
    # record ingredients=["ground-cumin"], then merge it into "cumin" -> recent ingredient key "cumin", name "cumin"
async def test_searches_older_than_sixty_days_are_dropped(client): ...
    # insert a row dated 61 days ago directly; record a new one -> the old row is gone, and recent omits it
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_recipe_searches.py -q`
Expected: FAIL (404 on the routes).

- [ ] **Step 3: Write the migration and the model**

- [ ] **Step 4: Implement the service and routes**

`signature` is JSON of `{"text": text.strip().casefold(), "tags": sorted(set(lowercased)), "ingredients": sorted(set(resolved keys)), "on_sale": bool}` with `sort_keys=True`.
`record` stores the text stripped but otherwise as typed, ignores an empty search, and deletes rows older than `HISTORY_DAYS` in the same transaction.
`recent` takes the newest row per signature, newest first; ingredient names come from `ingredient_names`, falling back to the key with dashes as spaces.
`tag_frequency` counts, over rows inside the window, one per row for each tag the row holds.

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest tests/test_recipe_searches.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/alembic/versions backend/app/models.py backend/app/services/search_history.py backend/app/services/recipe_filters.py backend/app/services/kroger/pricing.py backend/app/schemas.py backend/app/routes/recipes.py backend/tests/test_recipe_searches.py
git commit -m "Remember the searches a recipe was opened from"
```

---

### Task 4: Facets and typed suggestions

**Files:**
- Modify: `backend/app/schemas.py`, `backend/app/routes/recipes.py`
- Test: `backend/tests/test_recipe_list.py` (facets, suggest)

**Interfaces:**
- Consumes: `sale_percentages` (Task 1), `recipes_using`/`intersect`/`ingredient_names` (Tasks 2-3), `tag_frequency` (Task 3).
- Produces: `RecipeFacets {tags: list[TagCount]; on_sale: int | None; ingredients: list[IngredientName]}` from `GET /api/recipes/facets` taking the list's filters (`q`, `tag`, `ingredient`, `on_sale`).
  - `tags`: every tag with its count within the filters, ordered by `tag_frequency` desc, then count desc, then name.
  - `on_sale`: how many recipes within the filters are on sale; `None` when pricing is off or there is no store.
  - `ingredients`: a display name for each requested ingredient key.
- Produces: `SearchSuggestions {ingredients: list[IngredientSuggestion]; tags: list[TagCount]; recipes: list[RecipeRef]}`, `IngredientSuggestion {key: str; name: str; count: int}`, from `GET /api/recipes/suggest?text=...` plus the list's filters.
  - Up to 5 per group, case-insensitive substring match on the name; counts within the filters; zero counts and items already in the filters left out; ingredients and tags ordered by count desc then name; recipes A-Z.
- The existing `GET /api/recipes/tags` stays as it is (the recipe form uses it).

- [ ] **Step 1: Write the failing tests**

```python
async def test_facets_count_tags_within_the_filters(client): ...
async def test_facets_put_the_most_searched_tags_first(client): ...
    # record searches tag "mexican" x3, "dinner" x1; dinner has more recipes -> order starts ["mexican", "dinner", ...]
async def test_facets_fall_back_to_the_biggest_tags_without_history(client): ...
async def test_facets_say_nothing_about_sales_without_a_store(client): ...   # on_sale is None
async def test_facets_name_the_ingredients_asked_for(client): ...
async def test_suggestions_group_ingredients_tags_and_recipes(client): ...
    # text="chi": ingredients [chicken thighs, chili powder], tags [chinese], recipes [Chicken Fried Rice]
async def test_suggestions_count_within_the_current_filters_and_drop_dead_ends(client): ...
async def test_suggestions_leave_out_what_is_already_picked(client): ...
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/test_recipe_list.py -q -k "facets or suggestions"`
Expected: FAIL (404).

- [ ] **Step 3: Implement both routes**

Factor the filter-to-ids step shared by `list_recipes`, `facets` and `suggest` into one helper in `routes/recipes.py`, so the three cannot disagree about what a filter means.

- [ ] **Step 4: Run all backend tests**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas.py backend/app/routes/recipes.py backend/tests/test_recipe_list.py
git commit -m "Count the filters a recipe search could add, and suggest them as it is typed"
```

---

### Task 5: Remove the recipe suggestions endpoint

**Files:**
- Modify: `backend/app/routes/recipes.py`, `backend/app/schemas.py`, `backend/app/services/kroger/costing.py`, `backend/app/services/kroger/pricing.py`
- Test: `backend/tests/test_grocery_pricing.py`

**Interfaces:**
- Removes: `GET /api/recipes/suggestions`, `costing.suggestions`, `pricing.recipes_on_sale`, `pricing._discounted` if nothing else uses it, `PANTRY_SHARE`, `SUGGESTION_LIMIT`, and schemas `Suggestions`, `CheapRecipe`, `PantryRecipe`, `RecipeOnSale`, `SaleItem`.

- [ ] **Step 1: Delete the suggestions tests in `test_grocery_pricing.py`** (the `suggestions` helper and every test calling it), and add one: `test_the_old_suggestions_endpoint_is_gone` asserting `GET /api/recipes/suggestions` is not 200.
- [ ] **Step 2: Run it to see it fail** - `uv run pytest tests/test_grocery_pricing.py -q -k old_suggestions` - FAIL (200).
- [ ] **Step 3: Remove the code listed above**; `grep -rn "recipes_on_sale\|CheapRecipe\|PantryRecipe\|Suggestions\b" backend/app` returns nothing.
- [ ] **Step 4: Run** `cd backend && uv run pytest -q && uv run ruff check .` - PASS, clean.
- [ ] **Step 5: Commit** - `git commit -am "Drop the recipe suggestions the search replaces"`

---

### Task 6: Frontend API and the search model

**Files:**
- Modify: `frontend/src/api.ts`, `frontend/src/test/fixtures.ts`
- Create: `frontend/src/recipeSearch.ts`
- Test: `frontend/src/recipeSearch.test.ts`

**Interfaces:**
- Produces in `api.ts`: `RecipeSort = "title" | "newest" | "cooked" | "sale"`; `RecipeFilters` gains `ingredients?: readonly string[]` and `onSale?: boolean` (sent as `ingredient` and `on_sale=true`); `RecipeSummary.sale_percent: number | null`; types `IngredientName`, `RecipeFacets`, `IngredientSuggestion`, `SearchSuggestions`, `RecentSearch`, `SearchInput` mirroring Tasks 3-4; functions `recipeFacets(filters)`, `suggestRecipes(text, filters)`, `recentSearches(limit = 5)`, `recordSearch(search: SearchInput)`, `forgetSearch(signature)`. Remove `suggestions` and its types.
- Produces in `recipeSearch.ts`:
  - `interface Search { text: string; tags: string[]; ingredients: IngredientName[]; onSale: boolean }`, `EMPTY_SEARCH`.
  - `type Token = { kind: "tag"; name: string } | { kind: "ingredient"; key: string; name: string } | { kind: "sale" } | { kind: "text"; text: string }`.
  - `tokensOf(s: Search): Token[]` - order: tags, ingredients, on sale, text.
  - `without(s: Search, t: Token): Search`; `isEmpty(s: Search): boolean`.
  - `describe(s: Search): string` - tokens joined by `" · "`, ingredients prefixed `"🥕 "`, on sale as `"on sale"`, text in curly quotes.
  - `searchFromParams(p: URLSearchParams): Search` - `q`, repeated `tag`, repeated `ing` (key; name = key with dashes as spaces until facets supply one), `sale=1`.
  - `sortFromParams(p): RecipeSort` (unknown -> `"title"`), `writeParams(s: Search, sort: RecipeSort, p: URLSearchParams): URLSearchParams` (omits defaults).
  - `toFilters(s: Search, draft = ""): RecipeFilters` - `q` is the text token if there is one, else the trimmed draft.
  - `toInput(s: Search): SearchInput`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads an old bookmark's q and tag as a text token and a tag", () => {
  const s = searchFromParams(new URLSearchParams("q=curry&tag=dinner"));
  expect(tokensOf(s)).toEqual([{ kind: "tag", name: "dinner" }, { kind: "text", text: "curry" }]);
});
it("round-trips every token through the URL", ...);       // tags, ing, sale, q, sort=sale
it("leaves defaults out of the URL", ...);                  // EMPTY_SEARCH + "title" -> ""
it("describes a search the way recent searches show it", () => {
  expect(describe({ text: "egg roll", tags: ["blackstone"], ingredients: [{ key: "ground-beef", name: "ground beef" }], onSale: true }))
    .toBe("blackstone · 🥕 ground beef · on sale · “egg roll”");
});
it("filters on the draft only while there is no text token", ...);
it("keeps text with wildcards and quotes exactly", ...);    // q='100% "x"' round-trips
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/recipeSearch.test.ts` - FAIL (module missing).
- [ ] **Step 3: Implement `api.ts` changes and `recipeSearch.ts`**; `fixtures.ts` `recipeSummary` defaults `sale_percent: null`, and gains `recipeFacets(overrides)`.
- [ ] **Step 4: Run** the test file and `npx tsc -b` - PASS, no type errors outside `RecipesPage.tsx` and its test (rewritten in Task 9; leave them compiling by keeping `api.suggestions` until then if needed, and delete it in Task 9).
- [ ] **Step 5: Commit** - `git commit -m "Model a recipe search as tokens that live in the URL"`

---

### Task 7: The search box

**Files:**
- Create: `frontend/src/components/RecipeSearchBox.tsx`
- Test: `frontend/src/components/RecipeSearchBox.test.tsx`
- Modify: `frontend/src/styles.css` (search box and dropdown, tokens only, light and dark)

**Interfaces:**
- Consumes: `Search`, `Token`, `tokensOf`, `without`, `toFilters`, `describe` (Task 6); `api.recentSearches`, `api.suggestRecipes`, `api.forgetSearch`.
- Produces: `RecipeSearchBox(props: { search: Search; onChange: (s: Search) => void; draft: string; onDraft: (text: string) => void; onOpenRecipe: (id: number) => void })`.
  - Empty draft and focused: "Recent searches" (newest first, each with a ✕ "Forget" button), or the no-history message; footer "Start typing for ingredients, tags and recipes". Choosing one calls `onChange` with it.
  - Non-empty draft: groups **Ingredient**, **Tag**, **Recipe** from `api.suggestRecipes(draft, toFilters(search))`, debounced with `useDebounced`; matched substring wrapped in `<mark>`; counts shown; last row `Search for “{draft}”`.
  - Choosing an ingredient or tag adds the token and clears the draft; choosing a recipe calls `onOpenRecipe`; Enter with nothing highlighted, or the last row, sets the text token to the draft (replacing any existing one) and clears the draft.
  - Each token has a ✕ button named "Remove {label}"; "Clear" empties the search and draft; Backspace in an empty draft removes the last token; Escape closes the dropdown.
  - ARIA: the input is a `combobox` with `aria-expanded`/`aria-activedescendant` over a `listbox`, following `TagInput.tsx`.

- [ ] **Step 1: Write the failing tests** (mocked backend via `mockBackend`)

```ts
it("shows recent searches when the empty box is focused", ...);
it("forgets a recent search with its ✕", ...);          // DELETE /api/recipes/searches?signature=...
it("switches to grouped suggestions as you type", ...); // headings Ingredient, Tag, Recipe in that order
it("adds a picked ingredient as a token and clears the typing", ...);
it("turns typed text into one text token on Enter, replacing an earlier one", ...);
it("opens a recipe picked from the suggestions", ...);
it("moves through suggestions with the arrow keys", ...);
it("removes the last token with Backspace on an empty box", ...);
```

- [ ] **Step 2: Run** `npx vitest run src/components/RecipeSearchBox.test.tsx` - FAIL.
- [ ] **Step 3: Implement the component and its styles.**
- [ ] **Step 4: Run** the test file - PASS.
- [ ] **Step 5: Commit** - `git commit -m "A recipe search box that takes ingredients, tags and text as tokens"`

---

### Task 8: The quick row

**Files:**
- Create: `frontend/src/components/QuickRow.tsx`
- Test: `frontend/src/components/QuickRow.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `chipsThatFit` from `chipFit.ts`; `TagCount`.
- Produces: `QuickRow(props: { tags: TagCount[]; onSale: number | null; saleSelected: boolean; onPickTag: (name: string) => void; onPickSale: () => void })`.
  - `tags` arrive in quick-row order and already exclude picked tags; the row shows at most `QUICK_TAGS = 4` with a count above zero.
  - Then a divider, then the **On sale** chip with its count when `onSale` is a number, not picked, and above zero; then an **All tags ▾** button (`aria-expanded`).
  - All tags opens a panel listing every tag in `tags` alphabetically with counts; a zero-count tag is disabled; picking one calls `onPickTag` and closes the panel.
  - Fitting: measure the tag chips and the tail (sale chip + All tags) in a layout effect, then `kept = chipsThatFit({ widths, total: widths.length, plus: 0, gap, room: rowWidth - tailWidth - gap })`; re-measure on resize via `ResizeObserver` (absent under jsdom: keep every candidate).
  - Under the phone breakpoint already used in `styles.css`, chip counts are hidden by CSS.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows up to four tags, then On sale, then All tags", ...);
it("leaves On sale out when sales are unknown or none", ...);   // onSale null and 0
it("lists every tag alphabetically under All tags and picks one", ...);
it("keeps On sale and All tags when only one tag fits", ...);    // stub offsetWidth/clientWidth so only 1 fits
```

- [ ] **Step 2: Run** `npx vitest run src/components/QuickRow.test.tsx` - FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** - `git commit -m "A row of the most-searched tags that fits its line"`

---

### Task 9: The Recipes page

**Files:**
- Modify: `frontend/src/pages/RecipesPage.tsx` (rewrite the top; remove `TagFilter`, `SuggestionPanels`, `NeedsALook` and their helpers)
- Modify: `frontend/src/pages/RecipesPage.test.tsx`, `frontend/src/pages/RecipeDetailPage.test.tsx`, `frontend/src/pages/GroceryPricing.test.tsx` (drop `/api/recipes/suggestions` routes)
- Modify: `frontend/src/styles.css` (sale ribbon, result line, sort; remove `.offers-section`, `.offer*`, `.tag-filter*` rules no longer used anywhere)

**Interfaces:**
- Consumes: everything from Tasks 6-8; `api.listRecipes`, `api.recipeFacets`, `api.recordSearch`.
- Produces: the page described in spec sections 1-7.
  - Layout: header (unchanged), then a row holding `RecipeSearchBox` and the sort `<select>` labelled "Sort" (desktop), then `QuickRow`, then the result line (`"{n} recipes"` or `"{n} recipes · {describe(search)}"`, plus the sort `<select>` on a phone), then the grid and Load more.
  - Sort options in Global Constraints order; `Biggest sale` only when `facets.on_sale !== null`.
  - Ingredient token names are taken from `facets.ingredients` once it answers.
  - Card: `RecipePhoto` inside a `.photo-wrap` holding `<span className="sale-ribbon">{n}% off</span>` when `sale_percent !== null`; no price.
  - History: clicking a card (or `onOpenRecipe` from the box) with a non-empty search calls `api.recordSearch(toInput(search))` without awaiting it, then navigates.
  - Empty results: `"No recipes match {describe(search)}."`; for each token, `api.listRecipes({ ...toFilters(without(search, token)), per_page: 1 })`; offer the first removal (in `tokensOf` order) whose total is above zero as a button `Remove “{label}” to see {n}`; if none, a Clear button.
  - The URL is written with `writeParams`, replacing history entries as today.

- [ ] **Step 1: Rewrite the failing page tests** in `RecipesPage.test.tsx` (keep the paging and load-more tests; replace tag-pill and suggestions tests)

```ts
it("starts the recipes right under the search controls", ...);  // no "On sale this week", "Needs a look", "Under" headings
it("filters by a tag picked from the quick row", ...);           // GET /api/recipes?tag=dinner
it("adds On sale from the quick row and sorts by biggest sale", ...);
it("hides Biggest sale when pricing is off", ...);
it("shows a sale ribbon on a recipe on sale and nothing on the rest", ...);
it("opens an old bookmark with its search in the box", ...);    // /recipes?q=curry&tag=dinner
it("records the search when a recipe is opened from it", ...);  // POST /api/recipes/searches body
it("does not record anything when no search is applied", ...);
it("offers the removal that brings results back", ...);         // "Remove “on sale” to see 1"
it("names ingredient tokens from the facets", ...);
```

- [ ] **Step 2: Run** `npx vitest run src/pages/RecipesPage.test.tsx` - FAIL.
- [ ] **Step 3: Implement the page, styles and removals**; delete `api.suggestions` and its types if Task 6 kept them.
- [ ] **Step 4: Run the whole frontend suite, lint and build**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: all pass, `check-tokens: ok`.

- [ ] **Step 5: Commit** - `git commit -m "Put the recipes right under one search box"`

---

### Task 10: Needs a look, by recipe, on the Ingredients page

**Files:**
- Create: `frontend/src/components/RecipeAttentionList.tsx` (moved from `RecipesPage.tsx`: `attentionLines`, `heldUp`, `AttentionGroup`, `HOLDS`)
- Modify: `frontend/src/pages/IngredientsPage.tsx`
- Test: `frontend/src/pages/IngredientsPage.test.tsx`

**Interfaces:**
- Consumes: `api.recipesAttention`, `RecipeAttention`.
- Produces: `RecipeAttentionList({ entries }: { entries: RecipeAttention[] })` - the same markup the Recipes page rendered inside its fold, without the fold or the "See it ingredient by ingredient" link.
- Produces on the Needs a look tab: a `Segmented` labelled "Group" with **By recipe** and **By ingredient**, remembered per device under `localStorage` key `ingredients-look-by` (default `"ingredient"`, so the tab opens as it does today). By recipe loads `api.recipesAttention()` and filters entries by the page's search box (recipe title or line name).

- [ ] **Step 1: Write the failing tests**

```ts
it("lists what needs a look by recipe, each line linking to its fix", ...);
it("remembers By recipe on this device", ...);
it("narrows the by-recipe list with the search box", ...);
it("says nothing needs a look when no recipe has a problem", ...);
```

- [ ] **Step 2: Run** `npx vitest run src/pages/IngredientsPage.test.tsx` - FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd frontend && npm test && npm run lint` - PASS.
- [ ] **Step 5: Commit** - `git commit -m "Show what needs a look recipe by recipe on the Ingredients page"`

---

### Task 11: End to end in a real browser

**Files:** none committed unless a defect is found (fix it with a test in the owning task's files).

- [ ] **Step 1: Run the app against a scratch database and the fake Kroger** (see the "E2E with a fake Kroger" memory: scratch sqlite, fake Kroger on :8765 with some products on promo, `client.API_BASE` patched; seed ~10 recipes with tags, a meal plan in the past, and one grocery-list fetch so picks exist).
- [ ] **Step 2: Check, with Playwright screenshots, in light and dark, at 1280px and 375px:**
  - recipes start directly under the quick row; no fold-out sections;
  - focus the empty box -> recent searches; type "chi" -> grouped suggestions; pick, Enter, Backspace, Clear;
  - quick row at 375px: no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), On sale and All tags visible;
  - ribbons legible on photos and on the placeholder; sort menu works for all four;
  - empty state offers the right removal; Ingredients -> Needs a look -> By recipe.
- [ ] **Step 3: Fix anything that looks off**, with a test where behaviour was wrong.
- [ ] **Step 4: Run every suite and lint once more**

Run: `cd backend && uv run pytest -q && uv run ruff check . && cd ../frontend && npm test && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 5: Merge** `recipes-page-search` into `main` after review, then delete the branch.
