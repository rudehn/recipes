"""A meal that repeats is planned once and read as every day it falls on.

Repeats are expanded when the plan is read, so the list, the grocery list,
the cost and the "cooked" ordering must all see the same days.
"""

from test_meal_plan_and_grocery import grocery, make_recipe
from test_plan_reads import plan


async def oats(client, ingredients=()):
    return (await make_recipe(client, "Oats", list(ingredients)))["id"]


async def start_repeat(client, entry_id, weekdays, today):
    return await client.post(
        f"/api/meal-plan/{entry_id}/repeat", json={"weekdays": weekdays, "today": today}
    )


async def listed(client, start, end):
    resp = await client.get("/api/meal-plan", params={"start": start, "end": end})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def planned_dates(client, start, end):
    return [m["plan_date"] for m in await listed(client, start, end)]


async def test_a_repeat_fills_its_weekdays_in_every_week(client):
    entry = await plan(client, "2026-10-20", "breakfast", await oats(client))  # a Tuesday
    resp = await start_repeat(client, entry["entry_id"], [1, 3], today="2026-10-19")
    assert resp.status_code == 201, resp.text
    assert resp.json()["weekdays"] == [1, 3]
    assert resp.json()["starts_on"] == "2026-10-20"
    assert resp.json()["ends_on"] is None

    days = await planned_dates(client, "2026-10-19", "2026-11-01")
    assert days == ["2026-10-20", "2026-10-22", "2026-10-27", "2026-10-29"]


async def test_a_repeated_meal_is_named_by_its_day_and_knows_its_repeat(client):
    entry = await plan(client, "2026-10-20", "breakfast", await oats(client))
    repeat = (await start_repeat(client, entry["entry_id"], [1], "2026-10-19")).json()
    meals = await listed(client, "2026-10-19", "2026-10-25")
    assert [(m["key"], m["entry_id"], m["repeat"]) for m in meals] == [
        (f"r{repeat['id']}-2026-10-20", None, repeat)
    ]
    # The entry it was made from is gone: the repeat is the only source.
    assert (await client.delete(f"/api/meal-plan/{entry['entry_id']}")).status_code == 404


async def test_a_repeat_starts_on_its_day_and_never_before(client):
    entry = await plan(client, "2026-10-21", "dinner", await oats(client))  # a Wednesday
    await start_repeat(client, entry["entry_id"], [0, 1, 2, 3, 4, 5, 6], "2026-10-21")
    days = await planned_dates(client, "2026-10-12", "2026-10-25")
    assert days[0] == "2026-10-21"
    assert len(days) == 5


async def test_a_range_starting_mid_repeat_sees_only_its_own_days(client):
    entry = await plan(client, "2026-10-13", "dinner", await oats(client))  # a Tuesday
    await start_repeat(client, entry["entry_id"], [1, 3], "2026-10-13")
    # Starts on the Thursday after: Tuesday's day is outside the range.
    days = await planned_dates(client, "2026-10-15", "2026-10-21")
    assert days == ["2026-10-15", "2026-10-20"]


async def test_repeats_come_before_one_offs_within_a_day(client):
    recipe = await oats(client)
    one_off = await plan(client, "2026-10-20", "dinner", recipe)
    entry = await plan(client, "2026-10-13", "dinner", recipe)
    await start_repeat(client, entry["entry_id"], [1], "2026-10-13")
    meals = await listed(client, "2026-10-20", "2026-10-20")
    assert [m["entry_id"] for m in meals] == [None, one_off["entry_id"]]


async def test_a_repeat_cannot_start_on_a_past_day(client):
    entry = await plan(client, "2026-10-20", "dinner", await oats(client))
    resp = await start_repeat(client, entry["entry_id"], [0], today="2026-10-21")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "That day has passed."
    assert len(await listed(client, "2026-10-19", "2026-10-25")) == 1


async def test_a_repeat_needs_valid_weekdays_and_a_real_meal(client):
    entry = await plan(client, "2026-10-20", "dinner", await oats(client))
    for weekdays in ([], [7], [-1]):
        resp = await start_repeat(client, entry["entry_id"], weekdays, "2026-10-19")
        assert resp.status_code == 422
    assert (await start_repeat(client, 9999, [0], "2026-10-19")).status_code == 404


async def test_repeated_meals_are_on_the_grocery_list_and_cost_and_cooked_sort(client):
    recipe = await oats(client, [{"name": "rolled oats", "quantity": 1, "unit": "cup"}])
    other = (await make_recipe(client, "Zucchini", []))["id"]
    await plan(client, "2026-10-19", "dinner", other)  # Monday, once
    entry = await plan(client, "2026-10-19", "breakfast", recipe)
    await start_repeat(client, entry["entry_id"], [0, 1, 2, 3, 4], "2026-10-19")

    items = (await grocery(client, "2026-10-19", "2026-10-25"))["items"]
    (oats_line,) = [i for i in items if "oats" in i["name"]]
    assert oats_line["amounts"] == ["5 cups"]
    assert len(oats_line["uses"]) == 5

    cost = await client.get(
        "/api/meal-plan/cost", params={"start": "2026-10-19", "end": "2026-10-25"}
    )
    assert cost.status_code == 200

    resp = await client.get("/api/recipes", params={"sort": "cooked", "today": "2026-10-23"})
    titles = [r["title"] for r in resp.json()["items"]]
    assert titles.index("Oats") < titles.index("Zucchini")


async def test_deleting_a_recipe_takes_its_repeats_with_it(client):
    recipe = await oats(client, [{"name": "rolled oats", "quantity": 1, "unit": "cup"}])
    entry = await plan(client, "2026-10-19", "breakfast", recipe)
    await start_repeat(client, entry["entry_id"], [0, 1], "2026-10-19")
    keep = (await make_recipe(client, "Toast", []))["id"]
    await plan(client, "2026-10-20", "lunch", recipe)

    assert (await client.delete(f"/api/recipes/{recipe}")).status_code == 204

    assert await listed(client, "2026-10-19", "2026-11-30") == []
    assert (await grocery(client, "2026-10-19", "2026-10-25"))["items"] == []
    resp = await client.get("/api/recipes", params={"sort": "cooked", "today": "2026-11-30"})
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()["items"]] == [keep]
