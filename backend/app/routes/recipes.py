import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import ALLOWED_IMAGE_TYPES, IMAGES_DIR, MAX_IMAGE_BYTES
from ..db import get_session
from ..models import Ingredient, Recipe
from ..schemas import RecipeIn, RecipeOut, RecipeSummary

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
    )
    session.add(recipe)
    await session.commit()
    await session.refresh(recipe)
    return recipe


@router.get("/{recipe_id}", response_model=RecipeOut)
async def get_recipe(recipe_id: int, session: AsyncSession = Depends(get_session)):
    return await _get_recipe(session, recipe_id)


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
