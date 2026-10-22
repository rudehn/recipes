"""Meals that repeat on chosen weekdays.

A repeat is stored once; `services.plan` works out its days for whatever
range is asked about. What lives here is the arithmetic on a repeat and the
writes that make one and change it.

A change to one day ("just this day") is a skip for that day plus, while the
day still has a meal, a row linked back to the repeat that stands in for it.
A change from a day on ends the repeat the day before and carries it on in a
new row, so the days before it cannot change: they belong to a row nothing
writes to any more.
"""

from datetime import date, timedelta
from enum import Enum

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MealPlanEntry, MealRepeat, MealRepeatSkip, PlanLabel
from .labels import unlabel_entries, unlabel_repeats


class PastDay(ValueError):
    """A change that reaches forward was asked of a day that has passed."""


class NoMeal(LookupError):
    """The repeat has no meal on the day asked about."""


class Unset(Enum):
    """A field a change leaves alone, as against one it sets to null."""

    UNSET = "unset"


UNSET = Unset.UNSET


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


def _weekday_mask(weekdays: list[int]) -> int:
    """The mask of a repeat's days, which must have at least one."""
    if not weekdays:
        raise ValueError("Pick at least one weekday.")
    return to_mask(weekdays)


def _refuse_past(day: date, today: date) -> None:
    if day < today:
        raise PastDay("That day has passed.")


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
    if entry.from_repeat_id is not None:
        # The day is already a repeat's; it changes through that repeat.
        raise ValueError("This meal already repeats.")
    _refuse_past(entry.plan_date, today)
    repeat = MealRepeat(
        recipe_id=entry.recipe_id,
        meal=entry.meal,
        weekdays=_weekday_mask(weekdays),
        servings=entry.servings,
        labels=list(entry.labels),
        starts_on=entry.plan_date,
    )
    await session.delete(entry)
    session.add(repeat)
    await session.flush()
    return repeat


async def override_day(
    session: AsyncSession,
    repeat: MealRepeat,
    day: date,
    *,
    servings: int | Unset | None = UNSET,
    labels: list[PlanLabel] | Unset = UNSET,
) -> MealPlanEntry:
    """Change the repeat's meal on `day` alone, on any day, past ones included.

    Null servings are the recipe's own count; a field left out stays.
    """
    entry = await _day_row(session, repeat, day)
    if servings is not UNSET:
        entry.servings = servings
    if labels is not UNSET:
        entry.labels = labels
    await session.flush()
    return entry


async def remove_day(session: AsyncSession, repeat: MealRepeat, day: date) -> None:
    """Leave `day` without the repeat's meal, and only that day."""
    entry = await _linked_entry(session, repeat, day)
    if entry is None:
        session.add(MealRepeatSkip(repeat_id=repeat.id, plan_date=day))
    else:
        # Its skip is already there; the day's own meal is what goes.
        await session.delete(entry)
    await session.flush()


async def change_from(
    session: AsyncSession,
    repeat: MealRepeat,
    day: date,
    today: date,
    *,
    servings: int | Unset | None = UNSET,
    weekdays: list[int] | Unset = UNSET,
    labels: list[PlanLabel] | Unset = UNSET,
) -> MealRepeat:
    """Change the repeat from `day` on, in this week and every week after.

    The change wins over everything the repeat had on and after `day`: days
    removed alone come back, and days with their own servings take the new
    ones. It also reaches the rows an earlier change from a later day split
    off, changing only the fields it is given, so a change from Wednesday
    covers a change already made from Friday. Returns the row that holds the
    repeat from `day`.
    """
    await _linked_entry(session, repeat, day)
    _refuse_past(day, today)
    mask = UNSET if weekdays is UNSET else _weekday_mask(weekdays)
    later = await _later_rows(session, repeat)
    await _forget_changes_from(session, [repeat, *later], day)
    if day <= repeat.starts_on:
        changed = repeat
    else:
        changed = MealRepeat(
            recipe_id=repeat.recipe_id,
            meal=repeat.meal,
            weekdays=repeat.weekdays,
            servings=repeat.servings,
            labels=list(repeat.labels),
            starts_on=day,
            ends_on=repeat.ends_on,
            origin_id=_origin(repeat),
        )
        repeat.ends_on = day - timedelta(days=1)
        session.add(changed)
    for row in (changed, *later):
        if servings is not UNSET:
            row.servings = servings
        if labels is not UNSET:
            row.labels = labels
        if mask is not UNSET:
            row.weekdays = mask
    await session.flush()
    return changed


async def remove_from(
    session: AsyncSession, repeat: MealRepeat, day: date, today: date
) -> None:
    """End the repeat before `day`: it has no meal from then on, in any week."""
    await _linked_entry(session, repeat, day)
    _refuse_past(day, today)
    await _end_before(session, repeat, day)


