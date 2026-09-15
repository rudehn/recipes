"""Choosing which USDA food an ingredient means.

A recipe's own nutrition is served beside the recipe, at
`/recipes/{id}/nutrition`. What lives here is the correction path: searching
the bundled foods, and pinning or unpinning a choice. A choice is made once
per ingredient and holds for every recipe that uses it, the same way a
hand-picked Kroger product does.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import FoodChoice, FoodMatchSelection, RecipeRef
from ..services.nutrition import facts, foods

# Enough to choose from without scrolling a catalogue. The search is local,
# so this is a reading limit, not a cost one.
SEARCH_LIMIT = 25

router = APIRouter(prefix="/nutrition", tags=["nutrition"])


@router.get("/foods", response_model=list[FoodChoice])
async def search_foods(q: str = Query(min_length=1, max_length=100)):
    return [facts.food_choice(f) for f in foods.search(q, SEARCH_LIMIT)]


@router.get("/uses", response_model=list[RecipeRef])
async def recipes_using(
    key: str = Query(min_length=1, max_length=300),
    session: AsyncSession = Depends(get_session),
):
    """Every recipe a choice for this ingredient reaches.

    A choice is shared, so the picker names what else it changes before it
    is made rather than after.
    """
    return await facts.recipes_using(session, key)


@router.put("/match", status_code=204)
async def choose_food(data: FoodMatchSelection, session: AsyncSession = Depends(get_session)):
    """Pin a food to an ingredient, or say it does not count. Either holds
    until it is forgotten."""
    if data.fdc_id is not None and foods.food(data.fdc_id) is None:
        raise HTTPException(status_code=404, detail="No such food")
    await facts.choose(session, data.key, data.fdc_id)


@router.delete("/match", status_code=204)
async def forget_food(
    key: str = Query(min_length=1, max_length=300),
    session: AsyncSession = Depends(get_session),
):
    """Go back to the ingredient's default food, or to none if it has none."""
    await facts.forget(session, key)
