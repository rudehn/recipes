"""A meal that repeats is planned once and read as every day it falls on.

Repeats are expanded when the plan is read, so the list, the grocery list,
the cost and the "cooked" ordering must all see the same days.
"""

from datetime import date

from sqlalchemy import select
from test_meal_plan_and_grocery import grocery, make_recipe
from test_plan_reads import plan

from app.db import session_factory
from app.models import MealPlanEntry, MealRepeat, MealRepeatSkip
from app.services.plan import last_planned, planned_meals


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


# Changing a repeat. The owner's today is a Wednesday; the repeat under change
# is oats for breakfast every day from the Monday after.

TODAY = "2026-10-21"
EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]


async def repeat_oats(client, starts_on="2026-10-26", weekdays=EVERY_DAY, today=TODAY):
    entry = await plan(client, starts_on, "breakfast", await oats(client))
    resp = await start_repeat(client, entry["entry_id"], weekdays, today)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def day_url(repeat_id, day):
    return f"/api/meal-plan/repeats/{repeat_id}/days/{day}"


async def change_day(client, repeat_id, day, today=TODAY, **fields):
    return await client.patch(
        day_url(repeat_id, day), json={"scope": "day", "today": today, **fields}
    )


async def change_from(client, repeat_id, day, today=TODAY, **fields):
    return await client.patch(
        day_url(repeat_id, day), json={"scope": "from", "today": today, **fields}
    )


async def remove(client, repeat_id, day, scope, today=TODAY):
    return await client.delete(
        day_url(repeat_id, day), params={"scope": scope, "today": today}
    )


async def stop(client, repeat_id, day, today=TODAY):
    return await client.post(f"{day_url(repeat_id, day)}/stop", json={"today": today})


async def move(client, repeat_id, day, plan_date, meal):
    return await client.post(
        f"{day_url(repeat_id, day)}/move", json={"plan_date": plan_date, "meal": meal}
    )


async def servings_by_day(client, start, end):
    return [(m["plan_date"], m["servings"]) for m in await listed(client, start, end)]


async def ok(resp, status=204):
    assert resp.status_code == status, resp.text
    return resp


