"""Which USDA food an ingredient means, when nobody has said.

Hand-curated, in the same spirit as the density table and `PREP_WORDS`, and
for the same reason the product matcher is strict: the failure that matters
is a wrong answer, not a missing one. A missing food is visible - the recipe
says which ingredient has none and withholds its nutrition - while "almond
flour" quietly counted as wheat flour is a plausible number that is 60%
wrong. So there is no fuzzy matching here at all. An ingredient either has
an entry, or it waits for a person to choose.

Lookup walks from the whole name to shorter tails of it, as the density
table's does, but only across words known not to change the food: colours,
varieties, "boneless", "extra-virgin". "yukon-gold-potato" finds "potato";
"sweet-potato", "sour-cream" and "almond-flour" do not find "potato", "cream"
and "flour", because "sweet", "sour" and "almond" are not on that list.
"""

from dataclasses import dataclass

from ..canonical import canonical_key
from .foods import words


@dataclass(frozen=True)
class Default:
    """A USDA food, and what it takes to weigh a recipe's amount of it."""

    fdc_id: int
    # The portion a bare count means, where USDA weighs several: "2 eggs"
    # means large ones, not the medium an unqualified count would get.
    piece: str | None = None
    # What one weighs, for a piece USDA did not weigh at all.
    piece_grams: float | None = None
    # What a cup weighs, where it differs from the food's own portion. Kosher
    # salt has table salt's nutrition and two thirds of its weight a spoon.
    grams_per_cup: float | None = None


# Words a name can carry that do not change which food it is. Deliberately
# short: every word added here lets a name reach a more general entry. Words
# that look harmless and are not stay off - "ground" (ground mustard is not
# mustard), "smoked" (smoked salmon has ten times the sodium), "white" (white
# chocolate chips), "granulated" (granulated garlic), "baby" (a baby carrot is
# a sixth of a carrot) - and their real uses have entries of their own.
HARMLESS_WORDS = frozenset({
    "all", "purpose", "extra", "virgin", "pure", "unbleached", "bleached",
    "yellow", "red", "green", "sharp", "mild", "plain", "firm",
    "boneless", "skinless", "organic",
    "jasmine", "basmati", "long", "grain",
    "russet", "yukon", "gold", "idaho", "roma", "plum", "vine", "vidalia",
    "spanish", "hass", "english", "persian", "seedless", "cremini", "button",
    "flat", "leaf", "curly", "cracked", "rolled", "old", "fashioned", "quick",
})

# Words `canonical_key` drops because they do not change what is bought, and
# which do change what is eaten. Two cups of cooked rice is a third of the
# food two cups of raw rice is, so "cooked rice" and "rice" are one grocery
# line and two different foods.
STATE_WORDS = ("cooked",)


def nutrition_key(name: str) -> str:
    """The identity nutrition is chosen under: `canonical_key`, plus state.

    Exactly `canonical_key` for almost every ingredient, so a food chosen for
    "onions" is chosen for "1 diced onion" too. The difference is the handful
    of words that change the food without changing the shopping, which are
    kept in front: "chicken breasts, cooked and shredded" is
    "cooked-chicken-breast". See ADR 8.
    """
    key = canonical_key(name)
    said = set(words(name))
    state = [w for w in STATE_WORDS if w in said and w not in key.split("-")]
    return "-".join([*state, key]) if key else ""


