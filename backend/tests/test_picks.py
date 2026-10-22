"""A week's picks: recipes set aside for that week, keyed by its Monday."""

from sqlalchemy import func, select
from test_meal_plan_and_grocery import make_recipe

from app.db import session_factory
from app.models import PlanPick

MONDAY = "2026-10-26"
NEXT_MONDAY = "2026-11-02"


async def pick(client, week, recipe_id):
    return await client.post(
        "/api/meal-plan/picks", json={"week_start": week, "recipe_id": recipe_id}
    )


async def picks(client, week):
    resp = await client.get("/api/meal-plan/picks", params={"week": week})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_picks_belong_to_their_week(client):
    oats = (await make_recipe(client, "Oats", []))["id"]
    curry = (await make_recipe(client, "Curry", []))["id"]
    first = await pick(client, MONDAY, oats)
    assert first.status_code == 201
    assert first.json()["recipe"]["title"] == "Oats"
    assert first.json()["week_start"] == MONDAY
    await pick(client, MONDAY, curry)
    await pick(client, NEXT_MONDAY, curry)

    assert [p["recipe"]["title"] for p in await picks(client, MONDAY)] == ["Oats", "Curry"]
    assert [p["recipe"]["title"] for p in await picks(client, NEXT_MONDAY)] == ["Curry"]

    resp = await client.delete(f"/api/meal-plan/picks/{first.json()['id']}")
    assert resp.status_code == 204
    assert [p["recipe"]["title"] for p in await picks(client, MONDAY)] == ["Curry"]
    assert (await client.delete(f"/api/meal-plan/picks/{first.json()['id']}")).status_code == 404


async def test_picking_twice_returns_the_same_pick(client):
    oats = (await make_recipe(client, "Oats", []))["id"]
    first = await pick(client, MONDAY, oats)
    again = await pick(client, MONDAY, oats)
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json() == first.json()
    assert len(await picks(client, MONDAY)) == 1


async def test_a_week_must_start_on_monday(client):
    oats = (await make_recipe(client, "Oats", []))["id"]
    assert (await pick(client, "2026-10-27", oats)).status_code == 422
    resp = await client.get("/api/meal-plan/picks", params={"week": "2026-10-27"})
    assert resp.status_code == 422


async def test_picking_an_unknown_recipe_is_not_found(client):
    assert (await pick(client, MONDAY, 999)).status_code == 404


async def test_deleting_a_recipe_drops_its_picks(client):
    oats = (await make_recipe(client, "Oats", []))["id"]
    curry = (await make_recipe(client, "Curry", []))["id"]
    await pick(client, MONDAY, oats)
    await pick(client, MONDAY, curry)

    assert (await client.delete(f"/api/recipes/{oats}")).status_code == 204

    assert [p["recipe"]["title"] for p in await picks(client, MONDAY)] == ["Curry"]
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(PlanPick)) == 1


async def test_copy_week_is_gone(client):
    assert (await client.post("/api/meal-plan/copy-week", json={})).status_code in (404, 405)
