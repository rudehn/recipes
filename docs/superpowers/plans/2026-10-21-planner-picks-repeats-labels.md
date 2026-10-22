# Planner Picks, Repeats and Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner fill a week by choosing recipes into a Picks panel and placing them by drag or click, set meals to repeat on chosen weekdays, and mark meals with owner-made labels they can filter by.

**Architecture:** One backend service, `services/plan.py`, answers "what is planned between these dates" by merging one-off rows (`meal_plan_entries`) with repeats (`meal_repeats`) expanded on read, minus skipped days.
The planner, the grocery list, the plan cost and "Recently cooked" all read through it.
A "Just this day" change to a repeat is stored as a skip plus, when the day still has a meal, an ordinary entry linked back to the repeat (`from_repeat_id`); "From this day on" ends the repeat the day before and starts a new one, deleting the old one's skips and linked entries from that day on.
The frontend splits `PlannerPage.tsx` into `components/planner/`, adds the Picks panel, label UI and repeat UI, and uses native HTML5 drag and drop with click to place as the equal path.

**Tech Stack:** FastAPI, SQLAlchemy 2 (async), Alembic, pytest; React 18, React Router, TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-planner-picks-repeats-labels-design.md`

## Global Constraints

- The word is **label** everywhere, in UI copy and code, for the planner's markers. **Tag** stays the recipe's search tag. Never mix them.
- No built-in labels. An unlabelled meal shows nothing extra.
- Label names: trimmed, 1 to 40 characters, unique ignoring case (stored `key` is the casefolded name).
- Weekdays travel as `list[int]`, 0 = Monday ... 6 = Sunday (Python `date.weekday()`), stored as a bitmask (Monday = bit 0).
- "Today" is the owner's: every endpoint that judges past against future takes a `today: date` from the client (`toISODate(new Date())`), as `GET /api/recipes?sort=cooked` already does.
- Past days never change through a repeat. "From this day on", changing days, stopping and starting a repeat are refused with 422 for a day before `today`. "Just this day" works on any day.
- "From this day on" replaces every "Just this day" change of that repeat on or after its day (removed days come back, day-only servings and labels are dropped). A day dragged elsewhere is an unlinked one-off and is never touched.
- The scope question (Just this day / From this day on) is asked once per edit, never per tap or per checkbox. One-off meals never ask.
- Repeat menu choices, in this order and with this copy: `Just this day`, `Every <Weekday>` (e.g. `Every Tuesday`), `Weekdays`, `Every day`, `Custom…`. On a repeated meal the days choices say `… from <Wed, Oct 28> on`.
- The filter: chips `Everything` then each label, single choice, URL param `label=<id>`; checkbox `Include unlabelled meals`, default on, URL `unlabelled=0` when off. Costs and the Grocery list link ignore the filter.
- Picks belong to a week, keyed by its Monday; they do not carry over.
- Copy uses the plain hyphen "-", never an em dash.
- SQLite in tests does not enforce foreign keys: delete dependent rows (skips, label links, linked entries, picks) explicitly in code, and also declare `ondelete="CASCADE"` for Postgres.
- Commit messages carry no co-author line. Work on a branch `planner-picks-repeats-labels`, merged to `main` at the end.
- Backend tests: `cd backend && uv run pytest <file> -q`. Frontend tests: `cd frontend && npx vitest run <file>`. Lint: `cd backend && uv run ruff check .` and `cd frontend && npm run lint`. Types: `cd frontend && npx tsc -b`.

## Review Focus

1. **A repeat seen across a week boundary and in a range that starts mid-repeat** (`start` on a Thursday, repeat started the previous Tuesday): occurrences appear only on matching weekdays inside both the repeat's span and the range; pinned in Task 2.
2. **Deleting a recipe that is in a repeat, an override, a pick or a labelled meal**: the planner, grocery list and cost still load, with no orphan rows answering; pinned in Task 2 (repeats), Task 4 (labels) and Task 5 (picks).
3. **Two "From this day on" changes on the same repeat, the second on a day before the first's split** (e.g. split on Fri, then change from Wed): the Wed change covers both halves from Wed on, and nothing before Wed moves; pinned in Task 3.
4. **The phone's "opens at today" on a week that is not the current one, and on a reload with a label filter in the URL**: other weeks open at Monday; the filter survives the reload; pinned in Tasks 6 and 8.
5. **A drag dropped outside any cell, or on the cell it started in**: nothing is written and nothing changes; pinned in Task 11.

---

### Task 1: One read path for planned meals

Every consumer reads planned meals through one function, and the API answers with a stable `key` per meal, before any repeat exists.

**Files:**
- Create: `backend/app/services/plan.py`
- Modify: `backend/app/schemas.py` (`MealPlanEntryOut` -> `PlannedMealOut`, `EntryCost.entry_id` -> `EntryCost.key`)
- Modify: `backend/app/routes/meal_plan.py` (`list_entries`, `create_entry`, `update_entry`)
- Modify: `backend/app/services/grocery.py` (`build_grocery_list`, `scale_factor`)
- Modify: `backend/app/services/kroger/costing.py` (`plan_cost`)
- Modify: `backend/app/routes/recipes.py` (the `cooked` sort)
- Modify: `frontend/src/api.ts`, `frontend/src/test/fixtures.ts`, `frontend/src/pages/PlannerPage.tsx`, `frontend/src/pages/PlannerPage.test.tsx`
- Test: `backend/tests/test_plan_reads.py` (new)

**Interfaces:**
- Produces, in `services/plan.py`:
  - `@dataclass(frozen=True) class PlannedMeal: key: str; plan_date: date; meal: str; recipe: Recipe; servings: int | None; entry_id: int | None` (Task 2 adds `repeat`, Task 4 adds `labels`).
  - `async def planned_meals(session: AsyncSession, start: date, end: date) -> list[PlannedMeal]`, ordered by `plan_date`, then entry id.
  - `async def last_planned(session: AsyncSession, today: date) -> dict[int, date]`: recipe id to its latest planned date on or before `today`.
  - Keys: `f"e{entry_id}"` for a row, `f"r{repeat_id}-{iso_date}"` for a repeat's day (Task 2).
- Produces: `PlannedMealOut {key: str, entry_id: int | None, plan_date: date, meal: Meal, servings: int | None, recipe: RecipeSummary}`; `EntryCost.key: str`.
- Produces: `def scale_factor(meal: Scaled) -> float` where `class Scaled(Protocol): servings: int | None; recipe: Recipe`.
- Produces (frontend): `interface PlannedMeal` mirroring `PlannedMealOut`; fixture `plannedMeal(overrides)` replacing `mealPlanEntry`; `EntryCost.key: string`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_planned_meals_carry_a_key_named_after_their_row(client):
    recipe = await make_recipe(client, "Tacos", [])
    entry = await plan(client, "2026-07-20", "dinner", recipe["id"])
    assert entry["key"] == f"e{entry['entry_id']}"
    listed = (await client.get("/api/meal-plan", params=WEEK)).json()
    assert [(m["key"], m["entry_id"]) for m in listed] == [(entry["key"], entry["entry_id"])]

async def test_plan_cost_names_each_meal_by_its_key(client, catalog):
    # Uses the catalog fixture pattern from test_grocery_pricing.py.
    ...
    assert [e["key"] for e in cost["entries"]] == [entry["key"]]

async def test_recently_cooked_reads_through_the_plan_service(client):
    # The same expectations as test_recipe_list.py::test_recently_cooked_puts_the_latest_past_plan_first,
    # asserted against plan.last_planned directly:
    assert await last_planned(session, date(2026, 7, 22)) == {mango_id: date(2026, 7, 22), beans_id: date(2026, 7, 1)}
```

