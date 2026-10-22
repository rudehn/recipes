"""What is planned, read one way for everyone who asks.

The planner, the grocery list, the plan's cost and the Recipes page all want
"the meals on these days". They read them here, so a meal that exists is the
same meal to each of them. Every meal carries a key that names it for a
client; a row's key is `e<id>`, and a repeat's day that has no row of its
own is `r<repeat id>-<date>`.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MealPlanEntry, MealRepeat, PlanLabel, Recipe
from .repeats import occurs_on


@dataclass(frozen=True)
class PlannedMeal:
    """One recipe planned for one meal of one day.

    `entry_id` is the row behind the meal, for the writes that need one; a
    repeat's day with no row of its own has none. `repeat` is the repeat the
    meal belongs to, if any. `labels` are the owner's markers on the meal,
    by name.
    """

    key: str
    plan_date: date
    meal: str
    recipe: Recipe
    servings: int | None
    entry_id: int | None
    repeat: MealRepeat | None = None
    labels: list[PlanLabel] = field(default_factory=list)


def from_entry(entry: MealPlanEntry) -> PlannedMeal:
    """The meal a stored row stands for. The one place a PlannedMeal is built."""
    return PlannedMeal(
        key=f"e{entry.id}",
        plan_date=entry.plan_date,
        meal=entry.meal,
        recipe=entry.recipe,
        servings=entry.servings,
        entry_id=entry.id,
        repeat=entry.repeat,
        labels=list(entry.labels),
    )


def _from_repeat(repeat: MealRepeat, day: date) -> PlannedMeal:
    """A repeat's meal on one of its days, when nothing changes it."""
    return PlannedMeal(
        key=f"r{repeat.id}-{day.isoformat()}",
        plan_date=day,
        meal=repeat.meal,
        recipe=repeat.recipe,
        servings=repeat.servings,
        entry_id=None,
        repeat=repeat,
        labels=list(repeat.labels),
    )


async def planned_meals(session: AsyncSession, start: date, end: date) -> list[PlannedMeal]:
    """Every meal planned from `start` to `end`, both included.

    Ordered by day; within a day the repeats come first (by repeat), then the
    one-off meals in the order they were planned.
    """
    rows = (
        await session.execute(
            select(MealPlanEntry).where(
                MealPlanEntry.plan_date >= start, MealPlanEntry.plan_date <= end
            )
        )
    ).scalars().all()
    repeats = (
        await session.execute(
            select(MealRepeat)
            .where(
                MealRepeat.starts_on <= end,
                or_(MealRepeat.ends_on.is_(None), MealRepeat.ends_on >= start),
            )
            .order_by(MealRepeat.id)
        )
    ).scalars().all()

    # A row linked to a repeat stands in for the repeat's meal on its day.
    replaced = {(r.from_repeat_id, r.plan_date) for r in rows if r.from_repeat_id}
    ranked: list[tuple[tuple[date, int, int], PlannedMeal]] = []
    for row in rows:
        group, order = (0, row.from_repeat_id) if row.from_repeat_id else (1, row.id)
        ranked.append(((row.plan_date, group, order), from_entry(row)))
    for repeat in repeats:
        skipped = {skip.plan_date for skip in repeat.skips}
        day = max(start, repeat.starts_on)
        last = end if repeat.ends_on is None else min(end, repeat.ends_on)
        while day <= last:
            if occurs_on(repeat, day) and day not in skipped and (repeat.id, day) not in replaced:
                ranked.append(((day, 0, repeat.id), _from_repeat(repeat, day)))
            day += timedelta(days=1)
    ranked.sort(key=lambda pair: pair[0])
    return [meal for _, meal in ranked]


async def last_planned(session: AsyncSession, today: date) -> dict[int, date]:
    """Each recipe's latest planned day on or before `today`.

    Plans in the future are intentions, not history, so they do not count.
    A recipe never planned by then is absent. A repeat counts for its latest
    day that actually happened.
    """
    rows = await session.execute(
        select(MealPlanEntry.recipe_id, func.max(MealPlanEntry.plan_date))
        .where(MealPlanEntry.plan_date <= today)
        .group_by(MealPlanEntry.recipe_id)
    )
    latest = dict(rows.all())
    repeats = (
        await session.execute(select(MealRepeat).where(MealRepeat.starts_on <= today))
    ).scalars().all()
    for repeat in repeats:
        skipped = {skip.plan_date for skip in repeat.skips}
        day = today if repeat.ends_on is None else min(today, repeat.ends_on)
        while day >= repeat.starts_on:
            if occurs_on(repeat, day) and day not in skipped:
                if day > latest.get(repeat.recipe_id, date.min):
                    latest[repeat.recipe_id] = day
                break
            day -= timedelta(days=1)
    return latest
