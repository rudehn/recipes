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
import math
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import MealPlanEntry, Recipe
from ...schemas import (
    CostLine,
    DayCost,
    EntryCost,
    PlanCost,
    RecipeCost,
    StoreOut,
)
from .. import settings as settings_service
from ..grocery import build_grocery_list, normalize_unit, scale_factor
from ..identity import Identity
from . import matching, pricing, products
from .client import KrogerError, enabled
from .products import Product
from .units import measure, parse_size, share_of_package, to_cents

log = logging.getLogger(__name__)

# How much of a recipe has to be priced before its cost per serving is
# trusted enough to rank it against the others, or to call it on sale. A
# recipe with half its ingredients unpriced is not cheap, it is half-costed.
PRICED_COVERAGE = 0.8

# How much of a recipe's cost the offers have to take off before the recipe
# is called on sale. A few cents off one ingredient in twenty is a coupon, not
# a reason to cook something.
SALE_THRESHOLD = 0.15

# How long listing recipes waits on Kroger for the prices its sale figures
# need. Finding a recipe must not hang on a grocery store's API, and sale
# data is a garnish: past this the list is answered without it.
SALE_LOOKUP_SECONDS = 1.5


def _line_cost(
    ingredient_key: str,
    quantity: float | None,
    unit: str | None,
    product: Product,
    price: float | None,
) -> tuple[float | None, bool]:
    """A line's cost and whether it is a whole package rather than a share.

    `price` is passed rather than read off the product so the same arithmetic
    can cost a line at today's price and at the regular one, which is how a
    recipe's discount is measured.
    """
    if price is None or quantity is None:
        return None, False
    # An amount in a unit nothing can read - "1 bunch", "2 sprigs" - is still
    # an amount, and is costed whole for want of anything better.
    need = measure(quantity, unit)
    share = share_of_package(
        price,
        parse_size(product.size),
        product.sold_by,
        need,
        ingredient_key,
        None,
        product.sold_by_piece,
    )
    if share is not None:
        return share, False
    return price, True


async def _picks_for(
    session: AsyncSession, recipes: list[Recipe], location_id: str, resolve: bool
) -> dict[str, str]:
    """The product id each ingredient across `recipes` means, by canonical key.

    `resolve` says whether unseen ingredients may be searched for. A single
    recipe's page may: it is a handful of searches, once. Ranking the whole
    box may not, or the first visit to the recipes page would be hundreds of
    searches - it uses what earlier lists and pages already decided, and
    recipes nothing has priced yet are simply not ranked.
    """
    identity = await Identity.of(session)
    keys = sorted({k for r in recipes for ing in r.ingredients if (k := identity.key(ing.name))})
    if not keys:
        return {}
    if resolve:
        picked = await matching.picks(session, keys, location_id)
    else:
        picked = await matching.stored_picks(session, keys, location_id)
    return {key: pick.product_id for key, pick in picked.items() if pick.product_id}


def _by_key(ids: dict[str, str], found: dict[str, Product]) -> dict[str, Product]:
    return {key: product for key, pid in ids.items() if (product := found.get(pid)) is not None}


async def _products_for(
    session: AsyncSession, recipes: list[Recipe], location_id: str, resolve: bool
) -> dict[str, Product]:
    """The product each ingredient across `recipes` means, by canonical key.

    See `_picks_for` for what `resolve` allows.
    """
    ids = await _picks_for(session, recipes, location_id, resolve)
    wanted = sorted(set(ids.values()))
    return _by_key(ids, await products.by_ids(wanted, location_id) if wanted else {})


