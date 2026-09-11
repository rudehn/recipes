"""Putting Kroger prices onto an already-built grocery list.

Deliberately a layer over `services.grocery` rather than a change to it. The
list is the product; prices are an optional garnish that a store outage, an
expired key, or a missing store must never be able to take the list away.
Everything here therefore fails to *nothing* - the list comes back exactly as
it would have without a Kroger account.

No conversion happens here, and that is the point of doing this before recipe
costing. A grocery list is already package shaped: it says "buy flour", and
the answer is the price of the bag, whole. Working out what a recipe's two
cups of that bag cost is a different question, and needs a density.

The amount the meals call for is still worked out, but only to choose
*which* package to buy and how many of it - never to take a share of one.
See `matching._fit` and `units.comparable`.

Coverage travels with the total for the same reason amounts travel with
in-pantry items in `services.grocery`: a number that quietly omits what it
could not price is indistinguishable from a complete one, and the difference
is only discovered at the till.
"""

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import Ingredient, IngredientProductMatch, PantryItem, Recipe
from ...schemas import (
    GroceryItem,
    GroceryList,
    GroceryPricing,
    ItemPrice,
    RecipeOnSale,
    RecipeSummary,
    RememberedPick,
    SaleItem,
)
from .. import settings as settings_service
from ..canonical import best_display, canonical_key
from . import matching, products
from .client import KrogerError, enabled
from .products import Product
from .units import Measure, comparable, cost_to_cover, measure, parse_size, to_cents

log = logging.getLogger(__name__)


def as_item_price(product: Product) -> ItemPrice:
    """A product as the client shows it.

    `promo` is carried only when the item is genuinely cheaper for it, so the
    client can render a strike-through without re-deciding what a sale is.
    """
    return ItemPrice(
        product_id=product.product_id,
        description=product.description,
        size=product.size,
        regular=product.regular or 0.0,
        promo=product.promo if product.on_sale else None,
        aisle=product.aisle,
        in_stock=product.in_stock,
    )


def needed(line: GroceryItem) -> Measure | None:
    """How much of an ingredient the week's meals call for, if it is countable.

    Summed from the individual uses rather than read off the rendered amounts,
    which are display strings ("1½ cups"). Only one dimension is answered: a
    line calling for both a weight and a volume of the same thing has no
    single amount to fit a package to, so it gets none.
    """
    totals: dict[str, float] = {}
    for use in line.uses:
        found = measure(use.quantity, use.unit)
        if found is not None:
            totals[found.dimension] = totals.get(found.dimension, 0.0) + found.base
    if len(totals) != 1:
        return None
    dimension, base = next(iter(totals.items()))
    return Measure(dimension, base)


def sized(line: GroceryItem, product: Product) -> bool:
    """Whether the line's amount can be related to the product's package.

    False is the case worth naming: the count sent to the cart is then one
    by default rather than worked out, and the shopper should know before
    trusting it. A line with no amount at all is not this problem - it is
    the recipe's, and is named there.
    """
    if not any(use.quantity for use in line.uses):
        return True
    need = needed(line)
    if need is None:
        return False
    size = parse_size(product.size)
    return comparable(size, need, line.key, None, product.sold_by_piece) is not None


async def _discounted(session: AsyncSession) -> dict[str, Product]:
    """The ingredients whose chosen product is on offer, by key.

    Built only from ingredients already matched to a product, and those rows
    exist only because someone opened a list containing them. Nothing is
    searched for here: this re-prices choices already made, which is the
    difference between noticing an offer and gathering a catalogue.

    Empty rather than an error when pricing is off, no store is set, or
    Kroger cannot be reached: an offers panel with nothing in it is a normal
    sight, and the page it sits on is not about offers.
    """
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return {}

    rows = (
        await session.execute(
            select(IngredientProductMatch).where(
                IngredientProductMatch.location_id == store.location_id,
                IngredientProductMatch.product_id.is_not(None),
            )
        )
    ).scalars().all()
    if not rows:
        return {}

    try:
        found = await products.by_ids(
            sorted({row.product_id for row in rows if row.product_id}), store.location_id
        )
    except KrogerError as exc:
        log.warning("Could not check for offers: %s", exc)
        return {}

    return {
        row.canonical_key: product
        for row in rows
        if (product := found.get(row.product_id or "")) is not None and product.on_sale
    }


