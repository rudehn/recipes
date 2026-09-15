"""How many grams of a food an ingredient's amount is.

Nutrition is per gram, and recipes almost never are: they say two cups,
three cloves, a large egg, a pinch. USDA weighed the kitchen measures for
most foods it lists - a cup of chopped onion is 160 g, a clove of garlic 3 g
- so those portions are the first answer, and the density table the grocery
list uses is the fallback for a volume USDA did not weigh.

The same rule as the rest of the arithmetic: an amount that cannot be
weighed comes back as None, never as a guess. A count with nothing to count
it against is not assumed to be a medium one of something; it is reported,
and the recipe's nutrition is withheld until it is fixed.
"""

from ..canonical import _singularize
from ..grocery import normalize_unit
from ..kroger.density import grams_per_cup
from ..kroger.units import VOLUME, WEIGHT, measure
from .defaults import Default
from .foods import Food, Portion, words

_ML_PER_CUP = measure(1, "cup").base

# Sizes a recipe gives a counted ingredient. `canonical_key` drops them, since
# they do not change what is bought, so they are read off the name instead.
_SIZES = ("extra-large", "jumbo", "large", "medium", "small")

# What a bare count is taken to mean when neither the recipe nor the food's
# own name says, in order. "medium" first because it is what USDA and cooks
# both mean by an unqualified onion or potato.
_GENERIC_PIECES = ("medium", "fruit", "unit", "piece", "each", "large", "small")

# Containers, whose size the recipe's line no longer says. The importer reads
# "1 (15 oz) can" as one can, and USDA's single weight for a can of a food is
# one particular can, so a count of these is not weighed at all: the recipe is
# asked for the weight instead.
_CONTAINERS = frozenset({
    "can", "jar", "bottle", "package", "packet", "envelope", "bag", "box",
    "carton", "container", "pouch", "tub",
})

# Measures that are someone else's idea of a helping, never a cook's amount.
_NOT_MEASURES = frozenset({"serving", "nlea", "portion", "recipe", "individual"})

# Amounts too small for USDA to have weighed, as teaspoons. Conventional
# kitchen equivalents, used only when the food has no portion of its own.
_TSP_PER = {"pinch": 1 / 16, "dash": 1 / 8, "smidgen": 1 / 32}

# Words in a recipe's name that match words in a portion's description.
# USDA says "chopped" where recipes say diced or minced.
_PREP_SYNONYMS = {"diced": "chopped", "minced": "chopped", "shredded": "grated"}


def _name_words(name: str) -> set[str]:
    found = {_PREP_SYNONYMS.get(w, w) for w in words(name)}
    if {"extra", "large"} <= found:
        found.add("extra-large")
    return found


def _prefer(portions: list[Portion], name: str) -> Portion:
    """Of several portions in one unit, the one the recipe describes.

    "1 cup sliced onion" is 115 g and "1 cup chopped" 160 g, so a portion
    whose description shares words with the ingredient wins. Failing that, a
    medium one, and failing that USDA's first, which is its most typical.
    """
    said = _name_words(name)

    def score(indexed: tuple[int, Portion]) -> tuple[int, int, int]:
        index, portion = indexed
        described = set(words(portion.description)) - {portion.unit}
        return (-len(said & described), "medium" not in described, index)

    return min(enumerate(portions), key=score)[1]


def _portion(food: Food, unit: str, name: str) -> Portion | None:
    matching = [p for p in food.portions if p.unit == unit]
    return _prefer(matching, name) if matching else None


