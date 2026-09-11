"""Spotting ingredient rows that will price or shop wrongly.

Every wrong number on the grocery list has a reason, and half of the reasons
are in the recipe rather than the shop: an amount that ended up inside the
name, no amount at all, a name that is not an ingredient. All of them are
cheap to see - a few string checks over a row - and the point of naming them
is that the fix is on the recipe page, not the shopping page.

The other half, the product half, is decided where the product is known:
see `kroger.pricing.attach_prices`. The two halves share one vocabulary,
`schemas.LineIssue`, and the most serious applicable one is shown.
"""

import re
from typing import Literal

from .canonical import PREP_WORDS, canonical_key

LineIssue = Literal[
    "amount_in_name", "no_amount", "check_line", "no_match", "unsized", "out_of_stock"
]

# Words that describe an ingredient without being one. A name made only of
# these - "boneless", "firmly" - is the wrong half of a line.
DESCRIPTORS = frozenset({
    "boneless", "skinless", "bone-in", "fresh", "frozen", "canned", "dried",
    "ground", "whole", "lean", "extra-lean", "firm", "soft", "unsalted",
    "salted", "sweet", "mild", "plain", "organic", "low-sodium", "reduced-fat",
    "fat-free", "nonfat", "light", "heavy", "thick", "thin", "extra",
    "firmly", "loosely", "tightly", "about", "approximately",
})

# Ingredients a recipe honestly leaves unmeasured.
_TO_TASTE_PHRASES = (
    "to taste", "for serving", "for garnish", "as needed", "optional",
    "for frying", "for greasing", "for dusting", "for the pan", "if desired",
)
_TO_TASTE_KEYS = frozenset({
    "salt", "pepper", "black-pepper", "kosher-salt", "sea-salt", "salt-and-pepper",
    "water", "cooking-spray", "oil", "olive-oil", "vegetable-oil", "ice", "garnish",
})

_LEADING_NUMBER = re.compile(r"^\s*(?:[a-z][a-z ]{0,20}:\s*)?[\d½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]", re.I)
_SIZE_IN_NAME = re.compile(
    r"\b\d+(?:\.\d+)?\s*-?\s*(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|ml|l)\b", re.I
)
_ALTERNATIVE = re.compile(r"\b(?:or)\b", re.I)
_VAGUE_START = re.compile(r"^\s*(?:a few|some|a handful|handful|a little|a bit)\b", re.I)


def _key_tokens(name: str) -> list[str]:
    return [t for t in canonical_key(name).split("-") if t]


def ingredient_issue(name: str, quantity: float | None, unit: str | None) -> LineIssue | None:
    """The recipe-side problem with an ingredient row, most serious first."""
    text = name.strip()
    lowered = text.casefold()
    if quantity is None and _LEADING_NUMBER.match(text):
        return "amount_in_name"

    tokens = _key_tokens(text)
    unmeasured = any(phrase in lowered for phrase in _TO_TASTE_PHRASES)
    if (
        _SIZE_IN_NAME.search(text)
        or (_ALTERNATIVE.search(text) and not unmeasured)
        or text.endswith("*")
        or _VAGUE_START.match(text)
        or not tokens
        or all(t in DESCRIPTORS or t in PREP_WORDS for t in tokens)
    ):
        return "check_line"

    if quantity is None and not unmeasured and "-".join(tokens) not in _TO_TASTE_KEYS:
        return "no_amount"
    return None
