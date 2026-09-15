"""Reading the size off a Kroger product, and comparing it to what is needed.

Kroger writes sizes as free text - "5 lb", "36 oz", "16.9 fl oz", "12 ct",
"1 each" - so this turns them into something comparable. Everything is
reduced to a base unit per dimension (grams, millilitres, items) so a 36 oz
tray and a 1 lb roll can be ranked against "1 lb of ground beef".

Deliberately conservative: anything it is not sure of comes back as None
rather than as a guess. A wrong size is worse than an unknown one, because an
unknown size simply falls back to the older ranking while a wrong one is
confidently used. Compound sizes are the clearest case. "3 ct / 1 lb" means
three one-pound packs, and "8 ct / 30.4 ounce" means eight patties weighing
30.4 ounces in total - the same shape with opposite arithmetic, and nothing
in the string says which. Both are refused.

Volume and weight are separate dimensions here, and crossing between them
needs a per-ingredient density. `comparable` is the one place that crossing
happens, and everything that relates a requirement to a package - which one
to buy, what it costs, how many to order - goes through it, so those three
answers cannot disagree.
"""

import math
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from .density import (
    counts_parts_of_a_piece,
    grams_per_cup,
    grams_per_piece,
    sold_by_the_piece,
)

WEIGHT = "weight"
VOLUME = "volume"
COUNT = "count"

# To grams, millilitres, and items respectively.
_UNITS: dict[str, tuple[str, float]] = {
    "g": (WEIGHT, 1.0),
    "gram": (WEIGHT, 1.0),
    "grams": (WEIGHT, 1.0),
    "kg": (WEIGHT, 1000.0),
    "kilogram": (WEIGHT, 1000.0),
    "oz": (WEIGHT, 28.3495),
    "ounce": (WEIGHT, 28.3495),
    "ounces": (WEIGHT, 28.3495),
    "lb": (WEIGHT, 453.592),
    "lbs": (WEIGHT, 453.592),
    "pound": (WEIGHT, 453.592),
    "pounds": (WEIGHT, 453.592),
    "ml": (VOLUME, 1.0),
    "milliliter": (VOLUME, 1.0),
    "l": (VOLUME, 1000.0),
    "liter": (VOLUME, 1000.0),
    "litre": (VOLUME, 1000.0),
    "fl oz": (VOLUME, 29.5735),
    "fluid ounce": (VOLUME, 29.5735),
    "tsp": (VOLUME, 4.92892),
    "tbsp": (VOLUME, 14.7868),
    "cup": (VOLUME, 236.588),
    "pt": (VOLUME, 473.176),
    "pint": (VOLUME, 473.176),
    "qt": (VOLUME, 946.353),
    "quart": (VOLUME, 946.353),
    "gal": (VOLUME, 3785.41),
    "gallon": (VOLUME, 3785.41),
    "ct": (COUNT, 1.0),
    "count": (COUNT, 1.0),
    "each": (COUNT, 1.0),
    "ea": (COUNT, 1.0),
    "dozen": (COUNT, 12.0),
}

_SIZE_RE = re.compile(r"^\s*([\d]+(?:\.[\d]+)?)\s*(.+?)\s*$")


@dataclass(frozen=True)
class Measure:
    """An amount reduced to its dimension's base unit."""

    dimension: str
    base: float


def measure(quantity: float | None, unit: str | None) -> Measure | None:
    """An amount as a comparable measure, or None if it is not one.

    A bare count - "2 eggs", with no unit at all - is a count of items, which
    is exactly how Kroger writes a dozen eggs.
    """
    if quantity is None or quantity <= 0:
        return None
    if unit is None or not unit.strip():
        return Measure(COUNT, quantity)
    known = _UNITS.get(unit.strip().casefold().rstrip("."))
    if known is None:
        return None
    dimension, factor = known
    return Measure(dimension, quantity * factor)