Existing tests in `test_meal_plan_and_grocery.py`, `test_tags_and_copy_week.py`, `test_recipe_list.py` and `test_grocery_pricing.py` that read `entry["id"]` or `entry_id` switch to `entry["entry_id"]` and `key`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_plan_reads.py -q`
Expected: FAIL (`key` missing, `app.services.plan` not found)

- [ ] **Step 3: Implement `services/plan.py` and route every reader through it**

`build_grocery_list` and `plan_cost` iterate `planned_meals(...)` instead of querying `MealPlanEntry`; `plan_cost` keys `EntryCost` by `meal.key` and groups days by `meal.plan_date`.
The `cooked` sort orders by `case(last_planned(...), value=Recipe.id, else_=None)` with nulls last, the same shape as the `sale` sort; an empty mapping skips the `case` as the sale sort does.
`create_entry` and `update_entry` answer `PlannedMealOut` built from the row.

- [ ] **Step 4: Move the frontend to `PlannedMeal`**

`api.listMealPlan` returns `PlannedMeal[]`; `addMealPlanEntry` and `updateMealPlanServings` return `PlannedMeal`; the planner looks costs up by `meal.key` and deletes by `meal.entry_id`.
`usePlannedServings` keys its maps by `meal.key`.
Planner tests use `plannedMeal(...)` and `EntryCost.key`.

- [ ] **Step 5: Run everything**

Run: `cd backend && uv run pytest -q && uv run ruff check .` and `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git commit -am "Read planned meals through one service, each with a key"
```

---

### Task 2: Repeats, expanded on read

**Files:**
- Modify: `backend/app/models.py` (add `MealRepeat`, `MealRepeatSkip`; `MealPlanEntry.from_repeat_id`)
- Create: `backend/alembic/versions/20261021_<rev>_meals_can_repeat.py`
- Create: `backend/app/services/repeats.py`
- Modify: `backend/app/services/plan.py`, `backend/app/schemas.py`, `backend/app/routes/meal_plan.py`, `backend/app/routes/recipes.py` (`delete_recipe`)
- Modify: `CONTEXT.md` (a **Planner** section: Repeat, One-off meal, Skip)
- Test: `backend/tests/test_repeats.py` (new)

**Interfaces:**
- Produces, in `models.py`:
  - `MealRepeat` (`meal_repeats`): `id`, `recipe_id` (FK recipes, CASCADE, indexed), `meal: str`, `weekdays: int` (bitmask), `servings: int | None`, `starts_on: date`, `ends_on: date | None` (inclusive), `created_at`.
  - `MealRepeatSkip` (`meal_repeat_skips`): `id`, `repeat_id` (FK, CASCADE), `plan_date`; unique `(repeat_id, plan_date)`.
  - `MealPlanEntry.from_repeat_id: int | None` (FK meal_repeats, CASCADE, indexed).
- Produces, in `services/repeats.py`:
  - `def to_mask(weekdays: list[int]) -> int`, `def from_mask(mask: int) -> list[int]` (sorted).
  - `def occurs_on(repeat: MealRepeat, day: date) -> bool`: within `starts_on..ends_on` and the weekday bit set (skips are the caller's).
  - `class PastDay(ValueError)`; routes turn it into 422 `"That day has passed."`.
  - `async def start_repeat(session, entry: MealPlanEntry, weekdays: list[int], today: date) -> MealRepeat`: deletes the entry and creates a repeat with its recipe, meal and servings, `starts_on = entry.plan_date`. Raises `PastDay` if `entry.plan_date < today`, `ValueError` on an empty or out-of-range weekday list.
- Produces, in `services/plan.py`: `PlannedMeal.repeat: MealRepeat | None`. A repeat's day with no override is `key=f"r{id}-{iso}"`, `entry_id=None`, servings from the repeat. A linked entry (`from_repeat_id`) is `key=f"e{id}"`, with both `entry_id` and `repeat` set. Within a day, repeats (by id) come before one-off rows (by id).
- Produces, in `schemas.py`: `RepeatOut {id: int, weekdays: list[int], starts_on: date, ends_on: date | None}`; `PlannedMealOut.repeat: RepeatOut | None`; `StartRepeat {weekdays: list[int], today: date}`.
- Produces, route: `POST /api/meal-plan/{entry_id}/repeat` body `StartRepeat` -> `RepeatOut` (201); 404 unknown entry; 422 past day or bad weekdays.

- [ ] **Step 1: Write the failing tests**

```python
async def test_a_repeat_fills_its_weekdays_in_every_week(client):
    entry = await plan(client, "2026-10-20", "breakfast", oats_id)          # a Tuesday
    await start_repeat(client, entry["entry_id"], [1, 3], today="2026-10-19")  # Tue, Thu
    days = await planned_dates(client, "2026-10-19", "2026-11-01")
    assert days == ["2026-10-20", "2026-10-22", "2026-10-27", "2026-10-29"]

