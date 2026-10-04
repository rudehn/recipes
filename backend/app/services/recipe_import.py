"""Parses a recipe web page into a RecipeDraft.

Most recipe sites embed schema.org/Recipe JSON-LD. We find the Recipe node
(handling @graph wrappers and lists), then convert its fields, including
parsing free-text ingredient lines like "1 ½ cups all-purpose flour" into
structured quantity / unit / name."""

import json
import re
from collections.abc import Collection

from bs4 import BeautifulSoup

from ..schemas import MAX_TAG_LENGTH, IngredientIn, RecipeDraft
from .grocery import UNIT_ALIASES

UNICODE_FRACTIONS = {
    "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75,
    "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
    "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
}

# Canonical units plus their aliases, all recognized in ingredient lines.
KNOWN_UNITS = (
    set(UNIT_ALIASES) | set(UNIT_ALIASES.values())
    | {"pinch", "dash", "stick", "sticks", "head", "heads", "sprig", "sprigs",
       "stalk", "stalks", "jar", "jars", "bottle", "bottles", "quart", "quarts",
       "pint", "pints", "gallon", "gallons", "packet", "packets", "bag", "bags",
       "box", "boxes", "container", "containers", "carton", "cartons", "tub", "tubs"}
)

# A package size written straight after the amount without brackets, as in
# "1 22-ounce bag frozen waffle fries" or "2 15 oz cans black beans". Noise
# on a shopping list for the same reason the bracketed form is: what you buy
# is one bag, and left in place it hides the unit and pollutes the name.
_BARE_SIZE = re.compile(
    r"^\d+(?:\.\d+)?-?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|ml|inch|in)\.?$",
    re.IGNORECASE,
)
_SIZE_UNIT = re.compile(r"^(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|ml)\.?$", re.I)

# A label a site puts before the line: "Optional: 1 avocado", "For the sauce:
# 1 cup ketchup". Read past, so the number after it is found. "Optional" is
# worth keeping and is moved to the end of the name in brackets, where the
# grocery key ignores it and the cook can still see it.
_LABEL = re.compile(r"^\s*([A-Za-z][A-Za-z ]{0,24}):\s*(?=\S)")

# Adjectives recipes slip between the amount and the unit ("2 heaping
# teaspoons minced garlic"). Only ever skipped when a real unit follows them,
# so "3 ripe bananas" still keeps "ripe" as part of the ingredient name.
UNIT_MODIFIERS = {
    "heaping", "heaped", "scant", "level", "rounded", "generous", "packed",
    "firmly", "lightly", "loosely", "large", "small", "big", "full",
}


class RecipeNotFound(Exception):
    pass


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", BeautifulSoup(text, "html.parser").get_text()).strip()


def _find_recipe_node(data: object) -> dict | None:
    if isinstance(data, dict):
        node_type = data.get("@type")
        types = node_type if isinstance(node_type, list) else [node_type]
        if "Recipe" in types:
            return data
        for value in data.values():
            if isinstance(value, (dict, list)):
                found = _find_recipe_node(value)
                if found:
                    return found
    elif isinstance(data, list):
        for item in data:
            found = _find_recipe_node(item)
            if found:
                return found
    return None


