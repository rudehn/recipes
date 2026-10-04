from collections.abc import Sequence

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Recipe, RecipeTag
from ..schemas import (
    ImportRequest,
    PastedRecipeDraft,
    RecipeDraft,
    RecipeSearchRequest,
    RecipeTextRequest,
)
from ..services.fetch import BROWSER_HEADERS
from ..services.recipe_import import RecipeNotFound, parse_recipe_html
from ..services.recipe_search import search_recipes, site_label
from ..services.recipe_source import source_key
from ..services.recipe_text import UnreadableText, read_recipe_text

router = APIRouter(prefix="/import", tags=["import"])


async def _mark_already_saved(session: AsyncSession, drafts: Sequence[RecipeDraft]) -> None:
    """Point each draft at the saved recipe imported from the same page.

    The keys are worked out here, on every call, rather than stored in an
    indexed column beside each link. A stored key is a second copy of the
    link that every change to `source_key` turns stale, so improving the
    match would need a data migration each time - the cost ADR 2 records for
    the grocery key. Working it out costs one read of the saved links, which
    for one household's box is a few hundred short strings against an import
    or a search that has already spent seconds fetching pages. If the box
    ever grows to where that read shows, this is the one function to change.

    Where a page was saved twice the older recipe is the one named, so the
    answer does not move when another copy is made.
    """
    if not drafts:
        return
    result = await session.execute(
        select(Recipe.id, Recipe.source_url)
        .where(Recipe.source_url.is_not(None))
        .order_by(Recipe.id)
    )
    saved: dict[str, int] = {}
    for recipe_id, url in result.all():
        saved.setdefault(source_key(url), recipe_id)
    for draft in drafts:
        # Pasted text with no link names no page, so it matches none, however
        # many recipes were saved without one.
        draft.saved_recipe_id = (
            saved.get(source_key(draft.source_url)) if draft.source_url else None
        )


async def _tags_in_use(session: AsyncSession) -> set[str]:
    """The tags already in the recipe box, which an imported recipe's
    suggested tags are spelled against. See recipe_import.suggest_tags."""
    return set((await session.scalars(select(RecipeTag.name).distinct())).all())


@router.post("/recipe", response_model=RecipeDraft)
async def import_recipe(data: ImportRequest, session: AsyncSession = Depends(get_session)):
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15, headers=BROWSER_HEADERS
        ) as client:
            resp = await client.get(str(data.url))
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch that page: {exc}")

    try:
        draft = parse_recipe_html(resp.text, str(data.url), await _tags_in_use(session))
    except RecipeNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    draft.source_label = site_label(str(data.url))
    await _mark_already_saved(session, [draft])
    return draft


@router.post("/text", response_model=PastedRecipeDraft)
async def import_text(data: RecipeTextRequest, session: AsyncSession = Depends(get_session)):
    """A recipe pasted in as text, read into a draft for the form.

    Nothing is fetched: a link the text names becomes the draft's source, so
    the form can save it and say when that page is already in the box, but
    the page itself is not read. Text that could only be partly read is
    still a draft, with what is missing named on it; only empty text, or
    text far longer than a recipe, is refused."""
    try:
        draft = read_recipe_text(data.text, await _tags_in_use(session))
    except UnreadableText as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if draft.source_url:
        draft.source_label = site_label(draft.source_url)
    await _mark_already_saved(session, [draft])
    return draft


@router.post("/search", response_model=list[RecipeDraft])
async def search(data: RecipeSearchRequest, session: AsyncSession = Depends(get_session)):
    """Candidate recipes for a dish, parsed but unsaved, for side-by-side
    comparison.

    Sites that fail are dropped rather than failing the search, and finding
    nothing is an ordinary outcome: this returns an empty list, so the client
    can show "no matches" instead of an error.

    Results already in the recipe box say so, but are not dropped: the box's
    copy may have been edited away from the original, and seeing the two
    side by side is a reason to have searched."""
    drafts = await search_recipes(data.query.strip(), await _tags_in_use(session))
    await _mark_already_saved(session, drafts)
    return drafts
