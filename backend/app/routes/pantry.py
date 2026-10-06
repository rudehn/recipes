from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import PantryItem
from ..schemas import PantryItemIn, PantryItemOut, PantryItemUpdate
from ..services.identity import Identity

router = APIRouter(prefix="/pantry", tags=["pantry"])


async def _get_item(session: AsyncSession, item_id: int) -> PantryItem:
    item = await session.get(PantryItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Pantry item not found")
    return item


async def _refuse_a_second(
    session: AsyncSession, name: str, exclude_id: int | None = None
) -> None:
    """Refuse a name for a staple that another staple already is.

    Compared as ingredients, not spellings: "Eggs" beside "Egg", or "Ground
    cumin" once it is merged into a "Cumin" staple, is the same ingredient,
    and the Ingredients page shows one staple per ingredient, so a second
    would be hidden and adding it would seem to do nothing. Respelling a
    staple as itself ("Egg" to "Eggs") is not a second one.
    """
    identity = await Identity.of(session)
    key = identity.key(name)
    spelled = name.strip().casefold()
    for staple in (await session.execute(select(PantryItem))).scalars():
        if staple.id == exclude_id:
            continue
        if (key and identity.key(staple.name) == key) or staple.name.casefold() == spelled:
            raise HTTPException(status_code=409, detail=f"{staple.name} is already a staple.")


@router.get("", response_model=list[PantryItemOut])
async def list_items(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(PantryItem).order_by(PantryItem.name))
    return result.scalars().all()


@router.post("", response_model=PantryItemOut, status_code=201)
async def create_item(data: PantryItemIn, session: AsyncSession = Depends(get_session)):
    await _refuse_a_second(session, data.name)
    item = PantryItem(name=data.name.strip(), in_stock=data.in_stock)
    session.add(item)
    await session.commit()
    await session.refresh(item)
    return item


@router.put("/{item_id}", response_model=PantryItemOut)
async def update_item(
    item_id: int, data: PantryItemUpdate, session: AsyncSession = Depends(get_session)
):
    item = await _get_item(session, item_id)
    if data.name is not None:
        await _refuse_a_second(session, data.name, exclude_id=item_id)
        item.name = data.name.strip()
    if data.in_stock is not None:
        item.in_stock = data.in_stock
    await session.commit()
    await session.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
async def delete_item(item_id: int, session: AsyncSession = Depends(get_session)):
    item = await _get_item(session, item_id)
    await session.delete(item)
    await session.commit()
