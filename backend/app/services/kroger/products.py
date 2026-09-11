"""Reading products and their prices out of the Kroger catalog.

Prices only exist against a store. The Products API returns no price at all
unless `filter.locationId` is passed, so every call here carries one.

The response shape is flatter than it looks: a product carries a list of
`items`, and the price, size and how it is sold live on the first of them
rather than on the product. `soldBy` is the field that matters most later -
`WEIGHT` means `regular` is the price per the `size` unit, so a pound of
chicken thighs is arithmetic, while `UNIT` means `regular` buys the whole
package and a recipe using part of it needs a conversion.

`promo` is absent rather than zero when nothing is on sale, which is the
common case, so it is optional here rather than defaulted to 0.

`categories` are Kroger's department names - "Produce", "Pet Care", "Baking
Goods" - and are carried because they answer a question the description
cannot: whether a thing whose name contains the ingredient is food at all.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from . import client
from .units import COUNT, parse_size

# How long a price is trusted before it is asked for again. Long enough that
# every reload of a grocery list during one sitting - each tick in the aisle
# reloads it - costs no Kroger call at all, and short enough that a price
# never outlives the visit. This is a cache of the last answer, kept in
# memory and gone on restart; it is not the price history Kroger's terms
# forbid, which would be prices kept over time to compare against.
PRICE_TTL_SECONDS = 600

# Kroger's word for a shelf with nothing on it. The other values seen are
# "HIGH" and "LOW", and an item can carry no inventory at all.
OUT_OF_STOCK = "TEMPORARILY_OUT_OF_STOCK"

# The API's own ceiling, for both filter.limit and the number of comma
# separated ids accepted by filter.productId. 51 ids is a 400.
MAX_LIMIT = 50


@dataclass(frozen=True)
class Product:
    """A product at one store, carried as Kroger describes it.
    """

    product_id: str
    upc: str
    description: str
    brand: str
    size: str
    # "UNIT" for a package, "WEIGHT" for anything priced per the size unit.
    sold_by: str
    regular: float | None
    promo: float | None
    aisle: str
    categories: tuple[str, ...] = ()
    # Kroger's own reading of the shelf, or "" when it says nothing.
    stock_level: str = ""

    @property
    def in_stock(self) -> bool:
        """Not known to be out. Silence counts as stocked."""
        return self.stock_level != OUT_OF_STOCK

    @property
    def sold_by_piece(self) -> bool:
        """Produce counted out by the piece: one avocado, a bag of four limes.

        Sized as a count, sold as a unit, and from the produce department.
        That is the one place a recipe's count and the shop's count are the
        same object without a list saying so - three avocados are three of
        the "1 each", or one of the "4 ct" bag - where "1 ct" on a jar of
        garlic powder is not. It vouches for the product only; whether the
        recipe counts the same piece is `units.comparable`'s question.
        """
        size = parse_size(self.size)
        return (
            self.sold_by == "UNIT"
            and size is not None
            and size.dimension == COUNT
            and any("produce" in c.casefold() for c in self.categories)
        )

    @property
    def on_sale(self) -> bool:
        return self.promo is not None and self.regular is not None and self.promo < self.regular

    @property
    def price(self) -> float | None:
        """What it costs today: the promotional price when there is one."""
        return self.promo if self.on_sale else self.regular


def _number(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return None


def _product(raw: dict[str, Any]) -> Product | None:
    product_id = raw.get("productId")
    if not product_id:
        return None
    items = raw.get("items") or [{}]
    item = items[0] if isinstance(items[0], dict) else {}
    price = item.get("price") or {}
    aisles = raw.get("aisleLocations") or []
    aisle = aisles[0].get("description", "") if aisles and isinstance(aisles[0], dict) else ""
    categories = tuple(c for c in raw.get("categories") or [] if isinstance(c, str))
    inventory = item.get("inventory") or {}
    stock_level = inventory.get("stockLevel", "") if isinstance(inventory, dict) else ""
    return Product(
        product_id=product_id,
        upc=raw.get("upc", ""),
        description=raw.get("description", ""),
        brand=raw.get("brand", ""),
        size=item.get("size", ""),
        sold_by=item.get("soldBy", ""),
        regular=_number(price.get("regular")),
        promo=_number(price.get("promo")),
        aisle=aisle,
        categories=categories,
        stock_level=stock_level if isinstance(stock_level, str) else "",
    )


def _products(payload: dict[str, Any]) -> list[Product]:
    found = (_product(raw) for raw in payload.get("data") or [])
    return [p for p in found if p is not None]


async def search(term: str, location_id: str, limit: int = MAX_LIMIT) -> list[Product]:
    """Products matching a free-text term at one store.

    The order is not stable: Kroger's search is fuzzy and answers identical
    requests differently, which is why callers rank the results themselves
    rather than taking the first.
    """
    payload = await client.get(
        "/v1/products",
        {
            "filter.term": term,
            "filter.locationId": location_id,
            "filter.limit": min(limit, MAX_LIMIT),
        },
    )
    return _products(payload)


# (location, product id) -> (expires at, product). See PRICE_TTL_SECONDS.
_recent: dict[tuple[str, str], tuple[float, Product]] = {}


def forget_prices() -> None:
    """Drop every remembered price. For tests, and for nothing else yet."""
    _recent.clear()


async def _batch(batch: list[str], location_id: str) -> list[Product]:
    payload = await client.get(
        "/v1/products",
        {"filter.productId": ",".join(batch), "filter.locationId": location_id},
    )
    return _products(payload)


async def by_ids(product_ids: list[str], location_id: str) -> dict[str, Product]:
    """Several products at once, keyed by id.

    `filter.productId` takes up to 50 comma separated ids, so a whole grocery
    list is one or two calls rather than one per line, and the calls go out
    together: each costs the better part of a second at Kroger's end
    whatever is asked, so two in sequence is twice the wait for nothing.

    A product asked for within the last few minutes is answered from memory.
    """
    now = time.monotonic()
    found: dict[str, Product] = {}
    missing: list[str] = []
    for product_id in product_ids:
        remembered = _recent.get((location_id, product_id))
        if remembered is not None and remembered[0] > now:
            found[product_id] = remembered[1]
        else:
            missing.append(product_id)

    batches = [missing[start : start + MAX_LIMIT] for start in range(0, len(missing), MAX_LIMIT)]
    for products in await asyncio.gather(*(_batch(b, location_id) for b in batches)):
        for product in products:
            found[product.product_id] = product
            _recent[(location_id, product.product_id)] = (now + PRICE_TTL_SECONDS, product)
    return found
