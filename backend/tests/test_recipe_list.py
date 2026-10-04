"""Paging, searching, and filtering on GET /api/recipes.

The list endpoint absorbed the work the recipes page used to do client-side
over the whole collection, so the cases that matter are the ones where a page
and the collection disagree.
"""

import pytest


async def make_recipe(client, title, tags=None, ingredients=None, description=""):
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "description": description,
            "tags": tags or [],
            "ingredients": ingredients or [],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def titles(client, **params):
    resp = await client.get("/api/recipes", params=params)
    assert resp.status_code == 200, resp.text
    return [r["title"] for r in resp.json()["items"]]


async def test_pages_split_the_collection_without_gaps_or_repeats(client):
    for n in range(1, 8):
        await make_recipe(client, f"Recipe {n}")

    first = await titles(client, per_page=3, page=1)
    second = await titles(client, per_page=3, page=2)
    third = await titles(client, per_page=3, page=3)

    assert first == ["Recipe 1", "Recipe 2", "Recipe 3"]
    assert second == ["Recipe 4", "Recipe 5", "Recipe 6"]
    assert third == ["Recipe 7"]
    assert len(set(first + second + third)) == 7


async def test_identical_titles_still_page_cleanly(client):
    """Title alone is not a stable sort key, so the id breaks the tie.

    Without it SQLite may order the duplicates differently per query, and a
    recipe then shows up on both pages or on neither.
    """
    for _ in range(4):
        await make_recipe(client, "Soup")

    ids = []
    for page in (1, 2):
        resp = await client.get("/api/recipes", params={"per_page": 2, "page": page})
        ids += [r["id"] for r in resp.json()["items"]]

    assert len(set(ids)) == 4


async def test_total_counts_matches_not_the_page(client):
    for n in range(1, 6):
        await make_recipe(client, f"Recipe {n}")

    body = (await client.get("/api/recipes", params={"per_page": 2})).json()
    assert len(body["items"]) == 2
    assert body["total"] == 5


async def test_page_past_the_end_is_empty_not_an_error(client):
    await make_recipe(client, "Pancakes")
    resp = await client.get("/api/recipes", params={"page": 9})
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 1, "page": 9, "per_page": 24}


@pytest.mark.parametrize("per_page", [0, -1, 101])
async def test_per_page_is_bounded(client, per_page):
    resp = await client.get("/api/recipes", params={"per_page": per_page})
    assert resp.status_code == 422


async def test_page_below_one_is_rejected(client):
    assert (await client.get("/api/recipes", params={"page": 0})).status_code == 422


async def test_search_matches_title_description_tag_and_ingredient(client):
    await make_recipe(client, "Chicken Curry")
    await make_recipe(client, "Dal", description="Warming lentil stew")
    await make_recipe(client, "Tacos", tags=["weeknight"])
    await make_recipe(client, "Risotto", ingredients=[{"name": "Arborio rice"}])
    await make_recipe(client, "Cake")

    assert await titles(client, q="curry") == ["Chicken Curry"]
    assert await titles(client, q="lentil") == ["Dal"]
    assert await titles(client, q="weeknight") == ["Tacos"]
    assert await titles(client, q="arborio") == ["Risotto"]


async def test_search_is_case_insensitive(client):
    await make_recipe(client, "Chicken Curry")
    assert await titles(client, q="CHICKEN") == ["Chicken Curry"]


async def test_search_matches_beyond_the_first_page(client):
    """The bug pagination alone would have introduced.

    Searching used to run in the browser over every recipe. If the server
    paged first and filtered second, a match sitting on page 3 would vanish.
    """
    for n in range(1, 30):
        await make_recipe(client, f"Recipe {n}")
    await make_recipe(client, "Zuppa Toscana")

    assert await titles(client, q="zuppa") == ["Zuppa Toscana"]


async def test_a_recipe_matching_twice_is_returned_once(client):
    await make_recipe(
        client,
        "Lemon Chicken",
        ingredients=[{"name": "Lemon zest"}, {"name": "Lemon juice"}],
    )
    body = (await client.get("/api/recipes", params={"q": "lemon"})).json()
    assert len(body["items"]) == 1
    assert body["total"] == 1


async def test_search_wildcards_are_literal(client):
    await make_recipe(client, "100% Whole Wheat Bread")
    await make_recipe(client, "Pancakes")
    assert await titles(client, q="100%") == ["100% Whole Wheat Bread"]
    assert await titles(client, q="_") == []


async def test_tag_filter_and_its_total(client):
    await make_recipe(client, "Tacos", tags=["weeknight"])
    await make_recipe(client, "Chili", tags=["weeknight"])
    await make_recipe(client, "Cake", tags=["dessert"])

    body = (await client.get("/api/recipes", params={"tag": "weeknight"})).json()
    assert [r["title"] for r in body["items"]] == ["Chili", "Tacos"]
    assert body["total"] == 2


async def test_tag_filter_is_case_insensitive(client):
    await make_recipe(client, "Tacos", tags=["weeknight"])
    assert await titles(client, tag="Weeknight") == ["Tacos"]


async def test_search_and_tag_filter_combine(client):
    await make_recipe(client, "Chicken Tacos", tags=["weeknight"])
    await make_recipe(client, "Chicken Pie", tags=["sunday"])
    assert await titles(client, q="chicken", tag="weeknight") == ["Chicken Tacos"]


