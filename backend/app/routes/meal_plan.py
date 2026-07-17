from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import MealPlanEntry, Recipe
from ..schemas import CopyWeekRequest, MealPlanEntryIn, MealPlanEntryOut

router = APIRouter(prefix="/meal-plan", tags=["meal-plan"])


@router.get("", response_model=list[MealPlanEntryOut])
async def list_entries(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    result = await session.execute(
        select(MealPlanEntry)
        .where(MealPlanEntry.plan_date >= start, MealPlanEntry.plan_date <= end)
        .order_by(MealPlanEntry.plan_date, MealPlanEntry.id)
    )
    return result.scalars().all()


@router.post("", response_model=MealPlanEntryOut, status_code=201)
async def create_entry(
    data: MealPlanEntryIn, session: AsyncSession = Depends(get_session)
):
    if await session.get(Recipe, data.recipe_id) is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    entry = MealPlanEntry(
        plan_date=data.plan_date, meal=data.meal, recipe_id=data.recipe_id
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


@router.post("/copy-week", response_model=list[MealPlanEntryOut])
async def copy_week(
    data: CopyWeekRequest, session: AsyncSession = Depends(get_session)
):
    """Copies one week's entries onto another, skipping meals already planned
    (so re-copying never duplicates)."""
    offset = data.to_start - data.from_start
    source_end = data.from_start + timedelta(days=6)
    source = (
        (
            await session.execute(
                select(MealPlanEntry).where(
                    MealPlanEntry.plan_date >= data.from_start,
                    MealPlanEntry.plan_date <= source_end,
                )
            )
        )
        .scalars()
        .all()
    )
    existing = (
        (
            await session.execute(
                select(MealPlanEntry).where(
                    MealPlanEntry.plan_date >= data.to_start,
                    MealPlanEntry.plan_date <= data.to_start + timedelta(days=6),
                )
            )
        )
        .scalars()
        .all()
    )
    taken = {(e.plan_date, e.meal, e.recipe_id) for e in existing}

    created: list[MealPlanEntry] = []
    for entry in source:
        target = (entry.plan_date + offset, entry.meal, entry.recipe_id)
        if target in taken:
            continue
        taken.add(target)
        copy = MealPlanEntry(
            plan_date=target[0], meal=entry.meal, recipe_id=entry.recipe_id
        )
        session.add(copy)
        created.append(copy)
    await session.commit()
    for copy in created:
        await session.refresh(copy)
    return created


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(entry_id: int, session: AsyncSession = Depends(get_session)):
    entry = await session.get(MealPlanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Meal plan entry not found")
    await session.delete(entry)
    await session.commit()
