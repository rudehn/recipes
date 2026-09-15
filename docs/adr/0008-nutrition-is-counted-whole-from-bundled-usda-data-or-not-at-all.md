# 8. Nutrition is counted whole from bundled USDA data, or not at all

Accepted, September 2026.

## Context

Recipes should show calories, protein, fat, carbohydrate and sodium per serving.
Most imported recipes publish their own figures, but hand-entered recipes do not, and publisher figures cannot be checked or corrected.
So nutrition is worked out from each recipe's ingredients instead.

That means three problems pricing already had, in a stricter form: which food an ingredient is, what its amount weighs, and what to do when either is unknown.

## Decision

**USDA's SR Legacy tables are bundled with the backend.**
`scripts/build_nutrition_data.py` reduces the release to two CSVs: five figures per 100 g for 6,752 foods, and 12,698 kitchen portions ("1 clove" is 3 g of garlic).
There is no API key, no network call, and nothing to configure.

**Which food an ingredient means is curated or chosen, never guessed.**
`services/nutrition/defaults.py` maps about 300 ingredient names to USDA foods by hand.
Lookup walks to shorter names only across words that do not change the food ("extra-virgin olive oil" reaches "olive oil"; "almond flour" never reaches "flour").
Anything else has no food until a person picks one, and a pick is stored in `ingredient_food_matches` and holds for every recipe using that ingredient.

**A choice is shared, and says how far it reaches.**
A person can pick the food an ingredient means, or say it does not count, and either holds for every recipe using that ingredient.
Per-recipe choices were considered and turned down: the same fix would have to be made again in each recipe, and a recipe added later would not get it.
The price of sharing is that a change made in one recipe changes others, so the food picker names those recipes before anything is chosen, and every row a choice reaches says "your choice".
Product choices were already shared for a stronger reason (the grocery list buys one product per ingredient) and are unchanged.

**Weights come from USDA's own portions first**, then the grocery density table.
A count with nothing to count it against, a bunch, or a container is not weighed: the importer drops "(15 oz)" from "1 (15 oz) can", and USDA's one weight for a can is some other can.

**The figure is all or nothing.**
`per_serving` is null unless every measured ingredient was counted and the recipe gives its servings.
Ingredients left to taste, and ingredients a person has said do not count, are the exceptions: not counted, not blocking, and named.
Every ingredient's food, grams and reason are returned, and the recipe page shows them in a breakdown with the fix for each.

**The key is `canonical_key` plus state words.**
`nutrition_key` keeps "cooked" in front of `canonical_key`, which drops it.

## Why

**A partial total is a wrong total that looks right.**
Pricing shows "3 of 4 priced" beside a total, and a price short one ingredient is still roughly a price.
Calories short the butter are not roughly anything, and a coverage note beside them would be read past.

**Fuzzy matching fails invisibly.**
USDA has 42 "Beef, ground" entries.
A matcher that picks one plausibly is wrong in the way nobody notices; a missing food says so on the page.
The same reasoning made product matching strict, and it applies harder here because nothing else checks the figure.

**This departs from ADR 2, narrowly.**
ADR 2 holds that one key should answer "is this the same thing" for shopping, marks and products.
Nutrition asks "is this the same thing to eat", and for cooked food the answers differ: "2 cups cooked rice" and "2 cups rice" are one grocery line and about a threefold difference in calories.
Reusing `canonical_key` exactly would let a choice made for one silently apply to the other.
The difference is kept to the words that cause it, so for almost every ingredient the two keys are identical.

**Bundled rather than fetched.**
SR Legacy is frozen, so there is nothing to keep current, and a recipe page never waits on a third party.
About a megabyte in the image buys that.

## Consequences

- Many recipes will show "Nutrition unavailable" at first, most often for rows lint already flags or for canned goods counted by the can. The fix for each is on the breakdown.
- Pricing borrows the same USDA portions for any ingredient its density table does not list, through the ingredient's default, so a spoon of a spice is costed as a share of the jar rather than the whole jar.
- A default added to `defaults.py` reaches every recipe at once; `test_every_default_is_a_food_the_tables_hold` fails if one points at nothing.
- Changing `canonical_key` now also orphans hand-picked foods, the fourth kind of state ADR 2 warns about.
- Nutrition per serving does not scale with the servings stepper, and is not totalled for the planner. Both are left for later.
