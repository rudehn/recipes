from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import GroceryCheck, PantryItem
from ..schemas import GroceryList, GroceryMark, GroceryPrices, LinePricing
from ..services.grocery import build_grocery_list, item_key
from ..services.kroger import cart, pricing

router = APIRouter(prefix="/grocery-list", tags=["grocery-list"])


@router.get("", response_model=GroceryList)
async def get_grocery_list(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    """The list, from the database alone.

    No Kroger call is made here, so the page shows what to buy at once and
    asks for prices separately. The list is the product; prices are a
    garnish that must never be able to delay it.
    """
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    return await build_grocery_list(session, start, end)


@router.get("/prices", response_model=GroceryPrices)
async def get_grocery_prices(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    """The prices for the same list, fetched after it.

    Rebuilt from the same range so the total honours the same marks. Empty
    rather than an error when pricing is off, no store is set, or Kroger is
    unreachable: a list without prices is the ordinary list.
    """
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    grocery_list = await pricing.attach_prices(
        session, await build_grocery_list(session, start, end)
    )
    return GroceryPrices(
        pricing=grocery_list.pricing,
        lines=[
            LinePricing(
                key=line.key,
                price=line.price,
                hand_picked=line.hand_picked,
                issue=line.issue,
            )
            for line in [*grocery_list.items, *grocery_list.pantry_restock]
        ],
    )


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
    """Clear every mark, bought and at-home alike, and the record of what went
    to the cart.

    All three are statements about one trip. "Have it" in particular is only
    true of the week it was said in - the avocados that were on the counter
    are gone by the next list - so it is not allowed to outlive the ticks.
    And a new trip is a new cart, so what the old one was sent no longer
    holds anything back.
    """
    await session.execute(delete(GroceryCheck))
    await session.commit()
    await cart.forget_sent(session)
