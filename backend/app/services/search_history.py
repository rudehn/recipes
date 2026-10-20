"""The searches the Recipes page remembers.

A search is written when a recipe is opened from its results, as one row of
an event log. Everything the page shows is read off that log: recent searches
are its distinct entries, newest first, and the most-searched tags count its
rows. Only the last `HISTORY_DAYS` days are kept or read, the same window the
quick row looks at.
"""

import json
from collections import Counter
from datetime import timedelta

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


def signature(search: SearchIn, identity: Identity) -> str:
    """What makes two searches the same one.

    Tag order and case do not matter, nor does the case or padding of the
    text, and ingredients are compared by identity, after merges. The text as
    typed is kept separately; this is only for telling searches apart.
    """
    return json.dumps(
        {
            "text": search.text.strip().casefold(),
            "tags": sorted(_tags(search)),
            "ingredients": sorted(_keys(search, identity)),
            "on_sale": search.on_sale,
        },
        sort_keys=True,
    )


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
            signature=signature(search, identity),
            text=text,
            tags=tags,
            ingredients=keys,
            on_sale=search.on_sale,
        )
    )
    await session.commit()


async def recent(session: AsyncSession, limit: int) -> list[RecentSearch]:
    """The newest row of each distinct search, newest first.

    Ingredient keys are resolved through merges as they are read, so an entry
    naming a merged-away ingredient opens as the one it became.
    """
    rows = (
        await session.execute(
            select(RecipeSearch)
            .where(RecipeSearch.searched_at >= _window_start())
            .order_by(RecipeSearch.searched_at.desc(), RecipeSearch.id.desc())
        )
    ).scalars()
    newest: dict[str, RecipeSearch] = {}
    for row in rows:
        newest.setdefault(row.signature, row)
    chosen = list(newest.values())[:limit]
    if not chosen:
        return []

    identity = await Identity.of(session)
    names = await ingredient_names(session)
    found = []
    for row in chosen:
        keys = dict.fromkeys(identity.resolve(key) for key in row.ingredients)
        found.append(
            RecentSearch(
                signature=row.signature,
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


async def forget(session: AsyncSession, signature: str) -> None:
    """Delete every time this search was made."""
    await session.execute(delete(RecipeSearch).where(RecipeSearch.signature == signature))
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
