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
    assert by_name["milk"]["amounts"] == ["1½ cups"]
    assert len(by_name["flour"]["uses"]) == 3


async def test_grocery_use_names_the_recipe_row_it_came_from(client):
    """A use carries the ingredient it was, not just the recipe.

    The line's own name is a pick among the variants, and the merge is by
    canonical name, so nothing on a grocery line can be matched back to a
    recipe's wording. The id is what lets the app open a recipe on the
    ingredient a shopper was reading - including both rows when one recipe
    calls for the same thing twice.
    """
    stew = await make_recipe(
        client,
        "Stew",
        [
            {"name": "salt", "quantity": 1, "unit": "tsp"},
            {"name": "salt, to taste", "quantity": None, "unit": None},
            {"name": "beef chuck", "quantity": 2, "unit": "lb"},
        ],
    )
    await plan(client, "2026-07-20", "dinner", stew["id"])

    data = await grocery(client)
    by_name = {i["name"].lower(): i for i in data["items"]}
    ids = {ing["name"]: ing["id"] for ing in stew["ingredients"]}

    # Both salt rows are one line, and the line names each of them.
    assert [u["ingredient_id"] for u in by_name["salt"]["uses"]] == [
        ids["salt"],
        ids["salt, to taste"],
    ]
    assert [u["ingredient_id"] for u in by_name["beef chuck"]["uses"]] == [
        ids["beef chuck"]
    ]


async def test_grocery_merges_descriptive_ingredient_variants(client):
    casserole = await make_recipe(
        client,
        "Hashbrown Breakfast Casserole",
        [
            {"name": "eggs", "quantity": 8, "unit": None},
            {"name": "finely diced onion", "quantity": 0.25, "unit": "cups"},
            {"name": "green bell pepper (diced)", "quantity": 0.5, "unit": None},
        ],
    )
    bread = await make_recipe(
        client,
        "Banana Bread",
        [
            {"name": "large eggs, at room temperature", "quantity": 4, "unit": None},
            {"name": "onion", "quantity": 1, "unit": None},
        ],
    )
    await plan(client, "2026-07-20", "breakfast", casserole["id"])
    await plan(client, "2026-07-21", "breakfast", bread["id"])

    data = await grocery(client)
    by_name = {i["name"]: i for i in data["items"]}
    # "eggs" + "large eggs, at room temperature" -> one line, 12 total.
    assert by_name["eggs"]["amounts"] == ["12"]
    assert {u["recipe_title"] for u in by_name["eggs"]["uses"]} == {
        "Hashbrown Breakfast Casserole",
        "Banana Bread",
    }
    # "finely diced onion" + "onion" -> one line with both amounts.
    assert sorted(by_name["onion"]["amounts"]) == ["1", "¼ cup"]
    assert by_name["green bell pepper"]["amounts"] == ["½"]
    assert len(data["items"]) == 3


async def test_pantry_matches_descriptive_ingredient_names(client):
    recipe = await make_recipe(
        client,
        "Casserole",
        [{"name": "Kosher salt (or to taste)", "quantity": 0.5, "unit": "tsp"}],
    )
    await plan(client, "2026-07-20", "dinner", recipe["id"])
    await client.post("/api/pantry", json={"name": "kosher salt", "in_stock": True})

    data = await grocery(client)
    assert data["items"] == []
    assert [i["name"] for i in data["in_pantry"]] == ["Kosher salt"]


async def test_grocery_respects_date_range(client):
    recipe = await make_recipe(
        client, "Soup", [{"name": "Carrots", "quantity": 3, "unit": None}]
    )
    await plan(client, "2026-07-19", "dinner", recipe["id"])  # outside range

    data = await grocery(client)
    assert data["items"] == []


