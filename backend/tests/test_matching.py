"""Pinning an ingredient to a Kroger product.

The behaviour worth guarding is stability. Kroger answers identical searches
in a different order, so the same ingredient has to land on the same product
anyway, and a match once made must not be re-derived. The other half is
restraint: a wrong match is invisible in a way a missing one is not, so
"nothing confident" has to be an answer the code is willing to give.
"""

import httpx
import pytest
from sqlalchemy import select

from app import config
from app.db import session_factory
from app.models import IngredientProductMatch
from app.services.kroger import client as kroger
from app.services.kroger import matching
from app.services.kroger.products import _product as _product_from
from app.services.kroger.units import measure

LOCATION = "01400765"

_real_get = httpx.AsyncClient.get


def product(product_id: str, description: str, regular: float | None = 2.59) -> dict:
    item: dict = {"size": "5 lb", "soldBy": "UNIT"}
    if regular is not None:
        item["price"] = {"regular": regular}
    return {
        "productId": product_id,
        "upc": f"upc-{product_id}",
        "description": description,
        "brand": "Kroger",
        "items": [item],
        "aisleLocations": [{"description": "AISLE 18"}],
    }


class FakeCatalog:
    def __init__(self) -> None:
        self.results: list[dict] = []
        self.searched: list[str] = []
        self.error = False

    def respond(self, params: dict | None) -> httpx.Response:
        if self.error:
            raise httpx.ConnectError("no route to host")
        term = (params or {}).get("filter.term", "")
        self.searched.append(term)
        request = httpx.Request("GET", kroger.API_BASE + "/v1/products")
        return httpx.Response(200, json={"data": self.results}, request=request)


@pytest.fixture
def catalog(monkeypatch):
    fake = FakeCatalog()

    async def fake_post(self, path, **kwargs):
        return httpx.Response(
            200,
            json={"access_token": "token-1", "expires_in": 1800},
            request=httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH),
        )

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        return fake.respond(params)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(kroger, "_token", None)
    return fake


async def resolve(keys: list[str]) -> dict[str, str]:
    async with session_factory() as session:
        return await matching.product_ids(session, keys, LOCATION)


async def stored_rows() -> list[IngredientProductMatch]:
    async with session_factory() as session:
        rows = (await session.execute(select(IngredientProductMatch))).scalars().all()
        return list(rows)


FLOURS = [
    product("0001600010610", "Gold Medal™ All Purpose Flour"),
    product("0001111086116", "Kroger® Unbleached Enriched All Purpose Flour"),
    product(
        "0007101201050",
        "King Arthur All Purpose Unbleached Flour, Non-GMO Project, Certified Kosher",
    ),
]


async def test_the_same_ingredient_lands_on_the_same_product_whatever_the_order(catalog):
    """Kroger's search is fuzzy and reorders identical requests, so ranking
    here has to be total rather than relying on the order it sent."""
    catalog.results = FLOURS
    first = await resolve(["all-purpose-flour"])

    async with session_factory() as session:
        await session.execute(IngredientProductMatch.__table__.delete())
        await session.commit()

    catalog.results = list(reversed(FLOURS))
    second = await resolve(["all-purpose-flour"])

    assert first == second
    # The plainest description wins: the shortest that still covers the name.
    assert first["all-purpose-flour"] == "0001600010610"


async def test_a_pinned_match_is_never_searched_for_again(catalog):
    """Re-deriving it would spend a call and, worse, could land elsewhere."""
    catalog.results = FLOURS
    await resolve(["all-purpose-flour"])
    assert catalog.searched == ["all purpose flour"]

    again = await resolve(["all-purpose-flour"])

    assert catalog.searched == ["all purpose flour"]
    assert again["all-purpose-flour"] == "0001600010610"


async def test_only_the_ingredients_asked_for_are_resolved(catalog):
    """Resolution is lazy by design. A pass that walked the whole recipe box
    is what the acceptable-use policy calls systematic gathering."""
    catalog.results = FLOURS
    await resolve(["all-purpose-flour"])

    assert len(await stored_rows()) == 1


async def test_a_product_that_misses_part_of_the_name_is_not_a_match(catalog):
    """"Chicken" for "chicken thigh" prices a recipe as a whole bird, and the
    total still looks entirely reasonable."""
    catalog.results = [product("0001", "Heritage Farm® Whole Chicken")]

    resolved = await resolve(["boneless-skinless-chicken-thigh"])

    assert resolved == {}


async def test_a_measure_word_inside_the_name_does_not_block_the_match(catalog):
    """"3 cloves garlic" canonicalizes to "garlic-clove", and Kroger sells
    garlic, not garlic cloves. Dropping measure words is a second pass, so
    the bar stays high for everything that matched without it."""
    catalog.results = [product("0001", "Garlic"), product("0002", "Garlic Powder")]

    resolved = await resolve(["garlic-clove"])

    assert resolved["garlic-clove"] == "0001"


async def test_dropping_measure_words_is_only_a_fallback(catalog):
    """A product accounting for the whole name wins outright, so the second
    pass never gets to widen a search that already succeeded. "Garlic" is the
    shorter description and would win on the fallback's terms."""
    catalog.results = [
        product("0001", "Peeled Garlic Cloves"),
        product("0002", "Garlic"),
    ]

    resolved = await resolve(["garlic-clove"])

    assert resolved["garlic-clove"] == "0001"


def beef(product_id: str, description: str, size: str, regular: float, sold_by="UNIT"):
    return {
        "productId": product_id,
        "description": description,
        "items": [{"size": size, "soldBy": sold_by, "price": {"regular": regular}}],
    }


