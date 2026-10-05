"""The one way ingredients are compared: their key, after the owner's merges.

`canonical_key` reduces a name to what is bought, and is the identity the
grocery list merges on, ticks and cart lines are stored under, products and
foods are chosen under, and staples are matched by (ADR 2). It cannot know
that "ground cumin" and "cumin" are one thing to buy, and nothing should
guess that, so the owner says so with a merge (ADR 10). This module applies
those merges, and every comparison of ingredients goes through it: a place
that called `canonical_key` directly would quietly disagree with the rest
of the app about what an ingredient is, and `tests/test_merged_names.py`
fails if one does.

Merges are read once per database session and kept on it, which is once per
request in the app, so a page that compares hundreds of names reads one
small table once. A merge or unmerge calls `forget` so the session's next
comparison sees it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import IngredientMerge
from .canonical import canonical_key
from .nutrition.defaults import STATE_WORDS
from .nutrition.foods import words

# Where a session keeps its merges. Sessions are per request, so this is the
# request's view of them.
_SESSION_KEY = "ingredient_identity"


@dataclass(frozen=True)
class Identity:
    """Merged-away key to the key it now means. One step: see IngredientMerge."""

    merges: Mapping[str, str]

    @classmethod
    def none(cls) -> "Identity":
        """No merges: exactly `canonical_key`, for pure code and tests."""
        return cls(MappingProxyType({}))

    @classmethod
    def from_merges(cls, merges: Mapping[str, str]) -> "Identity":
        return cls(MappingProxyType(dict(merges)))

    @classmethod
    async def load(cls, session: AsyncSession) -> "Identity":
        rows = await session.execute(select(IngredientMerge.from_key, IngredientMerge.to_key))
        return cls.from_merges(dict(rows.tuples().all()))

    @classmethod
    async def of(cls, session: AsyncSession) -> "Identity":
        """The session's merges, read on first use and kept for the rest of it."""
        cached = session.info.get(_SESSION_KEY)
        if cached is None:
            cached = await cls.load(session)
            session.info[_SESSION_KEY] = cached
        return cached

    @staticmethod
    def forget(session: AsyncSession) -> None:
        """Drop the session's merges, after a merge or unmerge changed them."""
        session.info.pop(_SESSION_KEY, None)

    def resolve(self, key: str) -> str:
        return self.merges.get(key, key)

    def key(self, name: str) -> str:
        """The ingredient a name means, or "" for a name that is not one."""
        key = canonical_key(name)
        return self.resolve(key) if key else ""

    def nutrition_key(self, name: str) -> str:
        """The identity a food is chosen under: state words, then `key`.

        Mirrors `nutrition.defaults.nutrition_key` with the merge applied to
        the part after the state words, so merging "ground cumin" into
        "cumin" carries "cooked ground cumin" to "cooked cumin", while
        "cooked rice" and "rice" stay two foods as ADR 8 requires.
        """
        raw = canonical_key(name)
        if not raw:
            return ""
        said = set(words(name))
        state = [w for w in STATE_WORDS if w in said and w not in raw.split("-")]
        return "-".join([*state, self.resolve(raw)])
