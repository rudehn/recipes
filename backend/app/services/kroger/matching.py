"""Deciding which Kroger product an ingredient means, once.

Kroger's search is fuzzy and answers identical requests in a different order,
so "take the first result" gives a different product, and a different price,
every time the page is opened. The choice is therefore made once, ranked by
rules of our own so it is deterministic, and then pinned.

The failure that matters is not a missing match but a *wrong* one. A missing
match is visible - the line says it could not be priced - while "kosher salt"
matching a decorative salt lamp silently adds forty dollars to a total that
still looks perfectly plausible. So the bar to record a match at all is
deliberately high, and no confident answer is stored as no answer.
"""

import logging
import re
from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import IngredientProductMatch
from ..canonical import _fold_accents, _singularize
from ..grocery import UNIT_ALIASES
from . import products
from .client import KrogerError
from .density import grams_per_cup
from .products import Product
from .units import Measure, comparable, cost_to_cover, parse_size

log = logging.getLogger(__name__)

# Which rules chose an automatic match. Rows are pinned, so a match made under
# older rules would otherwise keep its answer forever - "avocado" stayed a
# bottle of oil for as long as the row existed, however the ranking improved.
# Bump this when `choose` changes what it would pick, and unconfirmed rows
# made under the old number are searched again on their next use. Hand picks
# are never touched: they were not this module's decision.
#
# 1: substring coverage, no vetoes.
# 2: whole-word coverage, derivative and non-food vetoes, out-of-stock
#    products passed over.
MATCHER_VERSION = 2

# How much of the ingredient name a product description has to account for.
# Every token, in practice: "chicken thigh" matching a product that mentions
# only chicken is how a recipe ends up priced as a whole bird.
MIN_COVERAGE = 1.0

# Enough to rank within, without paying for the API's full ceiling on a term
# that is usually answered well by its first few hits.
SEARCH_LIMIT = 25


# Measure words that end up inside an ingredient name rather than beside it,
# as "garlic cloves, minced" does. Kroger sells garlic, not garlic cloves, so
# these are dropped on a second pass - but only on the second, because they
# are part of the name often enough ("clove" the spice) to be worth trying
# with first.
_UNIT_WORDS = set(UNIT_ALIASES) | set(UNIT_ALIASES.values())


def _tokens(canonical_key: str) -> list[str]:
    return [t for t in canonical_key.split("-") if t]


def _without_unit_words(tokens: list[str]) -> list[str] | None:
    """The name with measure words removed, or None if that changes nothing."""
    kept = [t for t in tokens if t not in _UNIT_WORDS]
    return kept if kept and len(kept) < len(tokens) else None


_WORD_RE = re.compile(r"[a-z0-9]+")


def _words(description: str) -> list[str]:
    """A description as the words `canonical_key` would have made of it.

    Accents are folded and plurals singularized the same way the key was, so
    "Jalapeño Peppers" and the key "jalapeno-pepper" meet on equal terms.
    """
    return [_singularize(w) for w in _WORD_RE.findall(_fold_accents(description).casefold())]


def _coverage(tokens: list[str], words: list[str]) -> float:
    """How much of the ingredient the description accounts for.

    Whole words, compared after the same singularizing the key went through.
    This used to be a substring test, chosen so that the key's "thigh" would
    find Kroger's "Thighs" - and it did, but it also let "pea" find peanuts
    and "pepper" find peppercorns, which are wrong in the invisible way. A
    word either is the ingredient or it is not.
    """
    if not tokens:
        return 0.0
    present = set(words)
    return sum(1 for t in tokens if t in present) / len(tokens)


# Words that make a product a different thing from the ingredient whose name
# it carries. "Avocado Oil" accounts for every letter of "avocado" and is not
# one; the same goes for garlic powder, coconut milk, apple juice, and a bag
# of dog food with chicken in its name. A candidate carrying one of these that
# the ingredient itself does not is refused - only for the automatic pick,
# since the alternatives exist for exactly the case where the rule is wrong.
#
# Hand-curated in the same spirit as PREP_WORDS. Words that name a form the
# ingredient is honestly sold in are left out on purpose: "sesame" is bought
# as sesame seeds and "maple" as maple syrup.
DERIVATIVE_WORDS = frozenset({
    # Extracted from the ingredient
    "oil", "juice", "extract", "powder", "concentrate", "vinegar", "wine",
    # Made from it
    "milk", "cream", "butter", "cheese", "yogurt", "flour", "bread", "chip",
    "flake", "sauce", "paste", "broth", "stock", "soup", "salsa", "jam",
    "jelly", "spread", "dip", "dressing", "seasoning", "chocolate", "candy",
    "cookie", "cake", "pie", "bar", "cereal", "smoothie", "drink", "soda",
    # Merely tastes or smells of it
    "flavored", "flavor", "scented",
    # Not food at all
    "food", "treat", "candle", "soap", "lotion", "shampoo", "supplement",
    "vitamin", "capsule", "spray", "cleaner", "wash",
})


