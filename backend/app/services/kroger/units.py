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

Volume and weight are separate dimensions here, and no attempt is made to
cross between them: that needs a per-ingredient density, which is the rest of
the unit-conversion work.
"""

import math
import re
from dataclasses import dataclass

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


def cost_to_cover(
    price: float, size: Measure | None, sold_by: str, need: Measure | None
) -> float:
    """What covering `need` actually costs, as against one package's price.

    Two cases the shelf price alone gets wrong. A `WEIGHT` item's price is a
    rate - Kroger's "1 lb" on fresh chicken thighs is $4.49 *per pound*, not a
    pack - so three pounds is three times it, and counting the rate as the
    price understated that line by two thirds. A package smaller than the
    requirement has to be bought more than once.

    Only weights are scaled. Counts and volumes look comparable and are not:
    a recipe's six cloves of garlic and Kroger's "1 ct" bulb are both counts
    of different things, and multiplying would buy six bulbs. Grams are
    always grams, so weight is the one dimension where the arithmetic is
    safe. Everything else falls back to the price of one package.
    """
    if need is None or size is None:
        return price
    if need.dimension != WEIGHT or size.dimension != WEIGHT or size.base <= 0:
        return price
    if sold_by == "WEIGHT":
        return price * (need.base / size.base)
    return price * math.ceil(need.base / size.base)


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
