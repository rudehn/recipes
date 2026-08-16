"""Whether the Kroger integration is switched on.

The client has to know before it can decide whether to show any pricing at
all, and "not configured" is a normal answer rather than an error: this app
is expected to run without a Kroger account, and did so exclusively until
pricing arrived.
"""

from fastapi import APIRouter

from ..schemas import PricingStatus
from ..services.kroger import client as kroger

router = APIRouter(prefix="/pricing", tags=["pricing"])


@router.get("/status", response_model=PricingStatus)
async def status() -> PricingStatus:
    return PricingStatus(enabled=kroger.enabled())
