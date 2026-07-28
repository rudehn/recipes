async def make_recipe(client, title, tags=None, ingredients=None):
    resp = await client.post(
        "/api/recipes",
        json={"title": title, "tags": tags or [], "ingredients": ingredients or []},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_tags_roundtrip_and_normalization(client):
    recipe = await make_recipe(client, "Tacos", tags=["Quick", " quick ", "MEXICAN", ""])
    assert recipe["tags"] == ["mexican", "quick"]

    resp = await client.put(
        f"/api/recipes/{recipe['id']}",
        json={"title": "Tacos", "tags": ["weeknight"], "ingredients": []},
    )
    assert resp.json()["tags"] == ["weeknight"]


async def test_update_keeps_overlapping_tags(client):
    """Editing a recipe resubmits the tags it already has.

    Every one of these overlaps the stored rows, which used to collide with
    the (recipe_id, name) unique constraint and fail the whole save - so any
    edit at all to a tagged recipe returned a 500.
    """
    recipe = await make_recipe(client, "Tso Chicken", tags=["chinese", "easy"])
    assert recipe["tags"] == ["chinese", "easy"]

    for sent, expected in [
        (["chinese", "easy"], ["chinese", "easy"]),          # unchanged
        (["chinese", "easy", "spicy"], ["chinese", "easy", "spicy"]),  # added
        (["chinese", "spicy"], ["chinese", "spicy"]),        # removed one
        (["chinese", "noodles"], ["chinese", "noodles"]),    # added and removed
        ([], []),                                            # cleared
    ]:
        resp = await client.put(
            f"/api/recipes/{recipe['id']}",
            json={"title": "Tso Chicken", "tags": sent, "ingredients": []},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["tags"] == expected


async def test_update_does_not_churn_kept_tag_rows(client):
    """A tag the edit did not touch keeps its row rather than being replaced."""
    from sqlalchemy import select

    from app.db import session_factory
    from app.models import RecipeTag

    recipe = await make_recipe(client, "Tacos", tags=["mexican", "quick"])

    async def tag_row_ids() -> dict[str, int]:
        async with session_factory() as session:
            rows = (await session.execute(select(RecipeTag))).scalars().all()
            return {row.name: row.id for row in rows}

    before = await tag_row_ids()
    resp = await client.put(
        f"/api/recipes/{recipe['id']}",
        json={"title": "Tacos", "tags": ["mexican", "weeknight"], "ingredients": []},
    )
    assert resp.status_code == 200, resp.text

    after = await tag_row_ids()
    assert after["mexican"] == before["mexican"]  # kept: same row, no delete+insert
    assert "quick" not in after
    assert "weeknight" in after


async def test_summaries_include_tags_but_not_ingredients(client):
    """Ingredients are searched server-side now, so a card never carries them."""
    await make_recipe(
        client,
        "Pesto Pasta",
        tags=["vegetarian"],
        ingredients=[
            {"name": "Basil", "quantity": 2, "unit": "cups"},
            {"name": "Parmesan", "quantity": None, "unit": None},
        ],
    )
    summaries = (await client.get("/api/recipes")).json()["items"]
    assert summaries[0]["tags"] == ["vegetarian"]
    assert "ingredient_names" not in summaries[0]
    assert "ingredients" not in summaries[0]


async def test_copy_week(client):
    curry = await make_recipe(client, "Curry")
    tacos = await make_recipe(client, "Tacos")
    for plan_date, meal, rid in [
        ("2026-07-20", "dinner", curry["id"]),
        ("2026-07-22", "lunch", tacos["id"]),
    ]:
        await client.post(
            "/api/meal-plan",
            json={"plan_date": plan_date, "meal": meal, "recipe_id": rid},
        )

    resp = await client.post(
        "/api/meal-plan/copy-week",
        json={"from_start": "2026-07-20", "to_start": "2026-07-27"},
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert [(e["plan_date"], e["meal"]) for e in created] == [
        ("2026-07-27", "dinner"),
        ("2026-07-29", "lunch"),
    ]

    # Copying again is a no-op, not a duplication.
    resp = await client.post(
        "/api/meal-plan/copy-week",
        json={"from_start": "2026-07-20", "to_start": "2026-07-27"},
    )
    assert resp.json() == []

    entries = (
        await client.get(
            "/api/meal-plan", params={"start": "2026-07-27", "end": "2026-08-02"}
        )
    ).json()
    assert len(entries) == 2
