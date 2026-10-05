"""Merging two names for one ingredient, and taking a merge back.

A merge says "ground cumin" is "cumin" from now on (ADR 10). Recipe text is
never touched; `services.identity` applies the merge wherever ingredients are
compared. What has to happen here is the rest: everything decided about the
merged-away name moves to the name that survives, in the same transaction
as the merge itself, so nothing the owner chose is lost by tidying up.

Where both names hold a decision, a hand pick beats an automatic one. Where
both hold different hand picks, or both are staples, nothing here can know
which the owner meant, so the merge is refused until they say
(`MergeNeedsChoice`), and the page asks before it sends.

Unmerging deletes the merge and nothing else. What moved stays with the
target, and the old name starts fresh: an automatic product on its next use
and its default food, if it has one.
"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    CartSentLine,
    GroceryCheck,
    Ingredient,
    IngredientFoodMatch,
    IngredientMerge,
    IngredientProductMatch,
    PantryItem,
)
from ..schemas import MergeChoices, MergeNeed, MergeSide
from .identity import Identity
from .nutrition.defaults import STATE_WORDS


class MergeRefused(Exception):
    """A merge that cannot be made. The message is a sentence for the page."""


class MergeUnknown(MergeRefused):
    """A name nothing uses, or a merge that does not exist."""


class MergeNeedsChoice(Exception):
    """Both names hold something only the owner can choose between."""

    def __init__(self, needs: list[MergeNeed]):
        super().__init__(f"Choose which {', '.join(needs)} to keep.")
        self.needs = needs


def _spoken(key: str) -> str:
    return key.replace("-", " ")


async def keys_in_use(session: AsyncSession, identity: Identity) -> set[str]:
    """Every ingredient a recipe line or a staple stands for."""
    names = (await session.execute(select(Ingredient.name))).scalars().all()
    staples = (await session.execute(select(PantryItem.name))).scalars().all()
    return {key for name in [*names, *staples] if (key := identity.key(name))}


async def _check(session: AsyncSession, identity: Identity, from_key: str, to_key: str) -> None:
    if from_key == to_key:
        raise MergeRefused("An ingredient cannot be merged into itself.")
    for key in (from_key, to_key):
        if key in identity.merges:
            raise MergeRefused(
                f"“{_spoken(key)}” is already merged into “{_spoken(identity.merges[key])}”; "
                "unmerge it first."
            )
    in_use = await keys_in_use(session, identity)
    for key in (from_key, to_key):
        if key not in in_use:
            raise MergeUnknown(f"No ingredient called “{_spoken(key)}”.")


def _food_keys(key: str) -> list[str]:
    """A key and its state-word variants, as foods are chosen under them."""
    return [key, *(f"{word}-{key}" for word in STATE_WORDS)]


async def _staples(
    session: AsyncSession, identity: Identity, from_key: str, to_key: str
) -> tuple[list[PantryItem], list[PantryItem]]:
    pantry = (await session.execute(select(PantryItem))).scalars().all()
    return (
        [p for p in pantry if identity.key(p.name) == from_key],
        [p for p in pantry if identity.key(p.name) == to_key],
    )


async def _products(
    session: AsyncSession, keys: list[str]
) -> dict[tuple[str, str], IngredientProductMatch]:
    found = await session.execute(
        select(IngredientProductMatch).where(IngredientProductMatch.canonical_key.in_(keys))
    )
    return {(row.canonical_key, row.location_id): row for row in found.scalars()}


async def _needs(
    session: AsyncSession,
    from_key: str,
    to_key: str,
    from_staples: list[PantryItem],
    to_staples: list[PantryItem],
) -> list[MergeNeed]:
    found: list[MergeNeed] = []
    products = await _products(session, [from_key, to_key])
    for (key, location), old in products.items():
        new = products.get((to_key, location))
        if (
            key == from_key
            and new is not None
            and old.user_confirmed
            and new.user_confirmed
            and old.product_id != new.product_id
        ):
            found.append("product")
            break
    for old_key, new_key in zip(_food_keys(from_key), _food_keys(to_key), strict=True):
        old = await session.get(IngredientFoodMatch, old_key)
        new = await session.get(IngredientFoodMatch, new_key)
        if old is not None and new is not None and old.fdc_id != new.fdc_id:
            found.append("food")
            break
    if from_staples and to_staples:
        found.append("staple")
    return found


async def needs(session: AsyncSession, from_key: str, to_key: str) -> list[MergeNeed]:
    """The choices merging `from_key` into `to_key` would ask for."""
    identity = await Identity.of(session)
    await _check(session, identity, from_key, to_key)
    from_staples, to_staples = await _staples(session, identity, from_key, to_key)
    return await _needs(session, from_key, to_key, from_staples, to_staples)


async def _move_products(
    session: AsyncSession, from_key: str, to_key: str, choice: MergeSide | None
) -> None:
    products = await _products(session, [from_key, to_key])
    for (key, location), old in list(products.items()):
        if key != from_key:
            continue
        new = products.get((to_key, location))
        if new is None or (old.user_confirmed and not new.user_confirmed):
            take = True
        elif old.user_confirmed and new.user_confirmed and old.product_id != new.product_id:
            take = choice == "from"
        else:
            take = False
        if take:
            if new is None:
                new = IngredientProductMatch(canonical_key=to_key, location_id=location)
                session.add(new)
            new.product_id = old.product_id
            new.user_confirmed = old.user_confirmed
            new.matcher_version = old.matcher_version
            new.resolved_at = old.resolved_at
        await session.delete(old)


async def _move_foods(
    session: AsyncSession, from_key: str, to_key: str, choice: MergeSide | None
) -> None:
    # Every stored food is a person's choice; the target's code default is
    # not a row and loses to it, as an automatic product loses to a hand pick.
    for old_key, new_key in zip(_food_keys(from_key), _food_keys(to_key), strict=True):
        old = await session.get(IngredientFoodMatch, old_key)
        if old is None:
            continue
        new = await session.get(IngredientFoodMatch, new_key)
        if new is None or (old.fdc_id != new.fdc_id and choice == "from"):
            if new is None:
                new = IngredientFoodMatch(key=new_key)
                session.add(new)
            new.fdc_id = old.fdc_id
        await session.delete(old)


async def _join_staples(
    session: AsyncSession,
    from_staples: list[PantryItem],
    to_staples: list[PantryItem],
    choice: MergeSide | None,
) -> None:
    # One staple needs nothing: once merged, its name means the target.
    if not (from_staples and to_staples):
        return
    keep = from_staples[0] if choice == "from" else to_staples[0]
    for staple in [*from_staples, *to_staples]:
        if staple is not keep:
            await session.delete(staple)


async def _move_mark(session: AsyncSession, model, from_key: str, to_key: str) -> None:
    """Re-key this trip's row for the line, unless the target has its own."""
    old = await session.get(model, from_key)
    if old is None:
        return
    if await session.get(model, to_key) is None:
        values = {column.key: getattr(old, column.key) for column in model.__table__.columns}
        session.add(model(**{**values, "key": to_key}))
    await session.delete(old)