async def test_a_repeat_starts_on_its_day_and_never_before(client): ...
    # range 2026-10-12..2026-10-25, repeat every day from Wed 2026-10-21 -> first date 2026-10-21

async def test_a_range_starting_mid_repeat_sees_only_its_own_days(client): ...  # Review Focus 1

async def test_a_repeat_cannot_start_on_a_past_day(client):
    resp = await start_repeat(client, past_entry_id, [0], today="2026-10-21")
    assert resp.status_code == 422

async def test_repeated_meals_are_on_the_grocery_list_and_cost_and_cooked_sort(client): ...
    # oats repeat Mon-Fri; grocery list for the week counts 5 uses of oats' ingredients;
    # sort=cooked&today=2026-10-23 puts oats first.

async def test_deleting_a_recipe_takes_its_repeats_with_it(client): ...  # Review Focus 2
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_repeats.py -q`
Expected: FAIL

- [ ] **Step 3: Model and migration**

Migration `meals_can_repeat` creates both tables, adds `meal_plan_entries.from_repeat_id` with its index (batch mode for SQLite, as earlier migrations that alter tables do), and its docstring says what the owner gains, in the style of `20261019_c4b8f2d6a1e9`.

- [ ] **Step 4: Expansion and `start_repeat`**

`planned_meals` loads repeats overlapping the range (`starts_on <= end` and `ends_on is null or ends_on >= start`) with their skips, and yields a meal for each day in the range where `occurs_on` holds and no skip exists.
`last_planned` adds, per repeat, its latest occurring non-skipped day on or before `min(today, ends_on)`: step back from there day by day until `starts_on`.
`delete_recipe` deletes the recipe's one-off entries, its repeats, their skips and their linked entries explicitly (today a deleted recipe's entries are left behind on SQLite, which does not enforce foreign keys).

- [ ] **Step 5: Run the tests and lint**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: all pass, including `test_migrations.py::test_upgrade_builds_the_schema_the_models_describe`

- [ ] **Step 6: Commit**

```bash
git commit -am "Let a planned meal repeat on chosen weekdays"
```

---

### Task 3: Changing a repeat by day or from a day on

**Files:**
- Modify: `backend/app/services/repeats.py`, `backend/app/schemas.py`, `backend/app/routes/meal_plan.py`
- Create: `docs/adr/0011-a-repeat-is-expanded-on-read-and-its-one-day-changes-are-entries.md`
- Test: `backend/tests/test_repeats.py`

**Interfaces:**
- Consumes: Task 2's models, `occurs_on`, `PastDay`.
- Produces, in `services/repeats.py` (each loads the repeat's day state first and raises `LookupError` when the repeat does not have `day`: outside its span, weekday not in it, or skipped with no linked entry):
  - `async def override_day(session, repeat, day, *, servings: int | None | Unset = UNSET, label_ids: list[int] | Unset = UNSET) -> MealPlanEntry`: the day's linked entry, created on first change (a skip for `day` plus an entry with `from_repeat_id`, the repeat's recipe, meal, servings and labels), with the given fields applied.
  - `async def remove_day(session, repeat, day) -> None`: a skip for `day`; deletes the day's linked entry.
  - `async def change_from(session, repeat, day, today, *, servings=UNSET, label_ids=UNSET, weekdays=UNSET) -> MealRepeat`: `PastDay` if `day < today`. If `day <= repeat.starts_on`, change in place; otherwise end `repeat` on `day - 1` and create a copy starting `day` with the old `ends_on` and the changes. Either way delete the original's skips and linked entries dated `>= day`.
  - `async def remove_from(session, repeat, day, today) -> None`: `PastDay` if `day < today`; ends the repeat on `day - 1` (deleting it when `day <= starts_on`), and deletes its skips and linked entries `>= day`.
  - `async def stop_after(session, repeat, day, today) -> MealPlanEntry`: `PastDay` if `day < today`; the day becomes an unlinked one-off with its current servings and labels, and the repeat is removed from `day` on.
  - `async def move_day(session, repeat, day, plan_date: date, meal: str) -> MealPlanEntry`: removes the day (`remove_day`) and creates an unlinked one-off at the target with the day's servings and labels.
  - `UNSET` sentinel and `Unset` type, so `servings=None` (reset to the recipe's count) differs from not given.
- Produces, routes (all under `/api/meal-plan/repeats/{repeat_id}/days/{day}`, 404 on `LookupError`, 422 on `PastDay`):
  - `PATCH` body `RepeatDayChange {scope: Literal["day", "from"], today: date, servings?: int | None, label_ids?: list[int], weekdays?: list[int]}` -> 204. `weekdays` with `scope="day"` is 422.
  - `DELETE ?scope=day|from&today=` -> 204.
  - `POST .../stop` body `{today}` -> `PlannedMealOut`.
  - `POST .../move` body `{plan_date, meal}` -> `PlannedMealOut`.
  - (Label ids are accepted and stored from Task 4; until then the field is absent.)

- [ ] **Step 1: Write the failing tests**

```python
async def test_the_owners_example_mon_wed_fri_from_next_wednesday(client):
    # oats every day from Mon 2026-10-26; today 2026-10-21
    await change_from(client, rid, "2026-10-28", weekdays=[0, 2, 4], today="2026-10-21")
    assert await planned_dates(client, "2026-10-26", "2026-11-01") == [
        "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-30"]
    assert await planned_dates(client, "2026-11-02", "2026-11-08") == [
        "2026-11-02", "2026-11-04", "2026-11-06"]

