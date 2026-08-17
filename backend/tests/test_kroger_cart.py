"""Sending a grocery list to a real Kroger cart.

Almost everything worth proving here comes from one property of the Cart API:
it is write-only. Nothing can be read back and nothing can be removed, so a
wrong send is permanent in a way a wrong price is not. That makes the
interesting tests the ones about what is *not* sent - ticked-off lines,
unmatched lines, a list sent on a connection that is no longer valid - and
about the quantities, since ordering three of something is as irreversible as
ordering the wrong thing.

The sign-in is the other half. It is a browser round trip through a third
party, which is the one place this app takes instructions from outside, so the
state check is tested as the security control it is rather than as plumbing.
"""

import time
from datetime import date

import httpx
import pytest

from app import config
from app.db import session_factory
from app.models import AppSettings, GroceryCheck, Ingredient, MealPlanEntry, Recipe
from app.services.kroger import cart
from app.services.kroger import client as kroger

LOCATION = "01400765"
DAY = date(2026, 8, 17)
RANGE = f"start={DAY}&end={DAY}"

_real_get = httpx.AsyncClient.get
_real_put = httpx.AsyncClient.put
_real_post = httpx.AsyncClient.post


def catalog_entry(product_id: str, description: str, size: str = "5 lb", sold_by: str = "UNIT"):
    return {
        "productId": product_id,
        "upc": f"00011110{product_id}",
        "description": description,
        "items": [{"size": size, "soldBy": sold_by, "price": {"regular": 2.59}}],
    }


CATALOG = {
    "flour": catalog_entry("0001", "Kroger® All Purpose Flour"),
    "sugar": catalog_entry("0002", "Kroger® Granulated Sugar", size="4 lb"),
    # No UPC at all. It prices, and it still cannot be ordered.
    "yeast": {**catalog_entry("0003", "Kroger® Active Dry Yeast"), "upc": ""},
    "saffron": None,
}


class FakeKroger:
    """Stands in for the products, token, and cart endpoints together.

    One fake rather than three, because the tests that matter here span them:
    a cart write that is refused has to reach back to the token endpoint, and
    the point is that it does.
    """

    def __init__(self) -> None:
        self.carts: list[dict] = []
        self.tokens: list[dict] = []
        # Access tokens the cart endpoint will refuse, so the retry path can
        # be driven without waiting out an expiry.
        self.reject_access: set[str] = set()
        # Set to make the token endpoint refuse the grant outright, the way it
        # does for a spent code or a revoked refresh token.
        self.reject_grant = False
        self.issued = 0
        self.granted = 0

    def token(self, form: dict) -> httpx.Response:
        request = httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH)
        self.tokens.append(form)
        if self.reject_grant and form["grant_type"] != "client_credentials":
            return httpx.Response(400, json={"error": "invalid_grant"}, request=request)

        self.issued += 1
        body: dict = {"access_token": f"access-{self.issued}", "expires_in": 1800}
        if form["grant_type"] in {"authorization_code", "refresh_token"}:
            # Kroger rotates the refresh token on every exchange, so each
            # response carries a different one.
            self.granted += 1
            body["refresh_token"] = f"refresh-{self.granted}"
        return httpx.Response(200, json=body, request=request)

    def products(self, params: dict | None) -> httpx.Response:
        params = params or {}
        request = httpx.Request("GET", kroger.API_BASE + "/v1/products")
        if "filter.productId" in params:
            wanted = set(params["filter.productId"].split(","))
            data = [e for e in CATALOG.values() if e and e["productId"] in wanted]
            return httpx.Response(200, json={"data": data}, request=request)
        entry = CATALOG.get(params.get("filter.term", ""))
        return httpx.Response(200, json={"data": [entry] if entry else []}, request=request)

    def cart_add(self, payload: dict, headers: dict) -> httpx.Response:
        request = httpx.Request("PUT", kroger.API_BASE + cart.CART_ADD_PATH)
        token = (headers or {}).get("Authorization", "").removeprefix("Bearer ")
        if token in self.reject_access:
            return httpx.Response(401, json={"errors": {}}, request=request)
        self.carts.append(payload)
        return httpx.Response(204, request=request)


