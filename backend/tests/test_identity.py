"""The one way ingredients are compared.

What is worth proving: without merges it is exactly `canonical_key`, so
nothing changes for a household that never merges; with one it answers the
target for every spelling of the merged name; nutrition keeps its state
words in front of the merged key, so "cooked" still separates two foods; and
the merges are read once per session until a merge says to read them again.
"""

from app.db import session_factory
from app.models import IngredientMerge
from app.services.canonical import canonical_key
from app.services.identity import Identity
from app.services.nutrition.defaults import nutrition_key as defaults_nutrition_key


def test_without_merges_it_is_the_canonical_key():
    identity = Identity.none()
    for name in ["Large eggs, at room temperature", "2 cups flour", "ground cumin", "***"]:
        assert identity.key(name) == canonical_key(name)


def test_a_merged_name_answers_its_target_however_it_is_spelled():
    identity = Identity.from_merges({"ground-cumin": "cumin"})
    assert identity.key("ground cumin") == "cumin"
    assert identity.key("Ground Cumin, toasted") == "cumin"
    assert identity.key("cumin") == "cumin"
    assert identity.resolve("ground-cumin") == "cumin"
    assert identity.resolve("paprika") == "paprika"


def test_a_name_with_no_key_has_no_identity_to_merge():
    assert Identity.from_merges({"": "cumin"}).key("***") == ""


def test_nutrition_keeps_state_words_in_front_of_the_merged_key():
    identity = Identity.from_merges({"ground-cumin": "cumin"})
    assert identity.nutrition_key("cooked ground cumin") == "cooked-cumin"
    assert identity.nutrition_key("ground cumin") == "cumin"
    # A merge never folds "cooked rice" into "rice": they are two foods.
    assert Identity.none().nutrition_key("cooked rice") == "cooked-rice"
    assert Identity.none().nutrition_key("rice") == "rice"


def test_a_nutrition_key_resolves_after_its_state_words():
    identity = Identity.from_merges({"ground-cumin": "cumin"})
    assert identity.resolve_nutrition("cooked-ground-cumin") == "cooked-cumin"
    assert identity.resolve_nutrition("ground-cumin") == "cumin"
    assert identity.resolve_nutrition("cooked-rice") == "cooked-rice"


async def test_merges_are_read_once_per_session_until_forgotten():
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

        first = await Identity.of(session)
        assert first.key("ground cumin") == "cumin"

        session.add(IngredientMerge(from_key="yellow-onion", to_key="onion"))
        await session.commit()
        assert (await Identity.of(session)) is first
        assert (await Identity.of(session)).key("yellow onion") == "yellow-onion"

        Identity.forget(session)
        assert (await Identity.of(session)).key("yellow onion") == "onion"


def test_without_merges_nutrition_keys_are_unchanged():
    """Guarantee that Identity.none().nutrition_key(n) == defaults.nutrition_key(n).

    Stored food choices are keyed by nutrition_key from defaults, so the
    Identity's nutrition_key must exactly match it when there are no merges.
    This ensures the app always finds the right nutrition facts for a food.
    """
    identity = Identity.none()
    test_names = [
        "22-ounce bag frozen waffle fries",
        "1-ounce packet ranch seasoning mix",
        "chicken breasts, cooked and shredded",
        "cooked rice",
        "rice",
        "Large eggs, at room temperature",
        "ground cumin",
        "***",
    ]
    for name in test_names:
        assert identity.nutrition_key(name) == defaults_nutrition_key(name)
