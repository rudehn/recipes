"""What is planned, read one way for everyone who asks.

The planner, the grocery list, the plan's cost and the Recipes page all want
"the meals on these days". They read them here, so a meal that exists is the
same meal to each of them. Every meal carries a key that names it for a
client; a row's key is `e<id>`.
"""

from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MealPlanEntry, Recipe


@dataclass(frozen=True)
class PlannedMeal:
    """One recipe planned for one meal of one day.

    `entry_id` is the row behind the meal, for the writes that need one.
    """

    key: str
    plan_date: date
    meal: str
    recipe: Recipe
    servings: int | None
    entry_id: int | None


def from_entry(entry: MealPlanEntry) -> PlannedMeal:
    """The meal a stored row stands for. The one place a PlannedMeal is built."""
    return PlannedMeal(
        key=f"e{entry.id}",
        plan_date=entry.plan_date,
        meal=entry.meal,
        recipe=entry.recipe,
        servings=entry.servings,
        entry_id=entry.id,
    )


async def planned_meals(session: AsyncSession, start: date, end: date) -> list[PlannedMeal]:
    """Every meal planned from `start` to `end`, both included.

    Ordered by day, then the order they were planned in.
    """
    rows = (
        await session.execute(
            select(MealPlanEntry)
            .where(MealPlanEntry.plan_date >= start, MealPlanEntry.plan_date <= end)
            .order_by(MealPlanEntry.plan_date, MealPlanEntry.id)
        )
    ).scalars().all()
    return [from_entry(row) for row in rows]


async def last_planned(session: AsyncSession, today: date) -> dict[int, date]:
    """Each recipe's latest planned day on or before `today`.

    Plans in the future are intentions, not history, so they do not count.
    A recipe never planned by then is absent.
    """
    rows = await session.execute(
        select(MealPlanEntry.recipe_id, func.max(MealPlanEntry.plan_date))
        .where(MealPlanEntry.plan_date <= today)
        .group_by(MealPlanEntry.recipe_id)
    )
    return dict(rows.all())
