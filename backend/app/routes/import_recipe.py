import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import RecipeTag
from ..schemas import ImportRequest, RecipeDraft, RecipeSearchRequest
from ..services.fetch import BROWSER_HEADERS
from ..services.recipe_import import RecipeNotFound, parse_recipe_html
from ..services.recipe_search import search_recipes, site_label

router = APIRouter(prefix="/import", tags=["import"])


async def _tags_in_use(session: AsyncSession) -> set[str]:
    """The tags already in the recipe box, which an imported recipe's
    suggested tags are spelled against. See recipe_import._suggest_tags."""
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
    return draft


@router.post("/search", response_model=list[RecipeDraft])
async def search(data: RecipeSearchRequest, session: AsyncSession = Depends(get_session)):
    """Candidate recipes for a dish, parsed but unsaved, for side-by-side
    comparison.

    Sites that fail are dropped rather than failing the search, and finding
    nothing is an ordinary outcome: this returns an empty list, so the client
    can show "no matches" instead of an error."""
    return await search_recipes(data.query.strip(), await _tags_in_use(session))
