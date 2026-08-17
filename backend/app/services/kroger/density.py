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
then to "flour", and an ingredient nobody thought of returns None rather than
a guess. Returning None is a real answer: without a density the amount simply
is not comparable to a package, and the caller falls back to ranking that
does not need one.
"""

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
    # Seasonings measured in spoons more often than cups, but no less real
    "salt": 273.0,
    "kosher-salt": 240.0,
    "baking-soda": 220.0,
    "baking-powder": 192.0,
    "vanilla-extract": 208.0,
}


def grams_per_cup(canonical_key: str) -> float | None:
    """What a cup of this ingredient weighs, or None if it is not known.

    Walks from the whole name down to its last word, so a specific entry wins
    over a general one and an unlisted variety still finds its family:
    "unbleached-bread-flour" tries itself, then "bread-flour", then "flour".
    """
    tokens = [t for t in canonical_key.split("-") if t]
    for start in range(len(tokens)):
        found = GRAMS_PER_CUP.get("-".join(tokens[start:]))
        if found is not None:
            return found
    return None
