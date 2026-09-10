"""What a recipe costs to cook, and what a week of them costs.

The grocery list prices whole packages, because that is what gets bought. A
recipe uses two cups of the five pound bag, so this prices the share - the
other half of the arithmetic in `units`, with the same `comparable` bridge
underneath so the two cannot disagree about what a cup of flour weighs.

Two rules from the grocery list carry over unchanged. Coverage travels with
every figure, because a total that quietly omits the ingredients it could not
price reads exactly like a complete one. And nothing here searches: products
come from `matching.picks`, the same remembered answers the grocery list
uses, so a recipe costs one batched lookup and a week of them costs one too.

Where an amount cannot be related to its package - "1 bunch parsley" against
a bunch, "2 sprigs" against the same bunch - the line is costed as the whole
package and says so. Whole is right for the bunch and ten times too much for
the sprigs, and nothing here can tell them apart, so the figure is shown with
its reason rather than folded silently into the total. An ingredient with no
amount at all ("salt, to taste") is not priced: a package of salt would be
wrong by a factor of a thousand.
"""

import logging
from datetime import date
from statistics import median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import MealPlanEntry, PantryItem, Recipe
from ...schemas import (
    CheapRecipe,
    CostLine,
    DayCost,
    PantryRecipe,
    PlanCost,
    RecipeCost,
    RecipeSummary,
    StoreOut,
    Suggestions,
)
from .. import settings as settings_service
from ..canonical import canonical_key
from ..grocery import build_grocery_list, normalize_unit, scale_factor
from . import matching, pricing, products
from .client import KrogerError, enabled
from .products import Product
from .units import measure, parse_size, share_of_package, to_cents

log = logging.getLogger(__name__)

# How much of a recipe has to be priced before its cost per serving is
# trusted enough to rank it against the others. A recipe with half its
# ingredients unpriced is not cheap, it is half-costed.
SUGGESTION_COVERAGE = 0.8

# How much of a recipe the pantry has to hold before it is suggested for it.
PANTRY_SHARE = 0.75

# Enough to rank within, without turning the panel into the recipe index.
SUGGESTION_LIMIT = 6


def _line_cost(
    ingredient_key: str, quantity: float | None, unit: str | None, product: Product
) -> tuple[float | None, bool]:
    """A line's cost and whether it is a whole package rather than a share."""
    if product.price is None or quantity is None:
        return None, False
    # An amount in a unit nothing can read - "1 bunch", "2 sprigs" - is still
    # an amount, and is costed whole for want of anything better.
    need = measure(quantity, unit)
    share = share_of_package(
        product.price,
        parse_size(product.size),
        product.sold_by,
        need,
        ingredient_key,
        None,
        product.sold_by_piece,
    )
    if share is not None:
        return share, False
    return product.price, True


async def _products_for(
    session: AsyncSession, recipes: list[Recipe], location_id: str, resolve: bool
) -> dict[str, Product]:
    """The product each ingredient across `recipes` means, by canonical key.

    `resolve` says whether unseen ingredients may be searched for. A single
    recipe's page may: it is a handful of searches, once. Ranking the whole
    box may not, or the first visit to the recipes page would be hundreds of
    searches - it uses what earlier lists and pages already decided, and
    recipes nothing has priced yet are simply not ranked.
    """
    keys = sorted({k for r in recipes for ing in r.ingredients if (k := canonical_key(ing.name))})
    if not keys:
        return {}
    if resolve:
        picked = await matching.picks(session, keys, location_id)
    else:
        picked = await matching.stored_picks(session, keys, location_id)
    wanted = sorted({p.product_id for p in picked.values() if p.product_id})
    found = await products.by_ids(wanted, location_id) if wanted else {}
    return {
        key: product
        for key, pick in picked.items()
        if pick.product_id and (product := found.get(pick.product_id)) is not None
    }


def _cost_recipe(
    recipe: Recipe, found: dict[str, Product], factor: float = 1.0
) -> tuple[list[CostLine], float, int]:
    """Every line of a recipe costed, with the total and how many priced."""
    lines: list[CostLine] = []
    total = 0.0
    priced = 0
    for ing in recipe.ingredients:
        key = canonical_key(ing.name)
        product = found.get(key)
        line = CostLine(ingredient_id=ing.id, name=ing.name)
        if product is not None:
            line.product = pricing.as_item_price(product)
            quantity = ing.quantity * factor if ing.quantity is not None else None
            cost, whole = _line_cost(key, quantity, normalize_unit(ing.unit), product)
            if cost is not None:
                line.cost = to_cents(cost)
                line.whole_package = whole
                total += cost
                priced += 1
        lines.append(line)
    return lines, total, priced


