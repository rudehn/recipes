"""Talks to the Kroger Public API.

Pricing is the first feature in this app that needs an account, and the app
has to keep working for anyone who does not have one. With no credentials
set, `enabled()` is false and callers show no pricing at all; nothing else
changes. That is why the credentials are read through `config` on every call
instead of being captured at import time.

There is a maintained third-party client (`kroger-api` on PyPI) and it is
deliberately not used. It is built on `requests`, so every call would block
the event loop this app runs on, and it persists tokens to files under the
user's home directory, which is the wrong shape for a container. We need
three endpoints. Its source was read for the exact request and response
shapes, which is the genuinely scarce part: the developer portal renders
entirely in the browser and returns the same shell to every HTTP client, so
the documentation cannot be fetched at all.

Tokens use the client credentials grant, which needs no user interaction.
The `product.compact` scope covers both products and locations, which is
everything the pricing features read. A token is cached in memory for the
lifetime Kroger reports and refreshed on a 401, because that lifetime is not
a promise: a token can be rejected early, and the request that discovers it
should recover rather than surface the failure.
"""

import asyncio
import base64
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from ... import config

log = logging.getLogger(__name__)

API_BASE = "https://api.kroger.com"
TOKEN_PATH = "/v1/connect/oauth2/token"

# Covers products and locations both, which is everything we read.
SCOPE = "product.compact"

TIMEOUT = 10.0

# Renew this far ahead of the stated expiry, so a token cannot lapse in the
# gap between being judged valid and the request reaching Kroger.
EXPIRY_MARGIN = 60.0


class KrogerError(RuntimeError):
    """Any failure talking to Kroger.

    Raised in place of the underlying httpx errors so callers can degrade one
    item at a time without knowing what this module is built on. A grocery
    list that failed to price is still a grocery list.
    """


class KrogerDisabled(KrogerError):
    """No credentials are configured, so there is nothing to talk to."""


class KrogerNotFound(KrogerError):
    """Kroger has no such resource.

    Separated from the general failure because it is an answer rather than a
    breakdown: an id that does not resolve is something the caller decides
    what to do about, not something to report as a bad gateway.
    """


@dataclass(frozen=True)
class _Token:
    value: str
    expires_at: float

    def fresh(self) -> bool:
        return time.monotonic() < self.expires_at - EXPIRY_MARGIN


_token: _Token | None = None
_token_lock = asyncio.Lock()


def enabled() -> bool:
    """Whether the Kroger integration is configured at all."""
    return bool(config.KROGER_CLIENT_ID and config.KROGER_CLIENT_SECRET)


def _basic_auth() -> str:
    pair = f"{config.KROGER_CLIENT_ID}:{config.KROGER_CLIENT_SECRET}"
    return base64.b64encode(pair.encode()).decode()


async def _mint_token(client: httpx.AsyncClient) -> _Token:
    try:
        resp = await client.post(
            TOKEN_PATH,
            data={"grant_type": "client_credentials", "scope": SCOPE},
            headers={"Authorization": f"Basic {_basic_auth()}"},
        )
        resp.raise_for_status()
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise KrogerError(f"token request failed: {exc}") from exc

    try:
        # Trust what Kroger reports rather than assuming a lifetime: the
        # documented value is not published anywhere a client can read.
        return _Token(body["access_token"], time.monotonic() + float(body["expires_in"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise KrogerError(f"malformed token response: {body!r}") from exc


async def _access_token(client: httpx.AsyncClient, stale: str | None = None) -> str:
    """The cached token, minting a new one when it is missing, near expiry, or
    has just been rejected.

    ``stale`` is the token the caller has already seen refused. Passing it
    makes the refresh conditional: if a concurrent request replaced that token
    while this one waited for the lock, the replacement is used rather than
    minting a second token for the same rejection.
    """
    global _token

    cached = _token
    if stale is None and cached is not None and cached.fresh():
        return cached.value

    async with _token_lock:
        cached = _token
        already_replaced = cached is not None and cached.value != stale
        if cached is not None and cached.fresh() and (stale is None or already_replaced):
            return cached.value
        _token = await _mint_token(client)
        return _token.value


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


async def get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """One GET against the Kroger API, with the token handled.

    A 401 is retried exactly once against a freshly minted token, since the
    reported lifetime is not a guarantee. Everything else surfaces as
    ``KrogerError``.
    """
    if not enabled():
        raise KrogerDisabled("no Kroger credentials configured")

    async with httpx.AsyncClient(base_url=API_BASE, timeout=TIMEOUT) as client:
        token = await _access_token(client)
        try:
            resp = await client.get(path, params=params, headers=_bearer(token))
            if resp.status_code == httpx.codes.UNAUTHORIZED:
                log.info("Kroger refused a token before its stated expiry, renewing")
                token = await _access_token(client, stale=token)
                resp = await client.get(path, params=params, headers=_bearer(token))
            if resp.status_code == httpx.codes.NOT_FOUND:
                raise KrogerNotFound(f"GET {path} found nothing")
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise KrogerError(f"GET {path} failed: {exc}") from exc
