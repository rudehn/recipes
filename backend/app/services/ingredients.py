"""Every ingredient seen whole: its recipes, staple, product and food.

The app has always treated an ingredient as one thing in four places - the
grocery line, the staple, the product, the food - but kept them on three
screens. This puts them together for the Ingredients page, worked out from
the recipe lines, the staples, the picks already made and the bundled
nutrition data.

Nothing here searches Kroger, for the reason ADR 6 gives for anything that
merely lists: products come from the stored picks and one batched lookup
for their prices, and a Kroger that fails costs the prices, not the page.
Changes are made through the endpoints that already make them (pantry,
product match, food match), so there is no second way to change one thing.
"""

import logging
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import IngredientMergeDismissal, PantryItem, Recipe
from ..schemas import (
    IngredientDetail,
    IngredientFood,
    IngredientFoodEntry,
    IngredientLine,
    IngredientList,
    IngredientProblem,
    IngredientProduct,
    IngredientStaple,
    IngredientSummary,
    MergedName,
    MergeSuggestion,
)
from . import merge_suggestions
from . import settings as settings_service
from .canonical import best_display
from .identity import Identity
from .kroger import matching, products
from .kroger.client import KrogerError, enabled
from .kroger.pricing import as_item_price
from .nutrition import facts, foods
from .nutrition.defaults import default_for

log = logging.getLogger(__name__)

# Keys as `canonical_key` makes them, before merges: what "also called" lists.
_RAW = Identity.none()


@dataclass
class _Seen:
    """Everything the ingredients are worked out from, read once."""

    identity: Identity
    lines: dict[str, list[IngredientLine]] = field(default_factory=lambda: defaultdict(list))
    variants: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    raw_names: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    staples: dict[str, PantryItem] = field(default_factory=dict)
    no_food: set[str] = field(default_factory=set)
    # The nutrition keys each ingredient's lines are counted under: its own,
    # and "cooked-rice" beside "rice" for a line that says it is cooked.
    food_keys: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    # The foods people chose, by nutrition key; None is "does not count".
    picked: dict[str, int | None] = field(default_factory=dict)

    @property
    def keys(self) -> list[str]:
        return sorted({*self.lines, *self.staples})


async def _see(session: AsyncSession) -> _Seen:
    identity = await Identity.of(session)
    seen = _Seen(identity)
    recipes = (
        (await session.execute(select(Recipe).order_by(Recipe.title, Recipe.id)))
        .scalars()
        .unique()
        .all()
    )
    staples = (await session.execute(select(PantryItem))).scalars().all()
    # Choices under every key the page shows a food for: the keys the lines
    # are counted under, and each ingredient's own, which is not one of them
    # when every line says "cooked", or when it is a staple with no lines.
    names = [ing.name for recipe in recipes for ing in recipe.ingredients]
    names += [staple.name for staple in staples]
    seen.picked = await facts.hand_picks(
        session,
        {
            *(key for recipe in recipes for key in facts.recipe_keys(recipe, identity)),
            *(key for name in names if (key := identity.key(name))),
        },
    )
    for recipe in recipes:
        nutrition = facts.count_recipe(recipe, seen.picked, identity)
        for ing, counted in zip(recipe.ingredients, nutrition.lines, strict=True):
            key = identity.key(ing.name)
            if not key:
                continue
            seen.lines[key].append(
                IngredientLine(
                    ingredient_id=ing.id,
                    recipe_id=recipe.id,
                    recipe_title=recipe.title,
                    name=ing.name,
                    quantity=ing.quantity,
                    unit=ing.unit,
                    source_line=ing.source_line,
                    issue=ing.issue,
                )
            )
            seen.variants[key].append(ing.name.strip())
            seen.raw_names[_RAW.key(ing.name)].append(ing.name.strip())
            seen.food_keys[key].add(counted.key)
            if counted.issue == "no_food":
                seen.no_food.add(key)
    for staple in staples:
        key = identity.key(staple.name)
        if key:
            seen.staples.setdefault(key, staple)
            seen.raw_names[_RAW.key(staple.name)].append(staple.name)
    return seen


async def _products(session: AsyncSession, keys: list[str]) -> dict[str, IngredientProduct] | None:
    """Each key's standing at the chosen store, from stored picks only."""
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return None
    stored = await matching.stored_picks(session, keys, store.location_id)
    wanted = sorted({pick.product_id for pick in stored.values() if pick.product_id})
    try:
        found = await products.by_ids(wanted, store.location_id) if wanted else {}
    except KrogerError as exc:
        log.warning("Could not price the ingredients: %s", exc)
        found = {}
    standing: dict[str, IngredientProduct] = {}
    for key in keys:
        pick = stored.get(key)
        if pick is None:
            standing[key] = IngredientProduct(status="unseen")
            continue
        if pick.product_id:
            status = "picked" if pick.hand_picked else "auto"
        else:
            status = "not_priced" if pick.hand_picked else "no_match"
        product = found.get(pick.product_id) if pick.product_id else None
        standing[key] = IngredientProduct(
            status=status, product=as_item_price(product) if product is not None else None
        )
    return standing


