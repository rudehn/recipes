"""Filters on the recipe list that need more than SQL can say.

Ingredient keys are not stored: they are computed from names in Python, after
the owner's merges (ADR 10). So a filter by ingredient cannot be a WHERE
clause. It reads the names once, reduces them the way the rest of the app
does, and hands the list route a set of recipe ids to restrict itself to.
"""

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Ingredient
from .identity import Identity


async def recipes_using(session: AsyncSession, keys: list[str]) -> set[int]:
    """Ids of the recipes that use every ingredient in `keys`.

    Each key is resolved through merges, so a history entry or bookmark naming
    a merged-away ingredient still finds what it always did. A key that is
    blank asks for nothing and is ignored; if that leaves nothing to ask for,
    nothing is restricted away, so the result is every recipe with an
    ingredient. Comparing keys, not substrings, keeps "chicken-thigh" from
    matching the wings.
    """
    identity = await Identity.of(session)
    wanted = {identity.resolve(key.strip().lower()) for key in keys if key.strip()}
    used: dict[int, set[str]] = defaultdict(set)
    rows = await session.execute(select(Ingredient.recipe_id, Ingredient.name))
    for recipe_id, name in rows.tuples():
        used[recipe_id].add(identity.key(name))
    return {recipe_id for recipe_id, found in used.items() if wanted <= found}


def intersect(*sets: set[int] | None) -> set[int] | None:
    """The ids every restriction allows; `None` is no restriction at all."""
    result: set[int] | None = None
    for ids in sets:
        if ids is not None:
            result = set(ids) if result is None else result & ids
    return result