async def test_sort_by_newest_reverses_creation_order(client):
    await make_recipe(client, "First")
    await make_recipe(client, "Second")
    assert await titles(client, sort="newest") == ["Second", "First"]


async def test_unknown_sort_is_rejected(client):
    resp = await client.get("/api/recipes", params={"sort": "servings"})
    assert resp.status_code == 422


async def test_tags_endpoint_lists_every_tag_with_counts(client):
    await make_recipe(client, "Tacos", tags=["weeknight", "mexican"])
    await make_recipe(client, "Chili", tags=["weeknight"])

    resp = await client.get("/api/recipes/tags")
    assert resp.status_code == 200
    assert resp.json() == [
        {"name": "mexican", "count": 1},
        {"name": "weeknight", "count": 2},
    ]


async def test_tags_endpoint_covers_recipes_beyond_the_first_page(client):
    """The filter bar cannot be built from one page of recipes any more."""
    for n in range(1, 30):
        await make_recipe(client, f"Recipe {n}")
    await make_recipe(client, "Zuppa Toscana", tags=["soup"])

    names = [t["name"] for t in (await client.get("/api/recipes/tags")).json()]
    assert names == ["soup"]


async def test_several_tags_narrow_to_recipes_carrying_all_of_them(client):
    await make_recipe(client, "Kung Pao Chicken", tags=["dinner", "chinese"])
    await make_recipe(client, "Congee", tags=["breakfast", "chinese"])
    await make_recipe(client, "Meatloaf", tags=["dinner"])

    body = (await client.get("/api/recipes", params={"tag": ["dinner", "chinese"]})).json()
    assert [r["title"] for r in body["items"]] == ["Kung Pao Chicken"]
    assert body["total"] == 1


async def test_several_tags_are_normalized_like_one(client):
    """Repeated, padded or capitalized, a tag is still the tag it names."""
    await make_recipe(client, "Kung Pao Chicken", tags=["dinner", "chinese"])
    await make_recipe(client, "Meatloaf", tags=["dinner"])

    assert await titles(client, tag=["Dinner", " chinese ", "dinner"]) == ["Kung Pao Chicken"]


async def test_search_and_several_tags_combine(client):
    await make_recipe(client, "Chicken Chow Mein", tags=["dinner", "chinese"])
    await make_recipe(client, "Beef Chow Mein", tags=["dinner", "chinese"])
    await make_recipe(client, "Chicken Fried Rice", tags=["chinese"])
    await make_recipe(client, "Chicken Pie", tags=["dinner"])

    assert await titles(client, q="chicken", tag=["dinner", "chinese"]) == ["Chicken Chow Mein"]


async def test_a_tag_filter_longer_than_any_tag_is_rejected(client):
    resp = await client.get("/api/recipes", params={"tag": ["x" * 51, "dinner"]})
    assert resp.status_code == 422


@pytest.mark.parametrize("path", ["/api/recipes", "/api/recipes/tags"])
async def test_a_tag_filter_naming_more_tags_than_anyone_would_tap_is_rejected(client, path):
    """Every tag is a subquery of its own, so the list has to end somewhere."""
    resp = await client.get(path, params={"tag": [f"tag{n}" for n in range(21)]})
    assert resp.status_code == 422
    resp = await client.get(path, params={"tag": [f"tag{n}" for n in range(20)]})
    assert resp.status_code == 200


async def test_tags_endpoint_counts_what_adding_each_tag_would_leave(client):
    """With a tag selected, each count is what selecting that one too gives.

    A tag none of the remaining recipes carry is still listed, at zero, so the
    bar keeps its shape and can dim it rather than have it vanish under the
    finger.
    """
    await make_recipe(client, "Kung Pao Chicken", tags=["dinner", "chinese", "spicy"])
    await make_recipe(client, "Mapo Tofu", tags=["dinner", "chinese", "spicy"])
    await make_recipe(client, "Meatloaf", tags=["dinner"])
    await make_recipe(client, "Congee", tags=["breakfast", "chinese"])

    resp = await client.get("/api/recipes/tags", params={"tag": "dinner"})
    assert resp.status_code == 200
    assert resp.json() == [
        {"name": "breakfast", "count": 0},
        {"name": "chinese", "count": 2},
        {"name": "dinner", "count": 3},
        {"name": "spicy", "count": 2},
    ]


async def test_tags_endpoint_counts_within_several_tags(client):
    await make_recipe(client, "Kung Pao Chicken", tags=["dinner", "chinese", "spicy"])
    await make_recipe(client, "Chow Mein", tags=["dinner", "chinese"])
    await make_recipe(client, "Meatloaf", tags=["dinner"])

    resp = await client.get("/api/recipes/tags", params={"tag": ["Dinner", "chinese"]})
    counts = {t["name"]: t["count"] for t in resp.json()}
    assert counts == {"chinese": 2, "dinner": 2, "spicy": 1}


async def test_tags_endpoint_counts_within_the_search(client):
    await make_recipe(client, "Chicken Curry", tags=["dinner", "indian"])
    await make_recipe(client, "Chicken Soup", tags=["dinner", "soup"])
    await make_recipe(client, "Lentil Soup", tags=["soup"])

    resp = await client.get("/api/recipes/tags", params={"q": "chicken"})
    counts = {t["name"]: t["count"] for t in resp.json()}
    assert counts == {"dinner": 2, "indian": 1, "soup": 1}
