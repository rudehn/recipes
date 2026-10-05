"""Connecting a Kroger account, and sending a grocery list to its cart.

Separate from `routes.pricing` because it is a separate capability with its
own way of being switched off. Pricing needs credentials; this needs
credentials, a registered redirect URI, and a real person to have signed in -
and each of those is a state the client has to be able to tell apart, since
only the last one has a button that fixes it.

The sign-in is a browser round trip rather than an API call, so two of these
routes are navigated to rather than fetched: `/sign-in` hands back a URL for
the page to send the browser to, and `/callback` is where Kroger sends it
back. `/callback` therefore answers with a redirect and never with JSON - it
is a page load, and whatever it returns is what the shopper is looking at.
"""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config
from ..db import get_session
from ..schemas import (
    CartPlan,
    CartRequest,
    CartResult,
    CartSignIn,
    CartStatus,
    PastePlan,
    PasteRequest,
    PasteSend,
)
from ..services import settings as settings_service
from ..services.grocery import build_grocery_list
from ..services.identity import Identity
from ..services.kroger import cart
from ..services.kroger import client as kroger
from ..services.kroger.locations import Store
from ..services.shopping_text import read_shopping_text

log = logging.getLogger(__name__)

router = APIRouter(prefix="/cart", tags=["cart"])

# Where the browser lands after a sign-in, one way or the other. Relative, so
# it works on whatever host the app is reached by: the redirect URI already
# pinned that to this origin, and hard-coding it again could only disagree.
SETTINGS_PAGE = "/settings"


def _require_configured() -> None:
    if not kroger.cart_enabled():
        raise HTTPException(
            status_code=503, detail="Adding to a Kroger cart is not configured"
        )


@router.get("/status", response_model=CartStatus)
async def status(session: AsyncSession = Depends(get_session)):
    connection = await settings_service.cart_connection(session)
    return CartStatus(
        configured=kroger.cart_enabled(),
        connected=connection is not None,
        connected_at=connection.connected_at if connection else None,
        last_sent_at=connection.last_sent_at if connection else None,
        redirect_uri=config.KROGER_REDIRECT_URI,
    )


@router.get("/sign-in", response_model=CartSignIn)
async def sign_in():
    """Where to send the browser so a shopper can grant cart access."""
    _require_configured()
    return CartSignIn(url=kroger.authorize_url(cart.new_state()))


@router.get("/callback", include_in_schema=False)
async def callback(
    code: str = "",
    state: str = "",
    session: AsyncSession = Depends(get_session),
):
    """Where Kroger returns the browser after a sign-in.

    Every outcome is a redirect back to the settings page carrying what
    happened, because the shopper is looking at whatever this returns. A JSON
    error here would be a page of braces at the end of signing in.

    The reason is a short code rather than a message: it lands in a URL the
    shopper can see and bookmark, and the page it returns to is the one that
    knows how to say it.
    """
    if not kroger.cart_enabled():
        return RedirectResponse(f"{SETTINGS_PAGE}?kroger=unconfigured", status_code=303)

    # Kroger sends `error=access_denied` rather than a code when someone
    # changes their mind at the consent screen. That is a decision, not a
    # fault, so it goes back quietly.
    if not code:
        return RedirectResponse(f"{SETTINGS_PAGE}?kroger=declined", status_code=303)

    if not cart.valid_state(state):
        log.warning("Discarded a Kroger callback whose state did not check out")
        return RedirectResponse(f"{SETTINGS_PAGE}?kroger=stale", status_code=303)

    try:
        await cart.connect(session, code)
    except kroger.KrogerError as exc:
        log.warning("Could not complete the Kroger sign-in: %s", exc)
        return RedirectResponse(f"{SETTINGS_PAGE}?kroger=failed", status_code=303)

    return RedirectResponse(f"{SETTINGS_PAGE}?kroger=connected", status_code=303)


@router.delete("/connection", status_code=204)
async def disconnect(session: AsyncSession = Depends(get_session)):
    """Forget the stored permission.

    Only ends it at this end. Kroger keeps its own record of what the account
    has authorised, which is the shopper's to revoke from their Kroger
    account, and the settings page says so rather than implying otherwise.
    """
    await cart.disconnect(session)


async def _plan_for(
    session: AsyncSession,
    start: date,
    end: date,
    quantities: dict[str, int] | None = None,
    resend: list[str] | None = None,
) -> CartPlan:
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start")
    grocery_list = await build_grocery_list(session, start, end)
    try:
        return await cart.plan(session, grocery_list, quantities, resend)
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")


