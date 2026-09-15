"""How much a cup of an ingredient weighs.

Recipes measure by volume and shops sell by weight, and there is no general
rule between them: a cup of flour is about 125 g, a cup of sugar 200 g, a cup
of honey 340 g. Only a table gets you across, and this is that table.

It is deliberately hand-curated rather than derived, in the same spirit as
`UNIT_ALIASES` and `PREP_WORDS`. Every figure here is a rounded standard
kitchen conversion, and being a few grams out costs nothing: this decides
which package to buy and roughly what a recipe costs, so the difference
between 120 g and 125 g of flour never changes an answer.

Lookup walks from the most specific name to the least, so "all-purpose-flour"
finds its own entry, "unbleached-bread-flour" falls back to "bread-flour" and
then to "flour". An ingredient the table does not list borrows USDA's kitchen
weights instead, through the food nutrition counts it as, so a tablespoon of
paprika is 6.8 g without a spice section here. An ingredient neither knows
returns None rather than a guess. Returning None is a real answer: without a
density the amount simply is not comparable to a package, and the caller falls
back to ranking that does not need one.
"""

from functools import cache

# Grams per US cup.
GRAMS_PER_CUP: dict[str, float] = {
    # Flours and dry baking
    "flour": 125.0,
    "bread-flour": 127.0,
    "cake-flour": 114.0,
    "whole-wheat-flour": 120.0,
    "almond-flour": 96.0,
    "cornmeal": 157.0,
    "cornstarch": 128.0,
    "breadcrumb": 108.0,
    "panko": 60.0,
    # Named for itself, since the walk would otherwise reach "breadcrumb" -
    # which weighs nearly twice as much a cup - before it reached "panko".
    "panko-breadcrumb": 60.0,
    "oat": 90.0,
    "rolled-oat": 90.0,
    # Sugars and syrups
    "sugar": 200.0,
    "brown-sugar": 220.0,
    "powdered-sugar": 120.0,
    "honey": 340.0,
    "maple-syrup": 322.0,
    "molasses": 337.0,
    "corn-syrup": 328.0,
    # Fats
    "butter": 227.0,
    "oil": 218.0,
    "olive-oil": 216.0,
    "coconut-oil": 218.0,
    "shortening": 205.0,
    # Dairy and wet things, all close to water and none of them exactly it
    "water": 236.0,
    "milk": 242.0,
    "buttermilk": 245.0,
    "cream": 238.0,
    "half-and-half": 242.0,
    "evaporated-milk": 252.0,
    "condensed-milk": 306.0,
    "coconut-milk": 240.0,
    "yogurt": 245.0,
    "sour-cream": 230.0,
    "cream-cheese": 232.0,
    "ricotta": 246.0,
    "broth": 240.0,
    "stock": 240.0,
    "wine": 236.0,
    "vinegar": 239.0,
    "juice": 240.0,
    # Cheeses, as a recipe measures them
    "cheese": 113.0,
    "parmesan": 100.0,
    "parmesan-cheese": 100.0,
    "cheddar": 113.0,
    # Condiments
    "soy-sauce": 255.0,
    "ketchup": 240.0,
    "mayonnaise": 220.0,
    "mustard": 249.0,
    "tomato-sauce": 245.0,
    "tomato-paste": 262.0,
    "salsa": 240.0,
    "peanut-butter": 258.0,
    "applesauce": 244.0,
    "pumpkin-puree": 245.0,
    # Grains, pulses and seeds
    "rice": 185.0,
    "jasmine-rice": 185.0,
    "basmati-rice": 185.0,
    "quinoa": 170.0,
    "couscous": 173.0,
    "lentil": 192.0,
    "bean": 180.0,
    "chickpea": 164.0,
    # Nuts, chocolate, fruit
    "almond": 143.0,
    "walnut": 117.0,
    "pecan": 99.0,
    "peanut": 146.0,
    "cashew": 137.0,
    "chocolate-chip": 170.0,
    "cocoa": 85.0,
    "cocoa-powder": 85.0,
    "raisin": 145.0,
    "coconut": 93.0,
    # Vegetables and fruit, as a recipe measures them: chopped, diced, or
    # kernels off the cob. The shop sells most of these by weight or by the
    # can, so without these a recipe's "3 cups corn" against a 10 oz can
    # could not be related at all, and the cart ordered one can for nine.
    "corn": 165.0,
    "corn-kernel": 165.0,
    "sweet-corn": 165.0,
    "onion": 160.0,
    "red-onion": 160.0,
    "yellow-onion": 160.0,
    "green-onion": 100.0,
    "shallot": 160.0,
    "tomato": 180.0,
    "cherry-tomato": 150.0,
    "bell-pepper": 150.0,
    "red-bell-pepper": 150.0,
    "green-bell-pepper": 150.0,
    "jalapeno": 90.0,
    "carrot": 128.0,
    "celery": 100.0,
    "potato": 150.0,
    "sweet-potato": 133.0,
    "cabbage": 90.0,
    "spinach": 30.0,
    "kale": 67.0,
    "lettuce": 55.0,
    "cilantro": 16.0,
    "parsley": 60.0,
    "basil": 24.0,
    "mushroom": 70.0,
    "broccoli": 90.0,
    "cauliflower": 100.0,
    "zucchini": 125.0,
    "cucumber": 120.0,
    "garlic": 136.0,
    "ginger": 96.0,
    "pea": 145.0,
    "green-bean": 110.0,
    "avocado": 150.0,
    "banana": 150.0,
    "apple": 125.0,
    "strawberry": 150.0,
    "blueberry": 150.0,
    "berry": 150.0,
    # Seasonings measured in spoons more often than cups, but no less real
    "salt": 273.0,
    "kosher-salt": 240.0,
    "baking-soda": 220.0,
    "baking-powder": 192.0,
    "vanilla-extract": 208.0,
}


