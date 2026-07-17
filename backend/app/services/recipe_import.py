"""Parses a recipe web page into a RecipeDraft.

Most recipe sites embed schema.org/Recipe JSON-LD. We find the Recipe node
(handling @graph wrappers and lists), then convert its fields, including
parsing free-text ingredient lines like "1 ½ cups all-purpose flour" into
structured quantity / unit / name."""

import json
import re

from bs4 import BeautifulSoup

from ..schemas import IngredientIn, RecipeDraft
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
       "pint", "pints", "gallon", "gallons"}
)


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
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, (int, float)):
        return int(value) or None
    if isinstance(value, str):
        match = re.search(r"\d+", value)
        if match:
            return int(match.group())
    return None


def _parse_image(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        url = value.get("url")
        return url if isinstance(url, str) else None
    if isinstance(value, list) and value:
        return _parse_image(value[0])
    return None


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


def parse_ingredient_line(line: str) -> IngredientIn:
    """Best-effort split of "1 ½ cups flour" into quantity/unit/name."""
    text = _strip_html(line)
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
        quantity = value if quantity is None else quantity + value
        index += 1
        # "1 - 2 cups" / "1 to 2 cups": keep the lower bound.
        if index < len(tokens) and tokens[index] in {"-", "–", "to"}:
            if index + 1 < len(tokens) and _token_to_number(tokens[index + 1]) is not None:
                index += 2
            break

    unit: str | None = None
    if quantity is not None and index < len(tokens):
        candidate = tokens[index].lower().rstrip(".,")
        if candidate in KNOWN_UNITS:
            unit = candidate
            index += 1

    name = " ".join(tokens[index:]).strip()
    if name.lower().startswith("of "):
        name = name[3:]
    # Sites like Budget Bytes annotate prices: "lo mein noodles ($1.30)".
    name = re.sub(r"\(\s*\$[^)]*\)", "", name)
    name = re.sub(r"\s+", " ", name).strip(" ,")
    if not name:
        # Line was only a quantity/unit ("1 pinch"): treat the unit as the name.
        name, unit = (unit or text), None
    return IngredientIn(name=name[:200], quantity=quantity, unit=unit)


def parse_recipe_html(html: str, source_url: str) -> RecipeDraft:
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

    description = recipe.get("description")
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
        description=_strip_html(description) if isinstance(description, str) else "",
        instructions=_parse_instructions(recipe.get("recipeInstructions")),
        prep_minutes=prep,
        cook_minutes=cook,
        servings=_parse_servings(recipe.get("recipeYield")),
        ingredients=[
            parse_ingredient_line(line)
            for line in ingredients_raw
            if isinstance(line, str) and line.strip()
        ],
        image_url=_parse_image(recipe.get("image")),
        source_url=source_url,
    )
