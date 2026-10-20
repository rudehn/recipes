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
import logging
import time
from dataclasses import dataclass
from typing import Any

from . import client
from .units import COUNT, parse_size

log = logging.getLogger(__name__)

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
    def sold_loose(self) -> bool:
        """Produce sold by weight off a pile: loose jalapenos, loose onions.

        Priced as a rate like anything sold by weight, and unlike the packaged
        ones - bacon, chicken from the meat case - it can be bought in any
        amount, down to a single pepper. Told apart the way produce sold by
        the piece is: by the department Kroger files it under.
        """
        return self.sold_by == "WEIGHT" and any(
            "produce" in c.casefold() for c in self.categories
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
# (location, product id) -> expires at, for an id Kroger answered without:
# a product it no longer carries. Remembered as long as a price is, so a pick
# that has gone stale is not asked about again on every request.
_absent: dict[tuple[str, str], float] = {}

# How long a page that must not wait on Kroger - the recipe list - goes
# without asking it again after it failed or was too slow. The page sends
# several requests at once and more on every keystroke; without this, each
# of them would wait out an outage of its own.
UNREACHABLE_SECONDS = 60.0

# location -> when Kroger last failed or was too slow there.
_failed_at: dict[str, float] = {}
# (location, product ids) -> the lookup already under way for them.
_pending: dict[tuple[str, tuple[str, ...]], asyncio.Future[dict[str, Product]]] = {}


def forget_prices() -> None:
    """Drop every remembered price and outage. For tests, and nothing else yet."""
    _recent.clear()
    _absent.clear()
    _failed_at.clear()
    _pending.clear()


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

    A product asked for within the last few minutes is answered from memory,
    and so is one Kroger answered without.
    """
    now = time.monotonic()
    found: dict[str, Product] = {}
    missing: list[str] = []
    for product_id in product_ids:
        remembered = _recent.get((location_id, product_id))
        if remembered is not None and remembered[0] > now:
            found[product_id] = remembered[1]
        elif _absent.get((location_id, product_id), 0.0) <= now:
            missing.append(product_id)

    batches = [missing[start : start + MAX_LIMIT] for start in range(0, len(missing), MAX_LIMIT)]
    for products in await asyncio.gather(*(_batch(b, location_id) for b in batches)):
        for product in products:
            found[product.product_id] = product
            _recent[(location_id, product.product_id)] = (now + PRICE_TTL_SECONDS, product)
    for product_id in missing:
        if product_id not in found:
            _absent[(location_id, product_id)] = now + PRICE_TTL_SECONDS
    return found


async def by_ids_promptly(
    product_ids: list[str], location_id: str, within: float
) -> dict[str, Product] | None:
    """`by_ids` for a page that must not wait on Kroger, or None instead.

    None when Kroger fails, or has not answered within `within` seconds, and
    then at once for `UNREACHABLE_SECONDS` after, so an outage costs the
    page one short wait a minute rather than one per request. Requests that
    ask for the same products together share one lookup. A lookup that ran
    out of time is not abandoned: it finishes in the background, and when it
    answers its prices are remembered and Kroger is reachable again.
    """
    if _unreachable(location_id):
        return None
    key = (location_id, tuple(product_ids))
    lookup = _pending.get(key)
    if lookup is None:
        lookup = asyncio.ensure_future(by_ids(product_ids, location_id))
        _pending[key] = lookup
        lookup.add_done_callback(lambda done: _settled(key, done))
    try:
        # Shielded, so running out of time stops the wait and not the lookup.
        return await asyncio.wait_for(asyncio.shield(lookup), within)
    except TimeoutError:
        if not _unreachable(location_id):
            log.warning("Kroger took over %ss for prices; going without", within)
        _failed_at[location_id] = time.monotonic()
        return None
    except client.KrogerError:
        return None


def _unreachable(location_id: str) -> bool:
    failed_at = _failed_at.get(location_id)
    return failed_at is not None and time.monotonic() - failed_at < UNREACHABLE_SECONDS


def _settled(key: tuple[str, tuple[str, ...]], lookup: asyncio.Future) -> None:
    """Note how a shared lookup ended, whether or not anyone still waits on it."""
    if _pending.get(key) is lookup:
        del _pending[key]
    if lookup.cancelled():
        return
    location_id = key[0]
    # Reading the exception also marks it handled, for a lookup nobody waits
    # on any more; anything but a KrogerError still reaches whoever does.
    if isinstance(lookup.exception(), client.KrogerError):
        log.warning("Could not look up prices: %s", lookup.exception())
        _failed_at[location_id] = time.monotonic()
    elif lookup.exception() is None:
        _failed_at.pop(location_id, None)
