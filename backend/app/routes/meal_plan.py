from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import MealPlanEntry, Recipe
from ..schemas import MealPlanEntryIn, MealPlanEntryOut

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


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(entry_id: int, session: AsyncSession = Depends(get_session)):
    entry = await session.get(MealPlanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Meal plan entry not found")
    await session.delete(entry)
    await session.commit()
