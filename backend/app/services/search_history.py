"""The searches the Recipes page remembers.

A search is written when a recipe is opened from its results, as one row of
an event log. Everything the page shows is read off that log: recent searches
are its distinct entries, newest first, and the most-searched tags count its
rows. Only the last `HISTORY_DAYS` days are kept or read, the same window the
quick row looks at.
"""

import hashlib
import json
from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import RecipeSearch, utcnow
from ..schemas import IngredientName, RecentSearch, SearchIn
from .identity import Identity
from .recipe_filters import ingredient_names

HISTORY_DAYS = 60


def _tags(search: SearchIn) -> list[str]:
    seen: dict[str, None] = {}
    for tag in search.tags:
        if cleaned := tag.strip().lower():
            seen.setdefault(cleaned)
    return list(seen)


def _keys(search: SearchIn, identity: Identity) -> list[str]:
    seen: dict[str, None] = {}
    for key in search.ingredients:
        if cleaned := key.strip().lower():
            seen.setdefault(identity.resolve(cleaned))
    return list(seen)


def signature(text: str, tags: list[str], keys: list[str], on_sale: bool) -> str:
    """What makes two searches the same one, as a short handle.

    Tag order and case do not matter, nor does the case or padding of the
    text, and ingredients are compared as the caller passes them - resolved
    through today's merges, so a search made before a merge and the same
    one made after it are one search. Worked out whenever the log is read
    rather than stored, since a merge changes it after the row is written.
    Hashed, so the handle the page sends back to forget a search is the same
    short length however long the search was.
    """
    grouping = json.dumps(
        {
            "text": text.strip().casefold(),
            "tags": sorted({tag.strip().lower() for tag in tags}),
            "ingredients": sorted(set(keys)),
            "on_sale": on_sale,
        },
        sort_keys=True,
    )
    return hashlib.sha256(grouping.encode()).hexdigest()


def _signature_of(row: RecipeSearch, identity: Identity) -> str:
    keys = [identity.resolve(key) for key in row.ingredients]
    return signature(row.text, row.tags, keys, row.on_sale)


def _window_start():
    return utcnow() - timedelta(days=HISTORY_DAYS)


async def record(session: AsyncSession, search: SearchIn) -> None:
    """Log a search, unless it is empty, and drop rows past the window.

    The text is stored as typed (stripped): "100%" and `"egg roll"` are
    replayed letter for letter.
    """
    identity = await Identity.of(session)
    tags, keys, text = _tags(search), _keys(search, identity), search.text.strip()
    if not (text or tags or keys or search.on_sale):
        return
    await session.execute(delete(RecipeSearch).where(RecipeSearch.searched_at < _window_start()))
    session.add(
        RecipeSearch(
            text=text,
            tags=tags,
            ingredients=keys,
            on_sale=search.on_sale,
        )
    )
    await session.commit()


async def _logged(session: AsyncSession, since: datetime | None = None) -> list[RecipeSearch]:
    """The log, newest first; from `since` on, when given."""
    stmt = select(RecipeSearch).order_by(RecipeSearch.searched_at.desc(), RecipeSearch.id.desc())
    if since is not None:
        stmt = stmt.where(RecipeSearch.searched_at >= since)
    return list((await session.execute(stmt)).scalars())


async def recent(session: AsyncSession, limit: int) -> list[RecentSearch]:
    """The newest row of each distinct search, newest first.

    Ingredient keys are resolved through merges as they are read, so an entry
    naming a merged-away ingredient opens as the one it became, and is the
    same entry as that ingredient searched for since.
    """
    identity = await Identity.of(session)
    newest: dict[str, RecipeSearch] = {}
    for row in await _logged(session, _window_start()):
        newest.setdefault(_signature_of(row, identity), row)
    chosen = list(newest.items())[:limit]
    if not chosen:
        return []

    names = await ingredient_names(session)
    found = []
    for handle, row in chosen:
        keys = dict.fromkeys(identity.resolve(key) for key in row.ingredients)
        found.append(
            RecentSearch(
                signature=handle,
                text=row.text,
                tags=row.tags,
                ingredients=[
                    IngredientName(key=key, name=names.get(key) or key.replace("-", " "))
                    for key in keys
                ],
                on_sale=row.on_sale,
            )
        )
    return found


async def forget(session: AsyncSession, handle: str) -> None:
    """Delete every time this search was made.

    The handle is worked out from each row, so the rows are read to find
    the ones it names. The log holds at most 60 days of openings, which is
    a small read.
    """
    identity = await Identity.of(session)
    ids = [row.id for row in await _logged(session) if _signature_of(row, identity) == handle]
    if ids:
        await session.execute(delete(RecipeSearch).where(RecipeSearch.id.in_(ids)))
        await session.commit()


async def tag_frequency(session: AsyncSession) -> Counter[str]:
    """How many logged searches inside the window hold each tag.

    One per row, however many times the row names it, and whether the tag was
    searched alone or combined: "dinner · on sale" counts toward dinner.
    """
    rows = await session.execute(
        select(RecipeSearch.tags).where(RecipeSearch.searched_at >= _window_start())
    )
    counts: Counter[str] = Counter()
    for (tags,) in rows.tuples():
        counts.update(set(tags))
    return counts
