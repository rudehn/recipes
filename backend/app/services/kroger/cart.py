"""Putting a grocery list into the shopper's own Kroger cart.

The last step of the trip that the app could not take before. Everything else
in this package reads the catalog on a token the app mints for itself; this
writes to something that belongs to a person, so it runs on a token that
person granted, and that difference drives the whole module.

Three properties of the Cart API shape the design, and all three are
constraints rather than choices:

**It is write-only.** There is no way to read the cart back and no way to
remove anything from it. So the app cannot reconcile, cannot retry safely, and
cannot show what is actually in there. What it can do is say exactly what it
is about to send before it sends it, and remember when it last sent - which is
why `plan` exists as a separate step from `send` rather than as its inside.

**It carries no store.** Items land in whatever cart the shopper's Kroger
account is pointed at, which is not necessarily the store this app prices
against. The two are chosen in different places and neither can see the other,
so the app quotes the store it priced with and says the cart is Kroger's to
place.

**Its grant expires.** An access token lasts half an hour, so it is not worth
a database round trip and is cached in memory here. The refresh token behind
it lasts months and is the shopper's consent made durable, so it lives in
`app_settings` - and Kroger rotates it on every refresh, meaning each renewal
has to be written back or the next one fails.

What gets ordered is not decided here. `pricing.chosen_products` picks the
product for a line, and this module orders that product and no other: a cart
that quietly disagrees with the total on screen is the failure worth designing
against, and it would be invisible until collection.
"""

import asyncio
import hashlib
import hmac
import logging
import time
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from ... import config
from ...schemas import CartLine, CartPlan, GroceryItem, GroceryList
from .. import settings as settings_service
from . import pricing
from .client import (
    EXPIRY_MARGIN,
    KrogerAuthRejected,
    KrogerError,
    KrogerUnauthorized,
    cart_enabled,
    exchange_code,
    put,
    refresh_user_token,
)
from .units import packages_to_cover, parse_size

log = logging.getLogger(__name__)

CART_ADD_PATH = "/v1/cart/add"

# How the order is to be collected. Kroger takes this per item, though nothing
# in this app has a reason to mix them within one trip.
MODALITIES = ("PICKUP", "DELIVERY")

# How long a sign-in may take before the app stops trusting the round trip.
# Generous, because the middle of it is a real person finding their Kroger
# password, and the state is single-purpose - too short is an error message at
# the end of a successful login.
STATE_TTL_SECONDS = 900


class NotConnected(KrogerError):
    """Nobody has granted this app access to a cart, or the grant is gone.

    Told apart from the other failures because it is the one with an answer
    the shopper can act on: sign in again. Raised in place of a stale token
    rather than after a doomed request, and also *by* a doomed request, since
    a revoked grant is only discovered when it is used.
    """


@dataclass(frozen=True)
class _Access:
    """A shopper's access token, cached for the half hour it lasts."""

    value: str
    expires_at: float

    def fresh(self) -> bool:
        return time.monotonic() < self.expires_at - EXPIRY_MARGIN


_access: _Access | None = None
_access_lock = asyncio.Lock()


def forget_cached_token() -> None:
    """Drop the in-memory access token.

    Called when the connection is deliberately ended or found dead, because
    the access token outlives the refresh token that produced it by up to half
    an hour, and a disconnect that leaves a working token behind has not
    disconnected anything.
    """
    global _access
    _access = None


# ---------------------------------------------------------------- sign-in ---


