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

There are two grants here, and they answer different questions.

Reading uses the client credentials grant, which needs no user interaction.
The `product.compact` scope covers both products and locations, which is
everything the pricing features read. A token is cached in memory for the
lifetime Kroger reports and refreshed on a 401, because that lifetime is not
a promise: a token can be rejected early, and the request that discovers it
should recover rather than surface the failure.

Writing to a cart cannot work that way. A cart belongs to a person, not to an
app, so it needs the authorization code grant: a browser round trip, a real
Kroger sign-in, and a registered redirect URI. That token is not cached here.
It belongs to a shopper rather than to the process, it outlives any restart,
and it has to be persisted - so `services.kroger.cart` owns its lifecycle and
this module only mints and spends it. See `docs/adr/0003`.
"""

import asyncio
import base64
import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from ... import config

log = logging.getLogger(__name__)

API_BASE = "https://api.kroger.com"
TOKEN_PATH = "/v1/connect/oauth2/token"
AUTHORIZE_PATH = "/v1/connect/oauth2/authorize"

# Covers products and locations both, which is everything we read.
SCOPE = "product.compact"

# The one thing the app's own token cannot do. Deliberately not asked for
# alongside `product.compact`: a shopper granting cart access should not be
# asked to grant anything the app already has without them.
CART_SCOPE = "cart.basic:write"

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


class KrogerAuthRejected(KrogerError):
    """Kroger refused a grant outright.

    A spent authorization code, or a refresh token that has expired or been
    revoked from the shopper's Kroger account. Separated from the general
    failure because the remedy is the opposite one: retrying will never work,
    and the stored connection should be dropped so the app asks to be
    reconnected rather than failing quietly every week.
    """


class KrogerUnauthorized(KrogerError):
    """A request was refused for its token.

    Raised only on the shopper's own token, where recovering means reading a
    refresh token out of the database - which this module has no access to.
    The app's own token handles its own 401 in `get`, where it can.
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


def cart_enabled() -> bool:
    """Whether a shopper could be asked to connect their cart.

    Credentials alone are not enough. The authorization code grant sends a
    browser to Kroger and needs somewhere for it to come back to, and that
    somewhere has to be registered on the Kroger app rather than guessed from
    the request.
    """
    return enabled() and bool(config.KROGER_REDIRECT_URI)


def _basic_auth() -> str:
    pair = f"{config.KROGER_CLIENT_ID}:{config.KROGER_CLIENT_SECRET}"
    return base64.b64encode(pair.encode()).decode()


async def _token_grant(client: httpx.AsyncClient, form: dict[str, str]) -> dict[str, Any]:
    """One exchange at the token endpoint, whatever the grant.

    A 4xx here is Kroger rejecting the grant itself rather than a wobble on
    the way, and is reported as such: an authorization code is single use and
    a refresh token can be revoked from the shopper's own account, and neither
    is worth retrying.
    """
    try:
        resp = await client.post(
            TOKEN_PATH, data=form, headers={"Authorization": f"Basic {_basic_auth()}"}
        )
        if resp.is_client_error:
            raise KrogerAuthRejected(
                f"Kroger refused the {form['grant_type']} grant: {resp.status_code}"
            )
        resp.raise_for_status()
        return resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise KrogerError(f"token request failed: {exc}") from exc


async def _mint_token(client: httpx.AsyncClient) -> _Token:
    body = await _token_grant(
        client, {"grant_type": "client_credentials", "scope": SCOPE}
    )
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


@dataclass(frozen=True)
class UserToken:
    """A token granted by a shopper, rather than minted by the app.

    `refresh` is the durable half and the one worth keeping: access lasts
    half an hour, while the refresh token stands for the shopper's consent
    and lasts months. `expires_in` is carried as Kroger reported it and turned
    into a deadline by whoever caches it, so this stays a plain description of
    the response.
    """

    access: str
    refresh: str
    expires_in: float


def authorize_url(state: str) -> str:
    """Where to send the browser so a shopper can grant cart access.

    Only `cart.basic:write` is asked for. The catalog is already readable on
    the app's own token, and asking for scopes the feature does not use makes
    the consent screen overstate what is being handed over.
    """
    query = urlencode(
        {
            "scope": CART_SCOPE,
            "response_type": "code",
            "client_id": config.KROGER_CLIENT_ID,
            "redirect_uri": config.KROGER_REDIRECT_URI,
            "state": state,
        }
    )
    return f"{API_BASE}{AUTHORIZE_PATH}?{query}"


def _user_token(body: dict[str, Any], keep_refresh: str = "") -> UserToken:
    try:
        return UserToken(
            access=body["access_token"],
            # Kroger rotates this: the token used to refresh is spent, and the
            # response carries its replacement. Falling back to the old one
            # rather than to nothing, because a response that omits it has
            # left the existing grant intact, and storing an empty string
            # would disconnect a shopper who is still connected.
            refresh=body.get("refresh_token") or keep_refresh,
            expires_in=float(body["expires_in"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise KrogerError("malformed token response") from exc


async def exchange_code(code: str) -> UserToken:
    """Turn the code Kroger sent back into a usable pair of tokens."""
    async with httpx.AsyncClient(base_url=API_BASE, timeout=TIMEOUT) as client:
        body = await _token_grant(
            client,
            {
                "grant_type": "authorization_code",
                "code": code,
                # Sent again at exchange, and Kroger checks it matches the one
                # the browser was sent to.
                "redirect_uri": config.KROGER_REDIRECT_URI,
            },
        )
    token = _user_token(body)
    if not token.refresh:
        # Without one the connection would last half an hour and then need the
        # whole sign-in again, which is not a connection.
        raise KrogerError("Kroger granted no refresh token")
    return token


async def refresh_user_token(refresh: str) -> UserToken:
    """A fresh access token from a stored refresh token.

    Raises `KrogerAuthRejected` when the grant is gone - expired, or revoked
    from the shopper's Kroger account - which is the caller's cue to forget
    the connection rather than to try again.
    """
    async with httpx.AsyncClient(base_url=API_BASE, timeout=TIMEOUT) as client:
        body = await _token_grant(
            client, {"grant_type": "refresh_token", "refresh_token": refresh}
        )
    return _user_token(body, keep_refresh=refresh)


async def put(path: str, payload: dict[str, Any], token: str) -> None:
    """One PUT on a shopper's own token, for a call that answers with nothing.

    A 401 is raised rather than retried, unlike `get`. Renewing this token
    means reading a refresh token out of the database, which is the caller's
    to do.
    """
    if not enabled():
        raise KrogerDisabled("no Kroger credentials configured")

    async with httpx.AsyncClient(base_url=API_BASE, timeout=TIMEOUT) as client:
        try:
            resp = await client.put(
                path,
                json=payload,
                headers={**_bearer(token), "Content-Type": "application/json"},
            )
            if resp.status_code == httpx.codes.UNAUTHORIZED:
                raise KrogerUnauthorized(f"PUT {path} was refused for its token")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise KrogerError(f"PUT {path} failed: {exc}") from exc


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
