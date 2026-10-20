# Recipes page: search first

Design, agreed with the owner on 2026-10-19 over a series of mockups.
Reworks the Recipes page around one search box and moves "Needs a look" to the Ingredients page.

## Why

The owner opens the Recipes page for two things: to add a recipe, or to find one they already have.
Today the recipes do not start until halfway down the screen.
Above them sit the tag bar and four fold-out sections - On sale this week, Under $X a serving, Mostly in your pantry, and Needs a look - each a list of links rather than recipes.

Each fold has a problem of its own:

- **Under $X a serving** compares every recipe against one median, so a sauce is always "cheap" next to a dinner. The owner likes the idea of cost but not this form of it.
- **On sale this week** is useful, but it is a list to read rather than a way to narrow the recipes on screen, and a single discounted onion is enough to put a dinner in it.
- **Mostly in your pantry** is not something the owner uses.
- **Needs a look** is useful, but it is upkeep work, and it sits in the place the owner goes to cook.

The owner finds recipes four ways, and wants all four to work from the top of the page:

- by an ingredient ("what uses chicken thighs?"),
- by tag ("dinners"),
- by browsing everything,
- by what is on sale, and by seeing on a recipe that it is on sale.

## Goals

- Recipes start right under the search controls, on desktop and phone.
- One search box finds recipes by ingredient, tag or title, and combines them.
- Tags stay visible without typing, and the ones shown are the ones the owner actually searches for.
- A recipe that is meaningfully on sale says so on its card, can be filtered to, and can be sorted by.
- "Needs a look" keeps all of its function, in a place meant for upkeep.

## Non-goals

- Showing a cost per serving anywhere on the Recipes page. The owner found it too noisy.
- A pantry filter on the Recipes page.
- Showing "needs a look" on recipe cards or recipe pages. Considered and deferred; see the end.
- Changing how recipes are priced, or adding any Kroger search while listing recipes.

## Anti-goals

- Anything that pushes the first row of recipes back below the fold again.
- Controls that are only reachable by swiping sideways on a phone.
- A recipe marked "on sale" because one minor ingredient is discounted.

## Decisions

1. One smart search box with tokens replaces the plain search input and the full tag bar.
2. Under the box, one row: the owner's most-searched tags, then **On sale**, then **All tags** at the end.
3. Clicking into the empty box shows recent searches; typing switches to suggestions grouped as ingredients, tags and recipes.
4. Sort menu: A-Z, Recently added, Recently cooked, Biggest sale.
5. Cards show a "N% off" ribbon on the photo when the recipe is on sale, and no price.
6. The four fold-out sections are removed from the Recipes page.
7. "Needs a look" moves to the Ingredients page's existing Needs a look tab, as a By recipe view beside the existing By ingredient view.
8. On a phone the row shows as many tags as fit, and On sale and All tags are always visible.

## 1. The page, top to bottom

1. **Header**, unchanged: "Recipes", the saved count, Find online, + New recipe.
2. **Search box**, full width, with the sort menu to its right on desktop.
3. **Quick row** of tags, On sale and All tags.
4. **Result line**, always shown: the number of recipes and what they are, e.g. "33 recipes" or "4 recipes · dinner · on sale". On a phone this line also holds the sort menu, so sort is reachable with nothing picked. *(Builder check: my call.)*
5. **Recipe grid**, with the paging the page has today.

Nothing else sits between the header and the grid.

## 2. The search box

### What it holds

The box holds **tokens** and free text.
A token is one of:

| Kind | Example | Matches recipes that |
| --- | --- | --- |
| Ingredient | 🥕 chicken thighs | use that ingredient, by its identity (merges respected), not by substring |
| Tag | dinner | carry that tag |
| On sale | on sale | are on sale by the rule in section 5 |

Tokens combine with AND, the way tags combine today.
Free text searches titles, descriptions, tags and ingredient names by substring, exactly as the `q` parameter does today.
The grid keeps filtering live as you type, debounced, as it does today.
Pressing Enter, or choosing the "Search for…" row, turns the typed text into a quoted **text token** ("egg roll"), so the box is free again for the next word and typing "ground" after it offers ingredient suggestions rather than extending the old text.
There is at most one text token; a second one replaces the first. *(Builder check: my call.)*
Each token has a ✕ to remove it, and a **Clear** control removes everything.

Choosing a recipe from the suggestions opens that recipe; it is not a token.

### Clicking into the empty box

A dropdown shows **Recent searches**, newest first, up to about five.
Each entry is a whole search (its tokens and any free text), shown as e.g. "dinner · on sale" or "blackstone · 🥕 ground beef".
Choosing one replaces the box's contents with it.
Each entry has a ✕ that forgets it.
With no history, the dropdown says that searches will appear here once a recipe is opened from one.
The dropdown ends with a hint: "Start typing for ingredients, tags and recipes".

### Typing

The dropdown switches to grouped suggestions, in this order: **Ingredient**, **Tag**, **Recipe**.
Ingredients and tags show how many recipes they would leave given the tokens already in the box.
The matched part of each suggestion is emphasised.
A last row offers to search titles and ingredients for the typed text, which is what Enter does.
Arrow keys move through the suggestions and Enter picks the highlighted one.

### Search history

A search is recorded when a recipe is **opened from its results**, not on every keystroke or token, so half-built searches do not clutter the history.
Opening a recipe from the dropdown's Recipe group while tokens are in the box counts too, with the tokens as the search.
History is stored on the server, so the owner's phone and desktop share it.

It is kept as an **event log**: every opening is its own row, holding the search's tokens and text and the time. *(Builder check: my call.)*

