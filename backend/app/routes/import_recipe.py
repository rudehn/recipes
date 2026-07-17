import httpx
from fastapi import APIRouter, HTTPException

from ..schemas import ImportRequest, RecipeDraft
from ..services.recipe_import import RecipeNotFound, parse_recipe_html

router = APIRouter(prefix="/import", tags=["import"])

# Some sites block default client UAs; a browser-ish UA is the norm here.
FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
}


@router.post("/recipe", response_model=RecipeDraft)
async def import_recipe(data: ImportRequest):
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15, headers=FETCH_HEADERS
        ) as client:
            resp = await client.get(str(data.url))
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch that page: {exc}")

    try:
        return parse_recipe_html(resp.text, str(data.url))
    except RecipeNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc))