async def recipe_cost(session: AsyncSession, recipe: Recipe) -> RecipeCost | None:
    """What one recipe costs, or None when there is nothing to price it with."""
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return None
    try:
        found = await _products_for(session, [recipe], store.location_id, resolve=True)
    except KrogerError as exc:
        log.warning("Could not cost recipe %s: %s", recipe.id, exc)
        return None

    lines, total, priced = _cost_recipe(recipe, found)
    return RecipeCost(
        store=StoreOut.model_validate(store),
        total=to_cents(total),
        per_serving=to_cents(total / recipe.servings) if recipe.servings else None,
        priced=priced,
        total_lines=len(lines),
        lines=lines,
    )


async def plan_cost(session: AsyncSession, start: date, end: date) -> PlanCost | None:
    """What the meals planned between two dates cost, day by day.

    Each entry is scaled to its planned servings the same way the grocery
    list scales it. The grocery total for the same days rides along so the
    two can be read against each other: the difference is what is left in
    the cupboard after the week.
    """
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return None

    entries = (
        await session.execute(
            select(MealPlanEntry)
            .where(MealPlanEntry.plan_date >= start, MealPlanEntry.plan_date <= end)
            .order_by(MealPlanEntry.plan_date, MealPlanEntry.id)
        )
    ).scalars().all()
    recipes = list({e.recipe.id: e.recipe for e in entries}.values())
    try:
        found = await _products_for(session, recipes, store.location_id, resolve=True)
        grocery_list = await pricing.attach_prices(
            session, await build_grocery_list(session, start, end)
        )
    except KrogerError as exc:
        log.warning("Could not cost the meal plan: %s", exc)
        return None

    by_day: dict[date, DayCost] = {}
    total = 0.0
    priced = 0
    total_lines = 0
    for entry in entries:
        _, entry_total, entry_priced = _cost_recipe(entry.recipe, found, scale_factor(entry))
        day = by_day.setdefault(
            entry.plan_date, DayCost(plan_date=entry.plan_date, total=0.0, priced=0, total_lines=0)
        )
        day.total = to_cents(day.total + entry_total)
        day.priced += entry_priced
        day.total_lines += len(entry.recipe.ingredients)
        total += entry_total
        priced += entry_priced
        total_lines += len(entry.recipe.ingredients)

    return PlanCost(
        store=StoreOut.model_validate(store),
        total=to_cents(total),
        priced=priced,
        total_lines=total_lines,
        days=list(by_day.values()),
        grocery_total=grocery_list.pricing.total if grocery_list.pricing else None,
    )


async def suggestions(session: AsyncSession) -> Suggestions:
    """Reasons to cook something this week.

    Three signals, each honest about what it needs. Offers and cost per
    serving need Kroger, and use only products already decided on - nothing
    is searched for here, so the first visit costs a batched lookup rather
    than a search per ingredient in the box. The pantry signal needs no
    Kroger at all, and is answered even when pricing is off.
    """
    recipes = (await session.execute(select(Recipe))).scalars().unique().all()
    recipes = [r for r in recipes if r.ingredients]

    pantry = {
        canonical_key(p.name)
        for p in (await session.execute(select(PantryItem))).scalars().all()
        if p.in_stock
    }
    from_pantry: list[PantryRecipe] = []
    for recipe in recipes:
        keys = {k for ing in recipe.ingredients if (k := canonical_key(ing.name))}
        have = len(keys & pantry)
        if keys and have / len(keys) >= PANTRY_SHARE:
            from_pantry.append(
                PantryRecipe(
                    recipe=RecipeSummary.model_validate(recipe),
                    in_pantry=have,
                    total_lines=len(keys),
                )
            )
    from_pantry.sort(key=lambda p: (-p.in_pantry / p.total_lines, p.recipe.title.casefold()))

    on_sale = await pricing.recipes_on_sale(session)

    cheap: list[CheapRecipe] = []
    median_per_serving: float | None = None
    store = await settings_service.selected_store(session)
    if enabled() and store is not None:
        try:
            found = await _products_for(session, recipes, store.location_id, resolve=False)
        except KrogerError as exc:
            log.warning("Could not cost the recipe box: %s", exc)
            found = {}
        costed: list[CheapRecipe] = []
        for recipe in recipes:
            if not recipe.servings:
                continue
            lines, total, priced = _cost_recipe(recipe, found)
            if priced / len(lines) < SUGGESTION_COVERAGE:
                continue
            costed.append(
                CheapRecipe(
                    recipe=RecipeSummary.model_validate(recipe),
                    per_serving=to_cents(total / recipe.servings),
                    priced=priced,
                    total_lines=len(lines),
                )
            )
        # One recipe is not a distribution, and "below the median of two" is
        # just "the cheaper one".
        if len(costed) >= 3:
            median_per_serving = to_cents(median(c.per_serving for c in costed))
            cheap = sorted(
                (c for c in costed if c.per_serving < median_per_serving),
                key=lambda c: (c.per_serving, c.recipe.title.casefold()),
            )

    return Suggestions(
        on_sale=on_sale[:SUGGESTION_LIMIT],
        cheap=cheap[:SUGGESTION_LIMIT],
        median_per_serving=median_per_serving,
        pantry=from_pantry[:SUGGESTION_LIMIT],
    )

