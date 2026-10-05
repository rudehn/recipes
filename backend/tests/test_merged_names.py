"""Merged names are one ingredient everywhere the app compares ingredients.

A merge is only as good as its weakest reader: a grocery list that merges
the two names while the pantry still tells them apart puts the spice that
is in the cupboard back on the list. So this proves the readers the owner
meets - the list, the pantry, the food a line counts as, "Needs a look" and
a pasted shopping list - and then that no code compares ingredients any
other way.
"""

import re
from pathlib import Path

from app import config
from app.db import session_factory
from app.models import AppSettings, IngredientFoodMatch, IngredientMerge, IngredientProductMatch
from app.services.identity import Identity
from app.services.shopping_text import read_shopping_text

WEEK = {"start": "2026-10-05", "end": "2026-10-11"}
LOCATION = "01400765"


async def merge(*pairs: tuple[str, str]) -> None:
    async with session_factory() as session:
        for from_key, to_key in pairs:
            session.add(IngredientMerge(from_key=from_key, to_key=to_key))
        await session.commit()


async def plan(client, title: str, ingredient: str, quantity: float, unit: str) -> int:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "servings": 4,
            "ingredients": [{"name": ingredient, "quantity": quantity, "unit": unit}],
        },
    )
    assert resp.status_code == 201, resp.text
    recipe_id = resp.json()["id"]
    resp = await client.post(
        "/api/meal-plan",
        json={"plan_date": WEEK["start"], "meal": "dinner", "recipe_id": recipe_id},
    )
    assert resp.status_code == 201, resp.text
    return recipe_id


async def grocery_list(client) -> dict:
    resp = await client.get("/api/grocery-list", params=WEEK)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_merged_names_are_one_grocery_line(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    await plan(client, "Salsa", "cumin", 1, "tsp")
    await merge(("ground-cumin", "cumin"))

    items = (await grocery_list(client))["items"]

    assert [(i["key"], len(i["uses"])) for i in items] == [("cumin", 2)]


async def test_a_staple_covers_a_name_merged_into_it(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    resp = await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    assert resp.status_code == 201
    await merge(("ground-cumin", "cumin"))

    listing = await grocery_list(client)

    assert listing["items"] == []
    assert [i["key"] for i in listing["in_pantry"]] == ["cumin"]


async def test_a_tick_on_the_merged_line_restocks_the_staple(client):
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    staple = (await client.post("/api/pantry", json={"name": "Cumin", "in_stock": False})).json()
    await merge(("ground-cumin", "cumin"))

    resp = await client.post("/api/grocery-list/mark", json={"key": "cumin", "status": "bought"})
    assert resp.status_code == 204

    stock = {i["id"]: i["in_stock"] for i in (await client.get("/api/pantry")).json()}
    assert stock[staple["id"]] is True


async def test_a_food_choice_on_the_target_reaches_the_merged_name(client):
    recipe_id = await plan(client, "Chili", "ground cumin", 2, "tsp")
    await merge(("ground-cumin", "cumin"))
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="cumin", fdc_id=None))
        await session.commit()

    lines = (await client.get(f"/api/recipes/{recipe_id}/nutrition")).json()["lines"]

    assert [(line["key"], line["skipped"]) for line in lines] == [("cumin", True)]


async def test_needs_a_look_reads_the_target_s_product(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await plan(client, "Chili", "ground cumin", 2, "tsp")
    await merge(("ground-cumin", "cumin"))
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=LOCATION))
        session.add(IngredientProductMatch(canonical_key="cumin", location_id=LOCATION))
        await session.commit()

    entries = (await client.get("/api/recipes/attention")).json()

    issues = [(i["name"], i["issue"]) for e in entries for i in e["issues"]]
    assert ("ground cumin", "no_match") in issues


def test_a_pasted_list_reads_merged_names_as_one():
    read = read_shopping_text(
        "ground cumin\ncumin", Identity.from_merges({"ground-cumin": "cumin"})
    )
    assert [item.key for item in read.lines] == ["cumin"]


# Files allowed to call the key functions directly: where they are defined,
# the identity itself, and lint, which inspects the words of one name rather
# than comparing two ingredients.
ALLOWED = {
    "services/canonical.py",
    "services/nutrition/defaults.py",
    "services/identity.py",
    "services/lint.py",
}
# A method of the identity is the sanctioned way, so only a bare call is flagged.
CALL = re.compile(r"(?<![.\w])(canonical_key|nutrition_key)\(")


def test_ingredients_are_only_compared_through_the_identity():
    app = Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for path in sorted(app.rglob("*.py")):
        rel = path.relative_to(app).as_posix()
        if rel in ALLOWED:
            continue
        for number, line in enumerate(path.read_text().splitlines(), start=1):
            code = line.split("#", 1)[0]
            if CALL.search(code) and not code.lstrip().startswith("def "):
                offenders.append(f"{rel}:{number}: {line.strip()}")
    assert offenders == []