@pytest.fixture
def fake(monkeypatch):
    stub = FakeKroger()

    async def fake_post(self, path, data=None, **kwargs):
        # The test client posts to the app through httpx too, so this has to
        # let anything that is not Kroger past.
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_post(self, path, data=data, **kwargs)
        return stub.token(data or {})

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        return stub.products(params)

    async def fake_put(self, path, json=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_put(self, path, json=json, headers=headers, **kwargs)
        return stub.cart_add(json or {}, headers or {})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "put", fake_put)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(config, "KROGER_REDIRECT_URI", "https://recipes.test/api/cart/callback")
    monkeypatch.setattr(kroger, "_token", None)
    cart.forget_cached_token()
    return stub


async def seed(
    ingredients: list[str],
    *,
    store: bool = True,
    connected: bool = True,
    quantity: float = 1,
    unit: str | None = "cup",
) -> None:
    async with session_factory() as session:
        recipe = Recipe(title="Test bake", servings=4)
        recipe.ingredients = [
            Ingredient(name=name, quantity=quantity, unit=unit, position=i)
            for i, name in enumerate(ingredients)
        ]
        session.add(recipe)
        await session.flush()
        session.add(MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=recipe.id))
        settings = AppSettings(id=1)
        if store:
            settings.kroger_location_id = LOCATION
            settings.kroger_location_name = "Kroger - Kroger Riverside"
            settings.kroger_location_address = "601 Woodman Dr, Dayton, OH 45431"
            settings.kroger_location_chain = "KROGER"
        if connected:
            settings.kroger_refresh_token = "refresh-stored"
        session.add(settings)
        await session.commit()


async def send(client, **body) -> httpx.Response:
    return await client.post(
        "/api/cart/add", json={"start": str(DAY), "end": str(DAY), **body}
    )


# ------------------------------------------------------------- being off ---


async def test_the_feature_is_off_without_a_redirect_uri(client, fake, monkeypatch):
    """Credentials are enough to read prices and not enough to write a cart.
    The sign-in is a browser round trip and has to come back somewhere Kroger
    already knows about."""
    monkeypatch.setattr(config, "KROGER_REDIRECT_URI", "")

    body = (await client.get("/api/cart/status")).json()

    assert body == {
        "configured": False,
        "connected": False,
        "connected_at": None,
        "last_sent_at": None,
        "redirect_uri": "",
    }
    assert (await client.get("/api/cart/sign-in")).status_code == 503
    assert (await send(client)).status_code == 503


async def test_status_separates_not_set_up_from_not_signed_in(client, fake):
    """The two need telling apart because only the second has a button that
    fixes it."""
    await seed(["flour"], connected=False)

    body = (await client.get("/api/cart/status")).json()

    assert body["configured"] is True
    assert body["connected"] is False
    # Reported so the settings page can show the one string that has to be
    # registered on the Kroger app. A mismatch is refused by Kroger before the
    # browser comes back, so nothing here can detect it.
    assert body["redirect_uri"] == "https://recipes.test/api/cart/callback"


# --------------------------------------------------------------- sign-in ---


async def test_the_sign_in_url_asks_only_for_cart_access(client, fake):
    """A consent screen that lists scopes the feature never uses overstates
    what is being handed over."""
    url = (await client.get("/api/cart/sign-in")).json()["url"]

    assert url.startswith(kroger.API_BASE + kroger.AUTHORIZE_PATH)
    assert "scope=cart.basic%3Awrite" in url
    assert "product.compact" not in url
    assert "response_type=code" in url
    assert "redirect_uri=https%3A%2F%2Frecipes.test%2Fapi%2Fcart%2Fcallback" in url


async def test_a_callback_this_app_did_not_start_is_discarded(client, fake):
    """The one place the app takes instructions from outside. Without the
    state check, anyone could hand this callback a code and connect a cart
    nobody here asked for."""
    resp = await client.get("/api/cart/callback?code=abc&state=1755400000.deadbeef")

    assert resp.status_code == 303
    assert resp.headers["location"] == "/settings?kroger=stale"
    assert (await client.get("/api/cart/status")).json()["connected"] is False


async def test_a_state_that_has_gone_stale_is_refused(client, fake, monkeypatch):
    """Signed is not enough. A captured callback URL stays valid forever
    otherwise."""
    state = cart.new_state()
    monkeypatch.setattr(time, "time", lambda: time.monotonic() + 1e9)

    resp = await client.get(f"/api/cart/callback?code=abc&state={state}")

    assert resp.headers["location"] == "/settings?kroger=stale"


