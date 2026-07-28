import pytest

from app.schemas import IngredientIn, RecipeDraft
from app.services.relevance import (
    MIN_RELEVANCE,
    query_terms,
    score_draft,
    score_title,
)


def _draft(
    title: str = "Untitled",
    description: str = "",
    ingredients: tuple[str, ...] = (),
    instructions: str = "",
    url: str = "https://example.com/p/1234/",
) -> RecipeDraft:
    return RecipeDraft(
        title=title,
        description=description,
        instructions=instructions,
        ingredients=[IngredientIn(name=n) for n in ingredients],
        source_url=url,
    )


def test_query_terms_drops_filler():
    assert query_terms("the best easy korean bbq recipe") == [
        ("korean",),
        ("bbq", "barbecue", "barbeque"),
    ]


def test_query_terms_keeps_filler_when_that_is_all_there_is():
    """A search for nothing but filler should still search for something."""
    assert query_terms("the best recipe") == [("the",), ("best",), ("recipe",)]


def test_query_terms_folds_plurals_and_repeats():
    assert query_terms("noodles noodle chicken") == [("noodle",), ("chicken",)]


@pytest.mark.parametrize(
    ("query", "title"),
    [
        ("korean bbq", "Korean Barbecue Short Ribs"),
        ("barbecue chicken", "BBQ Chicken Pizza"),
        ("shrimp scampi", "Garlic Prawn Scampi"),
        ("eggplant parmesan", "Aubergine Parmesan"),
        ("chicken noodle soup", "Chicken Noodles Soup"),
        ("banana bread", "Classic Banana Bread"),
    ],
)
def test_equivalent_wordings_score_as_full_matches(query, title):
    assert score_draft(query_terms(query), _draft(title)) >= 1.0


def test_a_word_the_title_only_starts_with_does_not_match_a_short_term():
    """Prefix matching earns "noodle" its plural, but must not let "pea" claim
    every peanut recipe."""
    terms = query_terms("pea soup")
    assert score_draft(terms, _draft("Peanut Soup")) == pytest.approx(0.5)
    assert score_draft(terms, _draft("Split Pea Soup")) >= 1.0


def test_title_matches_outrank_passing_mentions():
    terms = query_terms("korean bbq")

    titled = _draft("Vegan Korean BBQ Bowls")
    described = _draft("Grilled Shrimp", description="With a sticky Korean BBQ glaze.")
    stocked = _draft("Grilled Shrimp", ingredients=("korean bbq sauce",))
    mentioned = _draft("Cauliflower Wings", instructions="Serve with Korean BBQ sauce.")
    unrelated = _draft("Cauliflower Wings", description="Sweet and spicy.")

    scores = [score_draft(terms, d) for d in (titled, described, stocked, mentioned)]
    assert scores == sorted(scores, reverse=True)
    assert scores[0] >= MIN_RELEVANCE and scores[1] >= MIN_RELEVANCE
    assert scores[-1] < MIN_RELEVANCE
    assert score_draft(terms, unrelated) == 0.0


def test_matching_every_term_beats_matching_one_of_them_perfectly():
    """The failure this whole module exists for: half a query matched loudly
    must not outrank the whole query matched quietly."""
    terms = query_terms("korean bbq")
    half = score_draft(terms, _draft("Korean Cucumber Salad"))
    whole = score_draft(terms, _draft("Grilled Ribs", description="Korean BBQ style."))
    assert whole > half
    assert half < MIN_RELEVANCE


def test_the_query_as_a_phrase_beats_the_same_words_scattered():
    terms = query_terms("chicken pot pie")
    phrase = score_draft(terms, _draft("Easy Chicken Pot Pie"))
    scattered = score_draft(terms, _draft("Chicken Thighs in a Pot with Pie Crust"))
    assert phrase > scattered


def test_a_recipes_url_reads_as_a_second_title():
    """Sites whose search gives us little to go on still leak the title into
    the slug, and some parsed titles are decorated past recognition."""
    terms = query_terms("banana bread")
    slug_only = _draft("Grandma's Best-Ever Loaf", url="https://x.test/banana-bread/")
    assert slug_only.title.lower().find("banana") == -1
    assert score_draft(terms, slug_only) >= 1.0


def test_score_title_ranks_hits_before_they_are_fetched():
    terms = query_terms("banana bread")
    assert score_title(terms, "Banana Bread", "https://x.test/p/12/") >= 1.0
    assert score_title(terms, "Bread Basics", "https://x.test/p/13/") == pytest.approx(0.5)
    assert score_title(terms, "Sheet Pan Salmon", "https://x.test/p/14/") == 0.0
