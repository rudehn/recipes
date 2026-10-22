from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import MealPlanEntry, Recipe
from ..schemas import (
    CopyWeekRequest,
    MealPlanEntryIn,
    MealPlanEntryUpdate,
    PlanCost,
    PlannedMealOut,
    RepeatOut,
    StartRepeat,
)
from ..services import plan, repeats
from ..services.kroger import costing

router = APIRouter(prefix="/meal-plan", tags=["meal-plan"])


@router.get("", response_model=list[PlannedMealOut])
async def list_entries(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    return await plan.planned_meals(session, start, end)


@router.get("/cost", response_model=PlanCost | None)
async def plan_cost(start: date, end: date, session: AsyncSession = Depends(get_session)):
    """What the meals in a date range cost to cook, meal by meal and day by day.

    Declared above /{entry_id} so that path does not swallow it. Null when
    pricing is off or no store is set, which is the ordinary planner.
    """
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    return await costing.plan_cost(session, start, end)


@router.post("", response_model=PlannedMealOut, status_code=201)
async def create_entry(
    data: MealPlanEntryIn, session: AsyncSession = Depends(get_session)
):
    if await session.get(Recipe, data.recipe_id) is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    entry = MealPlanEntry(
        plan_date=data.plan_date,
        meal=data.meal,
        recipe_id=data.recipe_id,
        servings=data.servings,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return plan.from_entry(entry)


@router.patch("/{entry_id}", response_model=PlannedMealOut)
async def update_entry(
    entry_id: int,
    data: MealPlanEntryUpdate,
    session: AsyncSession = Depends(get_session),
):
    entry = await session.get(MealPlanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Meal plan entry not found")
    entry.servings = data.servings
    await session.commit()
    await session.refresh(entry)
    return plan.from_entry(entry)


@router.post("/{entry_id}/repeat", response_model=RepeatOut, status_code=201)
async def start_repeat(
    entry_id: int, data: StartRepeat, session: AsyncSession = Depends(get_session)
):
    """Make a planned meal repeat on the given weekdays, from its day on."""
    entry = await session.get(MealPlanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Meal plan entry not found")
    try:
        repeat = await repeats.start_repeat(session, entry, data.weekdays, data.today)
    except repeats.PastDay as error:
        raise HTTPException(status_code=422, detail="That day has passed.") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    await session.commit()
    await session.refresh(repeat)
    return repeat


@router.post("/copy-week", response_model=list[PlannedMealOut])
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
            plan_date=target[0],
            meal=entry.meal,
            recipe_id=entry.recipe_id,
            servings=entry.servings,
        )
        session.add(copy)
        created.append(copy)
    await session.commit()
    for copy in created:
        await session.refresh(copy)
    return [plan.from_entry(copy) for copy in created]


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(entry_id: int, session: AsyncSession = Depends(get_session)):
    entry = await session.get(MealPlanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Meal plan entry not found")
    await session.delete(entry)
    await session.commit()
