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


async def test_summaries_include_tags_and_ingredient_names(client):
    await make_recipe(
        client,
        "Pesto Pasta",
        tags=["vegetarian"],
        ingredients=[
            {"name": "Basil", "quantity": 2, "unit": "cups"},
            {"name": "Parmesan", "quantity": None, "unit": None},
        ],
    )
    summaries = (await client.get("/api/recipes")).json()
    assert summaries[0]["tags"] == ["vegetarian"]
    assert summaries[0]["ingredient_names"] == ["Basil", "Parmesan"]


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