async def test_signing_in_stores_the_connection(client, fake):
    state = cart.new_state()

    resp = await client.get(f"/api/cart/callback?code=the-code&state={state}")

    assert resp.status_code == 303
    assert resp.headers["location"] == "/settings?kroger=connected"

    grant = next(t for t in fake.tokens if t["grant_type"] == "authorization_code")
    assert grant["code"] == "the-code"
    # Kroger checks this matches the URI the browser was sent to.
    assert grant["redirect_uri"] == "https://recipes.test/api/cart/callback"

    status = (await client.get("/api/cart/status")).json()
    assert status["connected"] is True
    assert status["connected_at"] is not None


async def test_declining_at_kroger_comes_back_quietly(client, fake):
    """Changing your mind at the consent screen is a decision, not a fault."""
    resp = await client.get("/api/cart/callback?error=access_denied&state=x")

    assert resp.headers["location"] == "/settings?kroger=declined"


async def test_disconnecting_forgets_the_token_and_the_cached_one(client, fake):
    """An access token outlives the refresh token that made it by up to half
    an hour, so leaving it cached leaves the cart writable after a disconnect."""
    await seed(["flour"])
    await send(client)
    assert cart._access is not None

    assert (await client.delete("/api/cart/connection")).status_code == 204

    assert cart._access is None
    assert (await client.get("/api/cart/status")).json()["connected"] is False


# ------------------------------------------------------------ what is sent ---


async def test_the_list_reaches_the_cart_as_upcs(client, fake):
    await seed(["flour", "sugar"])

    resp = await send(client)

    assert resp.status_code == 200
    assert resp.json()["added"] == 2
    assert fake.carts == [
        {
            "items": [
                {"upc": "000111100001", "quantity": 1, "modality": "PICKUP"},
                {"upc": "000111100002", "quantity": 1, "modality": "PICKUP"},
            ]
        }
    ]


async def test_delivery_can_be_asked_for_instead(client, fake):
    await seed(["flour"])

    await send(client, modality="DELIVERY")

    assert fake.carts[0]["items"][0]["modality"] == "DELIVERY"


async def test_a_modality_kroger_does_not_have_is_refused(client, fake):
    await seed(["flour"])

    assert (await send(client, modality="CURBSIDE")).status_code == 422
    assert fake.carts == []


async def test_ticked_off_lines_are_not_ordered(client, fake):
    """A tick means it is already in a trolley or already at home. This runs
    before the trip, and ordering it again is exactly what cannot be undone."""
    await seed(["flour", "sugar"])
    async with session_factory() as session:
        session.add(GroceryCheck(key="flour", checked=True))
        await session.commit()

    resp = await send(client)

    assert resp.json()["added"] == 1
    assert [i["upc"] for i in fake.carts[0]["items"]] == ["000111100002"]


async def test_lines_that_cannot_be_ordered_are_named_not_counted(client, fake):
    """Saffron matches nothing and the yeast entry has no UPC, which is what
    the cart is addressed by. "2 not sent" is not something a shopper can act
    on; two names are."""
    await seed(["flour", "saffron", "yeast"])

    resp = await send(client)

    assert resp.json()["added"] == 1
    assert sorted(resp.json()["skipped"]) == ["saffron", "yeast"]


async def test_a_week_needing_more_than_one_package_orders_more_than_one(client, fake):
    """Twelve pounds of flour against a 5 lb bag is three bags. Ordering one
    is the quiet failure: the price said twelve pounds and the cart holds
    five."""
    await seed(["flour"], quantity=12, unit="lb")

    await send(client)

    assert fake.carts[0]["items"][0]["quantity"] == 3


async def test_a_countable_ingredient_is_never_multiplied(client, fake):
    """Six of a recipe's units against Kroger's package is not six packages -
    the two count different things - so the fallback is one."""
    await seed(["flour"], quantity=6, unit=None)

    await send(client)

    assert fake.carts[0]["items"][0]["quantity"] == 1


async def test_nothing_is_sent_when_nothing_matched(client, fake):
    await seed(["saffron"])

    resp = await send(client)

    assert resp.status_code == 200
    assert resp.json()["added"] == 0
    assert resp.json()["skipped"] == ["saffron"]
    assert fake.carts == []
    # Nothing went, so nothing is recorded. A time stamped here would make the
    # page warn that a list is already in the cart when none is.
    assert resp.json()["sent_at"] is None
    assert (await client.get("/api/cart/status")).json()["last_sent_at"] is None