def _is_derivative(words: list[str], tokens: list[str]) -> bool:
    """Whether the description names the ingredient as something else."""
    own = set(tokens)
    return any(w in DERIVATIVE_WORDS and w not in own for w in words)


# Kroger department names that no recipe ingredient is bought from. Kroger's
# search does not stop at the grocery aisles, so "chicken" reaches the pet
# food and "lavender" the candles, and a description is not always enough to
# tell. Matched as substrings of the category names Kroger returns, which are
# free text of theirs and have not been catalogued from here: a name that
# contains "Pet" is not food whatever the rest of it says.
NON_FOOD_CATEGORIES = (
    "pet",
    "health",
    "beauty",
    "personal care",
    "household",
    "cleaning",
    "baby",
    "home",
    "garden",
    "floral",
    "kitchen",
    "toy",
    "electronics",
    "office",
    "automotive",
    "sporting",
    "party",
    "apparel",
    "pharmacy",
)


def _non_food(product: Product) -> bool:
    return any(
        marker in category.casefold()
        for category in product.categories
        for marker in NON_FOOD_CATEGORIES
    )

# Extra words are bucketed rather than compared one by one, because brand
# names vary in length for reasons that say nothing about the product. Three
# is wide enough to put "Kroger® 75/25 Ground Beef Tray" and "Kroger® 73/27
# Ground Beef Roll 1 LB" in the same bucket, so price decides between them,
# and narrow enough to keep a bag of brown sugar out of the same bucket as
# "Less Sugar Maple & Brown Sugar Instant Oatmeal".
_SLACK = 3


def _slack(words: list[str], tokens: list[str]) -> int:
    """How much of the description the ingredient does *not* account for.

    Coverage asks whether the name appears; this asks how much else is there.
    Both were needed once price led the ranking: cheapest-that-matches happily
    bought oatmeal, because "brown sugar" appears in its name and it is
    cheaper than brown sugar. A product whose description is mostly the
    ingredient is far likelier to be the ingredient.
    """
    extra = sum(
        1
        for w in words
        # Numbers and measures are not description. Counting them punished
        # exactly the products that state a fat ratio or a pack size - "75/25
        # Ground Beef Tray" against "73/27 Ground Beef Roll 1 LB" - and that
        # put the ground beef bug straight back.
        if not w.isdigit() and w not in _UNIT_WORDS and not any(t in w for t in tokens)
    )
    return extra // _SLACK


def _fit(
    product: Product, need: Measure | None, canonical_key: str
) -> tuple[int, float, float]:
    """How well a package suits the amount the week's meals actually call for.

    Description length is a poor stand-in for "the obvious one to buy" once
    sizes differ. Asked for a pound of ground beef it chose a 36 oz tray at
    $12.00 over a 1 lb roll at $6.49, because the tray's name is shorter -
    two and a quarter times the meat at nearly twice the price.

    So: whatever covers the requirement most cheaply, and only then the least
    left over. Cost has to lead. Ordering on waste first sounds tidier and is
    actively wrong for a store cupboard - half a teaspoon of salt is dwarfed
    by every packet on the shelf, so "least left over" picks the smallest and
    dearest one. It moved salt from a 26 oz drum at $0.99 to a 2.12 oz grinder
    at $2.99, and let a $10.99 pack of brown-sugar-cured bacon beat a $2.29
    bag of brown sugar, because the bacon happened to be nearer a teaspoon in
    weight. What is left over is not waste; it is the cupboard.

    Both sides are converted to weight through the same density, so a recipe's
    two cups of flour and a five pound bag of it become comparable. Where
    there is no density, or the size cannot be read, the older ranking stands
    rather than a guess being made.
    """
    # Neutral, so an unreadable size leaves the older ranking exactly as it
    # was rather than quietly introducing a preference of its own.
    unknown = (2, 0.0, 0.0)
    if need is None:
        return unknown

    # Both sides are brought to one dimension by `comparable`, which is also
    # what the cart's quantity goes through, so the package chosen here is
    # the one whose count is worked out there. Where the two cannot be
    # related - no density for this ingredient, a size that cannot be read,
    # a count of cloves against a count of bulbs - the older ranking stands
    # rather than a guess being made.
    grams = grams_per_cup(canonical_key)
    each = product.sold_by_piece
    related = comparable(parse_size(product.size), need, canonical_key, grams, each)
    if related is None:
        return unknown
    size, wanted = related

    price = product.regular or 0.0
    cost = cost_to_cover(
        price, parse_size(product.size), product.sold_by, need, canonical_key, grams, each
    )

    # Sold by weight, the price is a rate and any amount can be bought, so it
    # fits the requirement exactly rather than over- or under-shooting it.
    if product.sold_by == "WEIGHT":
        return (0, cost, 0.0)
    if size.base >= wanted.base:
        return (0, cost, size.base - wanted.base)
    # Too small: it has to be bought more than once, which `cost` already
    # accounts for, so the cheapest way to get there still wins.
    return (1, cost, -size.base)


