# Planner: picks, repeating meals and labels

Design, agreed with the owner on 2026-10-21 over a series of mockups.
Reworks how a week gets filled in on the Planner page, mostly on desktop, with a phone equivalent for each part.

## Why

The owner plans mostly on a desktop.
Filling a week is two jobs mixed together: the thinking (which recipes this week?) and the data entry (put each one on a day).
Today every meal is the same four steps: click "+ Add" in a cell, type in the picker, choose the recipe, close.
A full week is up to 28 of those.

Much of the week is the same every week.
The same breakfast most days, the same lunches, sometimes a standing dinner.
Those are entered again or copied by hand, and "Copy last week" only helps when a week is an exact repeat.

The household eats differently per person.
Breakfasts and lunches differ between people, and sometimes a dinner is for one person only.
Nothing on the planner can say who a meal is for.

On a phone, the planner shows the week as a list of days starting Monday.
Later in the week the owner has to scroll past the days already gone to reach today.

## Goals

- Separate choosing the week's recipes from placing them, so placing is a drag (desktop) or two taps (phone).
- Choose recipes with the same search the Recipes page has.
- Set a meal to repeat on chosen days of the week, once, and have it appear every week without copying.
- Mark meals with labels the owner makes up, and view the week one label at a time.
- On a phone, open the current week at today.

## Non-goals

- Recommendations or "dinner ideas".
  The owner wants them, but they need their own brainstorm: what makes a good suggestion (not just "not made in a while", which may be something nobody liked), and where ingredient-based ideas would get their ingredients from.
  The layout leaves room for them under the picks (see section 1).
- Anything tied to a label beyond showing and filtering: no per-label nutrition, calorie goals or servings.
  Labels are what those later features (in `TODO.md`) would build on, so the model should not get in their way.
- Changing the recipe search itself. The planner reuses it as it is.
- Changing how the grocery list or plan cost are calculated, beyond counting repeated meals as planned meals.

## Anti-goals

- Labels that are required, or that assume who is in the household.
  There are no built-in labels; an unlabelled meal is normal and shows nothing extra.
- A repeat that changes the past.
  Days before today, and earlier weeks, always keep what was planned on them.
- Repeated meals that the grocery list, the plan cost or "Recently cooked" cannot see.
  To everything outside the planner page, a repeated meal on a day is a planned meal on that day.
- Drag as the only way to place a meal.
  Every drag has a click or tap equivalent, for the phone and for the keyboard.
- Two ideas of "tag".
  Recipes already have tags, which search uses; the planner's markers are called **labels** everywhere, in the UI and in code.

## Decisions

1. The desktop planner keeps its current week grid (meals as rows, days as columns) and gains a **Picks** panel on its left.
2. Picks are found with the Recipes page's search box and are placed by dragging onto a cell, or by choosing a pick and then a cell.
3. Any meal can **repeat** on chosen weekdays, with no end date until the owner changes it.
4. Changing or removing a repeated meal asks **Just this day** or **From this day on**; past days never change.
5. Meals can carry any number of owner-made **labels**.
6. A **label filter** shows one label's meals; adding a meal while it is on gives the meal that label.
7. On a phone, tapping a meal opens one sheet holding servings, labels, repeat and remove.
8. On a phone, the current week opens scrolled to today.
9. **Copy last week** is removed, button and endpoint: repeats replace it.

## 1. The desktop page

From top to bottom:

1. **Header**, unchanged apart from removing Copy last week: title, date range, Prev / Today / Next, Grocery list.
2. **Pricing summary**, unchanged.
3. **Label filter bar** (section 4), only when at least one label exists.
4. **Picks panel** on the left, **week grid** on the right.

### The Picks panel

- At the top, the Recipes page's search box (`RecipeSearchBox`), with the same tokens: ingredients, tags and text.
- Under it, when a search is active, its results as compact rows (thumbnail and title).
  Each result can be dragged straight onto the grid, or added to Picks with a "+".
- Under that, **This week's picks**: the recipes the owner has chosen for the week being viewed, in the order added.
  - A pick that appears anywhere in this week's plan is shown faded, with the day(s) it is on, so what is left to place stands out.
    This is worked out from the plan, not stored.
  - A pick can be placed more than once (leftovers, a double batch).
  - A pick can be removed from the list with an ✕; that does not touch the plan.
