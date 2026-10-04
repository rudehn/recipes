import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import ImportRequest, RecipeDraft, RecipeSearchRequest
from ..services.fetch import BROWSER_HEADERS
from ..services.recipe_import import RecipeNotFound, parse_recipe_html
from ..services.recipe_search import search_recipes, site_label
from ..services.recipe_source import mark_already_saved

router = APIRouter(prefix="/import", tags=["import"])


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
    await mark_already_saved(session, [draft])
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
    await mark_already_saved(session, drafts)
    return drafts