def _rank(
    product: Product,
    tokens: list[str],
    need: Measure | None = None,
    canonical_key: str = "",
) -> tuple:
    """Sort key, best first, and total so the order cannot wobble.

    Coverage of the ingredient's name first, then how much else the
    description carries, then how well the package fits the amount needed,
    and only then the shorter description - which remains
    the tiebreak when nothing else separates two candidates, because a short
    description is usually the plain version of the thing. The id breaks any
    remaining tie so two equally good candidates cannot swap between calls.
    """
    words = _words(product.description)
    return (
        -_coverage(tokens, words),
        _slack(words, tokens),
        _fit(product, need, canonical_key),
        len(product.description),
        product.product_id,
    )


def ranked(
    candidates: list[Product], canonical_key: str, need: Measure | None = None
) -> list[Product]:
    """Every candidate in best-fit order, for a person to choose from.

    Unlike `choose`, nothing is filtered on coverage. The whole point of
    offering alternatives is that the automatic pick was wrong, so the product
    the cook actually wants may well be one this module rejected.
    """
    tokens = _tokens(canonical_key)
    if not tokens:
        return list(candidates)
    return sorted(candidates, key=lambda p: _rank(p, tokens, need, canonical_key))


def _best(
    candidates: list[Product],
    tokens: list[str],
    need: Measure | None,
    canonical_key: str,
) -> Product | None:
    # A product with no price is no use even when it is the right thing, and
    # one that does not account for the whole ingredient name is a guess. One
    # that accounts for it and then some - the oil, the powder, the juice -
    # is a different thing, and so is anything from a department that sells
    # no food. One the shelf is out of is passed over too: pinning it would
    # price the list against something that cannot be bought, and the row
    # would outlast the gap on the shelf.
    usable = [
        p
        for p in candidates
        if p.regular is not None
        and p.in_stock
        and _coverage(tokens, words := _words(p.description)) >= MIN_COVERAGE
        and not _is_derivative(words, tokens)
        and not _non_food(p)
    ]
    if not usable:
        return None
    return min(usable, key=lambda p: _rank(p, tokens, need, canonical_key))


def choose(
    candidates: list[Product], canonical_key: str, need: Measure | None = None
) -> Product | None:
    """The best product for an ingredient, or None if none is good enough.

    Two passes over the same results, never a second search. The first asks
    for the whole name; the second drops measure words, which is what lets
    "garlic clove" find garlic without loosening the bar for everything else.
    """
    tokens = _tokens(canonical_key)
    if not tokens:
        return None
    chosen = _best(candidates, tokens, need, canonical_key)
    if chosen is not None:
        return chosen
    reduced = _without_unit_words(tokens)
    return _best(candidates, reduced, need, canonical_key) if reduced else None


async def _stored(
    session: AsyncSession, keys: list[str], location_id: str
) -> dict[str, IngredientProductMatch]:
    if not keys:
        return {}
    rows = (
        await session.execute(
            select(IngredientProductMatch).where(
                IngredientProductMatch.location_id == location_id,
                IngredientProductMatch.canonical_key.in_(keys),
            )
        )
    ).scalars().all()
    return {row.canonical_key: row for row in rows}


async def _resolve(
    session: AsyncSession,
    canonical_key: str,
    location_id: str,
    need: Measure | None = None,
) -> str | None:
    """Search for one ingredient and record the answer, including "none"."""
    term = canonical_key.replace("-", " ")
    try:
        candidates = await products.search(term, location_id, SEARCH_LIMIT)
    except KrogerError as exc:
        # Left unrecorded on purpose: a search that never happened is not the
        # same as one that found nothing, and storing it as "no match" would
        # make a transient outage permanent.
        log.warning("Kroger product search failed for %r: %s", canonical_key, exc)
        return None

    chosen = choose(candidates, canonical_key, need)
    if chosen is None:
        log.info(
            "No confident Kroger match for %r among %d results",
            canonical_key,
            len(candidates),
        )
    session.add(
        IngredientProductMatch(
            canonical_key=canonical_key,
            location_id=location_id,
            product_id=chosen.product_id if chosen else None,
            user_confirmed=False,
            matcher_version=MATCHER_VERSION,
        )
    )
    return chosen.product_id if chosen else None