- Picks belong to a week (keyed by its Monday) and are kept on the server, so they survive a reload and show on the phone.
  They do not carry over to the next week. *(Our call.)*
- The space below the picks is where recommendations would go later. Nothing is shown there now.

### Width

The grid needs about 1100px today (`WEEK_GRID` in `layout.ts`); the panel adds roughly 240px.
Where both do not fit, the panel collapses to a narrow strip with a "Picks" toggle and opens over the grid's left edge.
It never makes the page scroll sideways. *(Our call; exact breakpoint left to the builder.)*

### Placing a meal

- **Drag** a pick or a search result onto a cell. The cell highlights as a drop target while hovered.
- **Click to place**: clicking a pick selects it, every cell shows as a target, and clicking a cell places it there.
  Escape or clicking the pick again cancels.
  This is the keyboard path too: a pick is focusable, Enter selects it, and cells can be reached and chosen with the keyboard.
- **Move**: dragging a meal already on the grid moves it to the target cell.
  Holding Alt (Option on a Mac) while dropping copies it instead. *(Our call.)*
  Moving one day of a repeated meal moves only that day (section 3).
- The existing "+ Add" in each cell stays, for a quick one-off, and its picker modal switches to the same search box. *(Our call.)*

A newly placed meal uses the recipe's servings, as today, and gets the active filter's label, if any (section 4).

## 2. Meals in a cell

- A one-off meal looks as it does today: title, servings stepper, cost.
- A repeated meal is drawn lighter, with a ↻ mark, so the meals chosen for this week stand out from the routine ones.
- Labels show as small pills after the title. An unlabelled meal shows none.
- On desktop, each meal gets a small menu (or an affordance in its hover state) with: **Labels…**, **Repeat…**, **Remove**.
  The exact affordance is left to the builder; it must not make a busy breakfast cell, with three or four meals in it, harder to read.

## 3. Repeating meals

### What a repeat is

A repeat is one recipe in one meal slot (breakfast, lunch, dinner or snack) on a chosen set of weekdays, with its servings and labels.
It starts on the day it is created and runs with no end until the owner changes it.
Each day it falls on, it shows as a meal in that cell, in every week.

### Making one

From a meal's **Repeat…** menu, choose the days:

- Just this day (not repeating)
- Every <that weekday> (for example Every Tuesday)
- Weekdays
- Every day
- Custom: any set of weekdays

Choosing a pattern on a one-off meal turns it into a repeat starting that day.

### Changing or removing one

**Changing the days** always applies from the day it is made on, since changing the days of one date has no meaning.
The Repeat… choices on a repeated meal say so ("Mon, Wed, Fri from Wed, Oct 28 on") rather than asking. *(Our call.)*
Choosing "Just this day (not repeating)" on a repeated meal stops the repeat after this date: this date keeps the meal, and later dates no longer get it. *(Our call.)*

Any other change to a repeated meal (its servings or labels, or removing it) asks one question:

- **Just this day**: only this date changes.
  Removing makes this date empty for that repeat; a servings or label change applies to this date only.
- **From this day on**: the change applies from this date forward, in this week and every week after.
  Dates before it keep the repeat as it was.
  It also replaces every Just this day change the repeat had on or after this date: a removed day comes back, and a day with its own servings or labels takes the new ones.
  The owner chose this to keep it simple: the broad change is what they asked for, so it wins.
  A day of the repeat that was dragged to another cell is a one-off meal at its new place and is not touched; its old day follows the repeat again.

The question is asked once per edit, never per tap or per checkbox. *(Our call.)*
In the labels checklist and the phone meal sheet, changes are collected and the question is asked when the checklist or sheet closes.
For the servings stepper in a desktop cell, taps are collected and, once they settle, a small bar under the meal asks Just this day / From this day on; until it is answered the new count shows but is not saved.
A one-off meal has no question and keeps saving each change as it happens, as today.

The owner's example, which the owner confirmed reads right:
oats set for every day; on next week's Wednesday the owner changes the repeat to Mon / Wed / Fri, From this day on.
Next week keeps oats Monday, Tuesday, Wednesday and Friday, and loses Thursday, Saturday and Sunday.
Every week after has oats Monday, Wednesday and Friday.

### The past

