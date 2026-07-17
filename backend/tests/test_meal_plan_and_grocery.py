async def make_recipe(client, title, ingredients):
    resp = await client.post(
        "/api/recipes",
        json={"title": title, "ingredients": ingredients},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def plan(client, plan_date, meal, recipe_id):
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": plan_date, "meal": meal, "recipe_id": recipe_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def grocery(client, start="2026-07-20", end="2026-07-26"):
    resp = await client.get("/api/grocery-list", params={"start": start, "end": end})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_meal_plan_crud(client):
    recipe = await make_recipe(client, "Tacos", [])
    entry = await plan(client, "2026-07-20", "dinner", recipe["id"])
    assert entry["recipe"]["title"] == "Tacos"

    resp = await client.get(
        "/api/meal-plan", params={"start": "2026-07-20", "end": "2026-07-26"}
    )
    assert [e["meal"] for e in resp.json()] == ["dinner"]

    assert (await client.delete(f"/api/meal-plan/{entry['id']}")).status_code == 204
    resp = await client.get(
        "/api/meal-plan", params={"start": "2026-07-20", "end": "2026-07-26"}
    )
    assert resp.json() == []


async def test_meal_plan_rejects_unknown_recipe(client):
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": "2026-07-20", "meal": "dinner", "recipe_id": 999},
    )
    assert resp.status_code == 404


async def test_grocery_aggregates_across_recipes(client):
    pancakes = await make_recipe(
        client,
        "Pancakes",
        [
            {"name": "Flour", "quantity": 2, "unit": "cups"},
            {"name": "Milk", "quantity": 1.5, "unit": "cups"},
        ],
    )
    bread = await make_recipe(
        client,
        "Bread",
        [
            {"name": "flour", "quantity": 1, "unit": "cup"},
            {"name": "Flour", "quantity": 2, "unit": "tbsp"},
        ],
    )
    await plan(client, "2026-07-20", "breakfast", pancakes["id"])
    await plan(client, "2026-07-21", "dinner", bread["id"])

    data = await grocery(client)
    by_name = {i["name"].lower(): i for i in data["items"]}
    # "cups" and "cup" merge; tbsp stays a separate amount on the same line.
    assert sorted(by_name["flour"]["amounts"]) == ["2 tbsp", "3 cups"]
    assert by_name["milk"]["amounts"] == ["1.5 cups"]
    assert len(by_name["flour"]["uses"]) == 3


async def test_grocery_respects_date_range(client):
    recipe = await make_recipe(
        client, "Soup", [{"name": "Carrots", "quantity": 3, "unit": None}]
    )
    await plan(client, "2026-07-19", "dinner", recipe["id"])  # outside range

    data = await grocery(client)
    assert data["items"] == []


async def test_pantry_in_stock_items_are_excluded(client):
    recipe = await make_recipe(
        client,
        "Salad",
        [
            {"name": "Olive oil", "quantity": 2, "unit": "tbsp"},
            {"name": "Lettuce", "quantity": 1, "unit": None},
        ],
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    await client.post("/api/pantry", json={"name": "olive oil", "in_stock": True})

    data = await grocery(client)
    names = [i["name"].lower() for i in data["items"]]
    assert names == ["lettuce"]


async def test_out_of_stock_pantry_item_needed_by_recipe_stays_on_list(client):
    recipe = await make_recipe(
        client, "Salad", [{"name": "Olive oil", "quantity": 2, "unit": "tbsp"}]
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    pantry = (
        await client.post("/api/pantry", json={"name": "olive oil", "in_stock": False})
    ).json()

    data = await grocery(client)
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["from_pantry"] is True
    assert item["pantry_item_id"] == pantry["id"]
    # Not duplicated in the restock section.
    assert data["pantry_restock"] == []


async def test_out_of_stock_pantry_items_appear_in_restock(client):
    await client.post("/api/pantry", json={"name": "Coffee", "in_stock": False})
    await client.post("/api/pantry", json={"name": "Rice", "in_stock": True})

    data = await grocery(client)
    assert [i["name"] for i in data["pantry_restock"]] == ["Coffee"]


async def test_checking_pantry_item_restocks_it(client):
    pantry = (
        await client.post("/api/pantry", json={"name": "Coffee", "in_stock": False})
    ).json()
    data = await grocery(client)
    key = data["pantry_restock"][0]["key"]

    resp = await client.post(
        "/api/grocery-list/toggle", json={"key": key, "checked": True}
    )
    assert resp.status_code == 204

    items = (await client.get("/api/pantry")).json()
    assert items[0]["in_stock"] is True

    # Restocked, so it no longer needs buying.
    data = await grocery(client)
    assert data["pantry_restock"] == []


async def test_check_state_persists_across_regeneration(client):
    recipe = await make_recipe(
        client, "Soup", [{"name": "Carrots", "quantity": 3, "unit": None}]
    )
    await plan(client, "2026-07-20", "dinner", recipe["id"])

    data = await grocery(client)
    key = data["items"][0]["key"]
    await client.post("/api/grocery-list/toggle", json={"key": key, "checked": True})

    data = await grocery(client)
    assert data["items"][0]["checked"] is True

    await client.post("/api/grocery-list/clear-checks")
    data = await grocery(client)
    assert data["items"][0]["checked"] is False


async def test_pantry_duplicate_name_rejected(client):
    assert (
        await client.post("/api/pantry", json={"name": "Rice"})
    ).status_code == 201
    assert (
        await client.post("/api/pantry", json={"name": "  rice "})
    ).status_code == 409
