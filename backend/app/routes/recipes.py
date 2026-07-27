import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import ALLOWED_IMAGE_TYPES, IMAGES_DIR, MAX_IMAGE_BYTES
from ..db import get_session
from ..models import Ingredient, Recipe, RecipeTag
from ..schemas import ImageFromUrl, RecipeIn, RecipeOut, RecipeSummary

router = APIRouter(prefix="/recipes", tags=["recipes"])


async def _get_recipe(session: AsyncSession, recipe_id: int) -> Recipe:
    recipe = await session.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


@router.get("", response_model=list[RecipeSummary])
async def list_recipes(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Recipe).order_by(Recipe.title))
    return result.scalars().all()


@router.post("", response_model=RecipeOut, status_code=201)
async def create_recipe(data: RecipeIn, session: AsyncSession = Depends(get_session)):
    recipe = Recipe(
        title=data.title,
        description=data.description,
        instructions=data.instructions,
        prep_minutes=data.prep_minutes,
        cook_minutes=data.cook_minutes,
        servings=data.servings,
        ingredients=[
            Ingredient(name=i.name, quantity=i.quantity, unit=i.unit, position=pos)
            for pos, i in enumerate(data.ingredients)
        ],
        tag_rows=[RecipeTag(name=t) for t in data.normalized_tags()],
    )
    session.add(recipe)
    await session.commit()
    await session.refresh(recipe)
    return recipe


@router.get("/{recipe_id}", response_model=RecipeOut)
async def get_recipe(recipe_id: int, session: AsyncSession = Depends(get_session)):
    return await _get_recipe(session, recipe_id)


def _sync_tags(recipe: Recipe, wanted: list[str]) -> None:
    """Reconcile a recipe's tag rows against the names it should now carry.

    Assigning a fresh list of RecipeTag objects looks equivalent but is not:
    each one is transient, so the ORM inserts every tag and orphan-deletes the
    old rows. It flushes those inserts before the deletes, and recipe_tags is
    unique on (recipe_id, name) - so a tag the user kept collides with its own
    row that has not been deleted yet, and the save fails.

    Touching only the difference sidesteps that ordering entirely: a kept tag
    emits no SQL at all, and inserts and deletes can never involve the same
    name, since a name is either wanted or it is not.
    """
    keep = set(wanted)
    for row in list(recipe.tag_rows):
        if row.name not in keep:
            recipe.tag_rows.remove(row)
    existing = {row.name for row in recipe.tag_rows}
    for name in wanted:
        if name not in existing:
            recipe.tag_rows.append(RecipeTag(name=name))


@router.put("/{recipe_id}", response_model=RecipeOut)
async def update_recipe(
    recipe_id: int, data: RecipeIn, session: AsyncSession = Depends(get_session)
):
    recipe = await _get_recipe(session, recipe_id)
    recipe.title = data.title
    recipe.description = data.description
    recipe.instructions = data.instructions
    recipe.prep_minutes = data.prep_minutes
    recipe.cook_minutes = data.cook_minutes
    recipe.servings = data.servings
    recipe.ingredients = [
        Ingredient(name=i.name, quantity=i.quantity, unit=i.unit, position=pos)
        for pos, i in enumerate(data.ingredients)
    ]
    _sync_tags(recipe, data.normalized_tags())
    await session.commit()
    await session.refresh(recipe)
    return recipe


@router.delete("/{recipe_id}", status_code=204)
async def delete_recipe(recipe_id: int, session: AsyncSession = Depends(get_session)):
    recipe = await _get_recipe(session, recipe_id)
    _delete_image_file(recipe.image_filename)
    await session.delete(recipe)
    await session.commit()


def _delete_image_file(filename: str | None) -> None:
    if not filename:
        return
    path = IMAGES_DIR / filename
    if path.is_file():
        path.unlink()


@router.post("/{recipe_id}/image", response_model=RecipeOut)
async def upload_image(
    recipe_id: int, file: UploadFile, session: AsyncSession = Depends(get_session)
):
    recipe = await _get_recipe(session, recipe_id)
    ext = ALLOWED_IMAGE_TYPES.get(file.content_type or "")
    if ext is None:
        raise HTTPException(
            status_code=415, detail="Image must be JPEG, PNG, or WebP"
        )
    content = await file.read()
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image larger than 10 MB")

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ext}"
    (IMAGES_DIR / filename).write_bytes(content)

    _delete_image_file(recipe.image_filename)
    recipe.image_filename = filename
    await session.commit()
    await session.refresh(recipe)
    return recipe


@router.delete("/{recipe_id}/image", response_model=RecipeOut)
async def delete_image(recipe_id: int, session: AsyncSession = Depends(get_session)):
    recipe = await _get_recipe(session, recipe_id)
    _delete_image_file(recipe.image_filename)
    recipe.image_filename = None
    await session.commit()
    await session.refresh(recipe)
    return recipe


@router.post("/{recipe_id}/image-from-url", response_model=RecipeOut)
async def image_from_url(
    recipe_id: int, data: ImageFromUrl, session: AsyncSession = Depends(get_session)
):
    """Downloads a photo (used by the URL importer) and attaches it."""
    recipe = await _get_recipe(session, recipe_id)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            resp = await client.get(str(data.url))
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch image: {exc}")

    content_type = resp.headers.get("content-type", "").split(";")[0].strip()
    ext = ALLOWED_IMAGE_TYPES.get(content_type)
    if ext is None:
        raise HTTPException(status_code=415, detail="Image must be JPEG, PNG, or WebP")
    if len(resp.content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image larger than 10 MB")

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ext}"
    (IMAGES_DIR / filename).write_bytes(resp.content)

    _delete_image_file(recipe.image_filename)
    recipe.image_filename = filename
    await session.commit()
    await session.refresh(recipe)
    return recipe
