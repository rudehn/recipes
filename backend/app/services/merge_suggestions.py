"""Pairs of ingredients that might be one thing to buy, offered to the owner.

Never applied: a suggestion is a question with two answers, Merge and Not
the same (ADR 10). So the rules are tuned to be worth a glance rather than
to be right, with one hard line: a word that changes what is bought is
never dropped. "Red onion" is not "onion" at the shop, nor "whole milk"
"milk", nor "sweet potato" "potato", so those words are left off the list
below even where nutrition treats them as harmless.
"""

from collections import defaultdict
from collections.abc import Collection
from dataclasses import dataclass
from itertools import combinations

from ..schemas import MergeReason

# Words that describe an ingredient without changing what is bought, drawn
# from lint's DESCRIPTORS and nutrition's HARMLESS_WORDS and cut to the ones
# that hold at the shop as well as in the pan.
SAME_TO_BUY = frozenset({
    "ground", "fresh", "boneless", "skinless", "lean", "extra-lean", "organic",
    "all", "purpose", "unbleached", "bleached", "pure", "extra", "virgin",
    "yellow", "russet", "yukon", "gold", "idaho", "roma", "plum", "vine",
    "hass", "english", "persian", "seedless", "cremini", "button", "flat",
    "leaf", "curly", "plain", "jasmine", "basmati", "long", "grain",
})

# Words that count an ingredient rather than name it. `canonical_key` only
# singularizes the last word, so both forms are listed.
COUNTING = frozenset({
    "clove", "cloves", "strip", "strips", "slice", "slices", "sprig", "sprigs",
    "stalk", "stalks", "head", "heads",
})

# Two names for one thing that share no words.
SYNONYMS = frozenset(
    frozenset(pair)
    for pair in [
        ("mayo", "mayonnaise"),
        ("scallion", "green-onion"),
        ("garbanzo-bean", "chickpea"),
        ("powdered-sugar", "confectioners-sugar"),
        ("cilantro", "coriander-leaf"),
    ]
)


@dataclass(frozen=True)
class Pair:
    """`specific` might be `general`. `directed`: the rule says which way."""

    specific: str
    general: str
    reason: MergeReason
    directed: bool


def _closest_general(key: str, keyset: set[str]) -> tuple[str, MergeReason] | None:
    """The key left by dropping the fewest describing or counting words."""
    tokens = key.split("-")
    droppable = [i for i, t in enumerate(tokens) if t in SAME_TO_BUY or t in COUNTING]
    for size in range(1, len(droppable) + 1):
        for dropped in combinations(droppable, size):
            rest = [t for i, t in enumerate(tokens) if i not in dropped]
            candidate = "-".join(rest)
            if rest and candidate != key and candidate in keyset:
                counting = any(tokens[i] in COUNTING for i in dropped)
                return candidate, "counting" if counting else "describing"
    return None


def find(keys: Collection[str]) -> list[Pair]:
    """Every likely pair among `keys`, one per pair of names."""
    keyset = set(keys)
    found: dict[frozenset[str], Pair] = {}
    for key in sorted(keyset):
        closest = _closest_general(key, keyset)
        if closest is not None:
            general, reason = closest
            found[frozenset({key, general})] = Pair(key, general, reason, True)
    squashed: dict[str, list[str]] = defaultdict(list)
    for key in keyset:
        squashed[key.replace("-", "")].append(key)
    for group in squashed.values():
        for a, b in combinations(sorted(group), 2):
            found.setdefault(frozenset({a, b}), Pair(a, b, "spacing", False))
    for pair in SYNONYMS:
        if pair <= keyset:
            a, b = sorted(pair)
            found.setdefault(pair, Pair(a, b, "synonym", False))
    return sorted(found.values(), key=lambda p: (p.specific, p.general))