_ML_PER_CUP = _UNITS["cup"][1]


def as_weight(amount: Measure | None, grams_per_cup: float | None) -> Measure | None:
    """An amount in grams, converting from volume when a density is known.

    This is the bridge recipes need and shops do not have: a recipe asks for
    two cups of flour and the shelf offers a five pound bag. Both sides go
    through here, so a gallon of milk and a cup and a half of it end up
    comparable in the same unit.

    Counts never convert - a dozen eggs weighs nothing in particular - and
    without a density a volume stays unconvertible rather than being assumed
    to be water.
    """
    if amount is None:
        return None
    if amount.dimension == WEIGHT:
        return amount
    if amount.dimension == VOLUME and grams_per_cup is not None:
        return Measure(WEIGHT, amount.base * grams_per_cup / _ML_PER_CUP)
    return None


def comparable(
    size: Measure | None,
    need: Measure | None,
    canonical_key: str = "",
    grams: float | None = None,
    by_the_piece: bool = False,
) -> tuple[Measure, Measure] | None:
    """A package and a requirement in one dimension, or None if there is none.

    The bridge between what a recipe asks for and what a shelf offers. Weight
    against weight and volume against volume need nothing; a volume against a
    weight needs the ingredient's density, which is looked up unless given.
    Counts are the exception: a recipe's six cloves of garlic and Kroger's
    "1 ct" bulb are both counts, of different things, and relating them
    bought six bulbs. So a count compares only where the recipe's piece is
    the shop's piece: for the ingredients on the curated list - eggs,
    tortillas, buns - and where the caller vouches for the product, which
    `Product.sold_by_piece` does for produce sold by count. Even then a
    recipe that counts parts of the piece - cloves, stalks, sprigs - is
    refused, because garlic is produce and a bulb is not a clove.

    A recipe's count against a shelf priced by weight is weighed: "1 jalapeno"
    against loose peppers at so much a pound is what one pepper weighs, not
    the pound. Only that way round. A product's count is the shop's piece,
    and weighing a "1 ct" bulb of garlic as a clove would be the same mistake
    as counting cloves as bulbs.

    None is a real answer. It means the two cannot be related, and every
    caller falls back to one package rather than to a guess.
    """
    if size is None or need is None or size.base <= 0:
        return None
    if size.dimension == need.dimension:
        if size.dimension == COUNT:
            vouched = by_the_piece and not counts_parts_of_a_piece(canonical_key)
            if not (vouched or sold_by_the_piece(canonical_key)):
                return None
        return size, need
    if need.dimension == COUNT and size.dimension == WEIGHT:
        per_piece = grams_per_piece(canonical_key)
        if per_piece is None:
            return None
        return size, Measure(WEIGHT, need.base * per_piece)
    if {size.dimension, need.dimension} != {WEIGHT, VOLUME}:
        return None
    if grams is None:
        grams = grams_per_cup(canonical_key)
    weighed_size = as_weight(size, grams)
    weighed_need = as_weight(need, grams)
    if weighed_size is None or weighed_need is None:
        return None
    return weighed_size, weighed_need


def cost_to_cover(
    price: float,
    size: Measure | None,
    sold_by: str,
    need: Measure | None,
    canonical_key: str = "",
    grams: float | None = None,
    by_the_piece: bool = False,
    loose: bool = False,
) -> float:
    """What covering `need` actually costs, as against one package's price.

    Two cases the shelf price alone gets wrong. A `WEIGHT` item's price is a
    rate - Kroger's "1 lb" on fresh chicken thighs is $4.49 *per pound*, not a
    pack - so three pounds is three times it, and counting the rate as the
    price understated that line by two thirds. A package smaller than the
    requirement has to be bought more than once.

    Whether the two can be related at all is `comparable`'s decision. Where
    they cannot, this is the price of one package.
    """
    related = comparable(size, need, canonical_key, grams, by_the_piece)
    if related is None:
        return price
    size, need = related
    if sold_by == "WEIGHT":
        if loose:
            # Loose produce is the exception to the floor below: one pepper
            # off the pile is a thing a shop sells, and it costs what it
            # weighs. `Product.sold_loose` says which products those are.
            return price * need.base / size.base
        # Never less than one of whatever unit the rate is quoted in. The
        # arithmetic alone says a teaspoon of a $10.99/lb item costs eleven
        # cents, which is true and useless: you cannot buy five grams of
        # bacon. Unfloored, that made brown-sugar-cured bacon the cheapest
        # way to buy a teaspoon of brown sugar.
        return price * max(1.0, need.base / size.base)
    return price * math.ceil(need.base / size.base)


