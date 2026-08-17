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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import IngredientProductMatch
from ..grocery import UNIT_ALIASES
from . import products
from .client import KrogerError
from .density import grams_per_cup
from .products import Product
from .units import Measure, as_weight, cost_to_cover, parse_size

log = logging.getLogger(__name__)

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


def _coverage(tokens: list[str], description: str) -> float:
    """How much of the ingredient the description accounts for.

    Substring rather than word matching, because `canonical_key` singularizes
    ("thigh") while Kroger does not ("Thighs"), and because sizes run into
    words in descriptions.
    """
    if not tokens:
        return 0.0
    haystack = description.casefold()
    return sum(1 for t in tokens if t in haystack) / len(tokens)


_WORD_RE = re.compile(r"[a-z0-9]+")

# Extra words are bucketed rather than compared one by one, because brand
# names vary in length for reasons that say nothing about the product. Three
# is wide enough to put "Kroger® 75/25 Ground Beef Tray" and "Kroger® 73/27
# Ground Beef Roll 1 LB" in the same bucket, so price decides between them,
# and narrow enough to keep a bag of brown sugar out of the same bucket as
# "Less Sugar Maple & Brown Sugar Instant Oatmeal".
_SLACK = 3


def _slack(product: Product, tokens: list[str]) -> int:
    """How much of the description the ingredient does *not* account for.

    Coverage asks whether the name appears; this asks how much else is there.
    Both were needed once price led the ranking: cheapest-that-matches happily
    bought oatmeal, because "brown sugar" appears in its name and it is
    cheaper than brown sugar. A product whose description is mostly the
    ingredient is far likelier to be the ingredient.
    """
    words = _WORD_RE.findall(product.description.casefold())
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

    # Everything is compared as weight, both sides converted through the same
    # density. Counts are excluded and cannot be converted: a recipe's nine
    # garlic cloves and a "5 ct" bag of bulbs are counts of different things,
    # and comparing them bought five bulbs for nine cloves.
    grams = grams_per_cup(canonical_key)
    wanted = as_weight(need, grams)
    size = as_weight(parse_size(product.size), grams)
    if wanted is None or size is None:
        # No density for this ingredient, or a size that cannot be read. Both
        # leave the older ranking exactly as it was rather than guessing.
        return unknown

    price = product.regular or 0.0
    cost = cost_to_cover(price, size, product.sold_by, wanted)

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
    return (
        -_coverage(tokens, product.description),
        _slack(product, tokens),
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
    # one that does not account for the whole ingredient name is a guess.
    usable = [
        p
        for p in candidates
        if p.regular is not None and _coverage(tokens, p.description) >= MIN_COVERAGE
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
        )
    )
    return chosen.product_id if chosen else None


async def product_ids(
    session: AsyncSession,
    canonical_keys: list[str],
    location_id: str,
    needs: dict[str, Measure] | None = None,
) -> dict[str, str]:
    """Product ids for the ingredients given, resolving any not seen before.

    Only the keys asked for are touched. Keys already recorded are returned
    from the row, never re-searched, which is what keeps a price stable
    between page loads. Keys that resolved to nothing are absent from the
    result, and callers show them as unpriced.
    """
    stored = await _stored(session, canonical_keys, location_id)

    resolved: dict[str, str] = {
        key: row.product_id for key, row in stored.items() if row.product_id
    }
    unseen = [key for key in canonical_keys if key and key not in stored]
    for key in unseen:
        product_id = await _resolve(session, key, location_id, (needs or {}).get(key))
        if product_id:
            resolved[key] = product_id
    if unseen:
        await session.commit()
    return resolved


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
    await session.commit()
