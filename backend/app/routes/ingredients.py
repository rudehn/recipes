"""Ingredients, each seen whole, for the Ingredients page.

Reading only: every change the page makes goes through the endpoint that
already makes it - pantry, product match, food match - and merges through
`/merges` below.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import IngredientMergeDismissal
from ..schemas import (
    DismissRequest,
    IngredientDetail,
    IngredientList,
    MergeIn,
    MergePreview,
    MergeRequest,
    MergeSuggestion,
)
from ..services import ingredients, merges

router = APIRouter(prefix="/ingredients", tags=["ingredients"])


@router.get("", response_model=IngredientList)
async def list_ingredients(session: AsyncSession = Depends(get_session)):
    return await ingredients.list_ingredients(session)


def _refused(exc: merges.MergeRefused) -> HTTPException:
    status = 404 if isinstance(exc, merges.MergeUnknown) else 409
    return HTTPException(status_code=status, detail=str(exc))


@router.get("/suggestions", response_model=list[MergeSuggestion])
async def suggestions(session: AsyncSession = Depends(get_session)):
    """Declared above /{key} so that path does not swallow it."""
    return (await ingredients.list_ingredients(session)).suggestions


@router.post("/suggestions/dismiss", status_code=204)
async def dismiss(data: DismissRequest, session: AsyncSession = Depends(get_session)):
    """ "Not the same": this pair is never suggested again."""
    key_a, key_b = sorted((data.key_a, data.key_b))
    if await session.get(IngredientMergeDismissal, (key_a, key_b)) is None:
        session.add(IngredientMergeDismissal(key_a=key_a, key_b=key_b))
        await session.commit()


@router.post("/merges/preview", response_model=MergePreview)
async def preview_merge(data: MergeRequest, session: AsyncSession = Depends(get_session)):
    try:
        return await merges.preview(session, data.from_key, data.to_key)
    except merges.MergeRefused as exc:
        raise _refused(exc)


@router.post("/merges", status_code=204)
async def merge(data: MergeIn, session: AsyncSession = Depends(get_session)):
    try:
        await merges.merge(session, data.from_key, data.to_key, data.choices)
    except merges.MergeRefused as exc:
        raise _refused(exc)
    except merges.MergeNeedsChoice as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/merges/{from_key}", status_code=204)
async def unmerge(from_key: str, session: AsyncSession = Depends(get_session)):
    try:
        await merges.unmerge(session, from_key)
    except merges.MergeRefused as exc:
        raise _refused(exc)


@router.get("/{key}", response_model=IngredientDetail)
async def ingredient(key: str, session: AsyncSession = Depends(get_session)):
    """One ingredient. A name merged into another answers with the other."""
    found = await ingredients.ingredient(session, key)
    if found is None:
        raise HTTPException(status_code=404, detail="No ingredient called that.")
    return found
