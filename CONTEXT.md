# Mise

The words this codebase uses for its domain, and what they mean here.

## Ingredients

**Ingredient**: what a recipe line or a staple stands for, identified by its key after merges (`services.identity`).
"2 large eggs" and "eggs, beaten" are one ingredient, `egg`.
Avoid: item, product (a product is what a store sells).

**Staple**: an ingredient the household keeps in stock, recorded as a pantry item with an in-stock flag.
An ingredient is one staple at most, so a name that already means a staple's ingredient is refused.
Avoid: pantry item, in user-facing text.

**Merge**: the owner saying two names are one ingredient, stored apart from recipe text and reversible (ADR 10).

**Suggested merge**: a pair the app thinks might be one ingredient, offered for the owner to merge or turn down, never applied by itself.

## Planner

**Repeat**: a meal planned for chosen weekdays of every week, from a day on, stored once and worked out for whatever days are read.
It ends when the owner stops it, and a single day can be skipped without ending it.
Avoid: recurring meal, series, schedule.

**One-off meal**: a meal planned for one day, a stored row of its own.
Avoid: single meal, standalone.

**Skip**: a day a repeat does not happen on although its weekday says it would.
Avoid: exception, removed day.

**Label**: a marker the owner puts on planned meals ("Dad", "Kids", "Guests"), made and named by them.
A meal carries any number of labels, and a repeat carries its labels to every day it falls on.
Names are unique ignoring case.
Avoid: tag, which is the recipe's search tag and belongs to the recipe, not to a meal on the plan.