def _sign(payload: str) -> str:
    return hmac.new(
        config.KROGER_CLIENT_SECRET.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def new_state() -> str:
    """A one-use value proving a callback answers a sign-in this app started.

    Signed with the client secret and stamped rather than stored. There is no
    session to keep it in - this app has no users and no server-side session -
    and a signed value needs none: it cannot be forged without the secret, and
    the timestamp bounds how long a captured one is worth replaying. Without
    it, anyone could hand this app's callback a code of their own choosing and
    connect a cart nobody here asked for.
    """
    issued = str(int(time.time()))
    return f"{issued}.{_sign(issued)}"


def valid_state(state: str) -> bool:
    issued, _, signature = state.partition(".")
    if not issued.isdigit() or not signature:
        return False
    if not hmac.compare_digest(signature, _sign(issued)):
        return False
    return 0 <= time.time() - int(issued) <= STATE_TTL_SECONDS


async def connect(session: AsyncSession, code: str) -> None:
    """Trade the code Kroger sent back for a durable connection."""
    token = await exchange_code(code)
    await settings_service.connect_cart(session, token.refresh)
    global _access
    _access = _Access(token.access, time.monotonic() + token.expires_in)


async def disconnect(session: AsyncSession) -> None:
    await settings_service.disconnect_cart(session)
    forget_cached_token()


# ------------------------------------------------------------------ token ---


async def _renew(session: AsyncSession, refresh: str) -> _Access:
    """A new access token, and the rotated refresh token written back.

    A grant Kroger refuses is dropped here rather than reported. It will
    refuse it identically forever, and a connection that cannot be used is
    better shown as disconnected - which is a state the UI already knows how
    to offer a way out of.
    """
    try:
        token = await refresh_user_token(refresh)
    except KrogerAuthRejected as exc:
        log.info("The Kroger cart connection is no longer valid, forgetting it")
        await disconnect(session)
        raise NotConnected("the Kroger cart connection has expired") from exc

    if token.refresh != refresh:
        await settings_service.store_refreshed_token(session, token.refresh)
    return _Access(token.access, time.monotonic() + token.expires_in)


async def _token(session: AsyncSession, stale: str | None = None) -> str:
    """The shopper's access token, renewed when missing, old, or just refused.

    `stale` mirrors `client._access_token`: passing the token that was refused
    makes the renewal conditional, so a request that lost a race uses the
    replacement rather than minting a second one.
    """
    global _access

    cached = _access
    if stale is None and cached is not None and cached.fresh():
        return cached.value

    async with _access_lock:
        cached = _access
        already_replaced = cached is not None and cached.value != stale
        if cached is not None and cached.fresh() and (stale is None or already_replaced):
            return cached.value

        connection = await settings_service.cart_connection(session)
        if connection is None:
            raise NotConnected("no Kroger cart connected")
        _access = await _renew(session, connection.refresh_token)
        return _access.value


# ------------------------------------------------------------------- send ---


def _sendable(grocery_list: GroceryList) -> list[GroceryItem]:
    """The lines worth ordering.

    Ticked-off lines are left out. A tick means the thing is already in a real
    trolley or already at home, and this runs before a trip rather than during
    one, so ordering them again is the one mistake the cart cannot be asked to
    undo.
    """
    return [line for line in pricing.to_buy(grocery_list) if not line.checked]


async def plan(session: AsyncSession, grocery_list: GroceryList) -> CartPlan:
    """Exactly what sending this list would put in the cart.

    Shown before anything is sent, because nothing can be taken back out
    afterwards. It carries the quantities as well as the products: those are
    worked out from the week's meals and can differ from one, and "3 × Kroger
    Boneless Chicken Thighs" is a number worth reading before it is ordered.

    Lines that cannot be sent are named rather than counted. "2 not sent" is a
    number the shopper cannot act on; "parsley, bay leaf" is a shopping list.
    """
    store = await settings_service.selected_store(session)
    lines = _sendable(grocery_list)
    if store is None or not lines:
        return CartPlan(lines=[], skipped=[line.name for line in lines])

    chosen = await pricing.chosen_products(session, lines, store.location_id)

    sending: list[CartLine] = []
    skipped: list[str] = []
    for line in lines:
        product = chosen.get(line.key)
        # The UPC is what the cart is addressed by, and it is not the product
        # id. A product without one cannot be ordered even though it priced.
        if product is None or not product.upc:
            skipped.append(line.name)
            continue
        sending.append(
            CartLine(
                key=line.key,
                name=line.name,
                upc=product.upc,
                description=product.description,
                size=product.size,
                quantity=packages_to_cover(parse_size(product.size), pricing.needed(line)),
            )
        )
    return CartPlan(lines=sending, skipped=skipped)


async def send(session: AsyncSession, lines: list[CartLine], modality: str) -> None:
    """Add the lines to the cart, renewing the token once if it is refused.

    One call for the whole list: the API takes the items together, so a trip
    is a single write and cannot half-succeed across separate requests.
    """
    if not cart_enabled():
        raise NotConnected("adding to a Kroger cart is not configured")
    if not lines:
        return

    payload = {
        "items": [
            {"upc": line.upc, "quantity": line.quantity, "modality": modality}
            for line in lines
        ]
    }

    token = await _token(session)
    try:
        await put(CART_ADD_PATH, payload, token)
    except KrogerUnauthorized:
        # Half an hour is Kroger's stated lifetime, not a promise, and the
        # same reasoning as the app token applies: the request that finds out
        # should recover rather than report it.
        log.info("Kroger refused the cart token before its stated expiry, renewing")
        token = await _token(session, stale=token)
        try:
            await put(CART_ADD_PATH, payload, token)
        except KrogerUnauthorized as exc:
            # Refused on a token minted seconds ago, so it is the grant that
            # is wrong rather than the token.
            await disconnect(session)
            raise NotConnected("the Kroger cart connection was refused") from exc
