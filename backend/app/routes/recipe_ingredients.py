"""Recipe lines edited one at a time, from an ingredient's page.

Saving a recipe replaces all its lines, and with them their ids, which the
grocery list and "Needs a look" link to. A line fixed from its ingredient's
page is edited where it is instead, so those links keep landing on it. A
batch is checked whole before anything is written: a fix is all or nothing.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Ingredient
from ..schemas import EditedLine, LineEdit, LineEdits, Reread, RereadRequest
from ..services.identity import Identity
from ..services.quantity import format_quantity
from ..services.recipe_import import parse_ingredient_line

router = APIRouter(prefix="/recipe-ingredients", tags=["recipe-ingredients"])

GONE = "That line is no longer in its recipe; reload to see the recipe as it is now."


async def _lines(session: AsyncSession, ids: list[int]) -> dict[int, Ingredient]:
    found = await session.execute(select(Ingredient).where(Ingredient.id.in_(ids)))
    lines = {row.id: row for row in found.scalars()}
    if any(i not in lines for i in ids):
        raise HTTPException(status_code=404, detail=GONE)
    return lines


def _as_edit(row: Ingredient) -> LineEdit:
    return LineEdit(id=row.id, name=row.name, quantity=row.quantity, unit=row.unit)


def _rebuilt(row: Ingredient) -> str:
    """The line as it reads now, for one whose original was never kept."""
    amount = format_quantity(row.quantity) if row.quantity is not None else ""
    return " ".join(part for part in (amount, row.unit or "", row.name) if part)


@router.patch("", response_model=list[EditedLine])
async def edit_lines(data: LineEdits, session: AsyncSession = Depends(get_session)):
    ids = [edit.id for edit in data.lines]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="Each line can be edited once at a time.")
    lines = await _lines(session, ids)
    identity = await Identity.of(session)
    for edit in data.lines:
        if not identity.key(edit.name):
            raise HTTPException(
                status_code=422, detail=f'"{edit.name.strip()}" is not the name of an ingredient.'
            )
    for edit in data.lines:
        row = lines[edit.id]
        row.name = edit.name.strip()
        row.quantity = edit.quantity
        row.unit = (edit.unit or "").strip() or None
    await session.commit()
    return [
        EditedLine(
            **_as_edit(lines[i]).model_dump(),
            recipe_id=lines[i].recipe_id,
            issue=lines[i].issue,
            key=identity.key(lines[i].name),
        )
        for i in ids
    ]


@router.post("/reread", response_model=list[Reread])
async def reread(data: RereadRequest, session: AsyncSession = Depends(get_session)):
    """What today's importer makes of each line. Nothing is saved."""
    lines = await _lines(session, data.ids)
    found = []
    for i in data.ids:
        row = lines[i]
        parsed = parse_ingredient_line(row.source_line or _rebuilt(row))
        found.append(
            Reread(
                id=row.id,
                before=_as_edit(row),
                after=LineEdit(
                    id=row.id,
                    name=parsed.name,
                    quantity=parsed.quantity,
                    unit=parsed.unit,
                ),
                from_source=row.source_line is not None,
            )
        )
    return found
