"""Planned meals are read through one service, each answered with a key.

The key is what a client names a meal by. Today every meal is a row and the
key says so; the tests pin that the list, the cost and the "cooked" ordering
all agree on it because they all read through `services.plan`.
"""

from datetime import date, timedelta

from test_grocery_pricing import DAY, LOCATION, catalog, make_recipe  # noqa: F401

from app.db import session_factory
from app.models import AppSettings, MealPlanEntry
from app.services import repeats
from app.services.plan import last_planned, planned_meals

WEEK = {"start": "2026-07-20", "end": "2026-07-26"}


async def plan(client, plan_date, meal, recipe_id):
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": plan_date, "meal": meal, "recipe_id": recipe_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_planned_meals_carry_a_key_named_after_their_row(client):
    recipe = (
        await client.post("/api/recipes", json={"title": "Tacos", "ingredients": []})
    ).json()
    entry = await plan(client, "2026-07-20", "dinner", recipe["id"])
    assert entry["key"] == f"e{entry['entry_id']}"
    listed = (await client.get("/api/meal-plan", params=WEEK)).json()
    assert [(m["key"], m["entry_id"]) for m in listed] == [(entry["key"], entry["entry_id"])]


async def choose_store():
    async with session_factory() as session:
        session.add(
            AppSettings(
                id=1,
                kroger_location_id=LOCATION,
                kroger_location_name="Kroger - Kroger Riverside",
                kroger_location_address="601 Woodman Dr, Dayton, OH 45431",
                kroger_location_chain="KROGER",
            )
        )
        await session.commit()


async def test_plan_cost_names_each_meal_by_its_key(client, catalog):  # noqa: F811
    await choose_store()
    bread = await make_recipe("Bread", [("flour", 2, "cup")], servings=4)
    # Planned through the session: the fake catalog also answers the test
    # client's POSTs, so nothing can be created over HTTP while it is in place.
    async with session_factory() as session:
        row = MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=bread)
        session.add(row)
        await session.commit()
        key = f"e{row.id}"

    resp = await client.get("/api/meal-plan/cost", params={"start": str(DAY), "end": str(DAY)})
    cost = resp.json()

    assert [e["key"] for e in cost["entries"]] == [key]


async def test_plan_cost_counts_a_repeats_days_as_planned_meals(client, catalog):  # noqa: F811
    """A repeat is costed on every day it falls on, under the key the planner
    shows it by: `r<repeat>-<day>` for a plain day, the row's own `e<id>` for
    a day changed on its own (at that day's servings), and not at all on a
    day removed on its own."""
    await choose_store()
    bread = await make_recipe("Bread", [("flour", 2, "cup")], servings=4)
    tuesday, wednesday = DAY + timedelta(days=1), DAY + timedelta(days=2)
    # Through the service rather than HTTP, for the reason given above.
    async with session_factory() as session:
        entry = MealPlanEntry(plan_date=DAY, meal="breakfast", recipe_id=bread, labels=[])
        session.add(entry)
        await session.flush()
        repeat = await repeats.start_repeat(session, entry, [0, 1, 2], today=DAY)
        await repeats.remove_day(session, repeat, tuesday)
        doubled = await repeats.override_day(session, repeat, wednesday, servings=8)
        await session.commit()
        monday_key, wednesday_key = f"r{repeat.id}-{DAY}", f"e{doubled.id}"

    resp = await client.get(
        "/api/meal-plan/cost", params={"start": str(DAY), "end": str(DAY + timedelta(days=6))}
    )
    assert resp.status_code == 200, resp.text
    cost = resp.json()

    assert cost["entries"] == [
        {"key": monday_key, "total": 0.29, "priced": 1, "total_lines": 1},
        {"key": wednesday_key, "total": 0.57, "priced": 1, "total_lines": 1},
    ]
    assert cost["days"] == [
        {"plan_date": str(DAY), "total": 0.29, "priced": 1, "total_lines": 1},
        {"plan_date": str(wednesday), "total": 0.57, "priced": 1, "total_lines": 1},
    ]
    assert cost["total"] == 0.86


async def test_recently_cooked_reads_through_the_plan_service(client):
    ids = {}
    for title in ("Mango", "Beans", "Cake"):
        ids[title] = (
            await client.post("/api/recipes", json={"title": title, "ingredients": []})
        ).json()["id"]
    for title, day in (
        ("Beans", "2026-06-20"),
        ("Beans", "2026-07-01"),
        ("Mango", "2026-07-22"),
        ("Cake", "2026-07-23"),
    ):
        await plan(client, day, "dinner", ids[title])

    async with session_factory() as session:
        assert await last_planned(session, date(2026, 7, 22)) == {
            ids["Mango"]: date(2026, 7, 22),
            ids["Beans"]: date(2026, 7, 1),
        }
        meals = await planned_meals(session, date(2026, 7, 1), date(2026, 7, 22))
        assert [(m.recipe.title, m.plan_date) for m in meals] == [
            ("Beans", date(2026, 7, 1)),
            ("Mango", date(2026, 7, 22)),
        ]
