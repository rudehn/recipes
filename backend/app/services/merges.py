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
from ..schemas import (
    FoodConflict,
    FoodSide,
    MergeChoices,
    MergeNeed,
    MergePreview,
    MergeSide,
    ProductConflict,
    ProductSide,
    RecipeRef,
    StapleConflict,
    StapleSide,
)
from . import ingredients
from . import settings as settings_service
from .identity import Identity
from .nutrition import facts, foods
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


async def _product_clash(
    session: AsyncSession, from_key: str, to_key: str
) -> tuple[IngredientProductMatch, IngredientProductMatch] | None:
    """The first store where both names hold a different hand pick."""
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
            return old, new
    return None


async def _food_clash(
    session: AsyncSession, from_key: str, to_key: str
) -> tuple[IngredientFoodMatch, IngredientFoodMatch] | None:
    """The first food, plain or under a state word, both names chose differently."""
    for old_key, new_key in zip(_food_keys(from_key), _food_keys(to_key), strict=True):
        old = await session.get(IngredientFoodMatch, old_key)
        new = await session.get(IngredientFoodMatch, new_key)
        if old is not None and new is not None and old.fdc_id != new.fdc_id:
            return old, new
    return None


async def _needs(
    session: AsyncSession,
    from_key: str,
    to_key: str,
    from_staples: list[PantryItem],
    to_staples: list[PantryItem],
) -> list[MergeNeed]:
    found: list[MergeNeed] = []
    if await _product_clash(session, from_key, to_key) is not None:
        found.append("product")
    if await _food_clash(session, from_key, to_key) is not None:
        found.append("food")
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


def _stored_product(row: IngredientProductMatch) -> ProductSide:
    """A hand pick as its row holds it: whether it is priced, not which product.

    Enough to choose between when the pick is at a store other than the one
    prices are quoted against, or pricing is off, and nothing can say more.
    """
    return ProductSide(hand_picked=True, not_priced=row.product_id is None)


def _stored_food(row: IngredientFoodMatch) -> FoodSide:
    chosen = foods.food(row.fdc_id) if row.fdc_id is not None else None
    return FoodSide(
        food=facts.food_out(chosen) if chosen is not None else None,
        hand_picked=True,
        skipped=row.fdc_id is None,
    )


def _keeps(from_side, to_side, from_wins: bool) -> MergeSide:
    """Which side a merge keeps, where the owner does not have to choose."""
    if from_side is not None and (to_side is None or from_wins):
        return "from"
    return "to"


async def preview(session: AsyncSession, from_key: str, to_key: str) -> MergePreview:
    """What merging `from_key` into `to_key` would change, at the chosen store.

    Products are shown as they stand at the store prices are quoted against,
    and foods as the names themselves count. A choice the merge needs is
    shown from the rows that need it instead, wherever they are - another
    store, pricing off, a "cooked" food - since a question the page has
    nothing to show for leaves the owner unable to merge at all. The choice
    applies at every store and to every food where both names differ.
    """
    wanted = await needs(session, from_key, to_key)
    listing = {s.key: s for s in (await ingredients.list_ingredients(session)).ingredients}
    source, target = listing[from_key], listing[to_key]
    going = await ingredients.ingredient(session, from_key)

    def product_side(summary) -> ProductSide | None:
        standing = summary.product
        if standing is None or standing.status in ("unseen", "no_match"):
            return None
        return ProductSide(
            product=standing.product,
            hand_picked=standing.status in ("picked", "not_priced"),
            not_priced=standing.status == "not_priced",
        )

    def food_side(summary, *, stored_only: bool = False) -> FoodSide | None:
        food = summary.food
        # A default food is code, not a stored row, so a merge never moves it:
        # the going name's default is gone afterwards, while the target's
        # default survives because merged lines read the target.
        if food.status == "none" or (stored_only and food.status == "default"):
            return None
        return FoodSide(
            food=food.food,
            hand_picked=food.status in ("picked", "skipped"),
            skipped=food.status == "skipped",
        )

    def staple_side(summary) -> StapleSide | None:
        staple = summary.staple
        return StapleSide(name=staple.name, in_stock=staple.in_stock) if staple else None

    product = None
    p_from, p_to = product_side(source), product_side(target)
    clash = await _product_clash(session, from_key, to_key)
    if clash is not None:
        store = await settings_service.selected_store(session)
        at_store = store is not None and store.location_id == clash[0].location_id
        # At the chosen store the listing has the products, with prices.
        if not (at_store and p_from and p_to):
            p_from, p_to = _stored_product(clash[0]), _stored_product(clash[1])
        product = ProductConflict(from_side=p_from, to_side=p_to, keeps=None)
    elif p_from or p_to:
        from_wins = bool(p_from and p_from.hand_picked and not (p_to and p_to.hand_picked))
        product = ProductConflict(
            from_side=p_from, to_side=p_to, keeps=_keeps(p_from, p_to, from_wins)
        )
    food = None
    f_from, f_to = food_side(source, stored_only=True), food_side(target)
    food_clash = await _food_clash(session, from_key, to_key)
    if food_clash is not None:
        food = FoodConflict(
            from_side=_stored_food(food_clash[0]), to_side=_stored_food(food_clash[1]), keeps=None
        )
    elif f_from or f_to:
        from_wins = bool(f_from and f_from.hand_picked and not (f_to and f_to.hand_picked))
        food = FoodConflict(
            from_side=f_from, to_side=f_to, keeps=_keeps(f_from, f_to, from_wins)
        )
    staple = None
    s_from, s_to = staple_side(source), staple_side(target)
    if s_from or s_to:
        # One staple is kept whichever side it is on; two need a choice.
        staple = StapleConflict(
            from_side=s_from,
            to_side=s_to,
            keeps=None if "staple" in wanted else ("to" if s_to else "from"),
        )

    recipes = {line.recipe_id: line.recipe_title for line in (going.lines if going else [])}
    return MergePreview(
        from_key=from_key,
        from_name=source.name,
        to_key=to_key,
        to_name=target.name,
        recipes=[RecipeRef(id=rid, title=title) for rid, title in recipes.items()],
        product=product,
        food=food,
        staple=staple,
        needs=wanted,
    )
