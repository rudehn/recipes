"""The recipes page's "Needs a look": every row that will price, shop or count
wrongly, grouped by recipe, and what each one stands in the way of.

What is worth proving is the split. A row the recipe itself has wrong is
wrong for the price and the nutrition alike, and is one reason; a row the
shop and the food tables each failed on is two, with two fixes. Rows left
out honestly - to taste, or by a person's choice - are not faults, here any
more than on the recipe page. And the check covers the whole box on every
visit to the recipes page, so it has to cost the same few queries however
large the box grows.
"""

from sqlalchemy import event

from app import config
from app.db import engine, session_factory
from app.models import AppSettings, IngredientFoodMatch, IngredientProductMatch

LOCATION = "01400765"
ALMONDS = 170567


async def make(client, title: str, ingredients: list[tuple], servings: int | None = 4) -> int:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "servings": servings,
            "ingredients": [
                {"name": name, "quantity": quantity, "unit": unit}
                for name, quantity, unit in ingredients
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def needing_a_look(client) -> list[dict]:
    resp = await client.get("/api/recipes/attention")
    assert resp.status_code == 200, resp.text
    return resp.json()


def reasons(entry: dict) -> list[tuple[str, str, list[str]]]:
    return [(i["name"], i["issue"], i["affects"]) for i in entry["issues"]]


async def price_at_a_store(monkeypatch, unmatched: list[str]) -> None:
    """Pricing on, with a store, and `unmatched` already searched for there
    and found nothing. Nothing here calls Kroger: the check reads the rows."""
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=LOCATION))
        for key in unmatched:
            session.add(
                IngredientProductMatch(canonical_key=key, location_id=LOCATION, product_id=None)
            )
        await session.commit()


async def test_a_row_the_recipe_has_wrong_stands_in_the_way_of_both(client):
    await make(client, "Salsa", [("Optional: 1 diced ripe avocado", None, None)])

    (salsa,) = await needing_a_look(client)

    assert salsa["recipe"]["title"] == "Salsa"
    assert reasons(salsa) == [
        ("Optional: 1 diced ripe avocado", "amount_in_name", ["price", "nutrition"])
    ]
    assert salsa["no_servings"] is False


async def test_what_stands_in_the_way_of_nutrition_is_listed_without_pricing(client):
    """No Kroger account at all: the nutrition reasons are the app's own, and
    there is no "nothing matched" without a store to match at."""
    await make(
        client,
        "Cake",
        [
            ("all-purpose flour", 1, "cup"),
            ("almond flour", 1, "cup"),
            ("shallot", 1, None),
        ],
    )

    (cake,) = await needing_a_look(client)

    assert reasons(cake) == [
        ("almond flour", "no_food", ["nutrition"]),
        ("shallot", "unweighable", ["nutrition"]),
    ]


async def test_a_row_can_stand_in_the_way_of_each_for_its_own_reason(client, monkeypatch):
    """Saffron matched nothing at the store and has no food either. Two
    faults, two fixes, so it is listed once for each."""
    await price_at_a_store(monkeypatch, unmatched=["saffron", "flour"])
    await make(client, "Paella", [("saffron", 1, "g"), ("flour", 1, "cup")])

    (paella,) = await needing_a_look(client)

    assert reasons(paella) == [
        ("saffron", "no_match", ["price"]),
        ("saffron", "no_food", ["nutrition"]),
        ("flour", "no_match", ["price"]),
    ]


async def test_a_row_left_out_honestly_is_not_a_fault(client):
    """Salt to taste is not measured, and paprica a person said does not
    count. The recipe page does not hold either against the figure."""
    await make(
        client,
        "Bake",
        [
            ("all-purpose flour", 1, "cup"),
            ("salt, to taste", None, None),
            ("paprica", 1, "tbsp"),
        ],
    )
    assert reasons((await needing_a_look(client))[0]) == [("paprica", "no_food", ["nutrition"])]

    await client.put("/api/nutrition/match", json={"key": "paprica", "fdc_id": None})

    assert await needing_a_look(client) == []


async def test_a_row_left_out_of_nutrition_can_still_shop_wrongly(client):
    """Saying a row does not count settles its nutrition, not its amount."""
    await make(client, "Salsa", [("lettuce", None, None)])
    await client.put("/api/nutrition/match", json={"key": "lettuce", "fdc_id": None})

    (salsa,) = await needing_a_look(client)

    assert reasons(salsa) == [("lettuce", "no_amount", ["price"])]


async def test_a_food_chosen_in_one_recipe_clears_every_recipe_using_it(client):
    await make(client, "Macarons", [("almond flour", 1, "cup")])
    await make(client, "Almond cake", [("Almond flour, sifted", 2, "cups")])
    assert len(await needing_a_look(client)) == 2

    await client.put("/api/nutrition/match", json={"key": "almond-flour", "fdc_id": ALMONDS})

    assert await needing_a_look(client) == []


async def test_a_recipe_that_does_not_say_how_many_it_serves_is_flagged(client):
    """Nutrition is per serving, so there is nothing to divide by - but only
    a recipe with something to count has a figure to miss."""
    await make(client, "Bake", [("all-purpose flour", 1, "cup")], servings=None)
    await make(client, "Empty", [], servings=None)
    await make(client, "Seasoning", [("salt, to taste", None, None)], servings=None)

    (bake,) = await needing_a_look(client)

    assert bake["recipe"]["title"] == "Bake"
    assert bake["no_servings"] is True
    assert bake["issues"] == []


async def test_the_recipes_with_most_to_fix_come_first(client):
    await make(client, "Bread", [("almond flour", 1, "cup")])
    await make(client, "Apple cake", [("almond flour", 1, "cup")], servings=None)
    await make(client, "Salsa", [("lettuce", None, None), ("shallot", 1, None)])

    assert [r["recipe"]["title"] for r in await needing_a_look(client)] == [
        "Apple cake",
        "Salsa",
        "Bread",
    ]


async def test_the_check_costs_the_same_queries_however_large_the_box(client, monkeypatch):
    """It runs over every recipe on every visit to the recipes page, so a
    query per recipe - for its hand-picked foods, say - would grow with the
    box. Pricing is on, so the store's picks are read too."""
    await price_at_a_store(monkeypatch, unmatched=["saffron"])
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="almond-flour", fdc_id=ALMONDS))
        await session.commit()

    async def queries_for_the_check() -> int:
        statements: list[str] = []

        def count(conn, cursor, statement, *args):
            statements.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", count)
        try:
            await needing_a_look(client)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count)
        return len(statements)

    rows = [("almond flour", 1, "cup"), ("saffron", 1, "g"), ("paprica", 1, "tbsp")]
    for n in range(2):
        await make(client, f"Recipe {n}", rows)
    few = await queries_for_the_check()

    for n in range(2, 12):
        await make(client, f"Recipe {n}", rows)
    many = await queries_for_the_check()

    assert len(await needing_a_look(client)) == 12
    assert many == few
