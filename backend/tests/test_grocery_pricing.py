"""Prices on the grocery list.

The list is the product and prices are a garnish, so most of what is worth
proving here is what happens when Kroger is not available: the list has to
survive every one of those paths intact. The rest is that the total says how
much of the list it actually covers, because a total that quietly omits the
lines it could not match reads exactly like a complete one.
"""

from datetime import date

import httpx
import pytest

from app import config
from app.db import session_factory
from app.models import AppSettings, Ingredient, MealPlanEntry, PantryItem, Recipe
from app.services.kroger import client as kroger

LOCATION = "01400765"
DAY = date(2026, 8, 17)

_real_get = httpx.AsyncClient.get


def catalog_entry(product_id: str, description: str, regular: float, promo: float | None = None):
    price: dict = {"regular": regular}
    if promo is not None:
        price["promo"] = promo
    return {
        "productId": product_id,
        "upc": f"upc-{product_id}",
        "description": description,
        "items": [{"size": "5 lb", "soldBy": "UNIT", "price": price}],
        "aisleLocations": [{"description": "AISLE 18"}],
    }


CATALOG = {
    "flour": catalog_entry("0001", "Kroger® All Purpose Flour", 2.59),
    "sugar": catalog_entry("0002", "Kroger® Granulated Sugar", 3.99, promo=2.99),
    "saffron": None,
}


class FakeCatalog:
    def __init__(self) -> None:
        self.error = False
        self.calls = 0

    def respond(self, params: dict | None) -> httpx.Response:
        if self.error:
            raise httpx.ConnectError("no route to host")
        self.calls += 1
        params = params or {}
        request = httpx.Request("GET", kroger.API_BASE + "/v1/products")

        if "filter.productId" in params:
            wanted = set(params["filter.productId"].split(","))
            data = [e for e in CATALOG.values() if e and e["productId"] in wanted]
            return httpx.Response(200, json={"data": data}, request=request)

        term = params.get("filter.term", "")
        entry = CATALOG.get(term)
        return httpx.Response(200, json={"data": [entry] if entry else []}, request=request)


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


async def seed(ingredients: list[str], store: bool = True) -> None:
    async with session_factory() as session:
        recipe = Recipe(title="Test bake", servings=4)
        recipe.ingredients = [
            Ingredient(name=name, quantity=1, unit="cup", position=i)
            for i, name in enumerate(ingredients)
        ]
        session.add(recipe)
        await session.flush()
        session.add(MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=recipe.id))
        if store:
            session.add(
                AppSettings(
                    id=1,
                    kroger_location_id=LOCATION,
                    kroger_location_name="Kroger - Kroger Riverside",
                    kroger_location_address="601 Woodman Dr, Dayton, OH 45431",
                    kroger_location_chain="KROGER",
                )
            )
        await session.commit()


async def fetch(client) -> dict:
    resp = await client.get(f"/api/grocery-list?start={DAY}&end={DAY}")
    assert resp.status_code == 200
    return resp.json()


async def test_lines_carry_a_price_and_the_total_says_what_it_covers(client, catalog):
    """Saffron matches nothing, so the total is over two of three lines and
    has to say so rather than quietly reading as the whole list."""
    await seed(["flour", "sugar", "saffron"])

    body = await fetch(client)

    by_name = {i["name"]: i for i in body["items"]}
    assert by_name["flour"]["price"]["regular"] == 2.59
    assert by_name["flour"]["price"]["description"] == "Kroger® All Purpose Flour"
    assert by_name["saffron"]["price"] is None

    # Sugar is on offer, so the trip pays the promotional price.
    assert by_name["sugar"]["price"]["promo"] == 2.99
    assert body["pricing"]["total"] == round(2.59 + 2.99, 2)
    assert body["pricing"]["priced"] == 2
    assert body["pricing"]["total_lines"] == 3
    assert body["pricing"]["store"]["name"] == "Kroger - Kroger Riverside"