def packages_to_cover(
    size: Measure | None,
    need: Measure | None,
    canonical_key: str = "",
    grams: float | None = None,
    by_the_piece: bool = False,
) -> int:
    """How many of a product to order to cover `need`.

    The counting half of `cost_to_cover`, and deliberately the same arithmetic
    on the same conditions: the quantity that reaches the cart has to be the
    quantity that was priced, or the estimate on screen describes a different
    trolley than the one being filled.

    Always rounded up, where `cost_to_cover` leaves a weight-sold item
    unrounded. A rate can honestly be charged in fractions and an order cannot:
    there is no way to ask this API for 1.4 lb of loose chicken, and rounding
    the other way means arriving home short of the ingredient the meal is
    named after. The two therefore disagree by up to one unit on weight-sold
    lines, which is why the quantity is shown before anything is sent.
    """
    related = comparable(size, need, canonical_key, grams, by_the_piece)
    if related is None:
        return 1
    size, need = related
    return max(1, math.ceil(need.base / size.base))


def parse_size(size: str) -> Measure | None:
    """The size Kroger printed on a product, or None if it is not readable.

    Compound sizes are refused rather than guessed at - see the module note.
    """
    if not size or "/" in size:
        return None
    match = _SIZE_RE.match(size)
    if match is None:
        return None
    try:
        quantity = float(match.group(1))
    except ValueError:
        return None
    return measure(quantity, match.group(2))


def to_cents(amount: float) -> float:
    """A money figure rounded the way a till does.

    Two problems, and the second is the one that bites. Python rounds half to
    even, where a till rounds half up. And the figure arriving here has
    usually been through a conversion or two, so a pound and a half of
    chicken at $4.49 is not 6.735 but 6.734999999999999 - the ratio behind it
    came out as 1.4999999999999998. Rounded straight to cents that is $6.73,
    a cent light, and wrong in a way that compounds down a column.

    So the noise is collapsed first, at a precision far finer than money and
    far coarser than the error, and only then rounded the way a till does.
    """
    settled = Decimal(str(round(amount, 6)))
    return float(settled.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def share_of_package(
    price: float,
    size: Measure | None,
    sold_by: str,
    need: Measure | None,
    canonical_key: str = "",
    grams: float | None = None,
    by_the_piece: bool = False,
) -> float | None:
    """What the part of a package a recipe uses costs, or None if unknowable.

    The other half of `cost_to_cover`. The grocery list buys whole packages,
    so that rounds up; a recipe consumes two cups of a five pound bag, so
    this takes the fraction. A weight-sold rate is charged at the rate with
    no floor: the floor in `cost_to_cover` exists because a shop will not
    sell five grams of bacon, and a recipe costing is not a purchase.

    None where the two cannot be related. A recipe cost that silently priced
    "a bunch of parsley" as a whole bunch would be right, and one that priced
    "2 sprigs" that way would be wrong by a factor of ten, and nothing here
    can tell them apart - so the caller decides what an unrelatable line
    counts as, and says so.
    """
    related = comparable(size, need, canonical_key, grams, by_the_piece)
    if related is None:
        return None
    size, need = related
    return price * need.base / size.base
