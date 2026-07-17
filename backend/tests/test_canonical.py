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


def test_clean_display_strips_annotations():
    assert (
        clean_display("evaporated milk (1 can, or 1 1/3 cups milk)")
        == "evaporated milk"
    )
    assert clean_display("large eggs, at room temperature") == "large eggs"
    assert clean_display("lo mein noodles ($1.30)") == "lo mein noodles"


def test_best_display_prefers_shortest_variant():
    assert best_display(["large eggs, at room temperature", "eggs"]) == "eggs"
    assert best_display(["finely diced onion", "onion"]) == "onion"


def test_best_display_drops_prep_words_from_single_variant():
    assert best_display(["finely diced onion"]) == "onion"
    assert best_display(["green bell pepper (diced)"]) == "green bell pepper"
    # Words that change what you buy stay.
    assert best_display(["ground pork sausage (cooked, crumbled, and drained)"]) == "ground pork sausage"
