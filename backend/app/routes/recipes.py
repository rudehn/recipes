import uuid
from collections import Counter
from datetime import date
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from sqlalchemy import Select, case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from ..config import ALLOWED_IMAGE_TYPES, IMAGES_DIR, MAX_IMAGE_BYTES
from ..db import get_session
from ..models import (
    Ingredient,
    MealPlanEntry,
    MealRepeat,
    MealRepeatSkip,
    Recipe,
    RecipeTag,
)
from ..schemas import (
    MAX_TAG_FILTERS,
    ImageFromUrl,
    IngredientKey,
    IngredientName,
    IngredientSuggestion,
    RecentSearch,
    RecipeAttention,
    RecipeCost,
    RecipeFacets,
    RecipeIn,
    RecipeNutrition,
    RecipeOut,
    RecipePage,
    RecipeRef,
    RecipeSummary,
    SearchIn,
    SearchSuggestions,
    TagCount,
    TagName,
)
from ..services import search_history
from ..services.attention import recipes_needing_a_look
from ..services.identity import Identity
from ..services.images import (
    ImageTooLarge,
    declared_length_exceeds,
    read_capped,
    upload_chunks,
)
from ..services.kroger import costing
from ..services.labels import unlabel_entries, unlabel_repeats
from ..services.nutrition import facts as nutrition
from ..services.plan import last_planned
from ..services.recipe_filters import ingredient_names, intersect, recipes_using

router = APIRouter(prefix="/recipes", tags=["recipes"])

DEFAULT_PER_PAGE = 24
# An uncapped page size would restore the unbounded query that pagination is
# here to remove.
MAX_PER_PAGE = 100

RecipeSort = Literal["title", "newest", "cooked", "sale"]

# An ingredient filter is a key (or a name, which is reduced to one), bounded
# like the rest: each one is read against every recipe's ingredients.
IngredientParam = IngredientKey
MAX_INGREDIENT_FILTERS = 20
# A typed-ahead group is a handful of choices, not a second list.
MAX_SUGGESTIONS = 5

