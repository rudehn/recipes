"""The Kroger client's token handling, and the switch that hides the feature.

Two things here are worth proving rather than assuming. Tokens are minted per
process and reused, so a bug that re-mints per request would be invisible in
behaviour but would put a second call on the wire for every request we make.
And the whole integration has to vanish cleanly when no credentials are set,
because the app ran without a Kroger account for its entire life before this
and has to keep being able to.
"""

import asyncio

import httpx
import pytest

from app import config
from app.services.kroger import client as kroger

_real_get = httpx.AsyncClient.get


class FakeKroger:
    """Stands in for api.kroger.com.

    Hands out a new token on every mint so tests can tell them apart, and
    refuses any token added to `reject`, which is how an early expiry is
    reproduced.
    """

    def __init__(self) -> None:
        self.minted: list[str] = []
        self.authorizations: list[str | None] = []
        self.reject: set[str] = set()
        self.expires_in = 1800
        self.payload: dict = {"data": [{"productId": "0001"}]}
        self.connect_error = False

    def mint(self) -> httpx.Response:
        token = f"token-{len(self.minted) + 1}"
        self.minted.append(token)
        return httpx.Response(
            200,
            json={"access_token": token, "expires_in": self.expires_in},
            request=httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH),
        )

    def fetch(self, path: str, headers: dict | None) -> httpx.Response:
        if self.connect_error:
            raise httpx.ConnectError("no route to host")
        auth = (headers or {}).get("Authorization")
        self.authorizations.append(auth)
        request = httpx.Request("GET", kroger.API_BASE + path)
        presented = (auth or "").removeprefix("Bearer ")
        if presented in self.reject:
            return httpx.Response(401, json={"error": "invalid_token"}, request=request)
        return httpx.Response(200, json=self.payload, request=request)


@pytest.fixture
def fake_kroger(monkeypatch):
    fake = FakeKroger()

    async def fake_post(self, path, **kwargs):
        return fake.mint()

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        # The app's own test client is an httpx.AsyncClient too, so only
        # requests actually aimed at Kroger are answered here.
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        return fake.fetch(path, headers)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(kroger, "_token", None)
    return fake


async def test_a_token_is_minted_once_and_reused(fake_kroger):
    """Every request carrying its own token request would silently double the
    calls we spend against a per-day budget."""
    await kroger.get("/v1/products", {"filter.term": "flour"})
    await kroger.get("/v1/products", {"filter.term": "sugar"})

    assert fake_kroger.minted == ["token-1"]
    assert fake_kroger.authorizations == ["Bearer token-1", "Bearer token-1"]


async def test_concurrent_calls_mint_a_single_token(fake_kroger):
    """Pricing fans out across a grocery list, so the first page load issues
    many requests at once against an empty token cache."""
    await asyncio.gather(*(kroger.get("/v1/products") for _ in range(5)))

    assert fake_kroger.minted == ["token-1"]


async def test_a_refused_token_is_renewed_and_the_request_retried(fake_kroger):
    """Kroger's stated lifetime is not a guarantee, so a token can be refused
    while we still believe it is good."""
    fake_kroger.reject = {"token-1"}

    body = await kroger.get("/v1/products")

    assert body == fake_kroger.payload
    assert fake_kroger.minted == ["token-1", "token-2"]
    assert fake_kroger.authorizations == ["Bearer token-1", "Bearer token-2"]


async def test_a_token_refused_twice_gives_up_rather_than_looping(fake_kroger):
    """Retrying a rejection that renewal cannot fix would spend the whole
    daily budget on one broken request."""
    fake_kroger.reject = {"token-1", "token-2", "token-3"}

    with pytest.raises(kroger.KrogerError):
        await kroger.get("/v1/products")

    assert fake_kroger.minted == ["token-1", "token-2"]


async def test_a_renewed_token_is_kept_for_the_next_call(fake_kroger):
    """The replacement has to land in the cache, or every later request pays
    for the same rejection again."""
    fake_kroger.reject = {"token-1"}
    await kroger.get("/v1/products")
    await kroger.get("/v1/products")

    assert fake_kroger.minted == ["token-1", "token-2"]


async def test_a_transport_failure_arrives_as_a_kroger_error(fake_kroger):
    """Callers degrade one item at a time and should not have to know that
    httpx is underneath."""
    fake_kroger.connect_error = True

    with pytest.raises(kroger.KrogerError):
        await kroger.get("/v1/products")


async def test_calling_without_credentials_is_refused_before_the_network(monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")

    with pytest.raises(kroger.KrogerDisabled):
        await kroger.get("/v1/products")


async def test_a_half_configured_integration_counts_as_off(monkeypatch):
    """A client id with no secret is a misconfiguration, and reporting it as
    on would surface as an authentication failure on the first price."""
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")

    assert kroger.enabled() is False


async def test_pricing_reports_itself_off_without_credentials(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")

    resp = await client.get("/api/pricing/status")

    assert resp.status_code == 200
    assert resp.json() == {"enabled": False, "store": None}


async def test_pricing_reports_itself_on_once_configured(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")

    resp = await client.get("/api/pricing/status")

    assert resp.json() == {"enabled": True, "store": None}