def _parse_iso_minutes(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(
        r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip()
    )
    if not match or not any(match.groups()):
        return None
    days, hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    total = days * 1440 + hours * 60 + minutes + (1 if seconds >= 30 else 0)
    return total or None


def _parse_servings(value: object) -> int | None:
    """Servings from a recipeYield, which is rarely a plain number.

    Sites commonly publish a list whose first entry is a useless unit count:
    ``["1", "1 loaf (12 slices)"]`` means twelve servings, not one. We take the
    largest number on offer, since the informative figure is the bigger one and
    understating servings inflates quantities once the planner scales a recipe.
    """
    candidates = value if isinstance(value, list) else [value]
    best: int | None = None
    for candidate in candidates:
        if isinstance(candidate, bool):
            continue
        if isinstance(candidate, (int, float)):
            found = [int(candidate)]
        elif isinstance(candidate, str):
            # Drop pan dimensions ("9x13 inch") so they cannot pose as a yield.
            cleaned = re.sub(r"\d+\s*[x×]\s*\d+", " ", candidate)
            found = [int(n) for n in re.findall(r"\d+", cleaned)]
        else:
            continue
        for number in found:
            if number > 0 and (best is None or number > best):
                best = number
    return best


def _parse_image(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        url = value.get("url")
        return url if isinstance(url, str) else None
    if isinstance(value, list) and value:
        return _parse_image(value[0])
    return None


def _meta_description(soup: BeautifulSoup) -> str:
    """The page's own blurb, for sites that publish an empty JSON-LD
    description (Southern Bite) but still fill in their meta tags."""
    for attrs in ({"name": "description"}, {"property": "og:description"}):
        tag = soup.find("meta", attrs=attrs)
        content = tag.get("content") if tag else None
        if isinstance(content, str) and content.strip():
            return _strip_html(content)
    return ""


def _tag_names(value: object) -> list[str]:
    """The names in a schema.org text field, spelled the way a tag is stored.

    recipeCategory, recipeCuisine and keywords may each be a string, a
    comma-separated string, or a list of either; whatever else a site puts
    there - an object, a number - is not a name. A name longer than a tag can
    be is a sentence rather than a tag, and is dropped rather than cut: cut
    at the limit it would be a tag nobody would ever type.
    """
    names: list[str] = []
    for item in value if isinstance(value, list) else [value]:
        if not isinstance(item, str):
            continue
        for part in _strip_html(item).split(","):
            name = part.strip().lower()
            if name and len(name) <= MAX_TAG_LENGTH:
                names.append(name)
    return names


def _plural_variants(tag: str) -> list[str]:
    """Spellings of `tag` that differ from it only by a regular plural.

    Read off the end of the whole tag, so "side dishes" meets "side dish" as
    well as "sides" meeting "side". Irregular plurals are left alone: a rule
    for those would be a dictionary.
    """
    variants = [tag + "s", tag + "es"]
    if tag.endswith("y"):
        variants.append(tag[:-1] + "ies")
    if tag.endswith("ies"):
        variants.append(tag[:-3] + "y")
    if tag.endswith("es"):
        variants.append(tag[:-2])
    if tag.endswith("s"):
        variants.append(tag[:-1])
    return variants


def _suggest_tags(recipe: dict, known_tags: Collection[str]) -> list[str]:
    """Tags for the recipe, from what its page says it is.

    Category and cuisine are suggested whatever they say. Keywords are not:
    they are mostly written for search engines ("best chili recipe"), so one
    is suggested only when it names a tag the box already has, which is the
    one case where it is plainly the person's own word for the recipe.

    A suggestion one plural away from a tag in the box takes the box's
    spelling, so a page filed under "Sides" does not start a second tag
    beside "side" that the filter bar would then show as two.
    """
    known = {tag.lower() for tag in known_tags}

    def spelled_as_known(tag: str) -> str:
        if tag in known:
            return tag
        return next((v for v in _plural_variants(tag) if v in known), tag)

    described = _tag_names(recipe.get("recipeCategory")) + _tag_names(recipe.get("recipeCuisine"))
    suggested = [spelled_as_known(tag) for tag in described]
    suggested += [word for word in _tag_names(recipe.get("keywords")) if word in known]
    return list(dict.fromkeys(suggested))


def _parse_instructions(value: object) -> str:
    steps: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, str):
            text = _strip_html(node)
            if text:
                steps.extend(s.strip() for s in re.split(r"\n+", text) if s.strip())
        elif isinstance(node, dict):
            if node.get("@type") == "HowToSection":
                walk(node.get("itemListElement"))
            else:
                text = node.get("text") or node.get("name")
                if isinstance(text, str) and _strip_html(text):
                    steps.append(_strip_html(text))
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(value)
    # Some sites (Half Baked Harvest) publish every step as one long run of
    # prose. Split it into sentences so the numbered list is usable. Only for a
    # lone oversized step: where a site marked up real steps, we trust them.
    if len(steps) == 1 and len(steps[0]) > 200:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", steps[0])]
        sentences = [s for s in sentences if s]
        if len(sentences) > 1:
            steps = sentences
    return "\n".join(steps)


def _token_to_number(token: str) -> float | None:
    if token in UNICODE_FRACTIONS:
        return UNICODE_FRACTIONS[token]
    if re.fullmatch(r"\d+/\d+", token):
        num, den = token.split("/")
        return int(num) / int(den) if int(den) else None
    if re.fullmatch(r"\d+(?:\.\d+)?", token):
        return float(token)
    return None


def _is_fraction(token: str) -> bool:
    return token in UNICODE_FRACTIONS or re.fullmatch(r"\d+/\d+", token) is not None


def _skip_package_size(tokens: list[str], index: int) -> int:
    """Index past a package size in parentheses right after the amount.

    "3 (3-ounce) packets ramen noodles" and "2 (15 oz) cans black beans" state
    the container size before the unit. It is noise on a shopping list - what
    you buy is three packets - and left in place it hides the real unit, so we
    drop it. Only a parenthetical that opens immediately after the number
    counts; trailing notes like "(optional)" are part of the name.
    """
    if index >= len(tokens):
        return index
    if tokens[index].startswith("("):
        for end in range(index, len(tokens)):
            if tokens[end].endswith(")"):
                return end + 1
        return index  # Unclosed: leave the text alone.
    # The same size without its brackets: "22-ounce" or "15 oz".
    if _BARE_SIZE.match(tokens[index]):
        return index + 1
    if (
        index + 1 < len(tokens)
        and re.fullmatch(r"\d+(?:\.\d+)?", tokens[index])
        and _SIZE_UNIT.match(tokens[index + 1])
        and index + 2 < len(tokens)
        and tokens[index + 2].lower().rstrip(".,") in KNOWN_UNITS
    ):
        return index + 2
    return index


def parse_ingredient_line(line: str) -> IngredientIn:
    """Best-effort split of "1 ½ cups flour" into quantity/unit/name.

    The line is kept on the result as `source_line`, so a better parser can
    be run over it later without importing the recipe again.
    """
    text = _strip_html(line)
    suffix = ""
    label = _LABEL.match(text)
    if label:
        if label.group(1).strip().casefold() == "optional":
            suffix = " (optional)"
        text = text[label.end() :]
    # Normalize "1½" -> "1 ½" and ranges "1-2" / "1 to 2" -> "1".
    text = re.sub(r"(\d)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])", r"\1 \2", text)
    text = re.sub(r"(\d)\s*[-–]\s*(\d)", r"\1 - \2", text)
    # Metric-style glued units: "350g flour" / "250ml milk" -> "350 g flour".
    text = re.sub(r"(\d)(g|kg|ml|l|oz|lb|lbs|tsp|tbsp)\b", r"\1 \2", text, flags=re.IGNORECASE)
    tokens = text.split()

    quantity: float | None = None
    index = 0
    while index < len(tokens):
        value = _token_to_number(tokens[index])
        if value is None:
            break
        # A mixed number is a whole and a fraction, "1 1/2". A second whole
        # number is something else - "2 15 oz cans" is two cans - and is
        # left for the size check below.
        if quantity is not None and not _is_fraction(tokens[index]):
            break
        quantity = value if quantity is None else quantity + value
        index += 1
        # "1 - 2 cups" / "1 to 2 cups": keep the lower bound.
        if index < len(tokens) and tokens[index] in {"-", "–", "to"}:
            if index + 1 < len(tokens) and _token_to_number(tokens[index + 1]) is not None:
                index += 2
            break

    unit: str | None = None
    if quantity is not None:
        index = _skip_package_size(tokens, index)
        # Step over any modifiers, but only commit to that if a unit follows.
        after_modifiers = index
        while (
            after_modifiers < len(tokens)
            and tokens[after_modifiers].lower().rstrip(".,") in UNIT_MODIFIERS
        ):
            after_modifiers += 1
        if after_modifiers < len(tokens):
            candidate = tokens[after_modifiers].lower().rstrip(".,")
            if candidate in KNOWN_UNITS:
                unit = candidate
                index = after_modifiers + 1

    name = " ".join(tokens[index:]).strip()
    if name.lower().startswith("of "):
        name = name[3:]
    # Sites like Budget Bytes annotate prices: "lo mein noodles ($1.30)".
    name = re.sub(r"\(\s*\$[^)]*\)", "", name)
    name = re.sub(r"\s+", " ", name).strip(" ,")
    if not name:
        # Line was only a quantity/unit ("1 pinch"): treat the unit as the name.
        name, unit = (unit or text), None
    name = (name + suffix)[:200]
    return IngredientIn(
        name=name, quantity=quantity, unit=unit, source_line=_strip_html(line)[:300] or None
    )


def parse_recipe_html(
    html: str, source_url: str, known_tags: Collection[str] = ()
) -> RecipeDraft:
    """The page's recipe as a draft for the form.

    `known_tags` are the tags already in the recipe box, which the suggested
    tags are spelled against (see `_suggest_tags`). They are handed in rather
    than looked up, so parsing stays a function of its arguments and never
    touches the database; the routes that have a session read them.
    """
    soup = BeautifulSoup(html, "html.parser")
    recipe: dict | None = None
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or script.get_text()
        if not raw:
            continue
        try:
            data = json.loads(raw, strict=False)
        except json.JSONDecodeError:
            continue
        recipe = _find_recipe_node(data)
        if recipe:
            break
    if not recipe:
        raise RecipeNotFound(
            "No structured recipe found on that page (missing schema.org Recipe data)"
        )

    title = recipe.get("name")
    if not isinstance(title, str) or not title.strip():
        raise RecipeNotFound("Recipe data on that page has no title")

    raw_description = recipe.get("description")
    description = _strip_html(raw_description) if isinstance(raw_description, str) else ""
    if not description:
        description = _meta_description(soup)

    ingredients_raw = recipe.get("recipeIngredient") or recipe.get("ingredients") or []
    if isinstance(ingredients_raw, str):
        ingredients_raw = [ingredients_raw]

    prep = _parse_iso_minutes(recipe.get("prepTime"))
    cook = _parse_iso_minutes(recipe.get("cookTime"))
    if cook is None:
        total = _parse_iso_minutes(recipe.get("totalTime"))
        if total is not None:
            cook = max(total - (prep or 0), 0) or None

    return RecipeDraft(
        title=_strip_html(title)[:200],
        description=description,
        instructions=_parse_instructions(recipe.get("recipeInstructions")),
        prep_minutes=prep,
        cook_minutes=cook,
        servings=_parse_servings(recipe.get("recipeYield")),
        ingredients=[
            parse_ingredient_line(line)
            for line in ingredients_raw
            if isinstance(line, str) and line.strip()
        ],
        tags=_suggest_tags(recipe, known_tags),
        image_url=_parse_image(recipe.get("image")),
        source_url=source_url,
    )