# Every sort ends on a unique column. Ordering by title alone is not stable -
# two recipes may share one - and an unstable order lets offsets skip or repeat
# rows between one page request and the next.
_SORTS: dict[str, tuple] = {
    "title": (Recipe.title.asc(), Recipe.id.asc()),
    "newest": (Recipe.created_at.desc(), Recipe.id.desc()),
    # Without sale data nothing is on sale, which leaves the title order.
    # With it, `list_recipes` puts the percentages in front.
    "sale": (Recipe.title.asc(), Recipe.id.asc()),
    # `list_recipes` joins the last-cooked dates in front of this.
    "cooked": (Recipe.title.asc(), Recipe.id.asc()),
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


def _tag_filter(tags: list[str]) -> list[str]:
    """The tags a filter names, spelled the way they are stored.

    Tags are stored trimmed and lowercased, so a filter has to be to match
    one, and naming the same tag twice is still asking for it once.
    """
    return list(dict.fromkeys(name for name in (t.strip().lower() for t in tags) if name))


def _filtered_recipes(q: str, tags: list[str], only: set[int] | None = None) -> Select:
    """Recipes matching the filters, unordered and unpaginated.

    Both the page query and the count run off this, so a total can never
    disagree with the rows it counts. Related tables are matched with EXISTS
    rather than a join, so a recipe with three matching ingredients is still
    one result - and each tag is an EXISTS of its own, so a recipe has to
    carry every tag named, not just one of them. `only` restricts the result
    to those ids, and an empty set matches nothing.
    """
    stmt = select(Recipe)
    if only is not None:
        stmt = stmt.where(Recipe.id.in_(only))
    for name in tags:
        stmt = stmt.where(Recipe.tag_rows.any(RecipeTag.name == name))
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


async def _restricted(
    session: AsyncSession,
    q: str,
    tags: list[str],
    ingredients: list[str],
    on_sale: bool,
    *,
    sales_wanted: bool = True,
) -> tuple[Select, dict[int, int] | None]:
    """Recipes matching every filter, and the sale percentages found on the way.

    The list, the facets and the suggestions all answer to this, so a count
    the page shows can never disagree with the recipes a click on it lists.
    Sales are None when there is no sale data, and are only worked out when
    the caller uses them or the On sale filter needs them: they cost a
    lookup of every recipe's prices. Without sale data nothing is on sale.
    """
    sales = await costing.sale_percentages(session) if sales_wanted or on_sale else None
    # Both restrictions apply together: on sale AND using every ingredient.
    only = intersect(
        set(sales or ()) if on_sale else None,
        await recipes_using(session, ingredients) if ingredients else None,
    )
    return _filtered_recipes(q.strip(), _tag_filter(tags), only), sales


@router.get("", response_model=RecipePage)
async def list_recipes(
    q: str = Query(default="", max_length=100),
    tag: list[TagName] = Query(default=[], max_length=MAX_TAG_FILTERS),
    ingredient: list[IngredientParam] = Query(default=[], max_length=MAX_INGREDIENT_FILTERS),
    sort: RecipeSort = "title",
    on_sale: bool = False,
    today: date | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    session: AsyncSession = Depends(get_session),
):
    filtered, sales = await _restricted(session, q, tag, ingredient, on_sale)
    sales = sales or {}
    total = await session.scalar(select(func.count()).select_from(filtered.subquery()))

    order = _SORTS[sort]
    if sort == "sale" and sales:
        # Biggest first, and everything not on sale after it. An empty mapping
        # is not valid for `case`, hence the guard.
        order = (case(sales, value=Recipe.id, else_=-1).desc(), *_SORTS["sale"])

    if sort == "cooked":
        # Plans in the future are intentions, not history: a recipe planned
        # only for tomorrow has not been cooked, so it ranks with the rest.
        # Today is the owner's, as the page sends it: the server's clock may
        # be on UTC, already tomorrow during a US evening.
        last = await last_planned(session, today or date.today())
        if last:
            # Most recent first, and what was never cooked after it. An empty
            # mapping is not valid for `case`, hence the guard.
            order = (
                case(last, value=Recipe.id, else_=None).desc().nulls_last(),
                *_SORTS["cooked"],
            )

    # A page past the end is an empty page, not an error: the collection can
    # shrink under a client that is holding a page number.
    result = await session.execute(
        filtered.options(noload(Recipe.ingredients))
        .order_by(*order)
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    return {
        "items": [
            RecipeSummary.model_validate(r).model_copy(update={"sale_percent": sales.get(r.id)})
            for r in result.scalars().all()
        ],
        "total": total or 0,
        "page": page,
        "per_page": per_page,
    }


@router.get("/tags", response_model=list[TagCount])
async def list_tags(
    q: str = Query(default="", max_length=100),
    tag: list[TagName] = Query(default=[], max_length=MAX_TAG_FILTERS),
    session: AsyncSession = Depends(get_session),
):
    """Every tag in use, each counted within the filters, for the filter bar.

    Takes the list's own filters, so a tag's count is how many recipes the
    list would show with that tag selected too. A tag none of them carry is
    still listed, at zero, rather than left out: the bar keeps every pill
    where it was and dims the ones that lead nowhere, instead of reshuffling
    under the finger that just tapped it.

    Declared above /{recipe_id} so that path does not swallow "tags".
    """
    counts = await _tag_counts(session, _filtered_recipes(q.strip(), _tag_filter(tag)))
    return [{"name": name, "count": count} for name, count in sorted(counts.items())]


async def _tag_counts(session: AsyncSession, filtered: Select) -> dict[str, int]:
    """Every tag in use, with how many of the `filtered` recipes carry it."""
    matching = filtered.with_only_columns(Recipe.id)
    result = await session.execute(
        select(
            RecipeTag.name,
            func.count(RecipeTag.recipe_id).filter(RecipeTag.recipe_id.in_(matching)),
        ).group_by(RecipeTag.name)
    )
    return dict(result.tuples().all())


@router.get("/facets", response_model=RecipeFacets)
async def facets(
    q: str = Query(default="", max_length=100),
    tag: list[TagName] = Query(default=[], max_length=MAX_TAG_FILTERS),
    ingredient: list[IngredientParam] = Query(default=[], max_length=MAX_INGREDIENT_FILTERS),
    on_sale: bool = False,
    session: AsyncSession = Depends(get_session),
):
    """What the quick row offers within the filters.

    Tags come most-searched first, so the row shows what the owner reaches
    for; with no history that is the tags with the most recipes. Every tag is
    listed, zeros included, and the page leaves out the dead ends itself.

    Declared above /{recipe_id} so that path does not swallow "facets".
    """
    filtered, sales = await _restricted(session, q, tag, ingredient, on_sale)
    counts = await _tag_counts(session, filtered)
    frequency = await search_history.tag_frequency(session)
    tags = sorted(counts, key=lambda name: (-frequency[name], -counts[name], name))

    # Without sale data there is nothing to count, which the page shows as no
    # On sale chip; zero is sale data saying none of these are on sale.
    on_sale_count = None
    if sales is not None:
        on_sale_count = await session.scalar(
            select(func.count()).select_from(filtered.where(Recipe.id.in_(set(sales))).subquery())
        )

    # Each ingredient is named as the one it is now, after merges, but under
    # the key it was asked for by: that is the key the page's token holds.
    identity = await Identity.of(session)
    names = await ingredient_names(session)
    asked = dict.fromkeys(k.strip() for k in ingredient if k.strip())
    named = []
    for key in asked:
        resolved = identity.resolve(key.lower())
        named.append(
            IngredientName(key=key, name=names.get(resolved) or resolved.replace("-", " "))
        )
    return {
        "tags": [{"name": name, "count": counts[name]} for name in tags],
        "on_sale": on_sale_count,
        "ingredients": named,
    }


@router.get("/suggest", response_model=SearchSuggestions)
async def suggest(
    text: str = Query(default="", max_length=100),
    q: str = Query(default="", max_length=100),
    tag: list[TagName] = Query(default=[], max_length=MAX_TAG_FILTERS),
    ingredient: list[IngredientParam] = Query(default=[], max_length=MAX_INGREDIENT_FILTERS),
    on_sale: bool = False,
    session: AsyncSession = Depends(get_session),
):
    """Ingredients, tags and recipes whose names contain the typed `text`.

    Counted within the filters, so a suggestion promises what picking it
    would leave. One that would leave nothing is a dead end and is left out,
    as is anything the filters already hold.

    Declared above /{recipe_id} so that path does not swallow "suggest".
    """
    needle = text.strip().casefold()
    if not needle:
        return {"ingredients": [], "tags": [], "recipes": []}
    filtered, _ = await _restricted(session, q, tag, ingredient, on_sale, sales_wanted=False)

    counts = await _tag_counts(session, filtered)
    picked_tags = set(_tag_filter(tag))
    tags = sorted(
        (
            (name, count)
            for name, count in counts.items()
            if count and needle in name.casefold() and name not in picked_tags
        ),
        key=lambda pair: (-pair[1], pair[0]),
    )[:MAX_SUGGESTIONS]

    identity = await Identity.of(session)
    picked = {identity.resolve(k.strip().lower()) for k in ingredient if k.strip()}
    in_scope = filtered.with_only_columns(Recipe.id)
    used: dict[int, set[str]] = {}
    rows = await session.execute(
        select(Ingredient.recipe_id, Ingredient.name).where(Ingredient.recipe_id.in_(in_scope))
    )
    for recipe_id, name in rows.tuples():
        used.setdefault(recipe_id, set()).add(identity.key(name))
    uses: Counter[str] = Counter(key for keys in used.values() for key in keys)
    names = await ingredient_names(session)
    named = [
        (key, names.get(key) or key.replace("-", " "), count)
        for key, count in uses.items()
        if key and key not in picked
    ]
    ingredients = sorted(
        (item for item in named if needle in item[1].casefold()),
        key=lambda item: (-item[2], item[1]),
    )[:MAX_SUGGESTIONS]

    titled = await session.scalars(
        filtered.where(Recipe.title.ilike(_contains(needle), escape="\\"))
        .options(noload(Recipe.ingredients))
        .order_by(Recipe.title.asc(), Recipe.id.asc())
        .limit(MAX_SUGGESTIONS)
    )
    return {
        "ingredients": [
            IngredientSuggestion(key=key, name=name, count=count)
            for key, name, count in ingredients
        ],
        "tags": [{"name": name, "count": count} for name, count in tags],
        "recipes": [RecipeRef(id=r.id, title=r.title) for r in titled],
    }


@router.post("/searches", status_code=204)
async def record_search(search: SearchIn, session: AsyncSession = Depends(get_session)):
    """Remember that a recipe was opened from this search.

    Declared above /{recipe_id} so that path does not swallow "searches".
    """
    await search_history.record(session, search)


@router.get("/searches", response_model=list[RecentSearch])
async def recent_searches(
    limit: int = Query(default=5, ge=1, le=8),
    session: AsyncSession = Depends(get_session),
):
    """The distinct searches of the last 60 days, newest first."""
    return await search_history.recent(session, limit)


@router.delete("/searches", status_code=204)
async def forget_search(
    signature: str = Query(max_length=64),
    session: AsyncSession = Depends(get_session),
):
    """Forget a search, every time it was made."""
    await search_history.forget(session, signature)


@router.get("/attention", response_model=list[RecipeAttention])
async def attention(session: AsyncSession = Depends(get_session)):
    """Recipes with rows that will price, shop or count wrongly.

    Declared above /{recipe_id} so that path does not swallow it. String
    checks and the bundled nutrition tables over every row, plus "nothing
    matched" from picks already made at the chosen store - never a search -
    so it costs a few queries for the whole box and no Kroger call.
    """
    return await recipes_needing_a_look(session)


@router.post("", response_model=RecipeOut, status_code=201)
async def create_recipe(data: RecipeIn, session: AsyncSession = Depends(get_session)):
    recipe = Recipe(
        title=data.title,
        description=data.description,
        instructions=data.instructions,
        prep_minutes=data.prep_minutes,
        cook_minutes=data.cook_minutes,
        servings=data.servings,
        source_url=data.source_url,
        ingredients=[
            Ingredient(
                name=i.name,
                quantity=i.quantity,
                unit=i.unit,
                position=pos,
                source_line=i.source_line,
            )
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


@router.get("/{recipe_id}/cost", response_model=RecipeCost | None)
async def recipe_cost(recipe_id: int, session: AsyncSession = Depends(get_session)):
    """What the recipe costs to cook, and how much of it that figure covers.

    Null rather than an error when there is nothing to price with: pricing
    is opt-in and a recipe page without a price is the ordinary page.
    """
    recipe = await _get_recipe(session, recipe_id)
    return await costing.recipe_cost(session, recipe)


@router.get("/{recipe_id}/nutrition", response_model=RecipeNutrition)
async def recipe_nutrition(recipe_id: int, session: AsyncSession = Depends(get_session)):
    """Nutrition per serving, and every ingredient's part in it.

    Always answered, since the figures are bundled rather than fetched. The
    figure itself is null until the whole recipe can be counted; the lines
    say what is stopping it.
    """
    recipe = await _get_recipe(session, recipe_id)
    return await nutrition.recipe_nutrition(session, recipe)


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
    recipe.source_url = data.source_url
    recipe.ingredients = [
        Ingredient(
            name=i.name, quantity=i.quantity, unit=i.unit, position=pos, source_line=i.source_line
        )
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
    # SQLite does not enforce foreign keys, so what hangs off the recipe goes
    # explicitly: its one-off meals, its repeats and what hangs off them.
    repeat_ids = select(MealRepeat.id).where(MealRepeat.recipe_id == recipe_id)
    meals = or_(
        MealPlanEntry.recipe_id == recipe_id, MealPlanEntry.from_repeat_id.in_(repeat_ids)
    )
    await unlabel_entries(session, meals)
    await unlabel_repeats(session, MealRepeat.recipe_id == recipe_id)
    await session.execute(delete(MealPlanEntry).where(meals))
    await session.execute(
        delete(MealRepeatSkip).where(MealRepeatSkip.repeat_id.in_(repeat_ids))
    )
    await session.execute(delete(MealRepeat).where(MealRepeat.recipe_id == recipe_id))
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
