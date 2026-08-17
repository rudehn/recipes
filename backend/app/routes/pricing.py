"""The pricing integration's status and its store selection.

The client asks `/status` before it shows anything: pricing is opt-in, and
"not configured" is a normal answer rather than an error. This app ran
without a Kroger account for its whole life before pricing arrived and has to
keep being able to.

Store selection lives here rather than in a general settings surface because
it is not really a preference. The Products API returns no price at all
without a locationId, so choosing a store is the step that makes pricing work
at all.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..schemas import (
    ItemPrice,
    MatchSelection,
    PricingStatus,
    SaleItem,
    StoreOut,
    StoreSelection,
)
from ..services import settings as settings_service
from ..services.kroger import client as kroger
from ..services.kroger import locations, matching, pricing, products

# Enough to choose from without turning the panel into a catalogue. The call
# costs the same whatever this is, so it is a reading limit, not a budget one.
ALTERNATIVES = 12

router = APIRouter(prefix="/pricing", tags=["pricing"])


def _require_configured() -> None:
    if not kroger.enabled():
        raise HTTPException(status_code=503, detail="Kroger pricing is not configured")


@router.get("/status", response_model=PricingStatus)
async def status(session: AsyncSession = Depends(get_session)):
    store = await settings_service.selected_store(session)
    return PricingStatus(enabled=kroger.enabled(), store=store)


@router.get("/stores", response_model=list[StoreOut])
async def search_stores(
    zip_code: str = Query(alias="zip", pattern=r"^\d{5}$"),
):
    """Shoppable stores near a zip code.

    Only ever called while someone is choosing, never on a page that shows
    prices: the Locations API's daily allowance is a fraction of the Products
    API's.
    """
    _require_configured()
    try:
        return await locations.search(zip_code)
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")


@router.put("/store", response_model=StoreOut)
async def select_store(
    data: StoreSelection, session: AsyncSession = Depends(get_session)
):
    """Choose the store to price against.

    The store is looked up again here rather than taken from the request, so
    the name and address that get stored are Kroger's own words and cannot be
    edited in transit.
    """
    _require_configured()
    try:
        store = await locations.get(data.location_id)
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")
    if store is None:
        raise HTTPException(status_code=404, detail="No such Kroger store")
    await settings_service.set_store(session, store)
    return store


@router.delete("/store", status_code=204)
async def clear_store(session: AsyncSession = Depends(get_session)):
    await settings_service.clear_store(session)


async def _require_store(session: AsyncSession) -> StoreOut:
    _require_configured()
    store = await settings_service.selected_store(session)
    if store is None:
        raise HTTPException(status_code=409, detail="No Kroger store chosen yet")
    return StoreOut.model_validate(store)


@router.get("/alternatives", response_model=list[ItemPrice])
async def alternatives(
    key: str = Query(min_length=1, max_length=300),
    session: AsyncSession = Depends(get_session),
):
    """Other products that could answer an ingredient, best fit first.

    Nothing is filtered on how well it matches. Someone opening this has
    already been told the automatic pick, so the one they want is quite likely
    to be one the matcher rejected.
    """
    store = await _require_store(session)
    try:
        found = await products.search(key.replace("-", " "), store.location_id, ALTERNATIVES)
    except kroger.KrogerError:
        raise HTTPException(status_code=502, detail="Could not reach Kroger")
    priced = [p for p in matching.ranked(found, key) if p.regular is not None]
    return [pricing.as_item_price(p) for p in priced[:ALTERNATIVES]]


@router.get("/sales", response_model=list[SaleItem])
async def sales(session: AsyncSession = Depends(get_session)):
    """Ingredients you cook with that are on offer.

    Re-prices products already chosen rather than searching for anything, so
    it costs one batched call and stays clear of gathering a catalogue.
    Returns an empty list rather than an error when pricing is off or no
    store is set, since an offers panel with nothing in it is a normal sight.
    """
    return await pricing.on_sale(session)


@router.put("/match", status_code=204)
async def set_match(
    data: MatchSelection, session: AsyncSession = Depends(get_session)
):
    """Pin a product to an ingredient by hand, or mark it as not to be priced.

    A hand-picked match is the last word: nothing re-derives it afterwards,
    which is the whole point of being able to correct one.
    """
    store = await _require_store(session)
    await matching.confirm(session, data.canonical_key, store.location_id, data.product_id)