async def merge(session: AsyncSession, from_key: str, to_key: str, choices: MergeChoices) -> None:
    """Make `from_key` mean `to_key`, moving everything decided about it."""
    identity = await Identity.of(session)
    await _check(session, identity, from_key, to_key)
    from_staples, to_staples = await _staples(session, identity, from_key, to_key)
    wanted = await _needs(session, from_key, to_key, from_staples, to_staples)
    missing = [need for need in wanted if getattr(choices, need) is None]
    if missing:
        raise MergeNeedsChoice(missing)

    await _move_products(session, from_key, to_key, choices.product)
    await _move_foods(session, from_key, to_key, choices.food)
    await _join_staples(session, from_staples, to_staples, choices.staple)
    await _move_mark(session, GroceryCheck, from_key, to_key)
    await _move_mark(session, CartSentLine, from_key, to_key)
    # Names already merged into the one going away now mean the target, so
    # a lookup stays one step.
    await session.execute(
        update(IngredientMerge).where(IngredientMerge.to_key == from_key).values(to_key=to_key)
    )
    session.add(IngredientMerge(from_key=from_key, to_key=to_key))
    await session.commit()
    Identity.forget(session)


async def unmerge(session: AsyncSession, from_key: str) -> None:
    """Take a merge back. What moved stays with the target."""
    row = await session.get(IngredientMerge, from_key)
    if row is None:
        raise MergeUnknown(f"“{_spoken(from_key)}” is not merged into anything.")
    await session.delete(row)
    await session.commit()
    Identity.forget(session)
