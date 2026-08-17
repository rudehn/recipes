"""Correcting the product an ingredient matched to.

The automatic pick is a heuristic and is sometimes confidently wrong - plain
"onion" matching green onions, "black pepper" matching whole peppercorns at
fifteen dollars. Neither is detectable from the total, so the remedy has to
be a person looking at the alternatives and saying which one it is. What is
worth proving is that saying so sticks.
"""

import httpx
import pytest
from sqlalchemy import select

from app import config
from app.db import session_factory
from app.models import AppSettings, IngredientProductMatch
from app.services.kroger import client as kroger

LOCATION = "01400765"

_real_get = httpx.AsyncClient.get

ONIONS = [
    {
        "productId": "0001",
        "description": "Green Onions",
        "items": [{"size": "1 bunch", "soldBy": "UNIT", "price": {"regular": 1.19}}],
        "aisleLocations": [{"description": "PRODUCE"}],
    },
    {
        "productId": "0002",
        "description": "Jumbo Yellow Onions",
        "items": [{"size": "1 lb", "soldBy": "WEIGHT", "price": {"regular": 1.29}}],
        "aisleLocations": [{"description": "PRODUCE TABLE 6"}],
    },
    {
        "productId": "0003",
        "description": "Boathouse Farms Onion Relish Jar",
        "items": [{"size": "12 oz", "soldBy": "UNIT"}],
        "aisleLocations": [],
    },
]


@pytest.fixture
def catalog(monkeypatch):
    async def fake_post(self, path, **kwargs):
        return httpx.Response(
            200,
            json={"access_token": "token-1", "expires_in": 1800},
            request=httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH),
        )

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        request = httpx.Request("GET", kroger.API_BASE + path)
        return httpx.Response(200, json={"data": ONIONS}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(kroger, "_token", None)


@pytest.fixture
async def store():
    async with session_factory() as session:
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


async def stored() -> list[IngredientProductMatch]:
    async with session_factory() as session:
        rows = (await session.execute(select(IngredientProductMatch))).scalars().all()
        return list(rows)


async def test_alternatives_come_back_best_fit_first(client, catalog, store):
    resp = await client.get("/api/pricing/alternatives?key=onion")

    assert resp.status_code == 200
    body = resp.json()
    # Every candidate that has a price, ours-first rather than Kroger's order.
    assert [p["description"] for p in body] == ["Green Onions", "Jumbo Yellow Onions"]
    assert body[0]["regular"] == 1.19


async def test_alternatives_are_not_filtered_the_way_the_automatic_pick_is(
    client, catalog, store
):
    """Anyone opening this has already been shown the automatic pick, so the
    product they want is quite likely one the matcher would have rejected."""
    resp = await client.get("/api/pricing/alternatives?key=yellow-onion")

    # "Green Onions" does not contain "yellow" and could never be chosen
    # automatically for this key, but it is still offered.
    assert "Green Onions" in [p["description"] for p in resp.json()]


async def test_a_product_with_no_price_is_not_offered(client, catalog, store):
    """It cannot be picked usefully: choosing it would leave the line unpriced
    while looking as though it had been fixed."""
    resp = await client.get("/api/pricing/alternatives?key=onion")

    assert "Boathouse Farms Onion Relish Jar" not in [
        p["description"] for p in resp.json()
    ]


async def test_choosing_a_product_pins_it(client, catalog, store):
    resp = await client.put(
        "/api/pricing/match", json={"canonical_key": "onion", "product_id": "0002"}
    )

    assert resp.status_code == 204
    rows = await stored()
    assert len(rows) == 1
    assert rows[0].product_id == "0002"
    assert rows[0].user_confirmed is True


async def test_a_correction_replaces_the_automatic_pick(client, catalog, store):
    """The row already exists from the automatic pass, so this has to update
    it rather than fail on the primary key."""
    async with session_factory() as session:
        session.add(
            IngredientProductMatch(
                canonical_key="onion", location_id=LOCATION, product_id="0001"
            )
        )
        await session.commit()

    await client.put(
        "/api/pricing/match", json={"canonical_key": "onion", "product_id": "0002"}
    )

    rows = await stored()
    assert len(rows) == 1
    assert rows[0].product_id == "0002"


async def test_a_line_can_be_marked_as_not_worth_pricing(client, catalog, store):
    """"Salt to taste" has no product. Left alone it is a permanent near-miss
    dragging on coverage; marked, it stops being counted."""
    resp = await client.put(
        "/api/pricing/match", json={"canonical_key": "salt", "product_id": None}
    )

    assert resp.status_code == 204
    rows = await stored()
    assert rows[0].product_id is None
    assert rows[0].user_confirmed is True


async def test_corrections_need_a_store_to_be_about(client, catalog):
    """Matches are per store, so there is no such thing as one without."""
    resp = await client.put(
        "/api/pricing/match", json={"canonical_key": "onion", "product_id": "0002"}
    )

    assert resp.status_code == 409


async def test_alternatives_need_credentials(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")

    resp = await client.get("/api/pricing/alternatives?key=onion")

    assert resp.status_code == 503