DEFAULTS: dict[str, Default] = {
    # Flours, sugars and baking
    "flour": Default(168894),
    "bread-flour": Default(168896),
    "whole-wheat-flour": Default(168893),
    "self-rising-flour": Default(168895),
    "cornmeal": Default(168867),
    "cornstarch": Default(169698),
    "sugar": Default(169655),
    "granulated-sugar": Default(169655),
    "white-sugar": Default(169655),
    "brown-sugar": Default(168833),
    "light-brown-sugar": Default(168833),
    "dark-brown-sugar": Default(168833),
    "powdered-sugar": Default(169656),
    "confectioners-sugar": Default(169656),
    "honey": Default(169640),
    "maple-syrup": Default(169661),
    "molasses": Default(168820),
    "baking-soda": Default(175040),
    "baking-powder": Default(172803),
    "vanilla": Default(173471),
    "vanilla-extract": Default(173471),
    "cocoa": Default(169593),
    "cocoa-powder": Default(169593),
    "unsweetened-cocoa-powder": Default(169593),
    "chocolate-chip": Default(167976),
    "semisweet-chocolate-chip": Default(167976),
    "yeast": Default(175043),
    "active-dry-yeast": Default(175043),
    "instant-yeast": Default(175043),
    # Fats and oils
    "butter": Default(173410),
    "salted-butter": Default(173410),
    "unsalted-butter": Default(173430),
    "oil": Default(172370),
    "vegetable-oil": Default(172370),
    "canola-oil": Default(172336),
    "olive-oil": Default(171413),
    "coconut-oil": Default(171412),
    "sesame-oil": Default(171016),
    "shortening": Default(173584),
    "lard": Default(171401),
    # Eggs and dairy
    "egg": Default(171287, piece="large"),
    "egg-yolk": Default(172184, piece="large"),
    "egg-white": Default(172183, piece="large"),
    "milk": Default(171265),
    "whole-milk": Default(171265),
    "skim-milk": Default(169868),
    "buttermilk": Default(170874),
    "heavy-cream": Default(170859),
    "heavy-whipping-cream": Default(170859),
    "whipping-cream": Default(170859),
    "half-and-half": Default(171255),
    "sour-cream": Default(171257),
    "cream-cheese": Default(173418),
    "yogurt": Default(171284),
    "plain-yogurt": Default(171284),
    "greek-yogurt": Default(171304),
    "evaporated-milk": Default(171276),
    "sweetened-condensed-milk": Default(171275),
    "cheddar": Default(170899),
    "cheddar-cheese": Default(170899),
    "mozzarella": Default(170845),
    "mozzarella-cheese": Default(170845),
    "parmesan": Default(171247),
    "parmesan-cheese": Default(171247),
    "feta": Default(173420),
    "feta-cheese": Default(173420),
    "ricotta": Default(170851),
    "ricotta-cheese": Default(170851),
    "swiss-cheese": Default(171251),
    "provolone": Default(170850),
    "provolone-cheese": Default(170850),
    "goat-cheese": Default(173435),
    "monterey-jack": Default(170844),
    "monterey-jack-cheese": Default(170844),
    # Salt, pepper and dried spices. Ground spices by their full name: see
    # HARMLESS_WORDS for why "ground" is not skipped over.
    "salt": Default(173468),
    "table-salt": Default(173468),
    "sea-salt": Default(173468),
    "kosher-salt": Default(173468, grams_per_cup=240.0),
    "black-pepper": Default(170931),
    "ground-black-pepper": Default(170931),
    "cumin": Default(170923),
    "ground-cumin": Default(170923),
    "chili-powder": Default(171319),
    "paprika": Default(171329),
    "smoked-paprika": Default(171329),
    "oregano": Default(171328),
    "dried-oregano": Default(171328),
    "cinnamon": Default(171320),
    "ground-cinnamon": Default(171320),
    "garlic-powder": Default(171325),
    "onion-powder": Default(171327),
    "dried-thyme": Default(170938),
    "dried-basil": Default(171317),
    "dried-rosemary": Default(171333),
    "cayenne": Default(170932),
    "cayenne-pepper": Default(170932),
    "red-pepper-flake": Default(170932),
    "ground-ginger": Default(170926),
    "nutmeg": Default(171326),
    "ground-nutmeg": Default(171326),
    "turmeric": Default(172231),
    "ground-turmeric": Default(172231),
    "curry-powder": Default(170924),
    "ground-coriander": Default(170922),
    "ground-clove": Default(171321),
    "allspice": Default(171315),
    "ground-allspice": Default(171315),
    "fennel-seed": Default(171323),
    "dried-sage": Default(170935),
    "ground-sage": Default(170935),
    # USDA weighs a teaspoon of crumbled leaves, not a leaf. A dried bay leaf
    # is about a fifth of a gram.
    "bay-leaf": Default(170917, piece_grams=0.2),
    # Fresh herbs. Bare names are fresh where recipes mean fresh; thyme and
    # rosemary are measured either way, so only their qualified names count.
    "cilantro": Default(169997),
    "fresh-cilantro": Default(169997),
    "parsley": Default(170416),
    "fresh-parsley": Default(170416),
    "basil": Default(172232),
    "fresh-basil": Default(172232),
    "dill": Default(172233),
    "fresh-dill": Default(172233),
    "mint": Default(173475),
    "fresh-mint": Default(173475),
    "fresh-thyme": Default(173470),
    "fresh-rosemary": Default(173473),
    "ginger": Default(169231),
    "fresh-ginger": Default(169231),
    "ginger-root": Default(169231),
    # Vegetables
    "onion": Default(170000),
    "white-onion": Default(170000),
    "green-onion": Default(170005, piece="medium"),
    "scallion": Default(170005, piece="medium"),
    "shallot": Default(170499),
    "garlic": Default(169230, piece="clove"),
    "garlic-clove": Default(169230, piece="clove"),
    "tomato": Default(170457),
    "cherry-tomato": Default(170457, piece="cherry"),
    "grape-tomato": Default(170457, piece="cherry"),
    "tomato-paste": Default(170459),
    "tomato-sauce": Default(170054),
    "tomato-puree": Default(170460),
    "canned-tomato": Default(170051),
    "bell-pepper": Default(170108),
    "red-bell-pepper": Default(170108),
    "green-bell-pepper": Default(170427),
    "green-pepper": Default(170427),
    "jalapeno": Default(168576),
    "jalapeno-pepper": Default(168576),
    "serrano": Default(169395),
    "serrano-pepper": Default(169395),
    "green-chile": Default(168577),
    "green-chili": Default(168577),
    "carrot": Default(170393),
    "celery": Default(169988, piece="stalk"),
    "celery-stalk": Default(169988, piece="stalk"),
    "celery-rib": Default(169988, piece="stalk"),
    "potato": Default(170026),
    "sweet-potato": Default(168482, piece="sweetpotato"),
    "spinach": Default(168462),
    "baby-spinach": Default(168462),
    "broccoli": Default(170379),
    "cauliflower": Default(169986),
    "mushroom": Default(169251),
    "zucchini": Default(169291),
    "cucumber": Default(168409),
    "romaine": Default(169247),
    "romaine-lettuce": Default(169247),
    "iceberg-lettuce": Default(169248),
    "cabbage": Default(169975),
    "kale": Default(168421),
    "corn": Default(169998),
    "corn-kernel": Default(169998),
    "pea": Default(170419),
    "frozen-pea": Default(170016),
    "green-bean": Default(169961),
    "asparagus": Default(168389),
    "eggplant": Default(169228),
    "butternut-squash": Default(169295),
    "brussels-sprout": Default(170383),
    "beet": Default(169145),
    "radish": Default(169276),
    "arugula": Default(169387),
    "leek": Default(169246),
    "avocado": Default(171705),
    "caper": Default(172238),
    # Fruit
    "lemon": Default(167746, piece="fruit"),
    "lemon-juice": Default(167747),
    "lemon-zest": Default(167749),
    "lime": Default(168155, piece="fruit"),
    "lime-juice": Default(168156),
    "orange": Default(169097, piece="fruit"),
    "orange-juice": Default(169098),
    "banana": Default(173944),
    "apple": Default(171688),
    "strawberry": Default(167762),
    "blueberry": Default(171711),
    "raspberry": Default(167755),
    "raisin": Default(168165),
    "dried-cranberry": Default(171723),
    # Meat and fish
    "chicken-breast": Default(171077, piece="piece"),
    "chicken-thigh": Default(173627, piece="thigh"),
    "chicken-drumstick": Default(172373, piece="drumstick"),
    "chicken-wing": Default(172390, piece="piece"),
    "whole-chicken": Default(171447, piece="chicken"),
    "ground-chicken": Default(171116),
    "ground-beef": Default(174036),
    "lean-ground-beef": Default(174030),
    "ground-turkey": Default(171505),
    "ground-pork": Default(167902),
    "ground-lamb": Default(174370),
    "bacon": Default(168277, piece="slice"),
    "italian-sausage": Default(171631, piece="link"),
    "pork-tenderloin": Default(168249),
    "pork-shoulder": Default(167843),
    "beef-chuck": Default(171206),
    "chuck-roast": Default(171206),
    "ham": Default(173864, piece="slice"),
    "salmon": Default(175167),
    "salmon-fillet": Default(175167, piece="fillet"),
    "shrimp": Default(175179),
    "cod": Default(171955),
    "cod-fillet": Default(171955, piece="fillet"),
    # Grains and pasta, dry as bought
    "rice": Default(168877),
    "white-rice": Default(168877),
    "brown-rice": Default(169703),
    "pasta": Default(169736),
    "spaghetti": Default(169736),
    "penne": Default(169736),
    "macaroni": Default(169736),
    "elbow-macaroni": Default(169736),
    "fettuccine": Default(169736),
    "linguine": Default(169736),
    "rotini": Default(169736),
    "lasagna-noodle": Default(169736),
    "egg-noodle": Default(169731),
    "rice-noodle": Default(169742),
    "oat": Default(169705),
    "quinoa": Default(168874),
    "couscous": Default(169699),
    "bulgur": Default(170688),
    "barley": Default(170284),
    "breadcrumb": Default(174928),
    "bread-crumb": Default(174928),
    # Panko is the same bread at half the weight a cup.
    "panko": Default(174928, grams_per_cup=60.0),
    "panko-breadcrumb": Default(174928, grams_per_cup=60.0),
    "flour-tortilla": Default(175037, piece="tortilla"),
    "tortilla": Default(175037, piece="tortilla"),
    "corn-tortilla": Default(175036, piece="tortilla"),
    # Beans, canned as most recipes buy them. Dried beans say "dried", which
    # is not a harmless word, so they reach no entry and are asked about.
    "black-bean": Default(175188),
    "chickpea": Default(175206),
    "garbanzo-bean": Default(175206),
    "kidney-bean": Default(175195),
    "pinto-bean": Default(175201),
    "lentil": Default(172420),
    "tofu": Default(172475),
    # Nuts and seeds
    "walnut": Default(170187),
    "almond": Default(170567),
    "pecan": Default(170182),
    "peanut": Default(172430),
    "cashew": Default(170162),
    "pine-nut": Default(170591),
    "sesame-seed": Default(170150),
    "coconut": Default(168586),
    "peanut-butter": Default(174266),
    # Liquids, sauces and condiments
    "water": Default(173647),
    "chicken-broth": Default(174536),
    "chicken-stock": Default(174536),
    "low-sodium-chicken-broth": Default(172888),
    "beef-broth": Default(171538),
    "beef-stock": Default(171538),
    "coconut-milk": Default(170173),
    "soy-sauce": Default(174277),
    "low-sodium-soy-sauce": Default(172473),
    "fish-sauce": Default(174531),
    "oyster-sauce": Default(174529),
    "hoisin-sauce": Default(172886),
    "worcestershire-sauce": Default(171610),
    "hot-sauce": Default(174527),
    "sriracha": Default(171186),
    "ketchup": Default(168556),
    "mustard": Default(172234),
    "yellow-mustard": Default(172234),
    "mayonnaise": Default(171009),
    "mayo": Default(171009),
    "salsa": Default(174524),
    "marinara": Default(171192),
    "marinara-sauce": Default(171192),
    "pasta-sauce": Default(171192),
    "vinegar": Default(172237),
    "white-vinegar": Default(172237),
    "apple-cider-vinegar": Default(173469),
    "cider-vinegar": Default(173469),
    "balsamic-vinegar": Default(172241),
    "red-wine-vinegar": Default(172240),
    "red-wine": Default(173190),
    "white-wine": Default(174837),
    "dry-white-wine": Default(174837),
}


def default_for(key: str) -> Default | None:
    """The default food for a nutrition key, or None if there is none.

    Walks from the whole key to shorter tails, stopping as soon as a word it
    would skip is not harmless: "extra-virgin-olive-oil" reaches "olive-oil",
    and "almond-flour" never reaches "flour".
    """
    tokens = [t for t in key.split("-") if t]
    for start in range(len(tokens)):
        if start and tokens[start - 1] not in HARMLESS_WORDS:
            return None
        found = DEFAULTS.get("-".join(tokens[start:]))
        if found is not None:
            return found
    return None
