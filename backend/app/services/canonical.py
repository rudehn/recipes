"""Canonicalizes ingredient names so the grocery list merges equivalents.

Recipe ingredient lines describe preparation as much as the item itself:
"finely diced onion", "large eggs, at room temperature", "green bell pepper
(diced)". For shopping, those are all just onions, eggs, and a bell pepper.
`canonical_key` reduces a name to its purchasable essence (used for merging
and pantry matching); `clean_display` keeps the nicest human form of a name
for showing on the list.
"""

import re

_PRICE_RE = re.compile(r"\(\s*\$[^)]*\)")
_PAREN_RE = re.compile(r"\([^)]*\)")

# Preparation / size words that don't change what you buy.
PREP_WORDS = {
    "diced", "chopped", "minced", "sliced", "shredded", "grated", "melted",
    "softened", "beaten", "mashed", "peeled", "seeded", "crushed", "cubed",
    "julienned", "trimmed", "halved", "quartered", "divided", "packed",
    "sifted", "rinsed", "drained", "cooked", "crumbled", "toasted", "warmed",
    "chilled", "thawed", "zested", "juiced", "pitted", "stemmed", "deveined",
    "finely", "coarsely", "roughly", "thinly", "thickly", "lightly",
    "freshly", "very",
    "large", "medium", "small", "jumbo", "extra-large", "xl",
    "ripe", "overripe", "raw", "cold", "warm", "hot", "cooled",
    "optional",
}

# Trailing qualifiers that aren't part of the item name.
_TRAILING_PHRASES = (
    "or to taste", "to taste", "for serving", "for garnish", "for dusting",
    "for greasing", "as needed", "if needed", "if desired", "or more",
    "plus more",
)

# Plural stripping exceptions: words that end in s but are singular.
_SINGULAR_S = {"hummus", "couscous", "asparagus", "molasses", "swiss", "grits"}


def _singularize(word: str) -> str:
    if len(word) <= 3 or word in _SINGULAR_S or word.endswith(("ss", "us", "is")):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("oes", "ches", "shes", "sses", "xes")):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word


def clean_display(name: str) -> str:
    """Human-facing cleanup: drop parentheticals, prices, and the trailing
    prep clause after a comma, but keep casing and plurality."""
    s = _PRICE_RE.sub("", name)
    s = _PAREN_RE.sub("", s)
    s = s.split(",")[0]
    s = re.sub(r"^\s*optional[:,]?\s+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip(" .,;")
    return s or name.strip()


def canonical_key(name: str) -> str:
    """Stable merge key: cleaned, lowercased, prep words dropped, last word
    singularized. "Large eggs, at room temperature" -> "egg"."""
    s = clean_display(name).casefold()
    for phrase in _TRAILING_PHRASES:
        if s.endswith(phrase):
            s = s[: -len(phrase)].rstrip(" ,")
    tokens = [t for t in re.split(r"[^a-z0-9-]+", s) if t]
    kept = [t for t in tokens if t not in PREP_WORDS]
    if kept:
        tokens = kept
    if not tokens:
        return ""
    tokens[-1] = _singularize(tokens[-1])
    return "-".join(tokens)


def _drop_prep_words(name: str) -> str:
    kept = [w for w in name.split() if w.casefold() not in PREP_WORDS]
    return " ".join(kept) if kept else name


def best_display(variants: list[str]) -> str:
    """Of all raw name variants that merged, show the shortest cleaned one
    with prep words dropped ("eggs" beats "large eggs", "finely diced onion"
    becomes "onion"); first-seen wins ties."""
    cleaned = [_drop_prep_words(clean_display(v)) for v in variants]
    return min(cleaned, key=len) if cleaned else ""