def _cost_recipe(
    recipe: Recipe, found: dict[str, Product], factor: float = 1.0, *, identity: Identity
) -> tuple[list[CostLine], float, int]:
    """Every line of a recipe costed, with the total and how many priced."""
    lines: list[CostLine] = []
    total = 0.0
    priced = 0
    for ing in recipe.ingredients:
        key = identity.key(ing.name)
        product = found.get(key)
        line = CostLine(ingredient_id=ing.id, name=ing.name, key=key)
        if product is not None:
            line.product = pricing.as_item_price(product)
            quantity = ing.quantity * factor if ing.quantity is not None else None
            unit = normalize_unit(ing.unit)
            cost, whole = _line_cost(key, quantity, unit, product, product.price)
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

    identity = await Identity.of(session)
    lines, total, priced = _cost_recipe(recipe, found, identity=identity)
    # Already decided by the lookup above, so this reads the rows it wrote and
    # searches for nothing.
    decided = await matching.stored_picks(
        session, sorted({line.key for line in lines if line.key}), store.location_id
    )
    for line in lines:
        line.hand_picked = line.key in decided and decided[line.key].hand_picked
    return RecipeCost(
        store=StoreOut.model_validate(store),
        total=to_cents(total),
        per_serving=to_cents(total / recipe.servings) if recipe.servings else None,
        priced=priced,
        total_lines=len(lines),
        lines=lines,
    )


async def plan_cost(session: AsyncSession, start: date, end: date) -> PlanCost | None:
    """What the meals planned between two dates cost, meal by meal and day by day.

    Each entry is scaled to its planned servings the same way the grocery
    list scales it, and is answered on its own as well as summed into its
    day, so the planner can put a figure on each meal. The grocery total for
    the same days rides along so the two can be read against each other: the
    difference is what is left in the cupboard after the week.
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

    identity = await Identity.of(session)
    by_day: dict[date, DayCost] = {}
    per_entry: list[EntryCost] = []
    total = 0.0
    priced = 0
    total_lines = 0
    for entry in entries:
        _, entry_total, entry_priced = _cost_recipe(
            entry.recipe, found, scale_factor(entry), identity=identity
        )
        per_entry.append(
            EntryCost(
                entry_id=entry.id,
                total=to_cents(entry_total),
                priced=entry_priced,
                total_lines=len(entry.recipe.ingredients),
            )
        )
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
        entries=per_entry,
        grocery_total=grocery_list.pricing.total if grocery_list.pricing else None,
    )


async def sale_percentages(session: AsyncSession) -> dict[int, int] | None:
    """Whole percent off, for each recipe whose ingredients are on offer.

    A recipe is on sale when the offers take at least `SALE_THRESHOLD` off
    what it costs at regular prices, both costed over the recipe's share of
    each package. Only recipes with `PRICED_COVERAGE` of their lines priced
    are judged: a discount on the two ingredients that could be priced says
    nothing about a recipe whose other half is unknown. The percent is
    rounded down, so a ribbon never promises more than the shelf gives.

    Nothing is searched for - products come from stored picks - and the
    prices are asked for promptly or not at all, since this runs on every
    request that lists recipes. None says there is no sale data (pricing
    off, no store, Kroger down or slow), which is not the same as nothing
    being on sale; either way the recipe list still loads.
    """
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return None
    box = (await session.execute(select(Recipe))).scalars().unique().all()
    recipes = [r for r in box if r.ingredients]
    ids = await _picks_for(session, recipes, store.location_id, resolve=False)
    wanted = sorted(set(ids.values()))
    prices = (
        await products.by_ids_promptly(wanted, store.location_id, SALE_LOOKUP_SECONDS)
        if wanted
        else {}
    )
    if prices is None:
        return None
    found = _by_key(ids, prices)

    identity = await Identity.of(session)
    sales: dict[int, int] = {}
    for recipe in recipes:
        regular_total = 0.0
        today_total = 0.0
        priced = 0
        for ing in recipe.ingredients:
            key = identity.key(ing.name)
            product = found.get(key)
            if product is None:
                continue
            unit = normalize_unit(ing.unit)
            regular, _ = _line_cost(key, ing.quantity, unit, product, product.regular)
            today, _ = _line_cost(key, ing.quantity, unit, product, product.price)
            if regular is None or today is None:
                continue
            regular_total += regular
            today_total += today
            priced += 1
        if priced / len(recipe.ingredients) < PRICED_COVERAGE or regular_total <= 0:
            continue
        off = (regular_total - today_total) / regular_total
        if off >= SALE_THRESHOLD:
            sales[recipe.id] = math.floor(off * 100)
    return sales
