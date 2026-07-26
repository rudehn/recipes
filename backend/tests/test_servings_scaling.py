async def make_recipe(client, title, servings, ingredients):
    resp = await client.post(
        "/api/recipes",
        json={"title": title, "servings": servings, "ingredients": ingredients},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def plan(client, plan_date, meal, recipe_id, servings=None):
    body = {"plan_date": plan_date, "meal": meal, "recipe_id": recipe_id}
    if servings is not None:
        body["servings"] = servings
    resp = await client.post("/api/meal-plan", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def grocery_items(client):
    resp = await client.get(
        "/api/grocery-list", params={"start": "2026-07-20", "end": "2026-07-26"}
    )
    assert resp.status_code == 200, resp.text
    return {i["name"].lower(): i for i in resp.json()["items"]}


CURRY_INGREDIENTS = [
    {"name": "Chicken", "quantity": 1.5, "unit": "lb"},
    {"name": "Rice", "quantity": 2, "unit": "cups"},
    {"name": "Salt", "quantity": None, "unit": None},
]


async def test_grocery_scales_by_planned_servings(client):
    curry = await make_recipe(client, "Curry", 4, CURRY_INGREDIENTS)
    await plan(client, "2026-07-20", "dinner", curry["id"], servings=8)

    items = await grocery_items(client)
    assert items["chicken"]["amounts"] == ["3 lb"]
    assert items["rice"]["amounts"] == ["4 cups"]
    # Unquantified ingredients are unaffected by scaling.
    assert items["salt"]["amounts"] == ["as needed"]
    # Per-recipe uses reflect the scaled amount.
    assert items["chicken"]["uses"][0]["quantity"] == 3


async def test_grocery_unscaled_without_override(client):
    curry = await make_recipe(client, "Curry", 4, CURRY_INGREDIENTS)
    await plan(client, "2026-07-20", "dinner", curry["id"])
    items = await grocery_items(client)
    assert items["chicken"]["amounts"] == ["1½ lb"]


async def test_override_ignored_when_recipe_has_no_servings(client):
    curry = await make_recipe(client, "Curry", None, CURRY_INGREDIENTS)
    await plan(client, "2026-07-20", "dinner", curry["id"], servings=8)
    items = await grocery_items(client)
    assert items["chicken"]["amounts"] == ["1½ lb"]


async def test_fractional_scaling_rounds_cleanly(client):
    curry = await make_recipe(client, "Curry", 3, CURRY_INGREDIENTS)
    await plan(client, "2026-07-20", "dinner", curry["id"], servings=4)
    items = await grocery_items(client)
    # 1.5 * 4/3 = 2; 2 * 4/3 = 2.667, shown as the fraction a cook can measure.
    assert items["chicken"]["amounts"] == ["2 lb"]
    assert items["rice"]["amounts"] == ["2⅔ cups"]


async def test_patch_entry_servings(client):
    curry = await make_recipe(client, "Curry", 4, CURRY_INGREDIENTS)
    entry = await plan(client, "2026-07-20", "dinner", curry["id"])
    assert entry["servings"] is None

    resp = await client.patch(f"/api/meal-plan/{entry['id']}", json={"servings": 6})
    assert resp.status_code == 200, resp.text
    assert resp.json()["servings"] == 6

    # Reset back to the recipe default.
    resp = await client.patch(f"/api/meal-plan/{entry['id']}", json={"servings": None})
    assert resp.json()["servings"] is None

    assert (
        await client.patch("/api/meal-plan/999", json={"servings": 2})
    ).status_code == 404


async def test_copy_week_preserves_servings(client):
    curry = await make_recipe(client, "Curry", 4, CURRY_INGREDIENTS)
    await plan(client, "2026-07-20", "dinner", curry["id"], servings=8)
    resp = await client.post(
        "/api/meal-plan/copy-week",
        json={"from_start": "2026-07-20", "to_start": "2026-07-27"},
    )
    assert resp.json()[0]["servings"] == 8
