"""Labels on planned meals: finding them and cleaning up their links.

SQLite does not enforce foreign keys, so a link row outlives the meal it
names unless whoever deletes the meal deletes the links first. Everything
that deletes meals in bulk does it through here.
"""

from collections.abc import Iterable

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    MealPlanEntry,
    MealRepeat,
    PlanLabel,
    meal_plan_entry_labels,
    meal_repeat_labels,
)


class UnknownLabel(ValueError):
    """A label id that names no label."""


def key_of(name: str) -> str:
    """What label names are unique by: the name, ignoring case."""
    return name.casefold()


async def get_labels(session: AsyncSession, ids: Iterable[int]) -> list[PlanLabel]:
    """The labels with these ids, by name. Raises UnknownLabel for a missing one."""
    wanted = set(ids)
    found = list(
        await session.scalars(
            select(PlanLabel).where(PlanLabel.id.in_(wanted)).order_by(PlanLabel.key)
        )
    )
    if len(found) != len(wanted):
        raise UnknownLabel("Unknown label.")
    return found


async def unlabel_entries(session: AsyncSession, entries: ColumnElement[bool]) -> None:
    """Drop the label links of the rows matching `entries`, before they go."""
    ids = select(MealPlanEntry.id).where(entries)
    await session.execute(
        delete(meal_plan_entry_labels).where(meal_plan_entry_labels.c.entry_id.in_(ids))
    )


async def unlabel_repeats(session: AsyncSession, repeats: ColumnElement[bool]) -> None:
    """Drop the label links of the repeats matching `repeats`, before they go."""
    ids = select(MealRepeat.id).where(repeats)
    await session.execute(
        delete(meal_repeat_labels).where(meal_repeat_labels.c.repeat_id.in_(ids))
    )


async def meals_by_label(session: AsyncSession) -> dict[int, int]:
    """How many meals carry each label; a label on no meal is absent.

    A one-off meal counts once and so does a repeat, however many rows a
    change from a day on split it into. A day of a repeat changed on its own
    counts only if the label is not already the repeat's.
    """
    repeat_labels = (
        await session.execute(
            select(
                meal_repeat_labels.c.label_id,
                meal_repeat_labels.c.repeat_id,
                MealRepeat.origin_id,
            ).join(MealRepeat, MealRepeat.id == meal_repeat_labels.c.repeat_id)
        )
    ).all()
    series: dict[int, set[int]] = {}
    carried = set()
    for label_id, repeat_id, origin_id in repeat_labels:
        series.setdefault(label_id, set()).add(origin_id or repeat_id)
        carried.add((label_id, repeat_id))
    counts = {label_id: len(origins) for label_id, origins in series.items()}
    entry_labels = (
        await session.execute(
            select(meal_plan_entry_labels.c.label_id, MealPlanEntry.from_repeat_id).join(
                MealPlanEntry, MealPlanEntry.id == meal_plan_entry_labels.c.entry_id
            )
        )
    ).all()
    for label_id, from_repeat_id in entry_labels:
        if from_repeat_id is None or (label_id, from_repeat_id) not in carried:
            counts[label_id] = counts.get(label_id, 0) + 1
    return counts
