"""Nutrition per serving, from the bundled USDA tables.

What is worth proving is the refusal as much as the arithmetic: a recipe
with one ingredient that cannot be counted gets no figure at all, never a
smaller one, and says which ingredient and why. The weighing cases are
real recipe lines, and the defaults cases are the near misses - "almond
flour" is not flour - that would otherwise count confidently and wrongly.

Expected figures are USDA's SR Legacy values per 100 g, worked by hand.
"""

import pytest

from app.services.nutrition import foods
from app.services.nutrition.defaults import DEFAULTS, default_for, nutrition_key
from app.services.nutrition.weights import grams

FLOUR = 168894
EGG = 171287
ALMONDS = 170567


def weigh(name: str, quantity: float | None, unit: str | None) -> float | None:
    """Weigh a line the way a recipe page does: its default food and hints."""
    key = nutrition_key(name)
    default = default_for(key)
    assert default is not None, f"no default for {key}"
    return grams(foods.food(default.fdc_id), quantity, unit, name, key, default)


# ------------------------------------------------------------- weighing ---


@pytest.mark.parametrize(
    ("name", "quantity", "unit", "expected"),
    [
        # Weights need nothing.
        ("boneless skinless chicken thighs", 1.5, "lb", 680.388),
        # Volumes by USDA's own portion for the food.
        ("all-purpose flour", 2, "cups", 250),
        ("butter", 2, "tbsp", 28.4),
        # Several cups of one food: the one the recipe describes wins.
        ("onion, diced", 1, "cup", 160),
        ("sliced onion", 1, "cup", 115),
        # A unit only the food can answer.
        ("unsalted butter", 1, "stick", 113),
        ("garlic", 3, "cloves", 9),
        # Counts: the ingredient's own word, the default's piece, the size the
        # recipe gives, and the food's own name.
        ("garlic cloves", 3, None, 9),
        ("eggs", 2, None, 100),
        ("small eggs", 2, None, 76),
        ("chicken breasts", 2, None, 544),
        ("jalapeno", 1, None, 14),
        # A pinch is a sixteenth of a teaspoon when USDA did not weigh one.
        ("salt", 1, "pinch", 0.375),
        # Kosher salt is table salt's nutrition at two thirds of its weight.
        ("kosher salt", 1, "tsp", 5.0),
    ],
)
def test_an_amount_is_weighed(name, quantity, unit, expected):
    assert weigh(name, quantity, unit) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize(
    ("name", "quantity", "unit"),
    [
        # USDA weighs a tablespoon of shallot, not a shallot.
        ("shallot", 1, None),
        # Nothing says what a bunch of parsley weighs.
        ("parsley", 1, "bunch"),
        # The importer dropped "(15 oz)", and USDA's can is some other can.
        ("black beans", 1, "can"),
        # No amount is not an amount.
        ("flour", None, "cup"),
    ],
)
def test_an_amount_that_cannot_be_weighed_is_not_guessed(name, quantity, unit):
    assert weigh(name, quantity, unit) is None


# ------------------------------------------------------------- defaults ---


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Harmless words are walked past.
        ("extra-virgin olive oil", 171413),
        ("boneless skinless chicken thighs", 173627),
        ("yukon gold potatoes", 170026),
        ("jasmine rice", 168877),
        # A qualified entry beats the general one.
        ("sour cream", 171257),
        ("ground ginger", 170926),
        ("sweet potato", 168482),
    ],
)
def test_an_ingredient_finds_its_default(name, expected):
    found = default_for(nutrition_key(name))
    assert found is not None
    assert found.fdc_id == expected


@pytest.mark.parametrize(
    "name",
    [
        # The word that is skipped changes the food.
        "almond flour",
        "baby carrots",
        "smoked salmon",
        "ground mustard",
        "white chocolate chips",
        "dried black beans",
        "part-skim mozzarella",
        # Cooking changes the food; see nutrition_key.
        "cooked rice",
        "chicken breasts, cooked and shredded",
    ],
)
def test_a_near_miss_has_no_default(name):
    assert default_for(nutrition_key(name)) is None


def test_cooking_is_kept_in_the_key_wherever_the_name_says_it():
    assert nutrition_key("cooked rice") == "cooked-rice"
    assert nutrition_key("rice, cooked") == "cooked-rice"
    assert nutrition_key("diced onion") == "onion"


@pytest.mark.parametrize(("key", "default"), sorted(DEFAULTS.items()))
def test_every_default_is_a_food_the_tables_hold(key, default):
    """A default pointing at nothing would silently ask about every recipe
    that uses the ingredient, and a named piece USDA did not weigh would
    fall through to a generic one."""
    food = foods.food(default.fdc_id)
    assert food is not None, f"{key}: no food {default.fdc_id}"
    if default.piece is not None:
        assert default.piece in {p.unit for p in food.portions}, (
            f"{key}: {food.description} has no '{default.piece}' portion"
        )


# ---------------------------------------------------------------- search ---


def test_a_search_puts_what_the_food_is_before_what_it_is_in():
    found = foods.search("garlic", 10)
    assert found[0].description == "Garlic, raw"


