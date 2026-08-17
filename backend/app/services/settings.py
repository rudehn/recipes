"""The single row of application settings.

Created lazily rather than seeded by a migration, so a database that predates
this table behaves the same as a fresh one and neither needs a backfill.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import SETTINGS_ID, AppSettings, utcnow
from .kroger.locations import Store


async def get(session: AsyncSession) -> AppSettings:
    """The settings row, creating it on first use."""
    settings = await session.get(AppSettings, SETTINGS_ID)
    if settings is None:
        settings = AppSettings(id=SETTINGS_ID)
        session.add(settings)
        await session.flush()
    return settings


async def selected_store(session: AsyncSession) -> Store | None:
    """The chosen Kroger store, without spending a Locations call.

    Held columns rather than a live lookup: this is read on any page that
    shows a price, and the Locations API's daily allowance is a fraction of
    the Products API's.
    """
    settings = await session.get(AppSettings, SETTINGS_ID)
    if settings is None or not settings.kroger_location_id:
        return None
    return Store(
        location_id=settings.kroger_location_id,
        name=settings.kroger_location_name or "",
        address=settings.kroger_location_address or "",
        chain=settings.kroger_location_chain or "",
    )


async def set_store(session: AsyncSession, store: Store) -> None:
    settings = await get(session)
    settings.kroger_location_id = store.location_id
    settings.kroger_location_name = store.name
    settings.kroger_location_address = store.address
    settings.kroger_location_chain = store.chain
    await session.commit()


async def clear_store(session: AsyncSession) -> None:
    settings = await get(session)
    settings.kroger_location_id = None
    settings.kroger_location_name = None
    settings.kroger_location_address = None
    settings.kroger_location_chain = None
    await session.commit()


@dataclass(frozen=True)
class CartConnection:
    """A shopper's standing permission to add to their Kroger cart."""

    refresh_token: str
    connected_at: datetime | None
    last_sent_at: datetime | None


async def cart_connection(session: AsyncSession) -> CartConnection | None:
    """The stored cart permission, or None when nobody has granted one."""
    settings = await session.get(AppSettings, SETTINGS_ID)
    if settings is None or not settings.kroger_refresh_token:
        return None
    return CartConnection(
        refresh_token=settings.kroger_refresh_token,
        connected_at=settings.kroger_connected_at,
        last_sent_at=settings.kroger_cart_sent_at,
    )


async def connect_cart(session: AsyncSession, refresh_token: str) -> None:
    """Record a permission just granted, and clear any trace of the last one.

    `kroger_cart_sent_at` goes with it: it exists to warn that sending again
    duplicates what is already in the cart, and a cart reached through a new
    sign-in may not be the same cart at all.
    """
    settings = await get(session)
    settings.kroger_refresh_token = refresh_token
    settings.kroger_connected_at = utcnow()
    settings.kroger_cart_sent_at = None
    await session.commit()


async def store_refreshed_token(session: AsyncSession, refresh_token: str) -> None:
    """Keep the replacement Kroger hands back when a token is refreshed.

    Separate from `connect_cart` because the permission is the same one: the
    shopper granted it once, and rotating the token that stands for it is not
    a new connection. Overwriting `connected_at` here would reset the age of a
    connection every half hour and make it unreadable.
    """
    settings = await get(session)
    settings.kroger_refresh_token = refresh_token
    await session.commit()


async def disconnect_cart(session: AsyncSession) -> None:
    settings = await get(session)
    settings.kroger_refresh_token = None
    settings.kroger_connected_at = None
    settings.kroger_cart_sent_at = None
    await session.commit()


async def record_cart_send(session: AsyncSession) -> datetime:
    """Note that a list has gone to the cart, and when."""
    settings = await get(session)
    settings.kroger_cart_sent_at = utcnow()
    await session.commit()
    return settings.kroger_cart_sent_at