async def test_the_list_survives_kroger_being_unreachable(client, catalog):
    """The list is the product. An outage takes the prices, not the list."""
    await seed(["flour", "sugar"])
    catalog.error = True

    body = await fetch(client)

    assert [i["name"] for i in body["items"]] == ["flour", "sugar"]
    assert body["pricing"] is None
    assert all(i["price"] is None for i in body["items"])


async def test_a_list_where_nothing_matched_claims_no_total(client, catalog):
    """"$0.00, 0 of 1 priced" says the shopping is free. It is also
    indistinguishable from an outage, since a failed search is skipped inside
    the matcher rather than raised, so the total is withheld instead."""
    await seed(["saffron"])

    body = await fetch(client)

    assert body["pricing"] is None
    assert body["items"][0]["price"] is None


async def test_no_store_chosen_leaves_the_list_alone(client, catalog):
    """Credentials but nowhere to price against. /pricing/status is what tells
    the client to prompt; the list itself just carries no prices."""
    await seed(["flour"], store=False)

    body = await fetch(client)

    assert body["pricing"] is None
    assert body["items"][0]["price"] is None


async def test_pricing_is_absent_without_credentials(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")
    await seed(["flour"])

    body = await fetch(client)

    assert body["pricing"] is None


async def test_stocked_items_are_not_priced_into_the_trip(client, catalog):
    """An in-pantry item is set aside precisely because it is not being
    bought, so counting it would inflate what the trip costs."""
    await seed(["flour", "sugar"])
    async with session_factory() as session:
        session.add(PantryItem(name="sugar", in_stock=True))
        await session.commit()

    body = await fetch(client)

    assert [i["name"] for i in body["in_pantry"]] == ["sugar"]
    assert body["pricing"]["total"] == 2.59
    assert body["pricing"]["total_lines"] == 1


async def test_a_second_load_does_not_search_again(client, catalog):
    """Matches are pinned, so a reload costs one batched price lookup rather
    than a search per line."""
    await seed(["flour", "sugar"])
    await fetch(client)
    after_first = catalog.calls

    await fetch(client)

    # Two searches plus one batch on the first load; one batch on the second.
    assert after_first == 3
    assert catalog.calls - after_first == 1


async def test_the_total_says_what_the_offers_took_off_it(client, catalog):
    """Sugar is discounted from $3.99 to $2.99, so the trip saved a pound."""
    await seed(["flour", "sugar"])

    body = await fetch(client)

    assert body["pricing"]["total"] == round(2.59 + 2.99, 2)
    assert body["pricing"]["saved"] == 1.00


async def test_a_trip_with_no_offers_saved_nothing(client, catalog):
    await seed(["flour"])

    assert (await fetch(client))["pricing"]["saved"] == 0.0


async def test_offers_are_listed_for_things_already_matched(client, catalog):
    """Built from matches that exist only because a list was opened. Nothing
    is searched for, so this notices an offer rather than gathering a
    catalogue."""
    await seed(["flour", "sugar"])
    await fetch(client)

    resp = await client.get("/api/pricing/sales")

    assert resp.status_code == 200
    body = resp.json()
    # Flour is matched but not discounted, so only sugar is an offer.
    assert [s["name"] for s in body] == ["sugar"]
    assert body[0]["price"]["promo"] == 2.99
    assert body[0]["price"]["regular"] == 3.99


async def test_offers_are_empty_before_anything_has_been_matched(client, catalog):
    """No searching happens here, so with nothing matched there is nothing to
    re-price - not an error, just an empty shelf."""
    await seed(["flour"], store=True)

    assert (await client.get("/api/pricing/sales")).json() == []


async def test_offers_are_empty_rather_than_an_error_without_a_store(client, catalog):
    await seed(["flour"], store=False)

    resp = await client.get("/api/pricing/sales")

    assert resp.status_code == 200
    assert resp.json() == []