def _food(key: str, picked: dict[str, int | None]) -> IngredientFood:
    """The food a nutrition key counts as: a person's choice, or its default."""
    if key in picked:
        if picked[key] is None:
            return IngredientFood(status="skipped")
        chosen = foods.food(picked[key])
        return IngredientFood(
            status="picked", food=facts.food_choice(chosen) if chosen is not None else None
        )
    default = default_for(key)
    chosen = foods.food(default.fdc_id) if default is not None else None
    if chosen is None:
        return IngredientFood(status="none")
    return IngredientFood(status="default", food=facts.food_choice(chosen))


def _foods(key: str, seen: _Seen) -> list[IngredientFoodEntry]:
    """The ingredient's own food, then each state-word variant its lines use.

    A variant such as `cooked-rice` has no default, so a line under it says
    "no food" whatever rice counts as; listing it is what lets the page clear
    that, rather than offering only rice's food, which would never reach it.
    """
    variants = sorted(seen.food_keys.get(key, set()) - {key})
    return [
        IngredientFoodEntry(
            **_food(food_key, seen.picked).model_dump(),
            key=food_key,
            # `Identity.nutrition_key` puts the state words in front of the key.
            state=food_key.removesuffix(f"-{key}").replace("-", " ") if food_key != key else None,
        )
        for food_key in [key, *variants]
    ]


def _name(key: str, seen: _Seen) -> str:
    staple = seen.staples.get(key)
    return staple.name if staple is not None else best_display(seen.variants[key])


def _merged(key: str, seen: _Seen) -> list[MergedName]:
    return sorted(
        (
            MergedName(
                key=raw,
                name=best_display(seen.raw_names[raw])
                if raw in seen.raw_names
                else raw.replace("-", " "),
            )
            for raw, target in seen.identity.merges.items()
            if target == key
        ),
        key=lambda merged: merged.name.casefold(),
    )


def _summary(
    key: str,
    seen: _Seen,
    standing: dict[str, IngredientProduct] | None,
    suggested: set[str],
) -> IngredientSummary:
    staple = seen.staples.get(key)
    product = standing.get(key) if standing is not None else None
    problems: list[IngredientProblem] = []
    if key in suggested:
        problems.append("merge")
    if product is not None and product.status == "no_match":
        problems.append("no_match")
    if key in seen.no_food:
        problems.append("no_food")
    if any(line.issue is not None for line in seen.lines.get(key, [])):
        problems.append("fix_line")
    return IngredientSummary(
        key=key,
        name=_name(key, seen),
        also_called=[merged.name for merged in _merged(key, seen) if merged.key in seen.raw_names],
        recipe_count=len({line.recipe_id for line in seen.lines.get(key, [])}),
        staple=(
            IngredientStaple(id=staple.id, name=staple.name, in_stock=staple.in_stock)
            if staple is not None
            else None
        ),
        product=product,
        food=_food(key, seen.picked),
        problems=problems,
    )


async def _suggestions(session: AsyncSession, seen: _Seen) -> list[MergeSuggestion]:
    """Likely pairs among the ingredients in use, less those turned down.

    A pair the rules leave undirected points at the name more recipes use,
    then at a staple, then at the alphabetically first, so the suggestion
    reads the way most of the box already does.
    """
    dismissed = {
        frozenset({row.key_a, row.key_b})
        for row in (await session.execute(select(IngredientMergeDismissal))).scalars()
    }

    def weight(key: str) -> tuple[int, bool, str]:
        inverted_key = "".join(chr(0x10FFFF - ord(c)) for c in key)
        return (len(seen.lines.get(key, [])), key in seen.staples, inverted_key)

    found: list[MergeSuggestion] = []
    for pair in merge_suggestions.find(seen.keys):
        if frozenset({pair.specific, pair.general}) in dismissed:
            continue
        source, target = pair.specific, pair.general
        if not pair.directed and weight(source) > weight(target):
            source, target = target, source
        found.append(
            MergeSuggestion(
                from_key=source,
                from_name=_name(source, seen),
                to_key=target,
                to_name=_name(target, seen),
                reason=pair.reason,
            )
        )
    return found


async def _overview(
    session: AsyncSession,
) -> tuple[_Seen, list[IngredientSummary], list[MergeSuggestion]]:
    seen = await _see(session)
    keys = seen.keys
    standing = await _products(session, keys)
    suggestions = await _suggestions(session, seen)
    suggested = {s.from_key for s in suggestions} | {s.to_key for s in suggestions}
    summaries = [_summary(key, seen, standing, suggested) for key in keys]
    summaries.sort(key=lambda s: s.name.casefold())
    return seen, summaries, suggestions


async def list_ingredients(session: AsyncSession) -> IngredientList:
    _, summaries, suggestions = await _overview(session)
    return IngredientList(ingredients=summaries, suggestions=suggestions)


async def ingredient(session: AsyncSession, key: str) -> IngredientDetail | None:
    """One ingredient's page, or None for a name nothing uses."""
    seen, summaries, suggestions = await _overview(session)
    target = seen.identity.resolve(key)
    summary = next((s for s in summaries if s.key == target), None)
    if summary is None:
        return None
    return IngredientDetail(
        **summary.model_dump(),
        lines=seen.lines.get(target, []),
        foods=_foods(target, seen),
        merged=_merged(target, seen),
        suggestions=[s for s in suggestions if target in (s.from_key, s.to_key)],
        redirected_from=key if key != target else None,
    )
