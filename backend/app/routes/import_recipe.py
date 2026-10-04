from collections.abc import Sequence

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Recipe
from ..schemas import ImportRequest, RecipeDraft, RecipeSearchRequest
from ..services.fetch import BROWSER_HEADERS
from ..services.recipe_import import RecipeNotFound, parse_recipe_html
from ..services.recipe_search import search_recipes, site_label
from ..services.recipe_source import source_key

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
        draft.saved_recipe_id = saved.get(source_key(draft.source_url))


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
        draft = parse_recipe_html(resp.text, str(data.url))
    except RecipeNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    draft.source_label = site_label(str(data.url))
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
    drafts = await search_recipes(data.query.strip())
    await _mark_already_saved(session, drafts)
    return drafts
