"""Meals that repeat on chosen weekdays.

A repeat is stored once; `services.plan` works out its days for whatever
range is asked about. What lives here is the arithmetic on a repeat and the
one write that makes a repeat out of a planned meal.
"""

from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MealPlanEntry, MealRepeat


class PastDay(ValueError):
    """A repeat was asked to begin on a day that has already passed."""


def to_mask(weekdays: list[int]) -> int:
    """Weekdays (0 = Monday ... 6 = Sunday) as a bitmask, Monday being bit 0."""
    mask = 0
    for day in weekdays:
        if not 0 <= day <= 6:
            raise ValueError("Weekdays are 0 (Monday) to 6 (Sunday).")
        mask |= 1 << day
    return mask


def from_mask(mask: int) -> list[int]:
    """The weekdays a bitmask holds, in order."""
    return [day for day in range(7) if mask & (1 << day)]


def occurs_on(repeat: MealRepeat, day: date) -> bool:
    """Whether the repeat falls on `day`. Its skips are the caller's to apply."""
    if day < repeat.starts_on or (repeat.ends_on is not None and day > repeat.ends_on):
        return False
    return bool(repeat.weekdays & (1 << day.weekday()))


async def start_repeat(
    session: AsyncSession, entry: MealPlanEntry, weekdays: list[int], today: date
) -> MealRepeat:
    """Turn a planned meal into a repeat that begins on its day.

    The meal becomes the repeat's first occurrence, so the row itself goes.
    A day that has passed is history and does not start anything.
    """
    if entry.plan_date < today:
        raise PastDay("That day has passed.")
    if not weekdays:
        raise ValueError("Pick at least one weekday.")
    repeat = MealRepeat(
        recipe_id=entry.recipe_id,
        meal=entry.meal,
        weekdays=to_mask(weekdays),
        servings=entry.servings,
        starts_on=entry.plan_date,
    )
    await session.delete(entry)
    session.add(repeat)
    await session.flush()
    return repeat