def test_the_smallest_package_that_covers_the_need_wins():
    """Ranking on description length alone bought 2¼ lb of beef at nearly
    twice the price, because "Kroger® 75/25 Ground Beef Tray" is a shorter
    string than "Kroger® 73/27 Ground Beef Roll 1 LB"."""
    candidates = [
        _product_from(beef("0001", "Kroger® 75/25 Ground Beef Tray", "36 oz", 12.00)),
        _product_from(beef("0002", "Kroger® 73/27 Ground Beef Roll 1 LB", "1 lb", 6.49)),
        _product_from(beef("0003", "Private Selection® Angus Ground Beef", "1 lb", 8.49)),
    ]

    need = measure(1, "lb")
    assert matching.choose(candidates, "ground-beef", need).product_id == "0002"
    # Without the amount it falls back to the old answer, which is the bug.
    assert matching.choose(candidates, "ground-beef").product_id == "0001"


def test_a_package_too_small_loses_to_one_that_covers():
    candidates = [
        _product_from(beef("0001", "Ground Beef Small", "8 oz", 3.00)),
        _product_from(beef("0002", "Ground Beef Large", "2 lb", 11.00)),
    ]

    assert matching.choose(candidates, "ground-beef", measure(1, "lb")).product_id == "0002"


def test_the_biggest_of_a_bad_lot_wins_when_nothing_covers_the_need():
    """These are the ones you have to buy two of, so the fewest is best."""
    candidates = [
        _product_from(beef("0001", "Ground Beef Tiny", "4 oz", 2.00)),
        _product_from(beef("0002", "Ground Beef Small", "12 oz", 5.00)),
    ]

    assert matching.choose(candidates, "ground-beef", measure(1, "lb")).product_id == "0002"


def test_a_weight_sold_item_is_costed_at_its_rate_not_its_label():
    """Its "1 lb" is a price per pound, not a pack. Three pounds is three
    times $4.99, dearer than the 3 lb tray - and comparing the labels alone
    would have said the opposite."""
    candidates = [
        _product_from(
            beef("0001", "Fresh Ground Beef", "1 lb", 4.99, sold_by="WEIGHT")
        ),
        _product_from(beef("0002", "Ground Beef Tray Packed", "3 lb", 14.00)),
    ]

    assert matching.choose(candidates, "ground-beef", measure(3, "lb")).product_id == "0002"


def test_a_weight_sold_item_is_not_rejected_for_being_too_small():
    """Any amount of it can be bought, so it fits the requirement exactly
    rather than losing to a package merely because the label is bigger."""
    candidates = [
        _product_from(
            beef("0001", "Fresh Ground Beef", "1 lb", 2.99, sold_by="WEIGHT")
        ),
        _product_from(beef("0002", "Ground Beef Tray Packed", "3 lb", 14.00)),
    ]

    assert matching.choose(candidates, "ground-beef", measure(3, "lb")).product_id == "0001"


def test_an_unreadable_size_keeps_the_older_ranking():
    """A compound size is refused rather than guessed, and the candidate is
    still offered - just ordered behind ones that could be read."""
    candidates = [
        _product_from(beef("0001", "Ground Beef Packs", "3 ct / 1 lb", 20.00)),
        _product_from(beef("0002", "Kroger® Ground Beef Roll 1 LB", "1 lb", 6.49)),
    ]

    assert matching.choose(candidates, "ground-beef", measure(1, "lb")).product_id == "0002"


async def test_nothing_confident_is_recorded_rather_than_searched_repeatedly(catalog):
    """The absence of a match is an answer. Leaving no row would re-run the
    search on every page load, for a term already known to fail."""
    catalog.results = [product("0001", "Decorative Himalayan Salt Lamp")]

    await resolve(["kosher-salt"])
    await resolve(["kosher-salt"])

    assert catalog.searched == ["kosher salt"]
    rows = await stored_rows()
    assert len(rows) == 1
    assert rows[0].product_id is None


async def test_a_product_with_no_price_is_no_use(catalog):
    """It may well be the right thing, but it cannot be priced, and a match
    that prices nothing is indistinguishable from a wrong one on the list."""
    catalog.results = [product("0001", "Kroger® All Purpose Flour", regular=None)]

    assert await resolve(["all-purpose-flour"]) == {}


async def test_a_failed_search_is_not_recorded_as_no_match(catalog):
    """A transient outage must not become a permanent verdict."""
    catalog.error = True

    assert await resolve(["all-purpose-flour"]) == {}
    assert await stored_rows() == []


async def test_a_hand_picked_match_survives_later_resolution(catalog):
    """Correcting one is the escape hatch for a bad match, so it has to be
    the last word rather than something the next search overwrites."""
    catalog.results = FLOURS
    await resolve(["all-purpose-flour"])

    async with session_factory() as session:
        await matching.confirm(session, "all-purpose-flour", LOCATION, "0007101201050")

    assert (await resolve(["all-purpose-flour"]))["all-purpose-flour"] == "0007101201050"

    rows = await stored_rows()
    assert rows[0].user_confirmed is True


async def test_a_match_is_scoped_to_its_store(catalog):
    """Catalogs differ between stores, so a match made at one says nothing
    about another."""
    catalog.results = FLOURS
    await resolve(["all-purpose-flour"])

    async with session_factory() as session:
        await matching.product_ids(session, ["all-purpose-flour"], "01400811")

    rows = await stored_rows()
    assert {row.location_id for row in rows} == {LOCATION, "01400811"}