async def stop_after(
    session: AsyncSession, repeat: MealRepeat, day: date, today: date
) -> MealPlanEntry:
    """End the repeat after `day`, keeping that day's meal as a one-off."""
    entry = await _linked_entry(session, repeat, day)
    _refuse_past(day, today)
    entry = entry or _replace_day(session, repeat, day)
    entry.from_repeat_id = None
    await _end_before(session, repeat, day)
    return entry


async def move_day(
    session: AsyncSession, repeat: MealRepeat, day: date, plan_date: date, meal: str
) -> MealPlanEntry:
    """Move the repeat's meal on `day` to another cell, as a one-off there.

    The moved meal is unlinked on purpose: it is somewhere the repeat never
    goes, so nothing the repeat does later should reach it. Its old day
    stays empty until a change from a day on gives it back to the repeat.
    """
    entry = await _day_row(session, repeat, day)
    entry.from_repeat_id = None
    entry.plan_date = plan_date
    entry.meal = meal
    await session.flush()
    return entry


async def _linked_entry(
    session: AsyncSession, repeat: MealRepeat, day: date
) -> MealPlanEntry | None:
    """The row standing in for the repeat's meal on `day`, if it has one.

    Raises NoMeal when the repeat has no meal on `day`: the day is
    outside its span, on a weekday it does not have, or removed on its own.
    """
    if not occurs_on(repeat, day):
        raise NoMeal("The repeat has no meal on that day.")
    entry = await session.scalar(
        select(MealPlanEntry).where(
            MealPlanEntry.from_repeat_id == repeat.id, MealPlanEntry.plan_date == day
        )
    )
    if entry is None:
        skipped = await session.scalar(
            select(MealRepeatSkip.id).where(
                MealRepeatSkip.repeat_id == repeat.id, MealRepeatSkip.plan_date == day
            )
        )
        if skipped is not None:
            raise NoMeal("The repeat has no meal on that day.")
    return entry


def _replace_day(session: AsyncSession, repeat: MealRepeat, day: date) -> MealPlanEntry:
    """Skip the repeat on `day` and put a linked row with its meal there."""
    session.add(MealRepeatSkip(repeat_id=repeat.id, plan_date=day))
    entry = MealPlanEntry(
        plan_date=day,
        meal=repeat.meal,
        recipe_id=repeat.recipe_id,
        servings=repeat.servings,
        labels=list(repeat.labels),
        from_repeat_id=repeat.id,
    )
    session.add(entry)
    return entry


async def _day_row(session: AsyncSession, repeat: MealRepeat, day: date) -> MealPlanEntry:
    """The repeat's meal on `day` as a row, made on the day's first change."""
    entry = await _linked_entry(session, repeat, day)
    return entry or _replace_day(session, repeat, day)


def _origin(repeat: MealRepeat) -> int:
    """The first row of the repeat that `repeat` is part of."""
    return repeat.id if repeat.origin_id is None else repeat.origin_id


async def _later_rows(session: AsyncSession, repeat: MealRepeat) -> list[MealRepeat]:
    """The rows that carry the repeat on after `repeat` ends, in order."""
    origin = _origin(repeat)
    rows = await session.scalars(
        select(MealRepeat)
        .where(
            or_(MealRepeat.id == origin, MealRepeat.origin_id == origin),
            MealRepeat.starts_on > repeat.starts_on,
        )
        .order_by(MealRepeat.starts_on)
    )
    return list(rows)


async def _forget_changes_from(
    session: AsyncSession, rows: list[MealRepeat], day: date
) -> None:
    """Drop the one-day changes these rows have on and after `day`.

    SQLite does not enforce foreign keys, so nothing here happens by itself.
    """
    ids = [row.id for row in rows]
    changes = (MealPlanEntry.from_repeat_id.in_(ids), MealPlanEntry.plan_date >= day)
    await unlabel_entries(session, and_(*changes))
    await session.execute(delete(MealPlanEntry).where(*changes))
    await session.execute(
        delete(MealRepeatSkip).where(
            MealRepeatSkip.repeat_id.in_(ids), MealRepeatSkip.plan_date >= day
        )
    )


async def _end_before(session: AsyncSession, repeat: MealRepeat, day: date) -> None:
    """End the repeat on the day before `day`, with the rows that carry it on.

    A repeat ended before its first day has no days at all, so it goes.
    """
    later = await _later_rows(session, repeat)
    await _forget_changes_from(session, [repeat, *later], day)
    gone = [row.id for row in later]
    if day <= repeat.starts_on:
        gone.append(repeat.id)
    else:
        repeat.ends_on = day - timedelta(days=1)
    await unlabel_repeats(session, MealRepeat.id.in_(gone))
    await session.execute(delete(MealRepeat).where(MealRepeat.id.in_(gone)))
    await session.flush()
