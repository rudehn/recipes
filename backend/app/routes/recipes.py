import uuid
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from ..config import ALLOWED_IMAGE_TYPES, IMAGES_DIR, MAX_IMAGE_BYTES
from ..db import get_session
from ..models import Ingredient, Recipe, RecipeTag
from ..schemas import ImageFromUrl, RecipeIn, RecipeOut, RecipePage, TagCount
from ..services.images import (
    ImageTooLarge,
    declared_length_exceeds,
    read_capped,
    upload_chunks,
)

router = APIRouter(prefix="/recipes", tags=["recipes"])

DEFAULT_PER_PAGE = 24
# An uncapped page size would restore the unbounded query that pagination is
# here to remove.
MAX_PER_PAGE = 100

RecipeSort = Literal["title", "newest"]

# Every sort ends on a unique column. Ordering by title alone is not stable -
# two recipes may share one - and an unstable order lets offsets skip or repeat
# rows between one page request and the next.
_SORTS: dict[str, tuple] = {
    "title": (Recipe.title.asc(), Recipe.id.asc()),
    "newest": (Recipe.created_at.desc(), Recipe.id.desc()),
}


def _too_large() -> HTTPException:
    """A fresh instance per raise: a shared one accumulates tracebacks."""
    return HTTPException(status_code=413, detail="Image larger than 10 MB")


async def _get_recipe(session: AsyncSession, recipe_id: int) -> Recipe:
    recipe = await session.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


def _contains(text: str) -> str:
    """A LIKE pattern matching `text` anywhere, with its wildcards defused.

    Unescaped, a search for "100%" would match every recipe.
    """
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _filtered_recipes(q: str, tag: str) -> Select:
    """Recipes matching the filters, unordered and unpaginated.

    Both the page query and the count run off this, so a total can never
    disagree with the rows it counts. Related tables are matched with EXISTS
    rather than a join, so a recipe with three matching ingredients is still
    one result.
    """
    stmt = select(Recipe)
    if tag:
        stmt = stmt.where(Recipe.tag_rows.any(RecipeTag.name == tag))
    if q:
        pattern = _contains(q)
        stmt = stmt.where(
            or_(
                Recipe.title.ilike(pattern, escape="\\"),
                Recipe.description.ilike(pattern, escape="\\"),
                Recipe.tag_rows.any(RecipeTag.name.ilike(pattern, escape="\\")),
                Recipe.ingredients.any(Ingredient.name.ilike(pattern, escape="\\")),
            )
        )
    return stmt


@router.get("", response_model=RecipePage)
async def list_recipes(
    q: str = Query(default="", max_length=100),
    tag: str = Query(default="", max_length=50),
    sort: RecipeSort = "title",
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    session: AsyncSession = Depends(get_session),
):
    # Tags are stored lowercased, so a filter has to be to match one.
    filtered = _filtered_recipes(q.strip(), tag.strip().lower())
    total = await session.scalar(select(func.count()).select_from(filtered.subquery()))

    # A page past the end is an empty page, not an error: the collection can
    # shrink under a client that is holding a page number.
    result = await session.execute(
        filtered.options(noload(Recipe.ingredients))
        .order_by(*_SORTS[sort])
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    return {
        "items": result.scalars().all(),
        "total": total or 0,
        "page": page,
        "per_page": per_page,
    }


@router.get("/tags", response_model=list[TagCount])
async def list_tags(session: AsyncSession = Depends(get_session)):
    """Every tag in use, for the filter bar.

    Declared above /{recipe_id} so that path does not swallow "tags".
    """
    result = await session.execute(
        select(RecipeTag.name, func.count(RecipeTag.recipe_id))
        .group_by(RecipeTag.name)
        .order_by(RecipeTag.name)
    )
    return [{"name": name, "count": count} for name, count in result.all()]


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
    try:
        content = await read_capped(upload_chunks(file), MAX_IMAGE_BYTES)
    except ImageTooLarge:
        raise _too_large()

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
    """Downloads a photo (used by the URL importer) and attaches it.

    Streamed rather than fetched whole: headers alone settle the type, and an
    oversized body is abandoned partway instead of being buffered and then
    measured. See services.images."""
    recipe = await _get_recipe(session, recipe_id)
    try:
        async with (
            httpx.AsyncClient(follow_redirects=True, timeout=20) as client,
            client.stream("GET", str(data.url)) as resp,
        ):
            resp.raise_for_status()

            content_type = resp.headers.get("content-type", "").split(";")[0].strip()
            ext = ALLOWED_IMAGE_TYPES.get(content_type)
            if ext is None:
                raise HTTPException(
                    status_code=415, detail="Image must be JPEG, PNG, or WebP"
                )
            if declared_length_exceeds(
                resp.headers.get("content-length"), MAX_IMAGE_BYTES
            ):
                raise _too_large()

            content = await read_capped(resp.aiter_bytes(), MAX_IMAGE_BYTES)
    except ImageTooLarge:
        raise _too_large()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch image: {exc}")

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ext}"
    (IMAGES_DIR / filename).write_bytes(content)

    _delete_image_file(recipe.image_filename)
    recipe.image_filename = filename
    await session.commit()
    await session.refresh(recipe)
    return recipe