async def test_just_this_day_removal_leaves_the_rest(client): ...
async def test_just_this_day_servings_override_only_that_day(client): ...
    # the day's meal now has entry_id set, repeat still set, servings 3; neighbours keep the repeat's

async def test_from_this_day_on_replaces_earlier_one_day_changes(client):
    # remove Thu 10-29 (day) and set Wed 10-28 to 3 servings (day), then change_from Mon 10-26 servings=2
    # -> Thu is back, Wed has 2 servings and entry_id None

async def test_a_moved_day_stays_where_it_was_put(client):
    # move Thu 10-29 breakfast to Sat 10-31 lunch, then change_from Mon 10-26 servings=2
    # -> Sat lunch one-off keeps its servings and has repeat None; Thu breakfast is back from the repeat

async def test_two_splits_on_one_repeat(client): ...  # Review Focus 3

async def test_from_this_day_on_is_refused_for_a_past_day(client):
    assert (await change_from(client, rid, "2026-10-20", servings=2, today="2026-10-21")).status_code == 422

async def test_just_this_day_still_works_on_a_past_day(client): ...
async def test_stop_after_keeps_the_day_as_a_one_off(client): ...
async def test_removing_from_the_first_day_deletes_the_repeat(client): ...
async def test_a_day_the_repeat_does_not_have_is_404(client): ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_repeats.py -q`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement the operations and routes**

- [ ] **Step 4: Write ADR 0011**

Context: three readers needed repeated meals as planned meals, and repeats run without end. Decision: expand on read through `services/plan.py`; one-day changes are skips plus linked entries; a split ends the old repeat and starts a new one, so past days are untouched by construction. Consequences: "From this day on" deletes linked entries and skips on or after its day; a moved day is unlinked on purpose.

- [ ] **Step 5: Run the tests and lint**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git commit -am "Change a repeated meal for one day or from a day on"
```

---

### Task 4: Labels

**Files:**
- Modify: `backend/app/models.py` (`PlanLabel`, association tables `meal_plan_entry_labels`, `meal_repeat_labels`; `labels` relationships, `lazy="selectin"`)
- Create: `backend/alembic/versions/20261021_<rev>_meals_can_carry_labels.py`
- Create: `backend/app/routes/labels.py` (included in `main.py`)
- Modify: `backend/app/schemas.py`, `backend/app/services/plan.py`, `backend/app/services/repeats.py`, `backend/app/routes/meal_plan.py`
- Modify: `CONTEXT.md` (Label, with "Avoid: tag" and why)
- Test: `backend/tests/test_labels.py` (new)

