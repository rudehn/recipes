"""The pairs offered as possible merges.

Pinned against the owner's real 92 ingredients, because the rules are only
as good as what they say about a real box: every pair here is one a person
would consider, and pairs that differ to buy (red onion and onion, whole
milk and milk, sweet potato and potato) are not offered at all.
"""

from pathlib import Path

from app.db import session_factory
from app.models import IngredientMergeDismissal
from app.services.merge_suggestions import Pair, find

REAL = (Path(__file__).parent / "fixtures" / "real_ingredient_keys.txt").read_text().split()


def test_the_real_box_gets_the_pairs_a_person_would_consider():
    assert sorted(find(REAL), key=lambda p: p.specific) == [
        Pair("all-purpose-flour", "flour", "describing", True),
        Pair("garlic-clove", "garlic", "counting", True),
        Pair("gold-potato", "potato", "describing", True),
        Pair("ground-cumin", "cumin", "describing", True),
        Pair("lean-ground-beef", "ground-beef", "describing", True),
        Pair("mayo", "mayonnaise", "synonym", False),
        Pair("russet-potato", "potato", "describing", True),
        Pair("strips-bacon", "bacon", "counting", True),
        Pair("yellow-onion", "onion", "describing", True),
    ]


def test_words_that_change_what_is_bought_are_never_dropped():
    assert (
        find(
            ["red-onion", "onion", "whole-milk", "milk", "sweet-potato", "potato", "green-onion"]
        )
        == []
    )


def test_ground_is_dropped_only_from_a_spice_sold_ground_anyway():
    """Ground ginger is not ginger root, ground red pepper is cayenne rather
    than a bell pepper, and ground beef is not a roast. Cumin, though, is
    ground cumin at the shop unless the recipe says seeds."""
    assert find(
        [
            *["ground-ginger", "ginger", "ground-red-pepper", "red-pepper"],
            *["ground-mustard", "mustard", "ground-beef", "beef"],
            *["ground-cumin", "cumin", "ground-black-pepper", "black-pepper"],
            *["salt-and-ground-pepper", "salt-and-pepper"],
        ]
    ) == [
        Pair("ground-black-pepper", "black-pepper", "describing", True),
        Pair("ground-cumin", "cumin", "describing", True),
        Pair("salt-and-ground-pepper", "salt-and-pepper", "describing", True),
    ]


def test_a_name_that_only_says_its_sauce_is_a_pair():
    assert find(["worcestershire", "worcestershire-sauce"]) == [
        Pair("worcestershire", "worcestershire-sauce", "synonym", False)
    ]


def test_spacing_alone_is_a_pair():
    assert find(["corn-starch", "cornstarch"]) == [
        Pair("corn-starch", "cornstarch", "spacing", False)
    ]


def test_the_closest_general_name_wins():
    assert find(["extra-virgin-olive-oil", "virgin-olive-oil", "olive-oil"]) == [
        Pair("extra-virgin-olive-oil", "virgin-olive-oil", "describing", True),
        Pair("virgin-olive-oil", "olive-oil", "describing", True),
    ]


async def recipe(client, *names: str) -> None:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": names[0],
            "ingredients": [{"name": n, "quantity": 1, "unit": "tsp"} for n in names],
        },
    )
    assert resp.status_code == 201, resp.text


async def test_the_list_offers_suggestions_and_marks_both_sides(client):
    await recipe(client, "ground cumin", "cumin", "paprika")

    body = (await client.get("/api/ingredients")).json()

    assert body["suggestions"] == [
        {
            "from_key": "ground-cumin",
            "from_name": "ground cumin",
            "to_key": "cumin",
            "to_name": "cumin",
            "reason": "describing",
        }
    ]
    problems = {i["key"]: i["problems"] for i in body["ingredients"]}
    assert problems == {"cumin": ["merge"], "ground-cumin": ["merge"], "paprika": []}


async def test_an_undirected_pair_points_at_the_name_more_recipes_use(client):
    await recipe(client, "mayo")
    await recipe(client, "mayonnaise")
    await recipe(client, "mayonnaise", "salt")

    (suggestion,) = (await client.get("/api/ingredients")).json()["suggestions"]

    assert (suggestion["from_key"], suggestion["to_key"]) == ("mayo", "mayonnaise")


async def test_a_turned_down_pair_is_not_offered_again(client):
    await recipe(client, "ground cumin", "cumin")
    async with session_factory() as session:
        session.add(IngredientMergeDismissal(key_a="cumin", key_b="ground-cumin"))
        await session.commit()

    assert (await client.get("/api/ingredients")).json()["suggestions"] == []
