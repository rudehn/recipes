from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import PantryItem
from ..schemas import PantryItemIn, PantryItemOut, PantryItemUpdate

router = APIRouter(prefix="/pantry", tags=["pantry"])


async def _get_item(session: AsyncSession, item_id: int) -> PantryItem:
    item = await session.get(PantryItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Pantry item not found")
    return item


async def _name_taken(
    session: AsyncSession, name: str, exclude_id: int | None = None
) -> bool:
    query = select(PantryItem).where(
        func.lower(PantryItem.name) == name.strip().lower()
    )
    if exclude_id is not None:
        query = query.where(PantryItem.id != exclude_id)
    return (await session.execute(query)).scalar_one_or_none() is not None


@router.get("", response_model=list[PantryItemOut])
async def list_items(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(PantryItem).order_by(PantryItem.name))
    return result.scalars().all()


@router.post("", response_model=PantryItemOut, status_code=201)
async def create_item(data: PantryItemIn, session: AsyncSession = Depends(get_session)):
    if await _name_taken(session, data.name):
        raise HTTPException(status_code=409, detail="Pantry item already exists")
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
        if await _name_taken(session, data.name, exclude_id=item_id):
            raise HTTPException(status_code=409, detail="Pantry item already exists")
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
