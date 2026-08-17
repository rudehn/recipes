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
*which* package to buy - the smallest that covers it - not to take a share
of one. See `matching._fit`.

Coverage travels with the total for the same reason amounts travel with
in-pantry items in `services.grocery`: a number that quietly omits what it
could not price is indistinguishable from a complete one, and the difference
is only discovered at the till.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import Ingredient, IngredientProductMatch, PantryItem
from ...schemas import GroceryItem, GroceryList, GroceryPricing, ItemPrice, SaleItem
from .. import settings as settings_service
from ..canonical import best_display, canonical_key
from . import matching, products
from .client import KrogerError, enabled
from .products import Product
from .units import Measure, cost_to_cover, measure, parse_size, to_cents

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


async def on_sale(session: AsyncSession) -> list[SaleItem]:
    """Things you cook with that are discounted this week.

    Built only from ingredients already matched to a product, and those rows
    exist only because someone opened a list containing them. Nothing is
    searched for here: this re-prices choices already made, which is the
    difference between noticing an offer and gathering a catalogue.

    The ingredient's own name comes from the recipes and pantry that use it,
    through the same `best_display` the grocery list uses, so a sale reads as
    "flour" rather than as a product code.
    """
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return []

    rows = (
        await session.execute(
            select(IngredientProductMatch).where(
                IngredientProductMatch.location_id == store.location_id,
                IngredientProductMatch.product_id.is_not(None),
            )
        )
    ).scalars().all()
    if not rows:
        return []

    try:
        found = await products.by_ids(
            sorted({row.product_id for row in rows if row.product_id}), store.location_id
        )
    except KrogerError as exc:
        log.warning("Could not check for offers: %s", exc)
        return []

    names = await _ingredient_names(session)
    sales: list[SaleItem] = []
    for row in rows:
        product = found.get(row.product_id or "")
        if product is None or not product.on_sale:
            continue
        sales.append(
            SaleItem(
                key=row.canonical_key,
                name=names.get(row.canonical_key) or row.canonical_key.replace("-", " "),
                price=as_item_price(product),
            )
        )
    sales.sort(key=lambda s: s.name)
    return sales


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
    what the trip costs.
    """
    return [*grocery_list.items, *grocery_list.pantry_restock]


async def chosen_products(
    session: AsyncSession, lines: list[GroceryItem], location_id: str
) -> dict[str, Product]:
    """The product each line means, keyed by the line's key.

    The single place that answers "which thing on the shelf is this". Pricing
    reads it to say what the trip costs and `cart` reads it to order the same
    things, and they must not be able to disagree: a total quoted against one
    product while another goes into the cart is wrong in the way that is only
    discovered at collection.

    Lines with no confident match are simply absent, which is the same answer
    both callers already give them - unpriced, and not ordered.
    """
    matched = await matching.product_ids(
        session,
        [line.key for line in lines],
        location_id,
        needs={line.key: need for line in lines if (need := needed(line))},
    )
    found = await products.by_ids(sorted(set(matched.values())), location_id)
    chosen: dict[str, Product] = {}
    for line in lines:
        product = found.get(matched.get(line.key, ""))
        if product is not None:
            chosen[line.key] = product
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

    lines = to_buy(grocery_list)
    if not lines:
        return grocery_list

    try:
        chosen = await chosen_products(session, lines, store.location_id)
    except KrogerError as exc:
        # One warning, and the list goes out unpriced. Same principle as a
        # failing site in recipe_search: a thinner answer beats no answer.
        log.warning("Could not price the grocery list: %s", exc)
        return grocery_list

    total = 0.0
    saved = 0.0
    priced = 0
    for line in lines:
        product = chosen.get(line.key)
        if product is None or product.price is None:
            continue
        cost = cost_to_cover(
            product.price, parse_size(product.size), product.sold_by, needed(line)
        )
        line.price = as_item_price(product)
        line.price.estimated = to_cents(cost)
        total += cost
        priced += 1
        if product.on_sale and product.regular is not None:
            # What the same trip would have cost at the regular price, scaled
            # the same way, so a saving on a weight-sold item is not quoted
            # per pound while its cost is quoted for three of them.
            was = cost_to_cover(
                product.regular, parse_size(product.size), product.sold_by, needed(line)
            )
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
        total_lines=len(lines),
    )
    return grocery_list
