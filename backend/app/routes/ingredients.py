"""Ingredients, each seen whole, for the Ingredients page.

Reading only: every change the page makes goes through the endpoint that
already makes it - pantry, product match, food match - and merges through
`/merges` below.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import IngredientDetail, IngredientList
from ..services import ingredients

router = APIRouter(prefix="/ingredients", tags=["ingredients"])


@router.get("", response_model=IngredientList)
async def list_ingredients(session: AsyncSession = Depends(get_session)):
    return await ingredients.list_ingredients(session)


@router.get("/{key}", response_model=IngredientDetail)
async def ingredient(key: str, session: AsyncSession = Depends(get_session)):
    """One ingredient. A name merged into another answers with the other."""
    found = await ingredients.ingredient(session, key)
    if found is None:
        raise HTTPException(status_code=404, detail="No ingredient called that.")
    return found
