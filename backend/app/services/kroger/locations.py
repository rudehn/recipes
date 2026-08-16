"""Finding the Kroger store that prices are quoted against.

Store choice is a precondition rather than a preference: the Products API
returns no price at all unless a locationId is passed, so nothing downstream
works until one is picked.

This is also the tightest budget in the integration. The Locations API allows
1,600 calls a day per endpoint against the Products API's 10,000, so it is
only ever called when a person is actually choosing a store, never on a page
that merely shows prices.

A search near a zip returns more than the stores you can shop. Kroger owns
many banners, so Harris Teeter and the rest are legitimate results, but the
response also carries internal locations - "Dayton Spoke", "Unused Spoke" -
which have no departments and can price nothing. They are filtered on the
empty department list rather than on their names: it is structural rather
than lexical, and the acceptable-use policy allows omitting results while
forbidding any rewrite of the names themselves.
"""

from dataclasses import dataclass
from typing import Any

from . import client

# Wide enough to reach past a sparse zip, short enough that the list stays
# recognisable as "near me".
RADIUS_MILES = 15

# The picker is a list a person reads, not a dataset.
SEARCH_LIMIT = 15


@dataclass(frozen=True)
class Store:
    """A store as Kroger describes it, carried verbatim.

    The acceptable-use policy requires location data be displayed exactly as
    returned, so nothing here is cleaned up, abbreviated, or title-cased.
    """

    location_id: str
    name: str
    address: str
    chain: str


def _address(raw: dict[str, Any]) -> str:
    parts = [
        raw.get("addressLine1"),
        raw.get("city"),
        " ".join(p for p in (raw.get("state"), raw.get("zipCode")) if p),
    ]
    return ", ".join(p for p in parts if p)


def _store(raw: dict[str, Any]) -> Store | None:
    """A shoppable store, or None for the internal locations.

    A location with no departments is a distribution point rather than a shop.
    It would happily be selected and then price nothing.
    """
    if not raw.get("departments"):
        return None
    location_id = raw.get("locationId")
    if not location_id:
        return None
    return Store(
        location_id=location_id,
        name=raw.get("name", ""),
        address=_address(raw.get("address") or {}),
        chain=raw.get("chain", ""),
    )


def _stores(payload: dict[str, Any]) -> list[Store]:
    found = (_store(raw) for raw in payload.get("data") or [])
    return [store for store in found if store is not None]


async def search(zip_code: str) -> list[Store]:
    """Shoppable stores near a zip code, nearest first."""
    payload = await client.get(
        "/v1/locations",
        {
            "filter.zipCode.near": zip_code,
            "filter.radiusInMiles": RADIUS_MILES,
            "filter.limit": SEARCH_LIMIT,
        },
    )
    return _stores(payload)


async def get(location_id: str) -> Store | None:
    """One store by id, or None if it is unknown or cannot be shopped.

    Selection goes through this rather than trusting what the client sends
    back, so the stored name and address are always Kroger's own words.
    """
    try:
        payload = await client.get(f"/v1/locations/{location_id}")
    except client.KrogerNotFound:
        return None
    raw = payload.get("data")
    if not isinstance(raw, dict):
        return None
    return _store(raw)
