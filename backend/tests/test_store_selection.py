"""Choosing the Kroger store that prices are quoted against.

The two things worth proving are that unshoppable locations never reach the
picker, and that what gets stored is Kroger's description of the store rather
than whatever the client sent back. Both are quiet failures otherwise: the
first surfaces much later as a store that prices nothing, the second as
location data we altered, which the acceptable-use policy forbids.
"""

import httpx
import pytest

from app import config
from app.services.kroger import client as kroger

_real_get = httpx.AsyncClient.get


def store(location_id: str, name: str, departments: int = 40, **address) -> dict:
    return {
        "locationId": location_id,
        "name": name,
        "chain": "KROGER",
        "address": {
            "addressLine1": address.get("line1", "601 Woodman Dr"),
            "city": address.get("city", "Dayton"),
            "state": "OH",
            "zipCode": "45431",
        },
        "departments": [{"departmentId": str(n)} for n in range(departments)],
    }


class FakeLocations:
    """Stands in for the Locations API."""

    def __init__(self) -> None:
        self.search_result: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.searches: list[dict] = []
        self.error = False

    def respond(self, path: str, params: dict | None) -> httpx.Response:
        if self.error:
            raise httpx.ConnectError("no route to host")
        request = httpx.Request("GET", kroger.API_BASE + path)
        if path == "/v1/locations":
            self.searches.append(params or {})
            return httpx.Response(200, json={"data": self.search_result}, request=request)
        location_id = path.rsplit("/", 1)[-1]
        found = self.by_id.get(location_id)
        if found is None:
            return httpx.Response(404, json={"errors": {}}, request=request)
        return httpx.Response(200, json={"data": found}, request=request)


@pytest.fixture
def fake_locations(monkeypatch):
    fake = FakeLocations()

    async def fake_post(self, path, **kwargs):
        return httpx.Response(
            200,
            json={"access_token": "token-1", "expires_in": 1800},
            request=httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH),
        )

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        return fake.respond(path, params)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(kroger, "_token", None)
    return fake


async def test_locations_with_no_departments_are_left_out(client, fake_locations):
    """Kroger returns distribution points alongside shops. One would be picked
    happily and then price nothing, and the failure would surface much later
    as an empty grocery list."""
    fake_locations.search_result = [
        store("01400765", "Kroger - Kroger Riverside", departments=41),
        store("540FC216", "Kroger - - Dayton Spoke", departments=0),
        store("01400811", "Kroger Marketplace - Beavercreek", departments=56),
    ]

    resp = await client.get("/api/pricing/stores?zip=45431")

    assert resp.status_code == 200
    assert [s["location_id"] for s in resp.json()] == ["01400765", "01400811"]


async def test_store_names_are_carried_through_unaltered(client, fake_locations):
    """The acceptable-use policy requires location data be displayed exactly
    as returned, so the doubled dash and the banner prefix stay."""
    fake_locations.search_result = [store("01400811", "Kroger Marketplace - Beavercreek")]

    body = (await client.get("/api/pricing/stores?zip=45431")).json()

    assert body[0]["name"] == "Kroger Marketplace - Beavercreek"
    assert body[0]["address"] == "601 Woodman Dr, Dayton, OH 45431"


async def test_a_zip_that_is_not_a_zip_is_refused(client, fake_locations):
    resp = await client.get("/api/pricing/stores?zip=Dayton")

    assert resp.status_code == 422
    assert fake_locations.searches == []


async def test_choosing_a_store_stores_krogers_own_description(client, fake_locations):
    """The client sends only an id. Trusting a name it sent back would let
    location data be edited in transit."""
    fake_locations.by_id = {"01400765": store("01400765", "Kroger - Kroger Riverside")}

    resp = await client.put("/api/pricing/store", json={"location_id": "01400765"})

    assert resp.status_code == 200
    assert resp.json()["name"] == "Kroger - Kroger Riverside"

    status = (await client.get("/api/pricing/status")).json()
    assert status["enabled"] is True
    assert status["store"]["location_id"] == "01400765"
    assert status["store"]["address"] == "601 Woodman Dr, Dayton, OH 45431"


async def test_the_chosen_store_is_read_without_a_locations_call(client, fake_locations):
    """Status is read on any page that shows a price, and the Locations API
    allows 1,600 calls a day against the Products API's 10,000."""
    fake_locations.by_id = {"01400765": store("01400765", "Kroger - Kroger Riverside")}
    await client.put("/api/pricing/store", json={"location_id": "01400765"})
    before = len(fake_locations.searches)

    for _ in range(5):
        await client.get("/api/pricing/status")

    assert len(fake_locations.searches) == before


async def test_an_unshoppable_store_cannot_be_chosen_directly(client, fake_locations):
    """Filtering the picker is not enough if the id can still be submitted."""
    fake_locations.by_id = {"540FC216": store("540FC216", "Kroger - - Dayton Spoke", departments=0)}

    resp = await client.put("/api/pricing/store", json={"location_id": "540FC216"})

    assert resp.status_code == 404


async def test_an_unknown_store_is_reported_as_missing(client, fake_locations):
    resp = await client.put("/api/pricing/store", json={"location_id": "00000000"})

    assert resp.status_code == 404


async def test_the_chosen_store_can_be_cleared(client, fake_locations):
    fake_locations.by_id = {"01400765": store("01400765", "Kroger - Kroger Riverside")}
    await client.put("/api/pricing/store", json={"location_id": "01400765"})

    assert (await client.delete("/api/pricing/store")).status_code == 204
    assert (await client.get("/api/pricing/status")).json()["store"] is None


async def test_kroger_being_unreachable_is_reported_as_a_gateway_failure(
    client, fake_locations
):
    fake_locations.error = True

    resp = await client.get("/api/pricing/stores?zip=45431")

    assert resp.status_code == 502


async def test_store_search_is_refused_without_credentials(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")

    resp = await client.get("/api/pricing/stores?zip=45431")

    assert resp.status_code == 503


async def test_status_reports_configured_but_unset_before_a_store_is_chosen(
    client, fake_locations
):
    """The half-configured state: credentials present, nowhere to price
    against. The client needs to tell it apart from having no credentials."""
    body = (await client.get("/api/pricing/status")).json()

    assert body == {"enabled": True, "store": None}
