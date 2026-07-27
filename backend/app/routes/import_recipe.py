import httpx
from fastapi import APIRouter, HTTPException

from ..schemas import ImportRequest, RecipeDraft, RecipeSearchRequest
from ..services.fetch import BROWSER_HEADERS
from ..services.recipe_import import RecipeNotFound, parse_recipe_html
from ..services.recipe_search import search_recipes

router = APIRouter(prefix="/import", tags=["import"])


@router.post("/recipe", response_model=RecipeDraft)
async def import_recipe(data: ImportRequest):
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15, headers=BROWSER_HEADERS
        ) as client:
            resp = await client.get(str(data.url))
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch that page: {exc}")

    try:
        return parse_recipe_html(resp.text, str(data.url))
    except RecipeNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/search", response_model=list[RecipeDraft])
async def search(data: RecipeSearchRequest):
    """Candidate recipes for a dish, parsed but unsaved, for side-by-side
    comparison.

    Sites that fail are dropped rather than failing the search, and finding
    nothing is an ordinary outcome: this returns an empty list, so the client
    can show "no matches" instead of an error."""
    return await search_recipes(data.query.strip())
