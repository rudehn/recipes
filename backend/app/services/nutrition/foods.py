"""USDA's nutrition figures and kitchen portions, bundled with the app.

Loaded once from the tables in `usda/`, which `scripts/build_nutrition_data.py`
writes from SR Legacy. Nothing here touches the network: a recipe page never
waits on a third party for its nutrition, and there is no key to configure.
"""

import csv
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from ..canonical import _fold_accents, _singularize

_TABLES = Path(__file__).parent / "usda"


@dataclass(frozen=True)
class Nutrients:
    """The five figures the app shows, for some amount of food."""

    kcal: float = 0.0
    protein_g: float = 0.0
    fat_g: float = 0.0
    carbs_g: float = 0.0
    sodium_mg: float = 0.0

    def scaled(self, factor: float) -> "Nutrients":
        return Nutrients(
            self.kcal * factor,
            self.protein_g * factor,
            self.fat_g * factor,
            self.carbs_g * factor,
            self.sodium_mg * factor,
        )

    def __add__(self, other: "Nutrients") -> "Nutrients":
        return Nutrients(
            self.kcal + other.kcal,
            self.protein_g + other.protein_g,
            self.fat_g + other.fat_g,
            self.carbs_g + other.carbs_g,
            self.sodium_mg + other.sodium_mg,
        )


@dataclass(frozen=True)
class Portion:
    """A kitchen measure USDA weighed: `grams` is one `unit` of the food."""

    unit: str
    description: str
    grams: float


@dataclass(frozen=True)
class Food:
    fdc_id: int
    description: str
    category: str
    per_100g: Nutrients
    # In USDA's own order, which puts the most typical measure first.
    portions: tuple[Portion, ...]


@cache
def _foods() -> dict[int, Food]:
    portions: dict[int, list[Portion]] = {}
    with (_TABLES / "portions.csv").open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            portions.setdefault(int(row["fdc_id"]), []).append(
                Portion(row["unit"], row["description"], float(row["grams"]))
            )
    found: dict[int, Food] = {}
    with (_TABLES / "foods.csv").open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            fdc_id = int(row["fdc_id"])
            found[fdc_id] = Food(
                fdc_id=fdc_id,
                description=row["description"],
                category=row["category"],
                per_100g=Nutrients(
                    float(row["kcal"]),
                    float(row["protein_g"]),
                    float(row["fat_g"]),
                    float(row["carbs_g"]),
                    float(row["sodium_mg"]),
                ),
                portions=tuple(portions.get(fdc_id, ())),
            )
    return found


def food(fdc_id: int) -> Food | None:
    return _foods().get(fdc_id)


_WORD_RE = re.compile(r"[a-z0-9]+")


def words(text: str) -> list[str]:
    """Text as the words `canonical_key` would make of it: folded, singular."""
    return [_singularize(w) for w in _WORD_RE.findall(_fold_accents(text).casefold())]


@cache
def _index() -> tuple[tuple[Food, frozenset[str], frozenset[str]], ...]:
    """Every food with its words, and the words of its first phrase.

    USDA names foods general-first - "Peppers, jalapeno, raw" - so the first
    phrase is what the food is, and the rest is which one.
    """
    return tuple(
        (f, frozenset(words(f.description)), frozenset(words(f.description.split(",")[0])))
        for f in _foods().values()
    )


# Recipe words USDA spells differently. A recipe buys "1 can tomatoes"; USDA
# lists "Tomatoes, red, ripe, canned".
_SEARCH_SPELLINGS = {"can": "canned", "tinned": "canned"}


def search(query: str, limit: int) -> list[Food]:
    """Foods for a person to choose between, best fit first.

    Only ever shown to someone choosing, never used to choose, so it can
    afford to be generous: a food matching any word is a candidate. It ranks
    by how many of the words it has, then by whether they name what the food
    is rather than a detail of it, then shortest first, since USDA's plainest
    entry for a food is usually its shortest description.
    """
    wanted = {_SEARCH_SPELLINGS.get(w, w) for w in words(query)}
    if not wanted:
        return []
    scored = []
    for candidate, all_words, head in _index():
        hits = len(wanted & all_words)
        if hits:
            scored.append(
                (-hits, -len(wanted & head), len(candidate.description), candidate.fdc_id)
            )
    scored.sort()
    return [_foods()[fdc_id] for *_, fdc_id in scored[:limit]]
