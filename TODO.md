# TODO

Ideas agreed on but not built yet.
Each one says what it is, why it is worth doing, and what to watch for.

## Nutrition on the planner, and scaled with servings

ADR 8 left both for later.

**What**

- The planner shows nutrition beside the cost it already totals: per day ("Tuesday: 1,850 kcal · 92 g protein") and for the week.
- It follows the same all-or-nothing rule as a recipe.
  A day is totalled only if every meal on it is counted; otherwise it says "2 of 3 meals counted" and names the ones that are not.
- A planned entry's servings scale what it contributes, so two servings of a curry count twice.
- On the recipe page, the servings stepper already scales the ingredient amounts and the cost.
  Nutrition stays per serving there, which does not change with the stepper, but a total for the scaled amount could sit beside it.

**Why**

It finishes the nutrition feature rather than starting a new one, and the planner is where "how am I eating this week" is actually asked.

**Watch for**

- Coverage.
  When this was proposed only 1 of 11 recipes had a complete figure, so a week total would mostly read "unavailable".
  Improve coverage first (fix lint-flagged lines, choose foods for the common misses), or the feature ships looking broken.
- A partial day total must never be shown as a number, for the same reason a partial recipe total is not.

## Cooking history: "made it", notes and a rating

Nothing records what happened after a meal was planned.
A recipe has no notes, rating or last-cooked date.

**What**

- A "Made it" action on the recipe page and at the end of cook mode, with an optional thumbs up or down and a note ("less salt next time", "double the sauce").
- Planned meals whose day has passed can be logged in one tap, or logged automatically, so history does not depend on remembering to press a button.
- Recipe cards show "Last made 3 weeks ago · made 6 times".
- Suggestions favor liked recipes that have not been made lately, and stop offering ones marked down.
- The recipe page shows past notes near the ingredients, where the next cook will see them.

**Why**

The app gets more useful the longer it is used, and notes are where the fixes discovered while cooking belong.

**Watch for**

- It only pays off if logging costs one tap; auto-logging from the planner is the important part.
- Keep a rating coarse (up or down).
  Five stars invites agonising and adds nothing a household needs to decide what to cook again.