@router.get("/preview", response_model=CartPlan)
async def preview(
    start: date, end: date, session: AsyncSession = Depends(get_session)
):
    """What sending this list would order.

    A read, and deliberately its own request rather than something folded into
    the grocery list. Nothing can be removed from a Kroger cart once it is in
    there, so this is the only chance to look - and it must not cost anything
    on a page that is merely being read.
    """
    _require_configured()
    return await _plan_for(session, start, end)


@router.post("/add", response_model=CartResult)
async def add(data: CartRequest, session: AsyncSession = Depends(get_session)):
    """Put the list in the cart.

    The list is rebuilt here rather than accepted from the client, so what is
    ordered is what this app would have priced. It is also re-planned rather
    than reusing the preview: a preview can be minutes old, and a product that
    has gone since is better skipped than ordered. The one thing taken from
    the client is a count per line, which is the shopper's to set and cannot
    put anything in the cart that the plan did not already carry.
    """
    _require_configured()

    # Ahead of the planning rather than left to `cart.send`, for two reasons.
    # Planning costs Kroger calls that a disconnected app cannot use, and a
    # list that plans to nothing would otherwise never reach the code that
    # notices - answering "sent, 0 items" to someone who has not signed in.
    if await settings_service.cart_connection(session) is None:
        raise HTTPException(status_code=409, detail="No Kroger account is connected")

    plan = await _plan_for(session, data.start, data.end, data.quantities, data.resend)
    if not plan.lines:
        # Nothing was sent, so nothing is recorded. Stamping a send here would
        # make the page warn that a list is already in the cart when none is.
        return CartResult(added=0, skipped=plan.skipped)

    try:
        await cart.send(session, plan.lines, data.modality)
    except cart.NotConnected:
        raise HTTPException(status_code=409, detail="No Kroger account is connected")
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")

    await cart.record_sent(session, plan.lines)
    sent_at = await settings_service.record_cart_send(session)
    return CartResult(added=len(plan.lines), skipped=plan.skipped, sent_at=sent_at)


# ----------------------------------------------------------- a pasted list ---


async def _store_for_paste(session: AsyncSession) -> Store:
    store = await settings_service.selected_store(session)
    if store is None:
        # A pasted list is nothing but products to find, and there is no
        # finding them without a store. Said outright, rather than answered
        # with every line unmatched, which would read as a list gone wrong.
        raise HTTPException(
            status_code=409, detail="Choose a Kroger store in Settings first"
        )
    return store


@router.post("/paste/preview", response_model=PastePlan)
async def paste_preview(data: PasteRequest, session: AsyncSession = Depends(get_session)):
    """What sending a pasted shopping list would order.

    A read, though it is a POST: the list is the request body, and it can be
    longer than belongs in a URL. Nothing reaches the cart from here.
    """
    _require_configured()
    store = await _store_for_paste(session)
    read = read_shopping_text(data.text, await Identity.of(session))
    try:
        ordered = await cart.order_pasted(session, read, store.location_id)
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")
    return cart.paste_plan(ordered, read)


@router.post("/paste/add", response_model=CartResult)
async def paste_add(data: PasteSend, session: AsyncSession = Depends(get_session)):
    """Put a pasted shopping list in the cart.

    The text is read and planned again rather than the preview being
    trusted, for the reasons `add` gives. It records the send's time, since
    it is the same cart and a second send adds to it, and nothing else: a
    pasted list is not the grocery list and holds none of its lines back.
    """
    _require_configured()
    if await settings_service.cart_connection(session) is None:
        raise HTTPException(status_code=409, detail="No Kroger account is connected")
    store = await _store_for_paste(session)

    read = read_shopping_text(data.text, await Identity.of(session))
    try:
        ordered = await cart.order_pasted(
            session, read, store.location_id, data.quantities, data.removed
        )
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")
    lines = [o.line for o in ordered if o.line is not None]
    skipped = [o.wanted.name for o in ordered if o.line is None]
    if not lines:
        return CartResult(added=0, skipped=skipped)

    try:
        await cart.send(session, lines, data.modality)
    except cart.NotConnected:
        raise HTTPException(status_code=409, detail="No Kroger account is connected")
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")

    sent_at = await settings_service.record_cart_send(session)
    return CartResult(added=len(lines), skipped=skipped, sent_at=sent_at)
