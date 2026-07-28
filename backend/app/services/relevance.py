"""Scores how well a recipe matches the words someone searched for.

Site search endpoints are generous: for "korean bbq" a post that mentions a
Korean BBQ sauce in passing comes back alongside one that is a Korean BBQ
recipe, and often ahead of it. We cannot fix another site's ranking, but we do
parse every candidate we fetch, so we can re-rank on the recipe itself and drop
the ones that only brushed against the query.

Matching is lexical on purpose: no model, no index, nothing to keep in sync
with the sites we search. A term is worth whatever the strongest field it
appears in is worth, and a recipe scores the average across the searched terms.
Averaging rather than summing is what makes the ranking useful - a recipe that
matches one of two terms perfectly cannot outrank one that matches both."""

import re
from collections.abc import Iterable, Sequence
from urllib.parse import urlsplit

from ..schemas import RecipeDraft

# How much a term is worth in each place it can turn up. A title says what a
# recipe *is*; an ingredient list only says what is in it, which is why
# "gochujang" in the ingredients is a weaker signal than in the name.
TITLE = 1.0
DESCRIPTION = 0.6
INGREDIENTS = 0.4
INSTRUCTIONS = 0.25

# Matching the query as a phrase ("korean bbq", not "korean" and "bbq" in
# unrelated corners of the title) is worth a nudge, not a tier of its own. It
# is the one thing that can push a score past 1: every recipe it applies to
# already matches every term in its title, and the point is to order those
# against each other.
PHRASE_BONUS = 0.15

# Below this, a result is dropped rather than ranked last. The rule it encodes:
# missing one word of a two-word query is disqualifying, however loudly the
# other word matches. That puts the bar just above 0.5 - a title hit for one
# term of two - and means a one-word query has to appear in the title or the
# description, not merely somewhere in the ingredients.
MIN_RELEVANCE = 0.55

# The bar for a result used only to fill out a thin set. Lexical matching is
# blind to spelling a dish a second way: "kimchi jjigae" scores a page titled
# "Kimchi Jigae" as a half-match, and dropping it leaves the user with nothing
# for a search that found exactly what they asked for. So a near miss can
# still be shown when there is little else - but it must have matched
# something, or an empty result is the more honest answer.
WEAK_RELEVANCE = 0.3

_WORD = re.compile(r"[a-z0-9']+")

# Words people pad a search with that say nothing about the dish. Dropped so
# "easy korean bbq" scores like "korean bbq" instead of penalising every recipe
# that does not call itself easy.
# Compared against stems, so the singular covers the plural.
_FILLER = frozenset({
    "a", "an", "and", "or", "the", "with", "without", "for", "of", "in", "on",
    "to", "my", "how", "make", "making", "recipe", "dish", "meal",
    "best", "easy", "quick", "simple", "good", "great", "homemade",
    "authentic", "real", "classic",
})

# Equivalences common enough in recipe titles that missing them reads as a bug.
# Deliberately tiny - this is not a thesaurus, and every entry here is a word
# pair that names the same ingredient or the same technique.
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "bbq": ("barbecue", "barbeque"),
    "barbecue": ("bbq", "barbeque"),
    "barbeque": ("bbq", "barbecue"),
    "eggplant": ("aubergine",),
    "aubergine": ("eggplant",),
    "cilantro": ("coriander",),
    "coriander": ("cilantro",),
    "shrimp": ("prawn",),
    "prawn": ("shrimp",),
    "zucchini": ("courgette",),
    "courgette": ("zucchini",),
    "chickpea": ("garbanzo",),
    "garbanzo": ("chickpea",),
    "scallion": ("green onion", "spring onion"),
}

# Terms this long or longer match by prefix, so "noodle" finds "noodles" and
# "chicken" finds "chickens". Shorter terms must match a whole word: "pea"
# has no business matching "peanut".
_PREFIX_MIN = 4


def _stem(word: str) -> str:
    """Crudely singularised ``word``, so "noodles" and "noodle" are one term.

    It over-stems - "hummus" becomes "hummu" - which is harmless because both
    the query and the text being searched go through it, so the two still line
    up. A real stemmer would be more accurate and much harder to predict."""
    if len(word) > 4 and word.endswith(("ches", "shes", "sses", "xes", "zes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _stems(text: str) -> list[str]:
    return [_stem(w) for w in _WORD.findall(text.lower())]


Term = tuple[str, ...]


def query_terms(query: str) -> list[Term]:
    """The searched-for terms, each as the group of spellings that satisfy it.

    Filler is dropped unless that would leave nothing, since a search for
    "the best" should still search for something."""
    words = [w for w in _stems(query) if w]
    meaningful = [w for w in words if w not in _FILLER]
    kept = meaningful or words

    terms: list[Term] = []
    seen: set[str] = set()
    for word in kept:
        if word in seen:
            continue
        seen.add(word)
        terms.append((word, *(_stem(s) for s in _SYNONYMS.get(word, ()))))
    return terms


def _matches(term: Term, words: Sequence[str]) -> bool:
    return any(
        word == variant or (len(variant) >= _PREFIX_MIN and word.startswith(variant))
        for variant in term
        for word in words
    )


def _slug_text(url: str) -> str:
    """The words in a URL's path. A recipe's slug is usually its title, which
    makes it a free second reading of the title for sites whose search gives us
    little else to go on."""
    return urlsplit(url).path.replace("-", " ").replace("_", " ").replace("/", " ")


def score_fields(terms: Sequence[Term], fields: Iterable[tuple[float, str]]) -> float:
    """Relevance of a document given as ``(weight, text)`` fields.

    Each term earns the weight of the strongest field it appears in; the score
    is the mean of those, so missing a term costs proportionally. That puts it
    on 0 to 1, which an exact phrase match in the title can exceed by
    ``PHRASE_BONUS``."""
    if not terms:
        return 0.0

    by_field = [(weight, _stems(text)) for weight, text in fields if text]
    total = 0.0
    for term in terms:
        total += max(
            (weight for weight, words in by_field if _matches(term, words)), default=0.0
        )
    score = total / len(terms)

    if len(terms) > 1:
        phrase = " ".join(term[0] for term in terms)
        title = " ".join(
            word for weight, words in by_field if weight == TITLE for word in words
        )
        if phrase in title:
            score += PHRASE_BONUS
    return score


def score_title(terms: Sequence[Term], title: str, url: str) -> float:
    """Relevance of a search hit before it is fetched, from its title and URL
    alone. Used to pick which candidates are worth the round trip."""
    return score_fields(terms, [(TITLE, f"{title} {_slug_text(url)}")])


def score_draft(terms: Sequence[Term], draft: RecipeDraft) -> float:
    """Relevance of a parsed recipe, reading everything the draft carries."""
    return score_fields(
        terms,
        [
            (TITLE, f"{draft.title} {_slug_text(draft.source_url)}"),
            (DESCRIPTION, draft.description),
            (INGREDIENTS, " ".join(i.name for i in draft.ingredients)),
            (INSTRUCTIONS, draft.instructions),
        ],
    )