"Past" is before today, by the owner's own date (the device's, as "Recently cooked" already does), not the server's.

- A repeat never changes a past day. A repeat created today does not appear on earlier days.
- On a past day, a repeated meal can still be changed or removed for **Just this day** (to record what really happened), but **From this day on** is not offered there. *(Our call.)*

### What everything else sees

The grocery list, the plan cost and the Recipes page's "Recently cooked" sort all read planned meals for a date range from `meal_plan_entries` today.
Each of them must count a repeated meal on a day exactly as if it had been planned on that day, with its servings, and must leave out the days it was removed from.
How that is achieved (expanding repeats when a range is read, writing real rows for them, or something else) is left to the builder, with these constraints:

- There must be one place that answers "what is planned between these dates", and all of the planner, the grocery list, the cost and "Recently cooked" go through it.
- Repeats run indefinitely, so nothing may depend on having written rows for every future week.
- A past day's meals must stay what they were even after the repeat changes.

### Copy last week

Removed: the button, `api.copyWeek`, the `/meal-plan/copy-week` endpoint and its schema and tests.

## 4. Labels

### What a label is

A short name the owner makes up: a person ("Dad"), a group ("Kids"), or anything else ("Meal prep", "Packed").
Names are unique ignoring case, and trimmed.
A meal (one-off or repeated) has zero or more labels.

### Labelling a meal

- **Desktop**: the meal's **Labels…** opens a small checklist of every label, each with a checkbox, and a "New label…" field at the bottom that creates a label and ticks it.
- **Phone**: the meal sheet (section 5) has a "For" row of label chips that toggle, and a "+ New" chip.
- Changing the labels of a repeated meal asks Just this day / From this day on, like any other change.

### Managing labels

Rename and delete live in a Labels section on the Settings page. *(Our call.)*
Deleting a label takes it off every meal that has it, after a confirmation that says how many meals that is.

### The filter

- A row of chips above the grid: **Everything**, then each label.
  One is selected at a time. *(Our call: single choice, which keeps "adding gets the label" unambiguous.)*
- With a label selected, meals with that label show as usual and unlabelled meals show dimmed.
  Meals carrying only other labels are hidden.
- A checkbox, **Include unlabelled meals**, on by default, hides the dimmed unlabelled meals when unticked.
- **Adding while filtered labels the meal**: any meal placed while a label is selected (drag, click to place, "+ Add") gets that label.
  This is how the owner fills in one person's breakfasts and lunches quickly.
- The selected label is kept in the URL, so a reload or a shared link keeps it. *(Our call.)*
- The filter changes what is shown on the grid only.
  The day and week costs and the Grocery list link always cover the whole household's plan. *(Our call.)*

## 5. Phone

The phone keeps today's list of days (`DayAgenda`).

- **Opens at today**: when the current week is shown, the list starts scrolled to today's day.
  Other weeks open at their Monday.
- **Meal sheet**: tapping a meal opens a sheet from the bottom with the recipe title (a link to it), a servings stepper, the "For" label chips, Repeat (showing the current pattern, opening the same choices as desktop), and Remove.
  The meal itself, in the list, shows only its title, its labels and its ↻ mark, which leaves room for longer titles.
  The servings stepper and ✕ move off the list into the sheet. *(Our call.)*
- **Picks**: a "Picks" button near the top opens a sheet with the search box and the week's picks.
  Tapping a pick asks for the day (seven chips) and the meal (four chips), and places it.
- The label filter is the same chip row, scrolling sideways within itself if it does not fit; the page itself never scrolls sideways.

## Existing data

Every meal planned today becomes a one-off meal with no labels; nothing about it changes.

## Testing

- The repeat rules are the riskiest part and should be covered below the UI: creating, Just this day, From this day on (including the owner's example), changes on a past day, and how repeats show in the grocery list, cost and "Recently cooked".
- Drag and click to place in the browser, on desktop and at a 375px phone width, per the owner's preference for checking the real UI end to end.

## Left to the builder

- How repeats are stored and expanded, within the constraints in section 3.
- The drag-and-drop implementation, including touch behavior on a tablet.
- The exact desktop affordance for a meal's menu, and the panel's collapse breakpoint.
- Visual details: the ↻ mark, dimming, label pill colors (one neutral style is fine; colors per label are not required).