**Interfaces:**
- Produces: `PlanLabel` (`plan_labels`): `id`, `name: String(40)`, `key: String(40)` unique (casefolded name).
- Produces: `LabelOut {id: int, name: str}`; `LabelUsage(LabelOut) {meals: int}` (one-off entries plus repeats carrying it, a repeat counting once); `LabelIn {name: str}` (trimmed, 1-40).
- Produces routes: `GET /api/labels` -> `list[LabelUsage]` by name; `POST /api/labels` -> `LabelOut` 201, 409 `"There is already a label called <name>."`; `PATCH /api/labels/{id}` -> `LabelOut`, same 409 against other labels (re-casing itself is fine); `DELETE /api/labels/{id}` -> 204, removing it from every meal.
- Produces: `PlannedMeal.labels: list[PlanLabel]` and `PlannedMealOut.labels: list[LabelOut]` (by name).
- Produces: `MealPlanEntryIn.label_ids: list[int] = []`; `MealPlanEntryUpdate` gains `label_ids`, `plan_date`, `meal`, applying only fields sent (`model_fields_set`; `servings: null` still resets). Unknown label ids are 422.
- Produces: `override_day`, `change_from`, `start_repeat`, `stop_after` and `move_day` carry labels across; `RepeatDayChange.label_ids` is accepted.

- [ ] **Step 1: Write the failing tests**

```python
async def test_a_label_is_made_once_whatever_its_case(client):
    assert (await client.post("/api/labels", json={"name": " Dad "})).json()["name"] == "Dad"
    assert (await client.post("/api/labels", json={"name": "dad"})).status_code == 409

async def test_a_meal_is_planned_with_labels_and_lists_them(client): ...
async def test_patch_moves_a_one_off_and_changes_only_what_is_sent(client): ...
    # PATCH {plan_date, meal} keeps servings and labels; PATCH {label_ids: []} keeps servings
async def test_label_usage_counts_one_offs_and_repeats(client): ...
async def test_deleting_a_label_takes_it_off_every_meal(client): ...
async def test_a_repeat_carries_its_labels_to_every_day_and_into_overrides(client): ...
async def test_just_this_day_labels_leave_the_rest_of_the_repeat_alone(client): ...
async def test_label_usage_forgets_the_meals_of_a_deleted_recipe(client): ...  # Review Focus 2
```

Deleting an entry, a repeat or a recipe deletes its label links explicitly.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_labels.py -q`
Expected: FAIL

- [ ] **Step 3: Implement model, migration, routes and label carrying**

- [ ] **Step 4: Run the tests and lint**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Let the owner label planned meals"
```

---

### Task 5: Picks, and Copy last week removed

**Files:**
- Modify: `backend/app/models.py` (`PlanPick`), `backend/app/schemas.py`, `backend/app/routes/meal_plan.py`, `backend/app/routes/recipes.py` (`delete_recipe` deletes its picks)
- Create: `backend/alembic/versions/20261021_<rev>_a_week_has_picks.py`
- Delete: the `/copy-week` route, `CopyWeekRequest`, `test_copy_week` (rename `test_tags_and_copy_week.py` to `test_tags.py`), `api.copyWeek`, the planner's Copy last week button and its tests
- Test: `backend/tests/test_picks.py` (new)

**Interfaces:**
- Produces: `PlanPick` (`plan_picks`): `id`, `week_start: date` (indexed), `recipe_id` (FK CASCADE), `created_at`; unique `(week_start, recipe_id)`.
- Produces: `PickOut {id: int, week_start: date, recipe: RecipeSummary}`; `PickIn {week_start: date, recipe_id: int}`.
- Produces routes (declared above `/{entry_id}`): `GET /api/meal-plan/picks?week=` -> `list[PickOut]` in the order added; `POST /api/meal-plan/picks` -> `PickOut`, 201 when new and 200 with the existing pick when already picked; `DELETE /api/meal-plan/picks/{id}` -> 204. A `week_start` that is not a Monday is 422; an unknown recipe is 404.

- [ ] **Step 1: Write the failing tests**

```python
async def test_picks_belong_to_their_week(client): ...
async def test_picking_twice_returns_the_same_pick(client): ...
async def test_a_week_must_start_on_monday(client): ...
async def test_deleting_a_recipe_drops_its_picks(client): ...  # Review Focus 2
async def test_copy_week_is_gone(client):
    assert (await client.post("/api/meal-plan/copy-week", json={})).status_code in (404, 405)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_picks.py -q`
Expected: FAIL

- [ ] **Step 3: Implement picks; remove copy-week end to end**

- [ ] **Step 4: Run everything**

Run: `cd backend && uv run pytest -q && uv run ruff check .` and `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Keep a week's picks, and drop Copy last week for repeats"
```

---

### Task 6: Split the planner page, and open the phone at today

**Files:**
- Create: `frontend/src/components/planner/` with `WeekGrid.tsx`, `DayAgenda.tsx`, `PlanCell.tsx`, `PlanFigure.tsx`, `usePlannedServings.ts`, `plan.ts`
- Modify: `frontend/src/pages/PlannerPage.tsx` (wiring only), `frontend/src/pages/PlannerPage.test.tsx`
- Test: `frontend/src/components/planner/plan.test.ts` (new)

