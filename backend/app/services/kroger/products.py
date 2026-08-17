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
"""

from dataclasses import dataclass
from typing import Any

from . import client

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


async def by_ids(product_ids: list[str], location_id: str) -> dict[str, Product]:
    """Several products at once, keyed by id.

    `filter.productId` takes up to 50 comma separated ids, so a whole grocery
    list is usually one call rather than one per line.
    """
    found: dict[str, Product] = {}
    for start in range(0, len(product_ids), MAX_LIMIT):
        batch = product_ids[start : start + MAX_LIMIT]
        if not batch:
            continue
        payload = await client.get(
            "/v1/products",
            {"filter.productId": ",".join(batch), "filter.locationId": location_id},
        )
        for product in _products(payload):
            found[product.product_id] = product
    return found
