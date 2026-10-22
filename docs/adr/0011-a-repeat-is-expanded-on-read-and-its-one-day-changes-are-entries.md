# 11. A repeat is expanded on read, and its one-day changes are entries

Accepted, October 2026.

## Context

The owner can set a meal to repeat on chosen weekdays, with no end until they change it.
Three readers besides the planner need those meals as planned meals: the grocery list, the plan's cost and the Recipes page's "Recently cooked" order.
Each must count a repeated meal on a day exactly as if it had been planned there, and leave out the days it was removed from.
A repeat runs without end, so nothing can depend on rows having been written for every future week.
A repeat must also never change the past: days before the owner's today keep what was planned on them.

## Decision

A repeat is one row (`meal_repeats`), and `services.plan` works out its days for whatever range is read.
It is the one place that answers "what is planned between these dates", and every reader goes through it.

A "Just this day" change is a skip for that day (`meal_repeat_skips`) plus, while the day still has a meal, an ordinary entry linked back to the repeat (`from_repeat_id`) that stands in for it.
Removing the day is the skip alone.

A "From this day on" change ends the repeat the day before and carries it on in a new row from that day, with the change applied.
On the repeat's first day it changes the row in place instead.
Every row a repeat is carried on in names its first row (`origin_id`), so a later change from an earlier day can find the rows that come after it.
That change reaches them too, setting only the fields it was given: a change of days from Wednesday covers a servings change already made from Friday, without undoing it.

Removing or stopping a repeat from a day ends it the day before, along with every row that carries it on, and deletes it when that day is its first.
Moving a repeated day to another cell skips the day and leaves the meal at its new place as a one-off, unlinked.

## Why

**Past days are untouched by construction.**
A split leaves the days before it in a row nothing writes to again, so no rule has to remember which days are past.
"From this day on" is refused for a day before the owner's today, and that refusal is the only check needed.

**One-day changes are meals.**
A linked entry is read the same way as any other entry, so the grocery list and the cost need nothing new to see a day's own servings.

**The broad change wins.**
The owner chose to keep "From this day on" simple: the change they asked for replaces the one-day changes in its way, rather than merging with them.

## Consequences

- "From this day on" deletes the repeat's skips and linked entries on or after its day, in every row it reaches: removed days come back, and days with their own servings take the new ones.
- A moved day is unlinked on purpose: the repeat never goes to its new cell, so no later change of the repeat touches it, and its old day follows the repeat again after the next "From this day on" change.
- SQLite does not enforce foreign keys, so every operation deletes the skips, linked entries and later rows it leaves behind explicitly, as does deleting a recipe.
- A repeat changed many times is several rows; reading a range costs one pass per row that overlaps it.