async def test_pantry_in_stock_items_are_set_aside_not_bought(client):
    recipe = await make_recipe(
        client,
        "Salad",
        [
            {"name": "Olive oil", "quantity": 2, "unit": "tbsp"},
            {"name": "Lettuce", "quantity": 1, "unit": None},
        ],
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    pantry = (
        await client.post("/api/pantry", json={"name": "olive oil", "in_stock": True})
    ).json()

    data = await grocery(client)
    assert [i["name"].lower() for i in data["items"]] == ["lettuce"]
    assert [i["name"].lower() for i in data["in_pantry"]] == ["olive oil"]
    assert data["pantry_restock"] == []
    # It is set aside, not forgotten: the amount the week's meals need travels
    # with it, which is the whole basis for overriding the default.
    stocked = data["in_pantry"][0]
    assert stocked["amounts"] == ["2 tbsp"]
    assert [u["recipe_title"] for u in stocked["uses"]] == ["Salad"]
    assert stocked["from_pantry"] is True
    assert stocked["pantry_item_id"] == pantry["id"]


async def test_stocked_staple_moves_to_the_buy_list_when_marked_out_of_stock(client):
    """"Buy anyway" on the grocery page marks the staple out of stock, which is
    what moves it across. The trip then finishes it off like any other item."""
    recipe = await make_recipe(
        client, "Salad", [{"name": "Olive oil", "quantity": 2, "unit": "tbsp"}]
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    pantry = (
        await client.post("/api/pantry", json={"name": "olive oil", "in_stock": True})
    ).json()

    resp = await client.put(f"/api/pantry/{pantry['id']}", json={"in_stock": False})
    assert resp.status_code == 200

    data = await grocery(client)
    assert [i["name"] for i in data["items"]] == ["Olive oil"]
    assert data["in_pantry"] == []
    assert data["items"][0]["amounts"] == ["2 tbsp"]

    # Ticking it off at the shop restocks it, and it goes back to being set aside.
    key = data["items"][0]["key"]
    await client.post("/api/grocery-list/mark", json={"key": key, "status": "bought"})
    await client.post("/api/grocery-list/new-trip")

    data = await grocery(client)
    assert data["items"] == []
    assert [i["name"] for i in data["in_pantry"]] == ["Olive oil"]


async def test_in_stock_staple_no_recipe_needs_is_not_listed(client):
    """The set-aside section is about this week's meals, not the whole pantry -
    otherwise it is just a second, longer copy of the pantry page."""
    await client.post("/api/pantry", json={"name": "Rice", "in_stock": True})

    data = await grocery(client)
    assert data["items"] == []
    assert data["in_pantry"] == []
    assert data["pantry_restock"] == []


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
    await client.post("/api/pantry", json={"name": "Coffee", "in_stock": False})
    data = await grocery(client)
    key = data["pantry_restock"][0]["key"]

    resp = await client.post(
        "/api/grocery-list/mark", json={"key": key, "status": "bought"}
    )
    assert resp.status_code == 204

    items = (await client.get("/api/pantry")).json()
    assert items[0]["in_stock"] is True

    # Restocked, but it stays on the list for the rest of the trip - see
    # test_checked_pantry_item_stays_on_the_list.
    data = await grocery(client)
    assert [i["name"] for i in data["pantry_restock"]] == ["Coffee"]
    assert data["pantry_restock"][0]["status"] == "bought"


async def test_checked_pantry_item_stays_on_the_list(client):
    """Checking a staple off restocks it, and an in-stock staple is normally
    dropped - so without care the row vanishes the moment it is ticked. In the
    shop that reads as the item never having been there: nothing to check
    against the basket, and no way to undo a misplaced tap."""
    pantry = (
        await client.post("/api/pantry", json={"name": "Coffee", "in_stock": False})
    ).json()
    key = (await grocery(client))["pantry_restock"][0]["key"]

    await client.post("/api/grocery-list/mark", json={"key": key, "status": "bought"})
    data = await grocery(client)
    assert [i["name"] for i in data["pantry_restock"]] == ["Coffee"]
    assert data["pantry_restock"][0]["status"] == "bought"

    # And unticking it is possible, because the row is still there to untick.
    await client.post("/api/grocery-list/mark", json={"key": key, "status": "to_buy"})
    data = await grocery(client)
    assert data["pantry_restock"][0]["status"] == "to_buy"
    assert (await client.get("/api/pantry")).json()[0]["in_stock"] is False
    assert data["pantry_restock"][0]["pantry_item_id"] == pantry["id"]


async def test_checked_pantry_ingredient_stays_in_the_buy_section(client):
    """Same rule for a staple a planned recipe calls for: it is listed under
    "to buy" rather than restock, and must survive being checked off there."""
    recipe = await make_recipe(
        client, "Salad", [{"name": "Olive oil", "quantity": 2, "unit": "tbsp"}]
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    await client.post("/api/pantry", json={"name": "olive oil", "in_stock": False})
    key = (await grocery(client))["items"][0]["key"]

    await client.post("/api/grocery-list/mark", json={"key": key, "status": "bought"})
    data = await grocery(client)
    assert [i["name"] for i in data["items"]] == ["Olive oil"]
    assert data["items"][0]["status"] == "bought"
    # Still one row, not one in each section - checking it off restocked it,
    # which is exactly the state that would otherwise move it to "in pantry".
    assert data["in_pantry"] == []
    assert data["pantry_restock"] == []


async def test_stocked_staple_is_set_aside_when_it_was_never_checked(client):
    """The exception is narrow: an ordinary in-stock staple stays off the buy
    list, and is only there at all because it was checked."""
    recipe = await make_recipe(
        client, "Salad", [{"name": "Olive oil", "quantity": 2, "unit": "tbsp"}]
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    await client.post("/api/pantry", json={"name": "olive oil", "in_stock": True})

    data = await grocery(client)
    assert data["items"] == []
    assert [i["name"] for i in data["in_pantry"]] == ["Olive oil"]
    assert data["pantry_restock"] == []


async def test_check_state_persists_across_regeneration(client):
    recipe = await make_recipe(
        client, "Soup", [{"name": "Carrots", "quantity": 3, "unit": None}]
    )
    await plan(client, "2026-07-20", "dinner", recipe["id"])

    data = await grocery(client)
    key = data["items"][0]["key"]
    await client.post("/api/grocery-list/mark", json={"key": key, "status": "bought"})

    data = await grocery(client)
    assert data["items"][0]["status"] == "bought"

    await client.post("/api/grocery-list/new-trip")
    data = await grocery(client)
    assert data["items"][0]["status"] == "to_buy"


async def test_a_line_can_be_marked_as_already_at_home(client):
    """The other thing a shopper says to a list. It is not a tick: the line
    is not struck through as bought, and it is not going to be paid for. It
    stays where it is, so it can be un-said."""
    recipe = await make_recipe(
        client, "Guacamole", [{"name": "Avocados", "quantity": 3, "unit": None}]
    )
    await plan(client, "2026-07-20", "dinner", recipe["id"])
    key = (await grocery(client))["items"][0]["key"]

    resp = await client.post("/api/grocery-list/mark", json={"key": key, "status": "have"})

    assert resp.status_code == 204
    data = await grocery(client)
    assert [i["name"] for i in data["items"]] == ["Avocados"]
    assert data["items"][0]["status"] == "have"


async def test_one_mark_replaces_another(client):
    """A line cannot be both in the trolley and left at home."""
    recipe = await make_recipe(client, "Soup", [{"name": "Carrots", "quantity": 3, "unit": None}])
    await plan(client, "2026-07-20", "dinner", recipe["id"])
    key = (await grocery(client))["items"][0]["key"]

    await client.post("/api/grocery-list/mark", json={"key": key, "status": "have"})
    await client.post("/api/grocery-list/mark", json={"key": key, "status": "bought"})

    assert (await grocery(client))["items"][0]["status"] == "bought"


async def test_a_new_trip_clears_at_home_marks_as_well_as_ticks(client):
    """"Have it" is only true of the week it was said in. The avocados on the
    counter are gone by the next list, so the mark is not allowed to outlive
    the ticks it sits beside."""
    recipe = await make_recipe(
        client,
        "Guacamole",
        [
            {"name": "Avocados", "quantity": 3, "unit": None},
            {"name": "Limes", "quantity": 2, "unit": None},
        ],
    )
    await plan(client, "2026-07-20", "dinner", recipe["id"])
    avocado, lime = [i["key"] for i in (await grocery(client))["items"]]
    await client.post("/api/grocery-list/mark", json={"key": avocado, "status": "have"})
    await client.post("/api/grocery-list/mark", json={"key": lime, "status": "bought"})

    await client.post("/api/grocery-list/new-trip")

    assert {i["status"] for i in (await grocery(client))["items"]} == {"to_buy"}


async def test_saying_a_staple_is_at_home_restocks_it(client):
    """Having enough olive oil and the pantry saying it is in stock are the
    same fact, so the mark tells the pantry rather than contradicting it."""
    recipe = await make_recipe(
        client, "Salad", [{"name": "Olive oil", "quantity": 2, "unit": "tbsp"}]
    )
    await plan(client, "2026-07-20", "lunch", recipe["id"])
    pantry = (
        await client.post("/api/pantry", json={"name": "olive oil", "in_stock": False})
    ).json()
    key = (await grocery(client))["items"][0]["key"]

    await client.post("/api/grocery-list/mark", json={"key": key, "status": "have"})

    stocked = {p["id"]: p["in_stock"] for p in (await client.get("/api/pantry")).json()}
    assert stocked[pantry["id"]] is True
    # And, like a tick, it stays on the list until the trip is over rather
    # than vanishing under the shopper's finger.
    data = await grocery(client)
    assert [i["name"] for i in data["items"]] == ["Olive oil"]
    assert data["items"][0]["status"] == "have"


async def test_a_mark_needs_a_status_the_list_knows(client):
    resp = await client.post("/api/grocery-list/mark", json={"key": "carrot", "status": "lost"})

    assert resp.status_code == 422


async def test_pantry_duplicate_name_rejected(client):
    assert (
        await client.post("/api/pantry", json={"name": "Rice"})
    ).status_code == 201
    assert (
        await client.post("/api/pantry", json={"name": "  rice "})
    ).status_code == 409