async def test_the_preview_says_what_would_be_sent_without_sending_it(client, fake):
    """The only chance to look, since nothing can be taken back out."""
    await seed(["flour", "saffron"], quantity=12, unit="lb")

    body = (await client.get(f"/api/cart/preview?{RANGE}")).json()

    assert fake.carts == []
    assert body["skipped"] == ["saffron"]
    assert body["lines"] == [
        {
            "key": "flour",
            "name": "flour",
            "upc": "000111100001",
            "description": "Kroger® All Purpose Flour",
            "size": "5 lb",
            "quantity": 3,
        }
    ]


async def test_the_client_cannot_choose_what_goes_in_the_cart(client, fake):
    """The request carries a date range and nothing else. Accepting UPCs would
    make the cart something the page could be talked into filling."""
    await seed(["saffron"])
    resp = await client.post(
        "/api/cart/add",
        json={
            "start": str(DAY),
            "end": str(DAY),
            "items": [{"upc": "000000000000", "quantity": 99}],
        },
    )

    assert resp.status_code == 200
    assert fake.carts == []


async def test_no_store_means_nothing_can_be_matched_to_order(client, fake):
    """Kroger returns no product data without a location, so there is nothing
    to address the cart with."""
    await seed(["flour"], store=False)

    resp = await send(client)

    assert resp.json()["added"] == 0
    assert resp.json()["skipped"] == ["flour"]


async def test_an_end_before_the_start_is_refused(client, fake):
    """A malformed request stays malformed whether or not an account is
    connected, so this is not allowed to sit behind that check."""
    resp = await client.post(
        "/api/cart/add", json={"start": str(DAY), "end": "2026-08-01"}
    )

    assert resp.status_code == 422
    assert (await client.get(f"/api/cart/preview?start={DAY}&end=2026-08-01")).status_code == 422


# ------------------------------------------------------------------ tokens ---


async def test_sending_twice_is_recorded_so_it_can_be_warned_about(client, fake):
    """Nothing can be read back out of the cart, so knowing when the last send
    went is the only thing standing between a shopper and two of everything."""
    await seed(["flour"])
    assert (await client.get("/api/cart/status")).json()["last_sent_at"] is None

    await send(client)

    assert (await client.get("/api/cart/status")).json()["last_sent_at"] is not None


async def test_a_refused_token_is_renewed_and_the_send_retried(client, fake):
    """Half an hour is Kroger's stated lifetime, not a promise. The request
    that discovers otherwise should recover rather than report it."""
    await seed(["flour"])
    await send(client)
    fake.reject_access.add(f"access-{fake.issued}")

    resp = await send(client)

    assert resp.status_code == 200
    assert len(fake.carts) == 2


async def test_the_rotated_refresh_token_is_kept(client, fake):
    """Kroger spends the refresh token it is given and hands back a
    replacement. Dropping it means the connection works once and then never
    again."""
    await seed(["flour"])

    await send(client)

    async with session_factory() as session:
        settings = await session.get(AppSettings, 1)
        assert settings.kroger_refresh_token == "refresh-1"
        assert settings.kroger_refresh_token != "refresh-stored"


async def test_a_revoked_grant_disconnects_rather_than_failing_every_week(client, fake):
    """A refresh token revoked from the shopper's Kroger account will be
    refused identically forever. Shown as disconnected, which is a state the
    settings page offers a way out of."""
    await seed(["flour"])
    fake.reject_grant = True

    resp = await send(client)

    assert resp.status_code == 409
    assert (await client.get("/api/cart/status")).json()["connected"] is False


async def test_sending_without_a_connection_asks_for_one(client, fake):
    await seed(["flour"], connected=False)

    resp = await send(client)

    assert resp.status_code == 409


async def test_an_empty_list_still_reports_that_nobody_is_connected(client, fake):
    """The connection is checked before the list is planned. Otherwise a list
    that plans to nothing never reaches the code that notices, and someone who
    has not signed in is answered "sent, 0 items"."""
    await seed([], connected=False)

    resp = await send(client)

    assert resp.status_code == 409


async def test_the_access_token_is_not_reminted_for_every_send(client, fake):
    """It lasts half an hour. Refreshing per request would also rotate the
    stored refresh token per request, for nothing."""
    await seed(["flour"])
    await send(client)
    refreshes = sum(1 for t in fake.tokens if t["grant_type"] == "refresh_token")

    await send(client)
    await send(client)

    assert sum(1 for t in fake.tokens if t["grant_type"] == "refresh_token") == refreshes