def test_a_search_reads_a_recipe_can_as_usda_canned():
    found = foods.search("can petite tomato", 5)
    assert all("canned" in f.description for f in found[:3])


# ------------------------------------------------------------ the recipe ---


async def make(client, ingredients: list[dict], servings: int | None = 4) -> int:
    resp = await client.post(
        "/api/recipes",
        json={"title": "Test bake", "servings": servings, "ingredients": ingredients},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def nutrition(client, recipe_id: int) -> dict:
    resp = await client.get(f"/api/recipes/{recipe_id}/nutrition")
    assert resp.status_code == 200, resp.text
    return resp.json()


BAKE = [
    {"name": "all-purpose flour", "quantity": 1, "unit": "cup"},
    {"name": "eggs", "quantity": 2, "unit": None},
    {"name": "salt, to taste", "quantity": None, "unit": None},
]


async def test_a_recipe_is_counted_per_serving(client):
    """125 g of flour and 100 g of egg, over four servings. Salt to taste is
    left out, and does not stand in the way."""
    recipe_id = await make(client, BAKE)

    body = await nutrition(client, recipe_id)

    assert body["per_serving"] == {
        "kcal": 149.5,
        "protein_g": 6.4,
        "fat_g": 2.7,
        "carbs_g": 24.0,
        "sodium_mg": 36.1,
    }
    assert body["counted"] == 2
    assert body["total_lines"] == 2
    flour, eggs, salt = body["lines"]
    assert flour["grams"] == 125.0
    assert flour["food"]["fdc_id"] == FLOUR
    assert flour["nutrients"]["kcal"] == 455.0
    assert eggs["grams"] == 100.0
    assert eggs["food"]["fdc_id"] == EGG
    assert salt["measured"] is False
    assert salt["issue"] is None


async def test_one_ingredient_that_cannot_be_counted_withholds_the_figure(client):
    recipe_id = await make(
        client,
        [
            *BAKE,
            {"name": "almond flour", "quantity": 1, "unit": "cup"},
            {"name": "shallot", "quantity": 1, "unit": None},
            {"name": "1 avocado", "quantity": None, "unit": None},
        ],
    )

    body = await nutrition(client, recipe_id)

    assert body["per_serving"] is None
    assert body["counted"] == 2
    assert body["total_lines"] == 5
    by_name = {line["name"]: line for line in body["lines"]}
    assert by_name["almond flour"]["issue"] == "no_food"
    assert by_name["almond flour"]["food"] is None
    # The food is still shown when only the amount is the problem.
    assert by_name["shallot"]["issue"] == "unweighable"
    assert by_name["shallot"]["food"]["description"] == "Shallots, raw"
    # The recipe-side reasons are pricing's, in the same words.
    assert by_name["1 avocado"]["issue"] == "amount_in_name"


async def test_a_recipe_without_servings_has_no_figure_per_serving(client):
    recipe_id = await make(client, BAKE, servings=None)

    body = await nutrition(client, recipe_id)

    assert body["per_serving"] is None
    assert body["counted"] == body["total_lines"] == 2


async def test_choosing_a_food_counts_the_ingredient_and_forgetting_it_undoes_that(client):
    recipe_id = await make(client, [*BAKE, {"name": "almond flour", "quantity": 1, "unit": "cup"}])
    line = (await nutrition(client, recipe_id))["lines"][-1]
    assert line["key"] == "almond-flour"

    resp = await client.put("/api/nutrition/match", json={"key": "almond-flour", "fdc_id": ALMONDS})
    assert resp.status_code == 204

    body = await nutrition(client, recipe_id)
    chosen = body["lines"][-1]
    assert chosen["food"]["fdc_id"] == ALMONDS
    assert chosen["hand_picked"] is True
    assert chosen["issue"] is None
    assert body["per_serving"] is not None

    resp = await client.delete("/api/nutrition/match", params={"key": "almond-flour"})
    assert resp.status_code == 204

    body = await nutrition(client, recipe_id)
    assert body["lines"][-1]["issue"] == "no_food"
    assert body["per_serving"] is None


async def test_a_choice_holds_for_every_recipe_using_the_ingredient(client):
    first = await make(client, [{"name": "almond flour", "quantity": 1, "unit": "cup"}])
    second = await make(client, [{"name": "Almond flour", "quantity": 2, "unit": "cups"}])

    await client.put("/api/nutrition/match", json={"key": "almond-flour", "fdc_id": ALMONDS})

    assert (await nutrition(client, first))["per_serving"] is not None
    assert (await nutrition(client, second))["per_serving"] is not None


async def test_a_food_that_does_not_exist_cannot_be_chosen(client):
    resp = await client.put("/api/nutrition/match", json={"key": "almond-flour", "fdc_id": 1})
    assert resp.status_code == 404


async def test_the_food_search_answers_with_what_100_g_holds(client):
    resp = await client.get("/api/nutrition/foods", params={"q": "garlic"})

    assert resp.status_code == 200
    first = resp.json()[0]
    assert first["description"] == "Garlic, raw"
    assert first["per_100g"]["kcal"] == 149.0