async def recipes_on_sale(session: AsyncSession) -> list[RecipeOnSale]:
    """Recipes with something discounted in them this week, most first.

    The offers used to be listed as ingredients on the grocery page, where
    they answered a question nobody on that page was asking: the list's own
    lines already show a sale price, and its total already says what the
    offers saved. What a discount on an ingredient is good for is deciding
    what to cook, so it is put with the recipes and phrased as them.

    Ranked by how much of the recipe is on offer, because two of three
    ingredients discounted is a reason to cook the thing and two of nineteen
    is a coincidence. Ties go to the title so the order cannot wobble.
    """
    discounted = await _discounted(session)
    if not discounted:
        return []

    names = await _ingredient_names(session)
    recipes = (await session.execute(select(Recipe))).scalars().unique().all()

    found: list[RecipeOnSale] = []
    for recipe in recipes:
        keys = {k for ing in recipe.ingredients if (k := canonical_key(ing.name))}
        hits = sorted(keys & discounted.keys(), key=lambda k: names.get(k, k))
        if not hits:
            continue
        found.append(
            RecipeOnSale(
                recipe=RecipeSummary.model_validate(recipe),
                on_sale=[
                    SaleItem(
                        key=key,
                        name=names.get(key) or key.replace("-", " "),
                        price=as_item_price(discounted[key]),
                    )
                    for key in hits
                ],
                ingredient_count=len(keys),
            )
        )
    found.sort(key=lambda r: (-len(r.on_sale) / r.ingredient_count, r.recipe.title.casefold()))
    return found


async def _ingredient_names(session: AsyncSession) -> dict[str, str]:
    """A readable name per canonical key, from the things that use it."""
    variants: dict[str, list[str]] = {}
    ingredients = (await session.execute(select(Ingredient.name))).scalars().all()
    pantry = (await session.execute(select(PantryItem.name))).scalars().all()
    for name in [*ingredients, *pantry]:
        key = canonical_key(name)
        if key:
            variants.setdefault(key, []).append(name)
    return {key: best_display(names) for key, names in variants.items()}


def to_buy(grocery_list: GroceryList) -> list[GroceryItem]:
    """The lines this trip actually pays for.

    In-pantry items are left out: they are set aside precisely because they
    are not being bought, and pricing them would inflate a total meant to say
    what the trip costs. So are lines marked as already at home, for the
    same reason. A ticked line stays: it is in the trolley, and the till will
    charge for it.
    """
    return [
        line
        for line in [*grocery_list.items, *grocery_list.pantry_restock]
        if line.status != "have"
    ]


@dataclass(frozen=True)
class Choice:
    """What a line means on the shelf, and whether a person said so.

    `product` is None for a line nothing confident matched, or one a person
    marked as not to be priced - the two are told apart by `hand_picked`.
    """

    product: Product | None
    hand_picked: bool


async def choices(
    session: AsyncSession, lines: list[GroceryItem], location_id: str
) -> dict[str, Choice]:
    """The product each line means, keyed by the line's key.

    The single place that answers "which thing on the shelf is this". Pricing
    reads it to say what the trip costs and `cart` reads it to order the same
    things, and they must not be able to disagree: a total quoted against one
    product while another goes into the cart is wrong in the way that is only
    discovered at collection.

    Every line is answered, so that a line with no product can still say
    whether that was the shopper's decision.
    """
    picked = await matching.picks(
        session,
        [line.key for line in lines],
        location_id,
        needs={line.key: need for line in lines if (need := needed(line))},
    )
    wanted = sorted({p.product_id for p in picked.values() if p.product_id})
    found = await products.by_ids(wanted, location_id) if wanted else {}
    chosen: dict[str, Choice] = {}
    for line in lines:
        pick = picked.get(line.key)
        if pick is None:
            continue
        chosen[line.key] = Choice(found.get(pick.product_id or ""), pick.hand_picked)
    return chosen