def usda_grams_per_cup(food: Food, unit: str | None = None, name: str = "") -> float | None:
    """What a cup of the food weighs by USDA's own kitchen portions, or None.

    The portion in `unit` first when one is given, since USDA weighed a
    tablespoon and a cup separately and they do not always scale; then its
    cup; then the largest volume it weighed, which is the most precise of what
    is left. Portions only: the density table is not consulted here, because
    the density table consults this.
    """
    volumes = [
        (p, size.base)
        for p in food.portions
        if (size := measure(1, p.unit)) is not None and size.dimension == VOLUME
    ]
    if not volumes:
        return None
    for wanted in (unit, "cup"):
        candidates = [p for p, _ in volumes if wanted is not None and p.unit == wanted]
        if candidates:
            chosen = _prefer(candidates, name)
            return chosen.grams / next(ml for p, ml in volumes if p is chosen) * _ML_PER_CUP
    largest = max(ml for _, ml in volumes)
    chosen = _prefer([p for p, ml in volumes if ml == largest], name)
    return chosen.grams / largest * _ML_PER_CUP


def _grams_per_ml(food: Food, unit: str | None, name: str, key: str, default: Default | None):
    """What a millilitre of the food weighs, or None.

    A default's own figure first, then USDA's portions for the food, then the
    grocery list's density table.
    """
    if default is not None and default.grams_per_cup is not None:
        return default.grams_per_cup / _ML_PER_CUP
    per_cup = usda_grams_per_cup(food, unit, name)
    if per_cup is None:
        per_cup = grams_per_cup(key)
    return per_cup / _ML_PER_CUP if per_cup is not None else None


def _grams_per_piece(food: Food, name: str, key: str, default: Default | None) -> float | None:
    """What one of a counted ingredient weighs, or None.

    Tried in order: a size the recipe gives ("2 small eggs"); the piece the
    default names ("2 eggs" means large ones); a word of the ingredient that
    USDA counts in ("garlic cloves", "chicken thighs"); a word of the food's
    own name ("Peppers, jalapeno" is counted by the pepper); and a generic
    medium, fruit or piece.
    """
    if default is not None and default.piece_grams is not None:
        return default.piece_grams
    said = _name_words(name)
    units = [size for size in _SIZES if size in said]
    if default is not None and default.piece is not None:
        units.append(default.piece)
    units += key.split("-")
    units += words(food.description.split(",")[0])
    units += _GENERIC_PIECES
    for unit in units:
        portion = _portion(food, unit, name)
        if portion is not None:
            return portion.grams
    return None


def usda_grams_per_piece(food: Food, key: str, default: Default | None = None) -> float | None:
    """What one of a counted ingredient weighs by USDA's portions, or None.

    For a caller with no recipe line to read sizes from - pricing, weighing a
    count against a shelf sold by weight. The same order as a recipe's own
    count, less the sizes a name would have given: the default's piece, a
    word of the key, a word of the food's name, a generic medium piece.
    """
    return _grams_per_piece(food, "", key, default)


def grams(
    food: Food,
    quantity: float | None,
    unit: str | None,
    name: str,
    key: str,
    default: Default | None = None,
) -> float | None:
    """The ingredient's amount in grams of `food`, or None if it cannot be weighed.

    `default` carries the hints a hand-curated default has about its food -
    which piece a count means, a volume weight that differs from USDA's - and
    is only passed when the food in use is that default's.
    """
    if quantity is None or quantity <= 0:
        return None
    unit = normalize_unit(unit)
    if unit is not None and _singularize(unit) in _CONTAINERS | _NOT_MEASURES:
        return None

    if unit in _TSP_PER:
        own = _portion(food, unit, name)
        if own is not None:
            return quantity * own.grams
        quantity, unit = quantity * _TSP_PER[unit], "tsp"

    amount = measure(quantity, unit)
    if amount is None and unit is not None:
        amount = measure(quantity, _singularize(unit))
    if amount is None:
        # A unit only the food can answer: a clove, a slice, a stick, a sprig.
        own = _portion(food, _singularize(unit or ""), name)
        return quantity * own.grams if own is not None else None

    if amount.dimension == WEIGHT:
        return amount.base
    if amount.dimension == VOLUME:
        per_ml = _grams_per_ml(food, unit, name, key, default)
        return amount.base * per_ml if per_ml is not None else None
    per_piece = _grams_per_piece(food, name, key, default)
    return amount.base * per_piece if per_piece is not None else None
