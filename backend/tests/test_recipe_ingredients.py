"""Editing recipe lines in place, from an ingredient's page.

Saving a whole recipe replaces every line with new ids, which would break
the links the grocery list and "Needs a look" make to a line. These edits
keep the id. They also refuse as a batch - a blank name, a name that is not
an ingredient, or a line that is no longer there - so a half-saved fix is
never left behind. Reading a line again never saves anything.
"""

from app.db import session_factory
from app.models import Ingredient


async def recipe(client, lines: list[dict]) -> dict:
    resp = await client.post("/api/recipes", json={"title": "Chili", "ingredients": lines})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_a_line_is_edited_in_place_and_keeps_its_id(client):
    chili = await recipe(
        client,
        [
            {
                "name": "can black beans, drained and rinsed",
                "quantity": 15,
                "unit": "oz",
            }
        ],
    )
    line_id = chili["ingredients"][0]["id"]

    resp = await client.patch(
        "/api/recipe-ingredients",
        json={
            "lines": [
                {
                    "id": line_id,
                    "name": "black beans, drained and rinsed",
                    "quantity": 15,
                    "unit": "oz",
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    (edited,) = resp.json()

    assert edited["id"] == line_id
    assert edited["key"] == "black-bean"
    reread = (await client.get(f"/api/recipes/{chili['id']}")).json()["ingredients"][0]
    assert (reread["id"], reread["name"]) == (line_id, "black beans, drained and rinsed")


async def test_a_bad_name_refuses_the_whole_batch(client):
    chili = await recipe(
        client,
        [
            {"name": "cumin", "quantity": 1, "unit": "tsp"},
            {"name": "paprika", "quantity": 1, "unit": "tsp"},
        ],
    )
    first, second = (i["id"] for i in chili["ingredients"])

    for bad in ["   ", "***"]:
        resp = await client.patch(
            "/api/recipe-ingredients",
            json={
                "lines": [
                    {"id": first, "name": "ground cumin", "quantity": 1, "unit": "tsp"},
                    {"id": second, "name": bad, "quantity": 1, "unit": "tsp"},
                ]
            },
        )
        assert resp.status_code == 422, resp.text

    recipe_data = (await client.get(f"/api/recipes/{chili['id']}")).json()
    names = [i["name"] for i in recipe_data["ingredients"]]
    assert names == ["cumin", "paprika"]


async def test_a_line_replaced_by_saving_its_recipe_is_not_found(client):
    chili = await recipe(client, [{"name": "cumin", "quantity": 1, "unit": "tsp"}])
    stale = chili["ingredients"][0]["id"]
    await client.put(
        f"/api/recipes/{chili['id']}",
        json={"title": "Chili", "ingredients": [{"name": "cumin", "quantity": 2, "unit": "tsp"}]},
    )

    resp = await client.patch(
        "/api/recipe-ingredients",
        json={
            "lines": [{"id": stale, "name": "cumin", "quantity": 1, "unit": "tsp"}]
        },
    )

    assert resp.status_code == 404
    assert "reload" in resp.json()["detail"]


async def test_a_line_cannot_be_edited_twice_in_one_batch(client):
    chili = await recipe(client, [{"name": "cumin", "quantity": 1, "unit": "tsp"}])
    line_id = chili["ingredients"][0]["id"]
    edit = {"id": line_id, "name": "cumin", "quantity": 1, "unit": "tsp"}

    resp = await client.patch("/api/recipe-ingredients", json={"lines": [edit, edit]})

    assert resp.status_code == 422


async def test_reading_again_uses_the_website_s_line_when_it_was_kept(client):
    chili = await recipe(
        client,
        [
            {
                "name": "black beans",
                "quantity": 1,
                "unit": "can",
                "source_line": "1 (15 oz) can black beans",
            },
            {
                "name": "can kidney beans, drained and rinsed",
                "quantity": 15,
                "unit": "oz",
            },
        ],
    )
    kept, rebuilt = (i["id"] for i in chili["ingredients"])

    resp = await client.post("/api/recipe-ingredients/reread", json={"ids": [kept, rebuilt]})
    assert resp.status_code == 200, resp.text
    first, second = resp.json()

    assert first["from_source"] is True
    first_after = (
        first["after"]["name"],
        first["after"]["quantity"],
        first["after"]["unit"],
    )
    assert first_after == ("black beans", 15, "oz")
    assert second["from_source"] is False
    second_after = (
        second["after"]["name"],
        second["after"]["quantity"],
        second["after"]["unit"],
    )
    assert second_after == ("kidney beans, drained and rinsed", 15, "oz")
    async with session_factory() as session:
        ingredient = await session.get(Ingredient, rebuilt)
        assert ingredient.name == "can kidney beans, drained and rinsed"


async def test_reading_a_missing_line_again_is_not_found(client):
    resp = await client.post("/api/recipe-ingredients/reread", json={"ids": [999]})
    assert resp.status_code == 404
