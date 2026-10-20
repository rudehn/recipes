# 6. A recipe costs a share of a package, and the box is ranked without searching

Accepted, September 2026.

## Context

The grocery list prices whole packages, because that is what gets bought.
Cost per recipe (issue 11), cost per meal plan (issue 12) and price-aware recommendations (issue 13) need a different number: what a recipe consumes.
Two cups of a five pound bag of flour is eleven percent of the bag.

Issue 11 also warned that a price on every recipe card is thousands of Kroger calls per page view, against a 10,000 per day allowance.

## Decision

`units.share_of_package` prices the fraction of a package a recipe uses, through the same `comparable` bridge the grocery list and the cart use, so the three cannot disagree about what a cup of flour weighs.
A weight-sold rate is charged at the rate with no floor: a costing is not a purchase.

Where an amount cannot be related to its package, the line is costed as the whole package and carries `whole_package: true`.
An ingredient with no amount at all is not priced.

Coverage travels with every figure, in the shape "est. $8.40 · 3 of 4 ingredients priced", on the recipe page and the planner.

A single recipe's page may search for ingredients nothing has matched yet.
Ranking the whole box may not: `matching.stored_picks` answers only from products already decided on, and a recipe nothing has priced is not ranked.
A recipe is called on sale only when at least 80 percent of its ingredients are priced.

## Why

**Whole-package is right for a bunch and wrong for a sprig, and nothing can tell them apart.**
"1 bunch parsley" against a bunch is exactly the package.
"2 sprigs" against the same bunch is ten times too much.
Both arrive as an amount in a unit the size parser does not know.
So the figure is shown with its reason in the row rather than folded silently into the total, and "salt, to taste" - no amount at all - is left unpriced, because a package of salt would be wrong by a thousand.

**Listing the recipes must not be a search per ingredient in the box.**
Two hundred recipes is a few hundred distinct ingredients, and a search each would be slow and would spend the day's allowance on a page that is merely being read.
Using only remembered picks makes the sale ribbons a batched lookup at most, and means they improve as grocery lists are priced.

**Never against a price history.**
Issue 13 records why: accumulating prices over time is prohibited by Kroger's acceptable use policy.
So a recipe is compared with its own regular price, not with what it used to cost.

**The plan cost and the grocery total are shown together on purpose.**
Cooking prices the share of each package; shopping prices whole packages.
The gap is the pantry surplus the shopper is left holding, which is worth seeing rather than hiding.

## Consequences

- A recipe page costs one batched lookup, plus one search per ingredient the first time it is seen.
- The planner costs one batched lookup plus a grocery list build per view.
- No recipe shows a sale ribbon in a recipe box that has never had a grocery list priced, and nothing says so.