# Ingredients a recipe counts in the same pieces the shop does. "2 eggs"
# against a "12 ct" carton is arithmetic; "6 cloves garlic" against a "1 ct"
# bulb is not, and multiplying bought six bulbs. So counts are refused unless
# the ingredient is one of these, where a recipe's unit and Kroger's are the
# same object. Curated for the same reason as the table above: there is no
# rule, only a list.
SOLD_BY_THE_PIECE: frozenset[str] = frozenset({
    "egg",
    "tortilla",
    "bun",
    "hamburger-bun",
    "hot-dog-bun",
    "bagel",
    "pita",
    "taco-shell",
    "english-muffin",
    "croissant",
    "hot-dog",
    "sausage-link",
})


# Words that say a recipe counts parts of the shop's piece rather than the
# piece. Garlic is sold as a bulb and counted in cloves; celery as a bunch
# and counted in stalks. A count of these against a count of the packages
# they come in is a count of different things, whatever department the
# package is from.
SUB_PIECE_WORDS: frozenset[str] = frozenset({
    "clove", "stalk", "rib", "sprig", "leaf", "slice", "wedge", "segment",
    "floret", "kernel", "seed", "piece",
})


def counts_parts_of_a_piece(canonical_key: str) -> bool:
    """Whether the recipe's count is of parts, not of what the shop packs."""
    return any(t in SUB_PIECE_WORDS for t in canonical_key.split("-"))


def _walk(canonical_key: str) -> list[str]:
    """The name, then each shorter tail of it: most specific first."""
    tokens = [t for t in canonical_key.split("-") if t]
    return ["-".join(tokens[start:]) for start in range(len(tokens))]


def grams_per_cup(canonical_key: str) -> float | None:
    """What a cup of this ingredient weighs, or None if it is not known.

    Walks from the whole name down to its last word, so a specific entry wins
    over a general one and an unlisted variety still finds its family:
    "unbleached-bread-flour" tries itself, then "bread-flour", then "flour".
    The table comes first; USDA's portions answer only what it does not list.
    """
    for name in _walk(canonical_key):
        found = GRAMS_PER_CUP.get(name)
        if found is not None:
            return found
    return _usda_grams_per_cup(canonical_key)


@cache
def _usda_grams_per_cup(canonical_key: str) -> float | None:
    """A cup's weight from USDA, for the food nutrition would count this as.

    Only through a hand-curated default, never a hand pick: this is asked
    without a database, and a default is the same answer for every caller.
    So a name with no default - a misspelling, say - borrows nothing.

    Imported here rather than at the top of the module, because nutrition's
    own weighing falls back to this table and the imports would go round.
    """
    from ..nutrition import foods
    from ..nutrition.defaults import default_for
    from ..nutrition.weights import usda_grams_per_cup

    default = default_for(canonical_key)
    if default is None:
        return None
    if default.grams_per_cup is not None:
        return default.grams_per_cup
    food = foods.food(default.fdc_id)
    return usda_grams_per_cup(food) if food is not None else None


def sold_by_the_piece(canonical_key: str) -> bool:
    """Whether a recipe's count of this is a count of what Kroger packs.

    The same walk as the density: "large-brown-egg" finds "egg".
    """
    return any(name in SOLD_BY_THE_PIECE for name in _walk(canonical_key))
