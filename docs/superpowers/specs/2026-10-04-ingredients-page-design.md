# Ingredients page

Design, approved section by section on 2026-10-04.
Replaces the Pantry tab, and takes over "Remembered products" from Settings.

## Why

The app already treats every ingredient as one thing for four purposes - the grocery line it merges into, the pantry staple that covers it, the Kroger product it is priced with, and the USDA food it is counted as - but there is no place where an ingredient is seen as one thing.
Those four are managed on three screens (Pantry, Settings, and each recipe's nutrition breakdown), and all of them depend on the exact ingredient name.

The owner's real data shows what that costs.
Thirteen recipes hold 125 ingredient lines that come to 92 distinct ingredients, and about ten of those are the same thing under two names:

- `cumin` and `ground cumin`, `flour` and `all-purpose flour`, `garlic` and `garlic clove`, `mayo` and `mayonnaise`, `bacon` and `strips bacon`, `onion` and `yellow onion`.
- The pantry's "Cumin" does not cover a recipe's "ground cumin", so a spice that is in the cupboard lands on the grocery list.
- Settings remembers a separate Kroger product for `cumin` and for `ground cumin`.

Other names are not synonyms but broken lines from older imports, and everything downstream inherits the damage:

| Stored line (quantity, unit, name) | What it should be |
| --- | --- |
| 15, oz, "can black beans, drained and rinsed" | 15 oz "black beans, drained and rinsed" |
| ⅓, cup, "all-purpose flour ((42 g))" | ⅓ cup "all-purpose flour" |
| ¼, teaspoon, "ancho chili powder**" | ¼ teaspoon "ancho chili powder" |
| 1, none, "22-ounce bag frozen waffle fries" | 22 oz "frozen waffle fries" |
| ¼, cup, "firmly packed brown sugar" | ¼ cup "brown sugar" |
| 6, none, "strips (uncooked) bacon (cut into small pieces)" | 6 strips "bacon (uncooked, cut into small pieces)" |

None of these lines kept the original text the website gave (`source_line` is empty for all of them), because they were imported before it was stored.

## Goals

- One place where each ingredient can be seen whole: the recipes that use it, whether it is a staple, the product it is priced with, and the food it is counted as.
- Merge two names for the same thing, once, so the app treats them as one everywhere - including in recipes imported later.
- Fix broken recipe lines from the ingredient's own page, and stop the importer producing them.
- Keep restocking the pantry as quick as it is today.

## Non-goals

- Ingredient amounts in the pantry ("half a jar left").
- Price history, or any new Kroger call while listing ingredients.
- Merging applied automatically.
- Per-person meal tags; that is a separate design.

## Decisions

1. The page replaces the Pantry tab, and "Remembered products" moves out of Settings into it.
2. A merge keeps each recipe's wording and changes only how the app identifies the ingredient; recipe text is never rewritten by a merge.
3. Merges are looked up wherever ingredients are compared, through one function, rather than stored on each row (approach 1 of 3).
4. The tab opens on Staples, with All and Needs a look one tap away, and remembers the last view per device.
5. Broken names are fixed line by line, by a separate Fix action, not by merging.
6. The importer learns to read the broken patterns found in the real data.

## 1. How merges work underneath

### Data

A new table, `ingredient_merges`:

| Column | Type | Notes |
| --- | --- | --- |
| `from_key` | `String(300)`, primary key | The merged-away identity, e.g. `ground-cumin`. |
| `to_key` | `String(300)`, indexed | The identity it now means, e.g. `cumin`. |
| `merged_at` | `DateTime(timezone=True)` | |

A `to_key` is never itself a `from_key`.
Merging `cumin` into something else later rewrites every row pointing at `cumin` to point at the new target in the same transaction, so a lookup is a single step and never follows a chain.
Merging a key into itself, or into a key already merged away, is refused.

### One way to identify an ingredient

A new module, `backend/app/services/identity.py`, is the only way the app compares ingredients.

- `Identity.load(session)` reads `ingredient_merges` once (one small query) and returns an immutable object.
- `identity.key(name)` is `canonical_key(name)`, then the merge lookup.
- `identity.nutrition_key(name)` is `nutrition_key`'s state words ("cooked") in front of `identity.key(name)`, so ADR 8's one exception survives a merge: merging `ground cumin` into `cumin` covers `cooked ground cumin` too, while `cooked rice` and `rice` stay two foods.
- `identity.resolve(key)` maps an already-computed key.
- `Identity.none()` applies no merges, for pure functions and tests that need none.

The object is loaded once per request and passed down, never re-read inside a loop.

These call sites move onto it:

| File | Function |
| --- | --- |
| `routes/grocery.py` | `mark_item` |
| `routes/pricing.py` | `alternatives` |
| `services/grocery.py` | `build_grocery_list` (three places, including pantry matching) |
| `services/shopping_text.py` | `read_shopping_text` |
| `services/attention.py` | `_issues` |
| `services/kroger/costing.py` | `_products_for`, `_cost_recipe`, `suggestions` (two places) |
| `services/kroger/pricing.py` | `recipes_on_sale`, `_ingredient_names` |
| `services/nutrition/facts.py` | `recipes_using`, `recipe_keys`, `count_recipe` |

`services/lint.py`'s `_key_tokens` keeps calling `canonical_key` directly, because it inspects the words of a name rather than comparing two ingredients.

A test scans `backend/app` and fails if `canonical_key(` or `nutrition_key(` is called anywhere outside `canonical.py`, `nutrition/defaults.py`, `identity.py` and `lint.py`, so nothing can quietly skip a merge.

### What a merge moves

Everything stored under the merged-away key moves to the target in the same transaction as the merge row.

| Stored under the old key | Target has none | Both have one |
| --- | --- | --- |
| Kroger product (`ingredient_product_matches`, per store) | Re-keyed to the target. | A hand pick beats an automatic one. If both are hand picks, the request says which to keep; the merge is refused without that choice. |
| Nutrition food (`ingredient_food_matches`, every state-word variant) | Re-keyed to the target. | Same rule as products. |
| Pantry staple (`pantry_items`, matched by name) | Nothing moves: the target's identity now covers the staple's name. | The two staples become one. The request says which name and stock status to keep; the other row is deleted. |
| Grocery marks (`grocery_checks`) | Re-keyed to the target. | The target's is kept. |
| Cart-sent lines (`cart_sent_lines`) | Re-keyed to the target. | The target's is kept. |

### Unmerge

Unmerging deletes the merge row and nothing else.
Everything that moved stays with the target.
The old name starts fresh: an automatic product match on its next use, and its default food if it has one.
The unmerge confirmation says so before it happens.

### ADR 10

Recorded as `docs/adr/0010-merges-are-the-owners-corrections-on-top-of-one-key.md`:

- Merges sit on top of ADR 2's single key; there is still one notion of "the same ingredient", now with the owner's corrections applied.
- A change to `canonical_key` still invalidates stored state, merges included: a merge row whose `from_key` no longer occurs is inert, and one whose `to_key` moved is repointed by the same migration that moves the rest.
- Merges are the owner's corrections and are never applied automatically.
- A short dated note is appended to ADR 2 pointing at ADR 10.

## 2. The page

### Where it lives

- An **Ingredients** tab replaces Pantry in the top nav and the phone's tab bar, with 🥕 for its glyph, at `/ingredients`.
- `/pantry` redirects to `/ingredients`, so bookmarks and the installed app's shortcuts keep working.
- Each ingredient has its own page at `/ingredients/:key`, so it can be linked to and Back works.
  A merged-away key redirects to its target's page.

### Top of the page

- The title, with "N to restock" as its subtitle when anything is out of stock.
- A search box, matching the ingredient's name and every name merged into it.
- The switcher **Staples · All · Needs a look**, each with its count, using the `Segmented` control.
  The last choice is remembered per device in `localStorage`, read and written inside `try`/`catch` so a blocked store only loses the memory.

### Staples

What Pantry is today, with two changes:

- Out-of-stock staples come first, under "To restock", and in-stock ones follow under "In stock", each group alphabetical.
- The remove control moves from the row to the ingredient's own page, since a one-tap delete with no undo sits too close to the stock switch.

The add-a-staple field and the in-stock switch stay on the list.
A name that is already a staple's ingredient is refused, by add and by rename alike, with a sentence naming that staple ("Egg is already a staple." for "Eggs", or for "Ground cumin" once it is merged into a "Cumin" staple), and the typed text stays in the field.

### All

Every ingredient that a recipe uses or that is kept as a staple, alphabetical.
Each row is the name and one muted line, e.g. "3 recipes · McCormick Ground Cumin $3.49 · counted".
A row with a problem also carries a small tag naming it.
The store part of the line is absent when pricing is off.

### Needs a look

Grouped by job, each group absent when empty:

1. Suggested merges.
2. No product at your store: an automatic match that found nothing, at the chosen store (only with pricing on).
   "Don't price this" is a decision, not a problem, and is not listed.
3. No food for nutrition: a measured line with no default food and no hand pick.
4. Recipe lines to fix: any line with a recipe-side issue from `services/lint`.

It is the ingredient-level partner of the recipe box's "Needs a look", which stays recipe by recipe.

### An ingredient's own page

- **Name** and **Also called**: the names merged into it, each with Unmerge.
- **Pantry**: a "Keep stocked" switch, and "In stock" while it is kept; "Stop keeping stocked" removes the staple.
- **At your store** (pricing on): the product with its size and price, marked "your pick" or automatic, with Change product (the existing product picker), Don't price this, and Back to automatic.
- **Nutrition**: the food it counts as, with Change food (the existing food picker, which already names the recipes a choice reaches), It doesn't count, and Back to default.
  A line with a state word is counted as a food of its own (ADR 8), so each such food its lines use ("cooked rice" beside "rice") gets a row of its own with the same three actions, acting on that food alone.
- **Used in**: each recipe and its line exactly as written ("2 tsp ground cumin" in Chili), each linking to that line on the recipe page, each with Fix (section 4).
- **Might be the same as**: suggested merges involving this ingredient.
- **Same as another ingredient…**: starts a merge (section 3).

### Display name

The staple's name if the ingredient is kept stocked, otherwise the shortest of its recipe wordings with preparation words dropped - `best_display`, the rule the grocery list already uses.

### Loading

The list is worked out on the server from recipe lines, staples, stored product picks and the bundled nutrition data.
It never searches Kroger, keeping ADR 6's rule for anything that merely lists: product details come from stored picks and one batched `products.by_ids` lookup, answered from the ten-minute price memory when warm.
If Kroger fails, rows still show whether a product is picked, without its price.
Every change on the page goes through an existing endpoint where one exists (pantry, product match, food match), so there is no second way to change the same thing.

## 3. Merging, and suggested merges

### Starting a merge

"Same as another ingredient…" opens a search over the ingredients.
Picking one proposes a direction: the more specific name merges into the more general one, or into whichever is a staple or has a hand-picked product.
A **Swap** button reverses it.

### The preview

Before anything changes, the preview says:

- **Recipes**: "Chili and Fresh Corn Salsa keep saying 'ground cumin', and shop as cumin."
- **Grocery list**: "One line, cumin, instead of two."
- **Product, food and staple**: what each side has and which survives under the rules in section 1, with a choice between the two only where section 1 requires one.
  A choice is drawn from the stored picks that need it, wherever they are: hand picks at a store other than the chosen one, or with pricing off, and foods chosen under a state word ("cooked").
  Where the preview cannot tell the two apart by what they hold, it asks whose to keep ("ground cumin's" or "cumin's"), so Merge is never left waiting on a question with no answers.
- **Merge** and Cancel.

After merging, the target's page opens with a banner, "Merged ground cumin into cumin", and an **Unmerge** button.
It is not labelled Undo, because the old name starts fresh rather than getting its old picks back.

### Suggested merges

Pairs among the ingredients in use, never applied without the owner:

- **Describing words that do not change what is bought**: the names differ only by words on a curated list, built from lint's `DESCRIPTORS` and nutrition's `HARMLESS_WORDS` (`ground cumin` and `cumin`, `lean ground beef` and `ground beef`, `yellow onion` and `onion`, `all-purpose flour` and `flour`).
- **Counting words**: `garlic cloves` and `garlic`, `strips bacon` and `bacon`, from a short list (clove, strip, slice, sprig, stalk, head).
- **Known synonyms**: a short curated list (mayo and mayonnaise, scallion and green onion, garbanzo and chickpea, powdered and confectioners' sugar).
- **Spacing**: names equal once spaces and hyphens are ignored (`corn starch` and `cornstarch`).

Each reads "Ground cumin and cumin look like the same thing to buy", with **Merge** (opens the preview) and **Not the same**.
"Not the same" is stored in a new table, `ingredient_merge_dismissals` (`key_a`, `key_b` as an ordered pair, `dismissed_at`), and that pair is never suggested again.
On the real data about ten suggestions are expected, some of them wrong to buy as one (`whole milk` and `milk`, `red onion` and `onion`); a dismissal costs one tap, which is the price of never guessing silently.

## 4. Fixing broken names

### Fix, one line at a time

- Every line under **Used in** has **Fix**; a line with a lint issue shows its reason ("amount is in the name") and its Fix is emphasised.
- Fix opens that line in place with the recipe form's quantity, unit and name fields, and shows the line as the website gave it (`source_line`) underneath when there is one.
- Save changes only that line.
  It goes through a new endpoint that edits recipe lines in place and keeps their ids, so links from the grocery list and "Needs a look" still land on them.
  Saving a whole recipe today replaces every line with new ids, which is why this cannot reuse that endpoint.
- When the corrected name is a different ingredient, the line moves there and says so: "Now shops as black beans".
  Both ingredients' pages, Needs a look and the recipe box's fold reflect it on their next load.

### Read it again

- **Read it again** runs today's importer over the line and shows the result before anything is saved.
  It reads `source_line` when there is one, and otherwise the line rebuilt from its own quantity, unit and name ("15 oz can black beans, drained and rinsed"), which is what makes it useful for the real broken lines, none of which kept their original.
- An ingredient with several lines offers "Read all N lines again", showing before and after for each and saving them together.

### The importer

`parse_ingredient_line` (in `services/recipe_import.py`) learns the patterns found in the real data, each with a test built from the real line:

1. **Footnote marks**: trailing asterisks are dropped from the name ("ancho chili powder**").
2. **Repeated measures**: a bracket that holds only an amount and a unit, optionally with "about", is dropped, and so is the bracket left empty by it ("all-purpose flour ((42 g))" becomes "all-purpose flour"; "medium yellow onion (chopped (about 1.5 cup/200 g))" becomes "medium yellow onion (chopped)").
   That is only on a line with an amount of its own, which the bracket repeats.
   On a line without one, the bracket is the only amount there is: one such bracket holding one measure becomes the amount ("Kosher salt (1 teaspoon)" becomes 1 teaspoon "Kosher salt"; "Parmesan (1/2 cup), grated" becomes ½ cup "Parmesan, grated"), and two brackets, or two measures in one, stay in the name.
3. **How it is measured**: "firmly", "loosely" or "lightly" packed after the unit is read as how to measure, not as part of the name ("firmly packed brown sugar" becomes "brown sugar").
4. **Package sizes**: a container word right after a weight or volume is dropped from the name ("15 oz can black beans" becomes 15 oz "black beans"), and a bracketed package size becomes the amount ("1 (15 oz) can black beans" becomes 15 oz "black beans"; "2 (15 oz) cans" becomes 30 oz).
   A size in the name gets the same treatment ("1 22-ounce bag frozen waffle fries" becomes 22 oz "frozen waffle fries"), and so does a size bracketed after its container ("1 can (15 ounces) black beans, drained" becomes 15 ounces "black beans, drained"; "2 cans (15 oz each) beans" becomes 30 oz).
   A line that names only its package ("1 (15 oz) can") keeps the container as its name, 15 oz "can", rather than making an ingredient of the size's unit.
   A weight can be priced against a package and weighed for nutrition, where "1 can" can be neither; ADR 8 gets a dated note, since it describes the importer dropping that size.
5. **Counted pieces**: "strip" and "slice" are read as units, and a bracket between the unit and the name moves after the name, joining a bracket already there ("6 strips (uncooked) bacon (cut into small pieces)" becomes 6 strips "bacon (uncooked, cut into small pieces)").

New imports benefit at once.
Existing lines change only when Read it again is used and confirmed.
Nothing is rewritten in bulk without being shown first.

## 5. What moves in, and how other pages link here

### From Pantry

- The Staples view takes over all of Pantry's jobs.
- `/api/pantry` stays as the API behind it.
- `PantryPage` and its tests are folded into the new page, and the README's pantry bullet is rewritten.

### From Settings

- "Remembered products" is removed.
- Settings keeps the store and the Kroger account, and gains one line: "Products you've picked are on each ingredient's page", linking to Ingredients.

### Links in

- **Grocery list**: the product panel opened by tapping a price gains "Open cumin's page".
  The line's name does not become a link, so ticking things off in the shop cannot navigate away by accident.
- **Recipe page**: the product picker and the nutrition breakdown gain the same link, and each name in the breakdown links to its ingredient.
- **Recipe box**: its "Needs a look" fold gains a link to the ingredient-level view.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/ingredients` | Every ingredient with its names, recipe count, staple, product and food status, issues and suggestion count. The views filter this on the client. |
| `GET /api/ingredients/{key}` | One ingredient with its lines, merged names, suggestions, and a food for each nutrition key its lines use; a merged-away key answers with its target and says so. |
| `GET /api/ingredients/suggestions` | Undismissed suggested merges, with the reason for each. |
| `POST /api/ingredients/suggestions/dismiss` | "Not the same" for a pair. |
| `POST /api/ingredients/merges/preview` | What merging `from_key` into `to_key` would change, and which choices it needs. |
| `POST /api/ingredients/merges` | Merge, with any choices the preview asked for. |
| `DELETE /api/ingredients/merges/{from_key}` | Unmerge. |
| `PATCH /api/recipe-ingredients` | Edit one or more recipe lines in place, by id, in one transaction. |
| `POST /api/recipe-ingredients/reread` | What the importer would make of the given lines now, without saving. |

## Testing

Backend:

- The identity module: lookups, single-step targets, state words, `Identity.none()`.
- The guard test against raw key comparisons.
- Merge and unmerge for every kind of stored state, including both conflict cases and the refusal without a required choice.
- Suggestion rules run over the 92 real ingredient keys, and dismissals.
- The list and detail endpoints, with pricing on and off, and with Kroger failing.
- Editing lines in place keeps ids and moves a line to its new ingredient.
- Each importer fix, from the real broken lines.
- The migration adding both tables, checked by `tests/test_migrations.py` and `alembic check`.

Frontend:

- The three views, the remembered switcher, search, and the staples flows carried over from `PantryPage.test.tsx`.
- The ingredient page's sections, the merge preview and its choices, Fix, and Read it again.
- The `/pantry` redirect, and the nav's new tab.

In a browser, on a copy of the real data, at phone and desktop width in light and dark:

- Merge cumin, and see one grocery line covered by the Cumin staple.
- Fix "can black beans", and see it shop as black beans.
- Choose a food, and see Chili's nutrition appear.
- Unmerge, and see the old name start fresh.

## Docs

- ADR 10, and dated notes on ADR 2 and ADR 8.
- The first `CONTEXT.md`, with the terms this introduces: ingredient, staple, merge, suggested merge.
- README: the Pantry bullet becomes an Ingredients bullet.

## Rollout

One migration adding `ingredient_merges` and `ingredient_merge_dismissals`, deployed as usual: push, wait for the image build, back up the database, pull and restart the backend and frontend.

The implementation plan splits the work into phases that each leave the app working:

1. Merges underneath: the identity module, the call sites, the guard test, merge and unmerge in the service layer, ADR 10.
2. The ingredients API.
3. The page with its three views, replacing Pantry.
4. The ingredient's own page.
5. Merging and suggestions in the UI.
6. Fixing lines, Read it again, and the importer.
7. Settings and the links in from other pages.