@dataclass(frozen=True)
class Pick:
    """What an ingredient has been decided to mean, and who decided.

    `product_id` is None for a line deliberately left unpriced, or for a
    search that found nothing confident. `hand_picked` is what separates a
    choice a person made from one this module made - the first is never
    revisited, and the page says which is which so a remembered choice is
    something the shopper can see rather than something that merely happens.
    """

    product_id: str | None
    hand_picked: bool


async def picks(
    session: AsyncSession,
    canonical_keys: list[str],
    location_id: str,
    needs: dict[str, Measure] | None = None,
) -> dict[str, Pick]:
    """What each ingredient given means here, resolving any not seen before.

    Only the keys asked for are touched. Keys already recorded are returned
    from the row, never re-searched, which is what keeps a price stable
    between page loads. Every key asked for is answered, including those that
    resolved to nothing: the caller shows those as unpriced, and needs to
    know whether that was a person's decision.
    """
    stored = await _stored(session, canonical_keys, location_id)

    # An automatic answer from older rules is dropped and asked again, so an
    # improvement to the ranking reaches the lists already priced under the
    # old one. Hand picks are kept whatever version they carry.
    stale = [
        row
        for row in stored.values()
        if not row.user_confirmed and row.matcher_version < MATCHER_VERSION
    ]
    for row in stale:
        await session.delete(row)
        del stored[row.canonical_key]
    if stale:
        await session.flush()

    resolved: dict[str, Pick] = {
        key: Pick(row.product_id, row.user_confirmed) for key, row in stored.items()
    }
    unseen = [key for key in canonical_keys if key and key not in stored]
    for key in unseen:
        product_id = await _resolve(session, key, location_id, (needs or {}).get(key))
        resolved[key] = Pick(product_id, False)
    if unseen or stale:
        await session.commit()
    return resolved


async def stored_picks(
    session: AsyncSession, canonical_keys: list[str], location_id: str
) -> dict[str, Pick]:
    """What is already decided, and nothing more.

    For callers that must not search - ranking the whole recipe box would
    otherwise be a search per ingredient in it. Keys nothing has answered
    are absent, and the caller treats them as unpriced.
    """
    stored = await _stored(session, canonical_keys, location_id)
    return {key: Pick(row.product_id, row.user_confirmed) for key, row in stored.items()}


async def product_ids(
    session: AsyncSession,
    canonical_keys: list[str],
    location_id: str,
    needs: dict[str, Measure] | None = None,
) -> dict[str, str]:
    """Product ids alone, for callers with no interest in who chose them.

    Keys that resolved to nothing are absent, which is the older contract.
    """
    found = await picks(session, canonical_keys, location_id, needs)
    return {key: pick.product_id for key, pick in found.items() if pick.product_id}


async def confirm(
    session: AsyncSession, canonical_key: str, location_id: str, product_id: str | None
) -> None:
    """Pin a hand-picked product, which re-resolution then leaves alone.

    A null `product_id` is a deliberate "do not price this", for the lines no
    product answers - "salt to taste", or a garnish. It is stored the same way
    as a search that found nothing, but confirmed, so it is never revisited.
    """
    row = await session.get(IngredientProductMatch, (canonical_key, location_id))
    if row is None:
        row = IngredientProductMatch(canonical_key=canonical_key, location_id=location_id)
        session.add(row)
    row.product_id = product_id
    row.user_confirmed = True
    row.matcher_version = MATCHER_VERSION
    await session.commit()


async def forget(session: AsyncSession, canonical_key: str, location_id: str) -> None:
    """Drop whatever was decided, so the next look decides afresh.

    The way back from a hand pick to the automatic one, and also the only way
    an automatic pick made under older rules gets remade under newer ones:
    rows are pinned, hand-picked or not, and nothing re-derives them by
    itself. Deleting rather than resetting means the next page load searches
    again, which is the point.
    """
    await session.execute(
        delete(IngredientProductMatch).where(
            IngredientProductMatch.canonical_key == canonical_key,
            IngredientProductMatch.location_id == location_id,
        )
    )
    await session.commit()