- **Recent searches** are the distinct searches from that log, newest first, so the same search opened again moves to the top rather than appearing twice. Forgetting one with ✕ deletes all of its rows.
- **Most-searched tags** count rows: a tag scores once for every opening whose search includes it, alone or combined ("dinner · on sale" counts toward dinner).

Old rows can be pruned past the 60-day window the quick row reads.

### The URL

The page keeps mirroring its state in the URL, as it does today, so a search can be bookmarked, shared between devices, and survives a reload.
Existing links using `?q=` and `?tag=` keep working.

## 3. The quick row

### What it shows

Left to right: up to four of the owner's **most-searched tags**, a divider, **On sale** with its count, and **All tags ▾** at the end.
Tapping a tag or On sale adds it to the box as a token.
Counts are how many recipes that pick would leave, as the tag bar computes today.

"Most-searched" means the tags that appear most often in search history over the last 60 days.
Until there is enough history, the row falls back to the tags with the most recipes.

### After something is picked

Picked items leave the row; they live in the box.
The row then offers the tags that would narrow the results further, still ordered by the owner's search frequency, with updated counts.
Tags that would leave zero recipes are not offered.
On sale stays in the row until it is picked.

### All tags

**All tags ▾** opens a panel under the row listing every tag with its count, alphabetically.
Choosing one adds it to the box and closes the panel.

### On a phone

The row stays one line and never scrolls sideways.
On sale and All tags are always shown at the end; as many tags as fit precede them, and the rest are reached through All tags.
Counts on the row's chips are dropped on a phone to make room.
This is the rule `chipFit.ts` already applies to tags on recipe cards, and should reuse it.
At 375px wide that leaves room for about two tags.

## 4. Sort

A menu offering four orders:

| Sort | Order | Notes |
| --- | --- | --- |
| A-Z | title, ascending | the default, as today |
| Recently added | created date, newest first | exists today as `newest` |
| Recently cooked | the latest meal-plan date on or before today, newest first | recipes never planned go last, A-Z |
| Biggest sale | sale percentage, highest first | recipes not on sale go last, A-Z |

The app does not record cooking itself, so "Recently cooked" reads the meal plan.
Picking the On sale token does not change the sort by itself.

## 5. What "on sale" means

A recipe is **on sale** when its current sale prices take at least **15%** off the cost of its priced ingredients:

> sale % = (regular total - sale total) / regular total, over the ingredients that have a chosen product at the selected store.

The totals are the recipe's share of each package, as `costing._cost_recipe` prices a recipe today, not whole package prices; so a discounted 5 lb bag of flour counts for the cup the recipe uses. *(Builder check: my call.)*

A recipe only qualifies when at least **80% of its ingredient lines are priced**, the same `SUGGESTION_COVERAGE` floor the cheap fold used. Without it, a recipe where only the onion has a chosen product would score the onion's discount, which is exactly the anti-goal. Recipes below the floor are simply not on sale. *(Builder check: my call.)*

The ribbon reads "N% off", rounded down to a whole percent.
Biggest sale sorts by this same figure.

It uses only products already chosen for each ingredient at the selected store, the same way the current On sale section and recipe pricing do; listing recipes never searches Kroger.
With pricing switched off, or no store selected, nothing is on sale: no ribbons, no On sale chip, and the Biggest sale sort is hidden.

The 15% threshold is a starting point and should be one constant that is easy to change.

## 6. Recipe cards

Cards are unchanged except for one addition: when the recipe is on sale, an orange pill reading "24% off" sits in the photo's top-left corner.
It must stay legible on any photo, and on the placeholder shown for recipes without one.
There is no price per serving on the card.

## 7. Empty results

When nothing matches, the page says so, naming the search the way the result line does ("No recipes match dinner · on sale · japanese"), and offers to remove the one token that would bring results back, with how many it would show ("Remove 'on sale' to see 1").
Tags have no notion of being a meal or a noun, so sentences stay generic rather than "4 dinners". *(Builder check: my call.)*
If no single removal helps, it offers Clear.

## 8. Needs a look, on the Ingredients page

The Ingredients page's Needs a look tab gains a two-way switch: **By recipe** and **By ingredient**.

- **By ingredient** is the view that exists today.
- **By recipe** is the list the Recipes page shows today, moved over without changes to its content: each recipe with its held-up lines grouped under Price and nutrition, Nutrition, and Price, each linking to its fix.

The tab's count stays as it is.
The switch remembers its last value per device, the way the tab itself does.

## 9. What is removed

From the Recipes page: the On sale this week, Under $X a serving, Mostly in your pantry and Needs a look sections, and the full tag bar.
Any server code that only those sections used (the cheap and pantry suggestions in particular) should be removed rather than left unused.

## Left to the builder

- The API shape for suggestions, history and the new filters and sorts, and where the sale figure is computed.
- How ingredient tokens are encoded in the URL, as long as old `?q=` and `?tag=` links still work.
- Keyboard and screen-reader behaviour of the box and dropdown, following the usual combobox pattern.
- How many recent searches the dropdown shows, between about three and eight.
- Exact visual styling, within the app's existing tokens and components; the mockups in `.superpowers/brainstorm/` are a guide, not a spec.

## Considered and deferred

- **Needs a look on the recipe itself**: an amber "⚠ 3 to fix" on the card and a callout on the recipe's page. The owner chose to start with the Ingredients page only.
- **Needs a look as a search filter** beside On sale.
- **Pinned tags** in the quick row, chosen by hand, instead of most-searched.
- **A filter sidebar** instead of a search box.
- **Cost per serving on cards**, and a Cheapest sort.
