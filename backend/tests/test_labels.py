"""Labels mark planned meals; a repeat carries its labels to every day."""

from sqlalchemy import func, select
from test_meal_plan_and_grocery import make_recipe
from test_repeats import (
    TODAY,
    change_day,
    change_from,
    day_url,
    listed,
    ok,
    remove,
    repeat_oats,
    start_repeat,
    stop,
)

from app.db import session_factory
from app.models import meal_plan_entry_labels, meal_repeat_labels


async def label(client, name):
    resp = await client.post("/api/labels", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def plan_with(client, plan_date, recipe_id, label_ids, meal="dinner", **extra):
    resp = await client.post(
        "/api/meal-plan",
        json={
            "plan_date": plan_date,
            "meal": meal,
            "recipe_id": recipe_id,
            "label_ids": label_ids,
            **extra,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def names(meal):
    return [x["name"] for x in meal["labels"]]


async def piece(client, day):
    """The id of the row holding the repeat on `day`, which a split changes."""
    (meal,) = await listed(client, day, day)
    return meal["repeat"]["id"]


async def usage(client):
    return {x["name"]: x["meals"] for x in (await client.get("/api/labels")).json()}


async def link_rows():
    async with session_factory() as session:
        entries = await session.scalar(select(func.count()).select_from(meal_plan_entry_labels))
        repeats = await session.scalar(select(func.count()).select_from(meal_repeat_labels))
    return entries, repeats


async def test_a_label_is_made_once_whatever_its_case(client):
    resp = await client.post("/api/labels", json={"name": " Dad "})
    assert resp.json()["name"] == "Dad"
    clash = await client.post("/api/labels", json={"name": "dad"})
    assert clash.status_code == 409
    assert clash.json()["detail"] == "There is already a label called dad."
    for name in ("", "   ", "x" * 41):
        assert (await client.post("/api/labels", json={"name": name})).status_code == 422


async def test_renaming_a_label_may_change_its_case_but_not_clash(client):
    dad = await label(client, "dad")
    await label(client, "Kids")
    resp = await client.patch(f"/api/labels/{dad}", json={"name": "Dad"})
    assert (resp.status_code, resp.json()["name"]) == (200, "Dad")
    assert (await client.patch(f"/api/labels/{dad}", json={"name": "KIDS"})).status_code == 409
    assert (await client.patch("/api/labels/999", json={"name": "x"})).status_code == 404
    assert [x["name"] for x in (await client.get("/api/labels")).json()] == ["Dad", "Kids"]


async def test_a_meal_is_planned_with_labels_and_lists_them(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    kids, dad = await label(client, "Kids"), await label(client, "Dad")
    entry = await plan_with(client, "2026-10-26", recipe, [kids, dad])
    assert names(entry) == ["Dad", "Kids"]
    (meal,) = await listed(client, "2026-10-26", "2026-10-26")
    assert names(meal) == ["Dad", "Kids"]
    bare = await plan_with(client, "2026-10-27", recipe, [])
    assert bare["labels"] == []
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": "2026-10-28", "meal": "dinner", "recipe_id": recipe, "label_ids": [999]},
    )
    assert resp.status_code == 422


async def test_patch_moves_a_one_off_and_changes_only_what_is_sent(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad = await label(client, "Dad")
    entry = await plan_with(client, "2026-10-26", recipe, [dad], servings=3)
    url = f"/api/meal-plan/{entry['entry_id']}"

    moved = (await client.patch(url, json={"plan_date": "2026-10-27", "meal": "lunch"})).json()
    assert (moved["plan_date"], moved["meal"], moved["servings"]) == ("2026-10-27", "lunch", 3)
    assert names(moved) == ["Dad"]

    cleared = (await client.patch(url, json={"label_ids": []})).json()
    assert (cleared["servings"], cleared["labels"]) == (3, [])

    reset = (await client.patch(url, json={"servings": None})).json()
    assert reset["servings"] is None

    assert (await client.patch(url, json={"label_ids": [999]})).status_code == 422
    assert (await client.patch(url, json={"plan_date": None})).status_code == 422
    assert (await client.patch(url, json={"label_ids": None})).status_code == 422


async def test_a_repeated_days_meal_moves_through_its_repeat(client):
    rid = await repeat_oats(client)
    await ok(await change_day(client, rid, "2026-10-27", servings=2))
    (meal,) = await listed(client, "2026-10-27", "2026-10-27")
    resp = await client.patch(f"/api/meal-plan/{meal['entry_id']}", json={"meal": "lunch"})
    assert resp.status_code == 422


async def test_label_usage_counts_one_offs_and_repeats(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad, kids = await label(client, "Dad"), await label(client, "Kids")
    await plan_with(client, "2026-10-26", recipe, [dad])
    await plan_with(client, "2026-10-27", recipe, [dad, kids])
    entry = await plan_with(client, "2026-10-28", recipe, [dad])
    await start_repeat(client, entry["entry_id"], [0, 2], TODAY)
    # A split keeps it one repeat, and a day of it with the same label adds nothing.
    rid = await piece(client, "2026-10-28")
    await ok(await change_from(client, rid, "2026-11-04", servings=2))
    await ok(await change_day(client, await piece(client, "2026-11-11"), "2026-11-11", servings=4))
    assert await usage(client) == {"Dad": 3, "Kids": 1}
    # A label on a day of its own is one more meal.
    day = "2026-11-18"
    await ok(await change_day(client, await piece(client, day), day, label_ids=[kids]))
    assert await usage(client) == {"Dad": 3, "Kids": 2}
    await label(client, "Guests")
    assert (await usage(client))["Guests"] == 0


async def test_deleting_a_label_takes_it_off_every_meal(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad, kids = await label(client, "Dad"), await label(client, "Kids")
    one = await plan_with(client, "2026-10-26", recipe, [dad, kids])
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-28", label_ids=[dad, kids]))
    await ok(await change_day(client, await piece(client, "2026-11-04"), "2026-11-04", servings=2))

    assert (await client.delete(f"/api/labels/{dad}")).status_code == 204
    assert (await client.delete(f"/api/labels/{dad}")).status_code == 404

    meals = await listed(client, "2026-10-26", "2026-11-08")
    assert {tuple(names(m)) for m in meals if m["entry_id"] != one["entry_id"]
            and m["plan_date"] >= "2026-10-28"} == {("Kids",)}
    assert names(next(m for m in meals if m["entry_id"] == one["entry_id"])) == ["Kids"]
    # One link for the one-off and one for the day's own row; one for the repeat.
    assert await link_rows() == (2, 1)
    assert await usage(client) == {"Kids": 2}


async def test_a_repeat_carries_its_labels_to_every_day_and_into_overrides(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad = await label(client, "Dad")
    entry = await plan_with(client, "2026-10-26", recipe, [dad], meal="breakfast")
    resp = await start_repeat(client, entry["entry_id"], [0, 1, 2], TODAY)
    rid = resp.json()["id"]
    assert (await link_rows()) == (0, 1)
    meals = await listed(client, "2026-10-26", "2026-11-01")
    assert [names(m) for m in meals] == [["Dad"]] * 3

    # A day's own change keeps the repeat's labels.
    await ok(await change_day(client, rid, "2026-10-27", servings=2))
    meals = await listed(client, "2026-10-27", "2026-10-27")
    assert names(meals[0]) == ["Dad"]

    # Moving it away and stopping after it keep them too.
    moved = await client.post(
        f"{day_url(rid, '2026-10-28')}/move", json={"plan_date": "2026-10-30", "meal": "lunch"}
    )
    assert names(moved.json()) == ["Dad"]
    stopped = await ok(await stop(client, rid, "2026-11-02"), 200)
    assert names(stopped.json()) == ["Dad"]

    # A change from a day on carries them into the piece it splits off.
    rid2 = await repeat_oats(client, starts_on="2026-11-09")
    first = await label(client, "Kids")
    await ok(await change_from(client, rid2, "2026-11-09", label_ids=[first]))
    await ok(await change_from(client, rid2, "2026-11-12", servings=5))
    meals = await listed(client, "2026-11-09", "2026-11-15")
    assert {tuple(names(m)) for m in meals} == {("Kids",)}


async def test_just_this_day_labels_leave_the_rest_of_the_repeat_alone(client):
    rid = await repeat_oats(client)
    kids = await label(client, "Kids")
    await ok(await change_day(client, rid, "2026-10-28", label_ids=[kids]))
    meals = await listed(client, "2026-10-26", "2026-10-30")
    assert {m["plan_date"]: names(m) for m in meals} == {
        "2026-10-26": [], "2026-10-27": [], "2026-10-28": ["Kids"],
        "2026-10-29": [], "2026-10-30": [],
    }
    # From a day on wins over the day's own labels.
    await ok(await change_from(client, rid, "2026-10-27", servings=2))
    meals = await listed(client, "2026-10-28", "2026-10-28")
    assert names(meals[0]) == []
    assert await link_rows() == (0, 0)


async def test_a_from_this_day_on_label_change_reaches_later_pieces(client):
    rid = await repeat_oats(client)
    dad, kids = await label(client, "Dad"), await label(client, "Kids")
    await ok(await change_from(client, rid, "2026-10-30", label_ids=[dad], servings=3))
    await ok(await change_from(client, rid, "2026-10-28", label_ids=[kids]))
    meals = await listed(client, "2026-10-26", "2026-11-03")
    assert {m["plan_date"]: (names(m), m["servings"]) for m in meals} == {
        "2026-10-26": ([], None), "2026-10-27": ([], None),
        "2026-10-28": (["Kids"], None), "2026-10-29": (["Kids"], None),
        "2026-10-30": (["Kids"], 3), "2026-10-31": (["Kids"], 3),
        "2026-11-01": (["Kids"], 3), "2026-11-02": (["Kids"], 3),
        "2026-11-03": (["Kids"], 3),
    }
    # Servings alone leave labels as they were.
    await ok(await change_from(client, await piece(client, "2026-10-30"), "2026-10-30", servings=4))
    meals = await listed(client, "2026-10-30", "2026-10-30")
    assert (names(meals[0]), meals[0]["servings"]) == (["Kids"], 4)


async def test_removing_meals_removes_their_label_links(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad = await label(client, "Dad")
    one = await plan_with(client, "2026-10-20", recipe, [dad])
    assert (await client.delete(f"/api/meal-plan/{one['entry_id']}")).status_code == 204
    assert await link_rows() == (0, 0)

    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-28", label_ids=[dad]))
    later = await piece(client, "2026-11-04")
    await ok(await change_day(client, later, "2026-11-04", servings=2))
    await ok(await change_day(client, later, "2026-11-05", label_ids=[dad]))
    assert await link_rows() == (2, 1)
    await ok(await remove(client, later, "2026-11-05", "day"))
    assert await link_rows() == (1, 1)
    await ok(await remove(client, later, "2026-10-28", "from"))
    assert await link_rows() == (0, 0)


async def test_a_change_from_a_day_on_forgets_day_labels(client):
    rid = await repeat_oats(client)
    dad = await label(client, "Dad")
    await ok(await change_day(client, rid, "2026-10-28", label_ids=[dad]))
    assert await link_rows() == (1, 0)
    await ok(await change_from(client, rid, "2026-10-27", servings=2))
    assert await link_rows() == (0, 0)


async def test_label_usage_forgets_the_meals_of_a_deleted_recipe(client):
    # Review Focus 2: no orphan link rows answer after the recipe goes.
    recipe = (await make_recipe(client, "Oats", []))["id"]
    keep = (await make_recipe(client, "Toast", []))["id"]
    dad = await label(client, "Dad")
    await plan_with(client, "2026-10-26", recipe, [dad])
    entry = await plan_with(client, "2026-10-27", recipe, [dad])
    await start_repeat(client, entry["entry_id"], [0, 1], TODAY)
    rid = (await listed(client, "2026-10-27", "2026-10-27"))[0]["repeat"]["id"]
    await ok(await change_day(client, rid, "2026-11-03", servings=2))
    await ok(await change_from(client, rid, "2026-11-10", label_ids=[dad]))
    await plan_with(client, "2026-10-28", keep, [dad])
    assert await usage(client) == {"Dad": 3}

    assert (await client.delete(f"/api/recipes/{recipe}")).status_code == 204

    assert await usage(client) == {"Dad": 1}
    assert await link_rows() == (1, 0)
    assert len(await listed(client, "2026-10-26", "2026-12-31")) == 1


async def test_a_change_to_a_repeat_needs_something_to_change(client):
    rid = await repeat_oats(client)
    for scope in ("day", "from"):
        resp = await client.patch(
            day_url(rid, "2026-10-28"), json={"scope": scope, "today": TODAY}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Nothing to change."
    unknown = await change_day(client, rid, "2026-10-28", label_ids=[999])
    assert unknown.status_code == 422
    assert (await change_from(client, rid, "2026-10-28", weekdays=None)).status_code == 422


async def test_copying_a_week_keeps_the_labels(client):
    recipe = (await make_recipe(client, "Oats", []))["id"]
    dad = await label(client, "Dad")
    await plan_with(client, "2026-10-26", recipe, [dad])
    resp = await client.post(
        "/api/meal-plan/copy-week", json={"from_start": "2026-10-26", "to_start": "2026-11-02"}
    )
    assert [names(m) for m in resp.json()] == [["Dad"]]
