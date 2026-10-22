from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import PlanLabel, meal_plan_entry_labels, meal_repeat_labels
from ..schemas import LabelIn, LabelOut, LabelUsage
from ..services import labels

router = APIRouter(prefix="/labels", tags=["labels"])


@router.get("", response_model=list[LabelUsage])
async def list_labels(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(PlanLabel).order_by(PlanLabel.key))
    counts = await labels.meals_by_label(session)
    return [
        LabelUsage(id=row.id, name=row.name, meals=counts.get(row.id, 0)) for row in rows
    ]


@router.post("", response_model=LabelOut, status_code=201)
async def create_label(data: LabelIn, session: AsyncSession = Depends(get_session)):
    await _refuse_taken(session, data.name)
    label = PlanLabel(name=data.name, key=labels.key_of(data.name))
    session.add(label)
    await session.commit()
    return label


@router.patch("/{label_id}", response_model=LabelOut)
async def rename_label(
    label_id: int, data: LabelIn, session: AsyncSession = Depends(get_session)
):
    label = await _get_label(session, label_id)
    # Re-casing its own name is a rename, not a clash.
    await _refuse_taken(session, data.name, besides=label_id)
    label.name = data.name
    label.key = labels.key_of(data.name)
    await session.commit()
    return label


@router.delete("/{label_id}", status_code=204)
async def delete_label(label_id: int, session: AsyncSession = Depends(get_session)):
    """Delete the label, which takes it off every meal that carried it."""
    label = await _get_label(session, label_id)
    # SQLite does not enforce foreign keys, so the links go explicitly.
    await session.execute(
        delete(meal_plan_entry_labels).where(meal_plan_entry_labels.c.label_id == label_id)
    )
    await session.execute(
        delete(meal_repeat_labels).where(meal_repeat_labels.c.label_id == label_id)
    )
    await session.delete(label)
    await session.commit()


async def _get_label(session: AsyncSession, label_id: int) -> PlanLabel:
    label = await session.get(PlanLabel, label_id)
    if label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    return label


async def _refuse_taken(session: AsyncSession, name: str, besides: int | None = None) -> None:
    query = select(PlanLabel.id).where(PlanLabel.key == labels.key_of(name))
    if besides is not None:
        query = query.where(PlanLabel.id != besides)
    if await session.scalar(query) is not None:
        raise HTTPException(status_code=409, detail=f"There is already a label called {name}.")