async def attach_prices(session: AsyncSession, grocery_list: GroceryList) -> GroceryList:
    """The same list, with prices where they could be found.

    Returns the list untouched when pricing is off, no store is chosen, or
    Kroger cannot be reached.
    """
    if not enabled():
        return grocery_list

    store = await settings_service.selected_store(session)
    if store is None:
        # Configured but with nowhere to price against. The client tells this
        # apart from "switched off" through /pricing/status and can prompt.
        return grocery_list

    # Every line gets its price, including those marked as already at home:
    # the product is still what the line means, and a set-aside line reading
    # "no match" would be a lie about the matching rather than a fact about
    # the trip. Only the total is particular about which lines it counts.
    lines = [*grocery_list.items, *grocery_list.pantry_restock]
    paying = to_buy(grocery_list)
    if not lines:
        return grocery_list

    try:
        chosen = await choices(session, lines, store.location_id)
    except KrogerError as exc:
        # One warning, and the list goes out unpriced. Same principle as a
        # failing site in recipe_search: a thinner answer beats no answer.
        log.warning("Could not price the grocery list: %s", exc)
        return grocery_list

    total = 0.0
    saved = 0.0
    priced = 0
    for line in lines:
        choice = chosen.get(line.key)
        if choice is None:
            continue
        line.hand_picked = choice.hand_picked
        product = choice.product
        if product is None:
            # Nothing matched, or a person said not to price it. Only the
            # first is a problem, and a recipe-side one outranks it.
            if not choice.hand_picked and line.issue is None:
                line.issue = "no_match"
            continue
        need = needed(line)
        size = parse_size(product.size)
        each = product.sold_by_piece
        if line.issue is None:
            # The product side of the arithmetic, most serious first.
            if not sized(line, product):
                line.issue = "unsized"
            elif not product.in_stock:
                line.issue = "out_of_stock"
        if product.price is None:
            continue
        cost = cost_to_cover(product.price, size, product.sold_by, need, line.key, None, each)
        line.price = as_item_price(product)
        line.price.estimated = to_cents(cost)
        if line.status == "have":
            continue
        total += cost
        priced += 1
        if product.on_sale and product.regular is not None:
            # What the same trip would have cost at the regular price, scaled
            # the same way, so a saving on a weight-sold item is not quoted
            # per pound while its cost is quoted for three of them.
            was = cost_to_cover(product.regular, size, product.sold_by, need, line.key, None, each)
            saved += was - cost

    if not priced:
        # Nothing priced reads the same either way on screen, but "$0.00, 0 of
        # 3" claims we looked and the list really is free. It also cannot be
        # told apart from an outage from here: a search that fails is logged
        # and skipped inside `matching`, so this function sees an empty result
        # rather than an error. Saying nothing is the honest version of both.
        return grocery_list

    grocery_list.pricing = GroceryPricing(
        store=store,
        total=to_cents(total),
        saved=to_cents(saved),
        priced=priced,
        total_lines=len(paying),
    )
    return grocery_list


async def remembered_picks(session: AsyncSession, location_id: str) -> list[RememberedPick]:
    """Every ingredient with a remembered answer at this store, by name.

    Read straight from the rows rather than re-resolved: this is a view of
    what has been decided, and looking must not decide anything.
    """
    rows = (
        await session.execute(
            select(IngredientProductMatch).where(
                IngredientProductMatch.location_id == location_id
            )
        )
    ).scalars().all()
    if not rows:
        return []
    wanted = sorted({row.product_id for row in rows if row.product_id})
    found = await products.by_ids(wanted, location_id) if wanted else {}
    names = await _ingredient_names(session)
    picks = [
        RememberedPick(
            key=row.canonical_key,
            name=names.get(row.canonical_key) or row.canonical_key.replace("-", " "),
            product=(
                as_item_price(product)
                if (product := found.get(row.product_id or "")) is not None
                else None
            ),
            hand_picked=row.user_confirmed,
            resolved_at=row.resolved_at,
        )
        for row in rows
    ]
    picks.sort(key=lambda p: p.name.casefold())
    return picks
