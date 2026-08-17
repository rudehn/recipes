"""Putting Kroger prices onto an already-built grocery list.

Deliberately a layer over `services.grocery` rather than a change to it. The
list is the product; prices are an optional garnish that a store outage, an
expired key, or a missing store must never be able to take the list away.
Everything here therefore fails to *nothing* - the list comes back exactly as
it would have without a Kroger account.

No conversion happens here, and that is the point of doing this before recipe
costing. A grocery list is already package shaped: it says "buy flour", and
the answer is the price of the bag. Working out what a recipe's two cups of
it cost needs the size parsing that has not been built yet.

Coverage travels with the total for the same reason amounts travel with
in-pantry items in `services.grocery`: a number that quietly omits what it
could not price is indistinguishable from a complete one, and the difference
is only discovered at the till.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from ...schemas import GroceryItem, GroceryList, GroceryPricing, ItemPrice
from .. import settings as settings_service
from . import matching, products
from .client import KrogerError, enabled
from .products import Product

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


def _priceable(grocery_list: GroceryList) -> list[GroceryItem]:
    """The lines this trip actually pays for.

    In-pantry items are left out: they are set aside precisely because they
    are not being bought, and pricing them would inflate a total meant to say
    what the trip costs.
    """
    return [*grocery_list.items, *grocery_list.pantry_restock]


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

    lines = _priceable(grocery_list)
    if not lines:
        return grocery_list

    try:
        matched = await matching.product_ids(
            session, [line.key for line in lines], store.location_id
        )
        found = await products.by_ids(sorted(set(matched.values())), store.location_id)
    except KrogerError as exc:
        # One warning, and the list goes out unpriced. Same principle as a
        # failing site in recipe_search: a thinner answer beats no answer.
        log.warning("Could not price the grocery list: %s", exc)
        return grocery_list

    total = 0.0
    priced = 0
    for line in lines:
        product = found.get(matched.get(line.key, ""))
        if product is None or product.price is None:
            continue
        line.price = as_item_price(product)
        total += product.price
        priced += 1

    if not priced:
        # Nothing priced reads the same either way on screen, but "$0.00, 0 of
        # 3" claims we looked and the list really is free. It also cannot be
        # told apart from an outage from here: a search that fails is logged
        # and skipped inside `matching`, so this function sees an empty result
        # rather than an error. Saying nothing is the honest version of both.
        return grocery_list

    grocery_list.pricing = GroceryPricing(
        store=store,
        total=round(total, 2),
        priced=priced,
        total_lines=len(lines),
    )
    return grocery_list