**Interfaces:**
- Produces, in `plan.ts`: `MEALS: Meal[]`; `type Cells = Map<string, PlannedMeal[]>`; `cellKey(date: string, meal: Meal): string`; `byCell(meals: PlannedMeal[]): Cells`; `isPast(iso: string, today?: Date): boolean`.
- Produces: `DayAgenda` scrolls today's section into view on mount when the shown week contains today (`scrollIntoView({ block: "start" })`), and never otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
it("opens the phone's week at today", async () => {
  setViewportWidth(375);
  const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
  mockBackend({ "GET /api/meal-plan": [] });
  renderApp("/planner");
  await screen.findByText("Jul 27 – Aug 2, 2026");
  expect(scrolled.mock.contexts[0]).toHaveTextContent("Wed");  // today, Jul 29
});

it("opens another week at its Monday", async () => { ... expect(scrolled).not.toHaveBeenCalled(); });
```

`jsdom` has no `scrollIntoView`; stub it in `test/setup.ts` if it is not already.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/pages/PlannerPage.test.tsx`
Expected: FAIL on the two new tests

- [ ] **Step 3: Move the components out unchanged, then add the scroll**

- [ ] **Step 4: Run the planner tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass, with every existing planner test unchanged

- [ ] **Step 5: Commit**

```bash
git commit -am "Split the planner into parts, and open a phone's week at today"
```

---

### Task 7: Labels on meals, and managing them in Settings

**Files:**
- Create: `frontend/src/components/planner/MealMenu.tsx`, `frontend/src/components/planner/LabelChecklist.tsx`, `frontend/src/components/planner/LabelPills.tsx`
- Modify: `frontend/src/api.ts` (label types and calls; `updateMealPlanServings` -> `updateMealPlanEntry`), `frontend/src/components/planner/PlanCell.tsx`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/components/planner/LabelChecklist.test.tsx`, `frontend/src/pages/PlannerPage.test.tsx`, `frontend/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Produces, `api.ts`: `Label {id; name}`, `LabelUsage extends Label {meals}`; `listLabels(): LabelUsage[]`, `createLabel(name): Label`, `renameLabel(id, name): Label`, `deleteLabel(id)`; `updateMealPlanEntry(id, patch: { servings?: number | null; label_ids?: number[]; plan_date?: string; meal?: Meal }): PlannedMeal`; `addMealPlanEntry({ plan_date, meal, recipe_id, servings?, label_ids? })`; `PlannedMeal.labels: Label[]`.
- Produces: `MealMenu` - a "⋯" button on each meal (shown on hover and focus on desktop, like `.plan-add`) opening a menu with `Labels…`, `Repeat…` (wired in Task 9), `Remove`. The ✕ moves into it.
- Produces: `LabelChecklist({ labels, chosen, onDone(ids: number[]) })` - a popover of checkboxes and a `New label…` field (Enter creates and ticks); calls `onDone` once, when it closes (Escape, outside press or Done), and only if the set changed.
- Produces: Settings `Labels` panel: each label with its meal count, Rename inline, Delete with a confirm naming the count (`Delete "Dad"? It is on 12 meals.`), using the app's in-page confirm, never `window.confirm`.

- [ ] **Step 1: Write the failing tests**

```ts
it("labels a one-off meal once the checklist closes", ...)
  // tick Dad and Kids, press Escape -> one PATCH /api/meal-plan/:id with { label_ids: [dad, kids] }
it("makes a new label from the checklist and ticks it", ...)
it("shows a meal's labels after its title, and nothing for an unlabelled meal", ...)
it("renames and deletes a label in Settings, saying how many meals it is on", ...)
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Label planned meals from a checklist, and manage labels in Settings"
```

---

### Task 8: The label filter

**Files:**
- Create: `frontend/src/components/planner/LabelFilter.tsx`
- Modify: `frontend/src/components/planner/plan.ts`, `frontend/src/pages/PlannerPage.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/components/planner/plan.test.ts`, `frontend/src/pages/PlannerPage.test.tsx`

