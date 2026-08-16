import pytest

from app.services.canonical import best_display, canonical_key, clean_display


@pytest.mark.parametrize(
    ("a", "b"),
    [
        # The real-world cases that failed to merge.
        ("eggs", "large eggs, at room temperature"),
        ("onion", "finely diced onion"),
        ("green bell pepper (diced)", "green bell pepper"),
        ("Butter", "butter, melted"),
        ("eggs", "Egg"),
        ("tomatoes", "ripe tomato"),
        ("berries", "berry"),
        ("kosher salt (or to taste)", "Kosher salt"),
        ("lo mein noodles ($1.30)", "lo mein noodles"),
        ("carrots, peeled and chopped", "carrot"),
    ],
)
def test_equivalents_share_a_key(a, b):
    assert canonical_key(a) == canonical_key(b), (canonical_key(a), canonical_key(b))


@pytest.mark.parametrize(
    ("a", "b"),
    [
        # Different purchases must NOT merge.
        ("ground cinnamon", "cinnamon sticks"),
        ("green bell pepper", "red bell pepper"),
        ("evaporated milk", "milk"),
        ("olive oil", "sesame oil"),
        ("hummus", "hummu"),
    ],
)
def test_distinct_items_keep_distinct_keys(a, b):
    assert canonical_key(a) != canonical_key(b)


def test_prep_only_name_survives():
    # A name made entirely of prep words shouldn't canonicalize to nothing.
    assert canonical_key("diced") != ""


def test_singular_s_exceptions():
    assert canonical_key("couscous") == "couscous"
    assert canonical_key("hummus") == "hummus"
    assert canonical_key("asparagus") == "asparagus"


def test_clean_display_strips_leading_optional():
    assert clean_display("optional: pecans or walnuts") == "pecans or walnuts"
    assert canonical_key("optional: pecans or walnuts") == canonical_key("pecans or walnuts")


def test_clean_display_strips_annotations():
    assert (
        clean_display("evaporated milk (1 can, or 1 1/3 cups milk)")
        == "evaporated milk"
    )
    assert clean_display("large eggs, at room temperature") == "large eggs"
    assert clean_display("lo mein noodles ($1.30)") == "lo mein noodles"


def test_clean_display_strips_nested_annotations():
    """Budget Bytes nests a gram weight inside the note carrying the price.
    Stopping at the first closing bracket left the price on the shopping list
    as part of the item's name - "onion $0.72)" - and keyed it that way too."""
    assert clean_display("onion (small dice, (265 g, 2 cups) $0.72)") == "onion"
    assert canonical_key("onion (small dice, (265 g, 2 cups) $0.72)") == "onion"
    assert (
        clean_display("chipotle pepper in adobo sauce (finely chopped, (50 g) $0.41)")
        == "chipotle pepper in adobo sauce"
    )
    # An unbalanced bracket is left alone rather than guessed at.
    assert clean_display("garlic cloves (minced") == "garlic cloves (minced"


def test_nested_annotations_merge_with_the_plain_name():
    """The whole point: the annotated line and the plain one are one item."""
    assert canonical_key("garlic cloves (minced (9 g, 1 heaping Tbsp) $0.18)") == (
        canonical_key("garlic cloves")
    )


def test_accents_do_not_split_the_key():
    """The key is tokenized on [a-z0-9-], which splits *on* an accented letter
    rather than keeping it: "jalapeño" keyed as "jalape-o", merging with
    nothing and searching for nothing."""
    assert canonical_key("jalapeño") == "jalapeno"
    assert canonical_key("jalapeño") == canonical_key("jalapenos")
    assert canonical_key("crème fraîche") == canonical_key("creme fraiche")
    # Display keeps them: only the merge key is folded.
    assert clean_display("jalapeño (deseeded)") == "jalapeño"


def test_best_display_prefers_shortest_variant():
    assert best_display(["large eggs, at room temperature", "eggs"]) == "eggs"
    assert best_display(["finely diced onion", "onion"]) == "onion"


def test_best_display_drops_prep_words_from_single_variant():
    assert best_display(["finely diced onion"]) == "onion"
    assert best_display(["green bell pepper (diced)"]) == "green bell pepper"
    # Words that change what you buy stay.
    sausage = ["ground pork sausage (cooked, crumbled, and drained)"]
    assert best_display(sausage) == "ground pork sausage"
