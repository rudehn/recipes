from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import GroceryCheck, PantryItem
from ..schemas import GroceryList, GroceryToggle
from ..services.grocery import build_grocery_list, item_key

router = APIRouter(prefix="/grocery-list", tags=["grocery-list"])


@router.get("", response_model=GroceryList)
async def get_grocery_list(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    return await build_grocery_list(session, start, end)


@router.post("/toggle", status_code=204)
async def toggle_item(data: GroceryToggle, session: AsyncSession = Depends(get_session)):
    check = await session.get(GroceryCheck, data.key)
    if check is None:
        check = GroceryCheck(key=data.key, checked=data.checked)
        session.add(check)
    else:
        check.checked = data.checked

    # Buying a pantry-tracked item restocks it: checking off "olive oil" on the
    # list flips the pantry item back to in stock, and unchecking undoes that.
    result = await session.execute(select(PantryItem))
    for pantry in result.scalars().all():
        if item_key(pantry.name) == data.key:
            pantry.in_stock = data.checked
    await session.commit()


@router.post("/clear-checks", status_code=204)
async def clear_checks(session: AsyncSession = Depends(get_session)):
    await session.execute(delete(GroceryCheck))
    await session.commit()