**Interfaces:**
- Produces, `plan.ts`: `interface LabelFilter { label: number | null; unlabelled: boolean }`; `filterFromParams(p: URLSearchParams): LabelFilter`; `writeFilter(f: LabelFilter, p: URLSearchParams): URLSearchParams`; `shownMeals(meals: PlannedMeal[], f: LabelFilter): { meal: PlannedMeal; dimmed: boolean }[]`.
- Produces: the page passes `label_ids: [filter.label]` on every add while a label is selected (picker, Task 10 placing, Task 11 drops).

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the chosen label's meals, dims unlabelled ones and hides the rest", () => {
  expect(shownMeals([dad, mom, none], { label: DAD, unlabelled: true }))
    .toEqual([{ meal: dad, dimmed: false }, { meal: none, dimmed: true }]);
  expect(shownMeals([dad, mom, none], { label: DAD, unlabelled: false }))
    .toEqual([{ meal: dad, dimmed: false }]);
});
it("keeps the filter in the URL across a reload", ...)            // Review Focus 4
it("labels a meal added while a label is selected", ...)
it("leaves the costs and the Grocery list link on the whole plan", ...)
it("shows no filter row until a label exists", ...)
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Filter the planner by label, and label what is added under one"
```

---

### Task 9: Repeating meals in the planner

**Files:**
- Create: `frontend/src/components/planner/RepeatMenu.tsx`, `frontend/src/components/planner/ScopePrompt.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/components/planner/PlanCell.tsx`, `frontend/src/components/planner/MealMenu.tsx`, `frontend/src/components/planner/usePlannedServings.ts`, `frontend/src/pages/PlannerPage.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/components/planner/RepeatMenu.test.tsx`, `frontend/src/pages/PlannerPage.test.tsx`

**Interfaces:**
- Produces, `api.ts`: `Repeat {id; weekdays: number[]; starts_on; ends_on}`; `PlannedMeal.repeat: Repeat | null`; `type Scope = "day" | "from"`; `startRepeat(entryId, weekdays)`, `changeRepeatDay(repeatId, day, change: { scope; servings?; label_ids?; weekdays? })`, `removeRepeatDay(repeatId, day, scope)`, `stopRepeat(repeatId, day): PlannedMeal`, `moveRepeatDay(repeatId, day, plan_date, meal): PlannedMeal`. Each sends `today: toISODate(new Date())` where the endpoint takes it.
- Produces: `RepeatMenu({ day, current: number[] | null, past, onChoose(weekdays: number[] | null) })`; `null` is `Just this day`. `Custom…` opens seven weekday toggles and a Save. Every choice in this menu applies from its day on (including `Just this day` on a repeated meal, which is `stopRepeat`), so on a past day the `Repeat…` item is disabled with the title `That day has passed`.
- Produces: `ScopePrompt({ day, onChoose(scope: Scope), onCancel })` - two buttons, `Just this day` and `From <Wed, Oct 28> on`; the second is absent on a past day.
- Produces: `usePlannedServings` for a repeated meal collects taps, shows the count at once, and after 800 ms with no tap shows the `ScopePrompt` under the meal; the choice sends one write (`override_day` via `changeRepeatDay` scope `day`, or `from`); Cancel puts the count back.
- Produces: a repeated meal renders with class `repeated`, a `↻` before the title (`aria-label="Repeats"`), and lighter styling.

- [ ] **Step 1: Write the failing tests**

```ts
it("turns a one-off into a repeat from its menu", ...)        // Every Wednesday -> POST /api/meal-plan/:id/repeat { weekdays: [2] }
it("offers the weekday of the meal's own day", ...)           // a Tuesday meal shows "Every Tuesday"
it("changes a repeat's days from that day on without asking", ...)
it("asks once whether removing a repeated meal is for the day or from it on", ...)
it("asks once after a burst of servings taps on a repeated meal", ...)  // 3 taps -> one PATCH with servings
it("does not offer From this day on for a past day", ...)
it("marks a repeated meal and leaves a one-off plain", ...)
it("no longer has a Copy last week button", ...)
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Repeat a planned meal, and ask once whether a change is for a day or from it on"
```

---

### Task 10: The Picks panel and click to place

**Files:**
- Create: `frontend/src/components/planner/PicksPanel.tsx`, `frontend/src/components/planner/placing.ts`
- Modify: `frontend/src/api.ts`, `frontend/src/components/RecipeBits.tsx` (`RecipePickerModal` uses `RecipeSearchBox`), `frontend/src/pages/PlannerPage.tsx`, `frontend/src/components/planner/WeekGrid.tsx`, `frontend/src/components/planner/PlanCell.tsx`, `frontend/src/layout.ts`, `frontend/src/styles.css`
- Test: `frontend/src/components/planner/PicksPanel.test.tsx`, `frontend/src/pages/PlannerPage.test.tsx`

**Interfaces:**
- Produces, `api.ts`: `Pick {id; week_start; recipe: RecipeSummary}`; `listPicks(week)`, `addPick(week, recipeId)`, `removePick(id)`.
- Produces, `placing.ts`: `type Placing = { kind: "recipe"; recipe: RecipeSummary } | { kind: "meal"; meal: PlannedMeal; copy: boolean }`; `function placedDays(recipeId: number, meals: PlannedMeal[]): string[]` (short weekday names, in week order).
- Produces: `PicksPanel({ week, meals, placing, onPlacing(p: Placing | null) })`. Top: `RecipeSearchBox` with its own `Search` state (not the URL), `onOpenRecipe` opening the recipe in a new tab. Under it, when the search is not empty, up to 8 results (`listRecipes` with `toFilters(search)`, `per_page: 8`) as rows with a `+` (`aria-label="Add <title> to picks"`). Then `This week's picks` with each pick's thumbnail, title, the days it is placed on (faded when placed), and an ✕ (`aria-label="Remove <title> from picks"`).
- Produces: click to place - pressing a pick or result sets `placing`; every cell gets class `drop-target` and an accessible name `Place <title> on <Wed> <dinner>`; pressing a cell adds the meal (with the filter's label) and clears `placing`; Escape or pressing the pick again clears it.
- Produces, `layout.ts`: `PICKS_PANEL = 240`; below `WEEK_GRID + PICKS_PANEL` the panel collapses to a 40px strip with a `Picks` toggle that opens it over the grid; the page never scrolls sideways.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds a search result to this week's picks", ...)
it("places a pick by pressing it and then a cell", ...)  // POST /api/meal-plan { plan_date: "2026-07-29", meal: "dinner", recipe_id }
it("fades a pick once it is on the plan and names its days", ...)
it("cancels placing with Escape", ...)
it("keeps picks per week", ...)                           // Next week asks GET /api/meal-plan/picks?week=2026-08-03
it("collapses the panel where it and the grid do not both fit", ...)
it("finds recipes in the + Add picker with the Recipes page search box", ...)
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Choose the week's picks beside the planner, and place them with a click"
```

---

### Task 11: Drag and drop

**Files:**
- Modify: `frontend/src/components/planner/placing.ts`, `PicksPanel.tsx`, `PlanCell.tsx`, `WeekGrid.tsx`, `frontend/src/pages/PlannerPage.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/pages/PlannerPage.test.tsx`

**Interfaces:**
- Consumes: `Placing` (Task 10), `updateMealPlanEntry` (Task 7), `moveRepeatDay` (Task 9).
- Produces: native HTML5 drag and drop. Picks, results and meals are `draggable`; the payload is kept in page state (set on `dragstart`, cleared on `dragend`), with `dataTransfer.setData("text/plain", title)` only so browsers start the drag.
- Produces: `dropOn(cell: { date: string; meal: Meal }, placing: Placing, altKey: boolean)` in `PlannerPage`:
  - a recipe -> `addMealPlanEntry` (with the filter's label);
  - a one-off meal -> `updateMealPlanEntry(id, { plan_date, meal })`, or with Alt a new entry with the same recipe, servings and labels;
  - a repeated meal's day -> `moveRepeatDay`, or with Alt a new one-off copy;
  - the meal's own cell, or a drop outside any cell -> nothing.
- Produces: the hovered cell gets class `drop-over`; `dropEffect` is `copy` with Alt and for recipes, `move` otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
it("plans a pick dropped on a cell", ...)              // fireEvent.dragStart(pick); fireEvent.dragOver(cell); fireEvent.drop(cell)
it("moves a one-off meal to the cell it is dropped on", ...)
it("copies a meal dropped with Alt held", ...)
it("moves only the dragged day of a repeated meal", ...)
it("does nothing for a drop on the meal's own cell or outside the grid", ...)  // Review Focus 5
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Drag picks onto the planner, and drag meals to move or copy them"
```

---

### Task 12: The phone: meal sheet and picks sheet

**Files:**
- Create: `frontend/src/components/planner/MealSheet.tsx`, `frontend/src/components/planner/PlaceSheet.tsx`
- Modify: `frontend/src/components/planner/DayAgenda.tsx`, `PlanCell.tsx`, `PicksPanel.tsx`, `LabelFilter.tsx`, `frontend/src/pages/PlannerPage.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/pages/PlannerPage.test.tsx` (inside the existing `below the width the week grid needs` block)

**Interfaces:**
- Produces: in the agenda, a meal is its title, labels and `↻` only; tapping it opens `MealSheet` (built on `Modal`, styled as a bottom sheet below `PHONE`): the title linking to the recipe, the servings stepper, a `For` row of label toggle chips plus `+ New`, `Repeat` showing the current pattern and opening `RepeatMenu`, and `Remove from <Tuesday>`. On a repeated meal, changed servings and labels are sent once, when the sheet closes, after the `ScopePrompt`.
- Produces: a `Picks` button at the top of the agenda opens `PicksPanel` in a sheet; choosing a pick opens `PlaceSheet` with seven day chips (`M T W T F S S`, today preselected in the current week) and four meal chips (`Breakfast Lunch Dinner Snack`, Dinner preselected), and a `Place` button.
- Produces: `LabelFilter` scrolls sideways within its own row on a phone; the page never does.

- [ ] **Step 1: Write the failing tests**

```ts
it("opens a meal's sheet with its servings, labels, repeat and remove", ...)
it("labels a repeated meal from the sheet with one question when it closes", ...)
it("places a pick on a day and meal from the picks sheet", ...)
it("keeps the label filter's row from widening the page at 375px", ...)
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests, lint and types**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git commit -am "Edit and place meals from sheets on a phone"
```

---

### Task 13: End-to-end check and docs

**Files:**
- Modify: `README.md` (the planner bullet: picks, repeats, labels; no Copy last week)
- Modify: `TODO.md` only if a follow-up is found (do not touch the owner's uncommitted notes otherwise)

- [ ] **Step 1: Run the app against a scratch SQLite database** (see the `run` skill; pricing optional)

- [ ] **Step 2: Walk the owner's flows in the browser, at desktop width and at 375px**

1. Search "chicken" in Picks, add two recipes, drag one to Wednesday dinner, click-place the other on Thursday.
2. Set Monday's oats to Weekdays; check next week has them Monday to Friday; on next Wednesday change to Mon / Wed / Fri, From this day on; check the days match Task 3's example.
3. Make labels Dad and Kids; filter by Dad; add a lunch; check it carries Dad and that the Grocery list link and costs did not change.
4. On the phone, check the week opens at today, a meal opens its sheet, and a pick places from the sheet.
5. Open the grocery list for the week and check the repeated meals' ingredients are on it.

Fix anything that looks off, pixel-level included, before moving on.

- [ ] **Step 3: Full suite, lint and types**

Run: `cd backend && uv run pytest -q && uv run ruff check .` and `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git commit -am "Describe picks, repeats and labels in the README"
```