async def test_the_owners_example_mon_wed_fri_from_next_wednesday(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-28", weekdays=[0, 2, 4], today=TODAY))
    assert await planned_dates(client, "2026-10-26", "2026-11-01") == [
        "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-30"]
    assert await planned_dates(client, "2026-11-02", "2026-11-08") == [
        "2026-11-02", "2026-11-04", "2026-11-06"]


async def test_just_this_day_removal_leaves_the_rest(client):
    rid = await repeat_oats(client)
    await ok(await remove(client, rid, "2026-10-28", "day"))
    assert await planned_dates(client, "2026-10-26", "2026-10-30") == [
        "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30"]
    # The week after is whole: only that one date changed.
    assert len(await planned_dates(client, "2026-11-02", "2026-11-08")) == 7


async def test_just_this_day_servings_override_only_that_day(client):
    rid = await repeat_oats(client)
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    meals = await listed(client, "2026-10-27", "2026-10-29")
    assert [m["servings"] for m in meals] == [None, 3, None]
    tue, wed, thu = meals
    assert wed["entry_id"] is not None
    assert wed["key"] == f"e{wed['entry_id']}"
    assert wed["repeat"]["id"] == rid
    assert (tue["entry_id"], thu["entry_id"]) == (None, None)

    # A second change edits the same day's meal rather than adding one, and
    # a change that names nothing is refused.
    await ok(await change_day(client, rid, "2026-10-28", servings=4))
    await ok(await change_day(client, rid, "2026-10-28"), 422)
    (wed,) = await listed(client, "2026-10-28", "2026-10-28")
    assert wed["servings"] == 4
    # Null is the recipe's own count, which is a change of its own.
    await ok(await change_day(client, rid, "2026-10-28", servings=None))
    (wed,) = await listed(client, "2026-10-28", "2026-10-28")
    assert (wed["servings"], wed["repeat"]["id"]) == (None, rid)


async def test_from_this_day_on_replaces_earlier_one_day_changes(client):
    rid = await repeat_oats(client)
    await ok(await remove(client, rid, "2026-10-29", "day"))
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    await ok(await change_from(client, rid, "2026-10-26", servings=2))
    meals = await listed(client, "2026-10-26", "2026-11-01")
    assert [(m["plan_date"], m["servings"]) for m in meals] == [
        (f"2026-10-{d}", 2) for d in range(26, 32)] + [("2026-11-01", 2)]
    assert all(m["entry_id"] is None for m in meals)


async def test_from_this_day_on_keeps_the_one_day_changes_before_it(client):
    rid = await repeat_oats(client)
    await ok(await remove(client, rid, "2026-10-27", "day"))
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    await ok(await change_day(client, rid, "2026-10-30", servings=5))
    await ok(await change_from(client, rid, "2026-10-29", servings=2))
    assert await servings_by_day(client, "2026-10-26", "2026-11-01") == [
        ("2026-10-26", None), ("2026-10-28", 3), ("2026-10-29", 2), ("2026-10-30", 2),
        ("2026-10-31", 2), ("2026-11-01", 2)]


async def test_from_its_first_day_a_repeat_changes_in_place(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-26", weekdays=[0]))
    meals = await listed(client, "2026-10-26", "2026-11-08")
    assert [(m["plan_date"], m["repeat"]["id"]) for m in meals] == [
        ("2026-10-26", rid), ("2026-11-02", rid)]


async def test_from_this_day_on_changes_only_what_it_is_given(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-26", servings=3))
    # Days only: the servings carry over to the new part.
    await ok(await change_from(client, rid, "2026-10-28", weekdays=[2, 4]))
    assert await servings_by_day(client, "2026-10-26", "2026-11-01") == [
        ("2026-10-26", 3), ("2026-10-27", 3), ("2026-10-28", 3), ("2026-10-30", 3)]
    (wed, _) = await listed(client, "2026-10-28", "2026-10-30")
    # Null servings go back to the recipe's own count; the days stay.
    await ok(await change_from(client, wed["repeat"]["id"], "2026-10-30", servings=None))
    assert await servings_by_day(client, "2026-10-28", "2026-11-08") == [
        ("2026-10-28", 3), ("2026-10-30", None), ("2026-11-04", None), ("2026-11-06", None)]


async def test_a_moved_day_stays_where_it_was_put(client):
    rid = await repeat_oats(client)
    await ok(await change_day(client, rid, "2026-10-29", servings=4))
    moved = await ok(await move(client, rid, "2026-10-29", "2026-10-31", "lunch"), 200)
    assert moved.json()["repeat"] is None
    assert (moved.json()["plan_date"], moved.json()["meal"]) == ("2026-10-31", "lunch")
    assert "2026-10-29" not in await planned_dates(client, "2026-10-26", "2026-11-01")

    await ok(await change_from(client, rid, "2026-10-26", servings=2))
    meals = await listed(client, "2026-10-29", "2026-10-31")
    by_place = {(m["plan_date"], m["meal"]): m for m in meals}
    lunch = by_place[("2026-10-31", "lunch")]
    assert (lunch["entry_id"], lunch["servings"], lunch["repeat"]) == (
        moved.json()["entry_id"], 4, None)
    thu = by_place[("2026-10-29", "breakfast")]
    assert (thu["servings"], thu["repeat"]["id"]) == (2, rid)


async def test_a_day_moves_with_the_repeats_servings(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-26", servings=2))
    moved = await ok(await move(client, rid, "2026-10-27", "2026-10-27", "dinner"), 200)
    assert (moved.json()["servings"], moved.json()["repeat"]) == (2, None)
    meals = await listed(client, "2026-10-27", "2026-10-27")
    assert [(m["meal"], m["repeat"] is None) for m in meals] == [("dinner", True)]


async def test_two_splits_on_one_repeat(client):
    # Review Focus 3: a change from Friday on, then a change from the
    # Wednesday before it. The Wednesday change covers both parts.
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-30", servings=3))
    await ok(await change_from(client, rid, "2026-10-28", weekdays=[0, 2, 4]))
    assert await servings_by_day(client, "2026-10-26", "2026-11-01") == [
        ("2026-10-26", None), ("2026-10-27", None), ("2026-10-28", None), ("2026-10-30", 3)]
    assert await servings_by_day(client, "2026-11-02", "2026-11-08") == [
        ("2026-11-02", 3), ("2026-11-04", 3), ("2026-11-06", 3)]
    # Nothing before Wednesday moved: Monday and Tuesday are the first part's,
    # which still begins on its own day.
    mon, tue = await listed(client, "2026-10-26", "2026-10-27")
    assert mon["repeat"] == tue["repeat"]
    assert (mon["repeat"]["id"], mon["repeat"]["starts_on"], mon["repeat"]["ends_on"]) == (
        rid, "2026-10-26", "2026-10-27")


async def test_removing_from_a_day_takes_the_later_parts_with_it(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-30", servings=3))
    await ok(await remove(client, rid, "2026-10-28", "from"))
    assert await planned_dates(client, "2026-10-26", "2026-11-30") == [
        "2026-10-26", "2026-10-27"]


async def test_from_this_day_on_is_refused_for_a_past_day(client):
    rid = await repeat_oats(client, starts_on="2026-10-19", today="2026-10-19")
    before = await listed(client, "2026-10-19", "2026-10-25")

    resp = await change_from(client, rid, "2026-10-20", servings=2, today="2026-10-21")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "That day has passed."
    assert (await remove(client, rid, "2026-10-20", "from", today="2026-10-21")).status_code == 422
    assert (await stop(client, rid, "2026-10-20", today="2026-10-21")).status_code == 422
    assert await listed(client, "2026-10-19", "2026-10-25") == before

    # Today itself is not past.
    await ok(await change_from(client, rid, "2026-10-21", servings=2, today="2026-10-21"))


async def test_just_this_day_still_works_on_a_past_day(client):
    rid = await repeat_oats(client, starts_on="2026-10-19", today="2026-10-19")
    await ok(await change_day(client, rid, "2026-10-19", servings=3, today="2026-10-21"))
    await ok(await remove(client, rid, "2026-10-20", "day", today="2026-10-21"))
    moved = await move(client, rid, "2026-10-21", "2026-10-20", "dinner")
    await ok(moved, 200)
    assert await servings_by_day(client, "2026-10-19", "2026-10-22") == [
        ("2026-10-19", 3), ("2026-10-20", None), ("2026-10-22", None)]
    assert [m["meal"] for m in await listed(client, "2026-10-20", "2026-10-20")] == ["dinner"]


async def test_stop_after_keeps_the_day_as_a_one_off(client):
    rid = await repeat_oats(client)
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    await ok(await change_from(client, rid, "2026-10-30", servings=2))

    resp = await ok(await stop(client, rid, "2026-10-28"), 200)
    kept = resp.json()
    assert (kept["plan_date"], kept["meal"], kept["servings"], kept["repeat"]) == (
        "2026-10-28", "breakfast", 3, None)

    meals = await listed(client, "2026-10-26", "2026-11-30")
    assert [(m["plan_date"], m["repeat"] and m["repeat"]["id"]) for m in meals] == [
        ("2026-10-26", rid), ("2026-10-27", rid), ("2026-10-28", None)]
    assert meals[2]["entry_id"] == kept["entry_id"]


async def test_stopping_on_a_plain_day_keeps_the_repeats_servings(client):
    rid = await repeat_oats(client)
    await ok(await change_from(client, rid, "2026-10-26", servings=2))
    kept = (await ok(await stop(client, rid, "2026-10-27"), 200)).json()
    assert (kept["servings"], kept["repeat"]) == (2, None)
    assert await planned_dates(client, "2026-10-26", "2026-11-30") == [
        "2026-10-26", "2026-10-27"]


async def test_removing_from_the_first_day_deletes_the_repeat(client):
    rid = await repeat_oats(client)
    await ok(await remove(client, rid, "2026-10-26", "from"))
    assert await listed(client, "2026-10-19", "2026-11-30") == []
    # The repeat is gone, not just empty.
    assert (await change_day(client, rid, "2026-10-27", servings=2)).status_code == 404
    async with session_factory() as session:
        assert (await session.execute(select(MealRepeat))).scalars().all() == []


async def test_stopping_on_the_first_day_leaves_only_that_day(client):
    rid = await repeat_oats(client)
    kept = (await ok(await stop(client, rid, "2026-10-26"), 200)).json()
    meals = await listed(client, "2026-10-19", "2026-11-30")
    assert [(m["plan_date"], m["entry_id"], m["repeat"]) for m in meals] == [
        ("2026-10-26", kept["entry_id"], None)]


async def test_a_day_the_repeat_does_not_have_is_404(client):
    rid = await repeat_oats(client, weekdays=[0, 2])  # Mondays and Wednesdays
    await ok(await remove(client, rid, "2026-11-02", "day"))
    await ok(await remove(client, rid, "2026-11-09", "from"))
    missing = [
        "2026-10-19",  # a Monday before it starts
        "2026-10-27",  # a Tuesday
        "2026-11-02",  # removed for just that day
        "2026-11-09",  # after it ends
    ]
    for day in missing:
        for resp in (
            await change_day(client, rid, day, servings=2),
            await change_from(client, rid, day, servings=2),
            await remove(client, rid, day, "day"),
            await remove(client, rid, day, "from"),
            await stop(client, rid, day),
            await move(client, rid, day, "2026-10-31", "lunch"),
        ):
            assert resp.status_code == 404, (day, resp.request.method, resp.text)
    assert (await change_day(client, 9999, "2026-10-26", servings=2)).status_code == 404
    assert await planned_dates(client, "2026-10-19", "2026-11-15") == [
        "2026-10-26", "2026-10-28", "2026-11-04"]


async def test_days_change_only_from_a_day_on(client):
    rid = await repeat_oats(client)
    resp = await change_day(client, rid, "2026-10-28", weekdays=[0])
    assert resp.status_code == 422
    for weekdays in ([], [7]):
        resp = await change_from(client, rid, "2026-10-28", weekdays=weekdays)
        assert resp.status_code == 422
    assert (await change_from(client, rid, "2026-10-28", servings=0)).status_code == 422
    assert (await remove(client, rid, "2026-10-28", "week")).status_code == 422
    assert len(await planned_dates(client, "2026-10-26", "2026-11-01")) == 7


async def test_a_repeat_ends_on_its_last_day_included(client):
    rid = await repeat_oats(client)
    await ok(await remove(client, rid, "2026-11-03", "from"))  # ends Mon 11-02
    await ok(await change_from(client, rid, "2026-10-30", servings=2))  # first part ends Thu
    meals = await listed(client, "2026-10-26", "2026-11-30")
    assert [m["plan_date"] for m in meals] == [
        "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29",
        "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]
    thu, fri = meals[3], meals[4]
    assert (thu["repeat"]["id"], thu["repeat"]["ends_on"], thu["servings"]) == (
        rid, "2026-10-29", None)
    assert (fri["repeat"]["starts_on"], fri["repeat"]["ends_on"], fri["servings"]) == (
        "2026-10-30", "2026-11-02", 2)

    recipe = thu["recipe"]["id"]
    async with session_factory() as session:
        last_day = await planned_meals(session, date(2026, 11, 2), date(2026, 11, 2))
        assert [m.plan_date for m in last_day] == [date(2026, 11, 2)]
        assert (await last_planned(session, date(2026, 12, 1)))[recipe] == date(2026, 11, 2)
        assert (await last_planned(session, date(2026, 11, 2)))[recipe] == date(2026, 11, 2)


async def test_a_changed_day_cannot_start_a_repeat_of_its_own(client):
    rid = await repeat_oats(client)
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    (wed,) = await listed(client, "2026-10-28", "2026-10-28")
    resp = await start_repeat(client, wed["entry_id"], [2], TODAY)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "This meal already repeats."


async def test_a_repeat_that_leaves_out_its_own_day_keeps_that_day_as_a_one_off(client):
    # The meal the owner chose the days from stays where it is: the days
    # chosen are where it goes next, not a reason to lose this one.
    entry = await plan(client, "2026-10-27", "dinner", await oats(client))  # a Tuesday
    resp = await start_repeat(client, entry["entry_id"], [0], TODAY)
    assert resp.status_code == 201, resp.text
    assert resp.json()["starts_on"] == "2026-10-27"
    meals = await listed(client, "2026-10-26", "2026-11-08")
    assert [(m["plan_date"], m["entry_id"], m["repeat"] is None) for m in meals] == [
        ("2026-10-27", entry["entry_id"], True),
        ("2026-11-02", None, False),
    ]


async def test_new_days_that_leave_out_the_day_they_are_made_on_keep_its_meal(client):
    rid = await repeat_oats(client)
    # Wednesday's own servings stay with it, as they are.
    await ok(await change_day(client, rid, "2026-10-28", servings=3))
    await ok(await change_from(client, rid, "2026-10-28", weekdays=[0, 4]))
    meals = await listed(client, "2026-10-26", "2026-11-08")
    assert [
        (m["plan_date"], m["servings"], m["repeat"] and m["repeat"]["id"]) for m in meals
    ] == [
        ("2026-10-26", None, rid), ("2026-10-27", None, rid),
        ("2026-10-28", 3, None),
        ("2026-10-30", None, meals[3]["repeat"]["id"]),
        ("2026-11-02", None, meals[3]["repeat"]["id"]),
        ("2026-11-06", None, meals[3]["repeat"]["id"]),
    ]
    # A one-off now: a later change from Monday on does not reach it.
    await ok(await change_from(client, rid, "2026-10-26", servings=2))
    (wed,) = await listed(client, "2026-10-28", "2026-10-28")
    assert (wed["servings"], wed["repeat"]) == (3, None)


async def test_new_days_from_a_repeats_first_day_keep_that_days_meal(client):
    rid = await repeat_oats(client)  # from Monday 10-26, every day
    await ok(await change_from(client, rid, "2026-10-26", weekdays=[2]))
    meals = await listed(client, "2026-10-26", "2026-11-08")
    assert [(m["plan_date"], m["repeat"] and m["repeat"]["id"]) for m in meals] == [
        ("2026-10-26", None), ("2026-10-28", rid), ("2026-11-04", rid)]


async def test_deleting_a_recipe_takes_its_repeats_changes_with_it(client):
    rid = await repeat_oats(client)
    recipe = (await listed(client, "2026-10-26", "2026-10-26"))[0]["recipe"]["id"]
    await ok(await change_day(client, rid, "2026-10-27", servings=3))
    await ok(await remove(client, rid, "2026-10-28", "day"))
    await ok(await change_from(client, rid, "2026-10-30", servings=2))
    (mon,) = await listed(client, "2026-11-02", "2026-11-02")
    part = mon["repeat"]["id"]  # what the change from Friday split off
    await ok(await change_day(client, part, "2026-11-02", servings=4))
    await ok(await remove(client, part, "2026-11-03", "day"))
    keep = (await make_recipe(client, "Toast", []))["id"]
    toast = await plan(client, "2026-10-27", "lunch", keep)

    assert (await client.delete(f"/api/recipes/{recipe}")).status_code == 204

    meals = await listed(client, "2026-10-19", "2026-11-30")
    assert [m["entry_id"] for m in meals] == [toast["entry_id"]]
    async with session_factory() as session:
        assert (await session.execute(select(MealRepeat))).scalars().all() == []
        assert (await session.execute(select(MealRepeatSkip))).scalars().all() == []
        entries = (await session.execute(select(MealPlanEntry))).scalars().all()
        assert [e.id for e in entries] == [toast["entry_id"]]
