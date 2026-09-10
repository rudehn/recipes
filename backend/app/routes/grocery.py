from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import GroceryCheck, PantryItem
from ..schemas import GroceryList, GroceryMark
from ..services.grocery import build_grocery_list, item_key
from ..services.kroger import pricing

router = APIRouter(prefix="/grocery-list", tags=["grocery-list"])


@router.get("", response_model=GroceryList)
async def get_grocery_list(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    grocery_list = await build_grocery_list(session, start, end)
    # Prices are attached after the fact and never in the way: attach_prices
    # returns the list unchanged if pricing is off, no store is set, or Kroger
    # is unreachable.
    return await pricing.attach_prices(session, grocery_list)


@router.post("/mark", status_code=204)
async def mark_item(data: GroceryMark, session: AsyncSession = Depends(get_session)):
    """Say what a line is this trip: bought, already at home, or neither.

    "to_buy" removes the mark rather than storing a third value, so a line
    with nothing to say about it has no row, which is also what a new trip
    leaves behind.
    """
    mark = await session.get(GroceryCheck, data.key)
    if data.status == "to_buy":
        if mark is not None:
            await session.delete(mark)
    elif mark is None:
        session.add(GroceryCheck(key=data.key, status=data.status))
    else:
        mark.status = data.status

    # Either mark on a pantry-tracked item restocks it: buying "olive oil"
    # puts it back in stock, and so does saying there is already enough at
    # home, which is the same fact told a different way. Taking the mark
    # off undoes that.
    result = await session.execute(select(PantryItem))
    for pantry in result.scalars().all():
        if item_key(pantry.name) == data.key:
            pantry.in_stock = data.status != "to_buy"
    await session.commit()


@router.post("/new-trip", status_code=204)
async def new_trip(session: AsyncSession = Depends(get_session)):
    """Clear every mark, bought and at-home alike.

    Both are statements about one trip. "Have it" in particular is only true
    of the week it was said in - the avocados that were on the counter are
    gone by the next list - so it is not allowed to outlive the ticks.
    """
    await session.execute(delete(GroceryCheck))
    await session.commit()
