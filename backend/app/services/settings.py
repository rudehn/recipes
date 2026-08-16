"""The single row of application settings.

Created lazily rather than seeded by a migration, so a database that predates
this table behaves the same as a fresh one and neither needs a backfill.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import SETTINGS_ID, AppSettings
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
