"""The ingredients list and one ingredient's page.

Proves what each row says - its recipes, staple, product and food - and that
saying it never searches Kroger: products come from picks already made, and
a Kroger that fails costs the prices, not the page. Also proves the edges a
person meets: a name merged away opens its target, and a name nothing uses
any more is "not found" rather than an error.
"""

from app import config
from app.db import session_factory
from app.models import AppSettings, IngredientFoodMatch, IngredientMerge, IngredientProductMatch
from app.services.kroger import client as kroger_client
from app.services.kroger import products

STORE = "01400765"


async def recipe(client, title: str, lines: list[tuple]) -> int:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": title,
            "servings": 4,
            "ingredients": [{"name": n, "quantity": q, "unit": u} for n, q, u in lines],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def listing(client) -> dict[str, dict]:
    resp = await client.get("/api/ingredients")
    assert resp.status_code == 200, resp.text
    return {i["key"]: i for i in resp.json()["ingredients"]}


async def test_every_recipe_ingredient_and_staple_is_listed_once(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("onion", 1, None)])
    await recipe(client, "Salsa", [("diced onion", 1, None)])
    await client.post("/api/pantry", json={"name": "Bread", "in_stock": False})

    found = await listing(client)

    assert sorted(found) == ["bread", "ground-cumin", "onion"]
    assert found["onion"]["recipe_count"] == 2
    assert found["bread"]["recipe_count"] == 0
    assert found["bread"]["staple"]["in_stock"] is False
    assert found["bread"]["name"] == "Bread"


async def test_a_merged_name_is_one_row_that_says_what_it_is_also_called(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    found = await listing(client)

    assert sorted(found) == ["cumin"]
    assert found["cumin"]["also_called"] == ["ground cumin"]
    assert found["cumin"]["recipe_count"] == 1


async def test_foods_are_default_picked_skipped_or_none(client):
    await recipe(
        client,
        "Box",
        [
            ("cumin", 1, "tsp"),
            ("paprika", 1, "tsp"),
            ("basil", 1, "tsp"),
            ("dragonfruit dust", 1, "tsp"),
        ],
    )
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="paprika", fdc_id=170923))
        session.add(IngredientFoodMatch(key="basil", fdc_id=None))
        await session.commit()

    found = await listing(client)

    assert found["cumin"]["food"]["status"] == "default"
    assert found["paprika"]["food"]["status"] == "picked"
    assert found["basil"]["food"]["status"] == "skipped"
    assert found["dragonfruit-dust"]["food"]["status"] == "none"
    assert "no_food" in found["dragonfruit-dust"]["problems"]


async def test_a_broken_line_is_a_line_to_fix(client):
    await recipe(client, "Chili", [("22-ounce bag frozen waffle fries", 1, None)])

    found = await listing(client)

    (only,) = found.values()
    assert only["problems"] == ["fix_line"]


async def test_pricing_off_says_nothing_about_products(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    assert (await listing(client))["cumin"]["product"] is None


async def test_products_come_from_picks_and_survive_kroger_failing(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await recipe(
        client,
        "Chili",
        [("cumin", 1, "tsp"), ("salt", 1, "tsp"), ("paprika", 1, "tsp"), ("thyme", 1, "tsp")],
    )
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=STORE))
        session.add(
            IngredientProductMatch(
                canonical_key="cumin", location_id=STORE, product_id="111", user_confirmed=True
            )
        )
        session.add(
            IngredientProductMatch(
                canonical_key="salt", location_id=STORE, product_id=None, user_confirmed=True
            )
        )
        session.add(
            IngredientProductMatch(canonical_key="paprika", location_id=STORE, product_id=None)
        )
        await session.commit()

    async def no_kroger(*args, **kwargs):
        raise kroger_client.KrogerError("down")

    async def no_search(*args, **kwargs):
        raise AssertionError("listing ingredients must never search Kroger")

    monkeypatch.setattr(products, "by_ids", no_kroger)
    monkeypatch.setattr(products, "search", no_search)

    found = await listing(client)

    assert {k: v["product"]["status"] for k, v in found.items()} == {
        "cumin": "picked",
        "salt": "not_priced",
        "paprika": "no_match",
        "thyme": "unseen",
    }
    assert found["cumin"]["product"]["product"] is None
    assert found["paprika"]["problems"] == ["no_match"]


async def test_one_ingredient_lists_its_lines_as_written(client):
    chili = await recipe(client, "Chili", [("ground cumin", 2, "tsp")])
    salsa = await recipe(client, "Salsa", [("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    resp = await client.get("/api/ingredients/cumin")
    assert resp.status_code == 200, resp.text
    detail = resp.json()

    assert [(line["recipe_id"], line["name"]) for line in detail["lines"]] == [
        (chili, "ground cumin"),
        (salsa, "cumin"),
    ]
    assert detail["merged"] == [{"key": "ground-cumin", "name": "ground cumin"}]
    assert detail["redirected_from"] is None


async def test_a_merged_away_name_opens_its_target(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    detail = (await client.get("/api/ingredients/ground-cumin")).json()

    assert detail["key"] == "cumin"
    assert detail["redirected_from"] == "ground-cumin"


async def test_a_name_nothing_uses_is_not_found(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    resp = await client.get("/api/ingredients/saffron")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No ingredient called that."


async def test_preview_says_what_a_merge_would_change(client):
    chili = await recipe(client, "Chili", [("ground cumin", 2, "tsp")])
    await recipe(client, "Salsa", [("cumin", 1, "tsp")])
    await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    async with session_factory() as session:
        session.add(IngredientFoodMatch(key="ground-cumin", fdc_id=None))
        await session.commit()

    resp = await client.post(
        "/api/ingredients/merges/preview", json={"from_key": "ground-cumin", "to_key": "cumin"}
    )
    assert resp.status_code == 200, resp.text
    preview = resp.json()

    assert preview["from_name"] == "ground cumin"
    assert preview["to_name"] == "Cumin"
    assert preview["recipes"] == [{"id": chili, "title": "Chili"}]
    assert preview["product"] is None
    assert preview["food"]["from_side"]["skipped"] is True
    assert preview["food"]["to_side"]["hand_picked"] is False
    assert preview["food"]["keeps"] == "from"
    assert preview["staple"] == {
        "from_side": None,
        "to_side": {"name": "Cumin", "in_stock": True},
        "keeps": "to",
    }
    assert preview["needs"] == []


async def test_preview_and_merge_ask_when_both_are_staples(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    await client.post("/api/pantry", json={"name": "Ground Cumin", "in_stock": False})
    await client.post("/api/pantry", json={"name": "Cumin", "in_stock": True})
    pair = {"from_key": "ground-cumin", "to_key": "cumin"}

    preview = (await client.post("/api/ingredients/merges/preview", json=pair)).json()
    assert preview["needs"] == ["staple"]
    assert preview["staple"]["keeps"] is None

    refused = await client.post("/api/ingredients/merges", json=pair)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Choose which staple to keep."

    done = await client.post("/api/ingredients/merges", json={**pair, "choices": {"staple": "to"}})
    assert done.status_code == 204
    assert [i["name"] for i in (await client.get("/api/pantry")).json()] == ["Cumin"]


async def test_merge_then_unmerge_through_the_api(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    pair = {"from_key": "ground-cumin", "to_key": "cumin"}

    assert (await client.post("/api/ingredients/merges", json=pair)).status_code == 204
    assert sorted(await listing(client)) == ["cumin"]

    assert (await client.delete("/api/ingredients/merges/ground-cumin")).status_code == 204
    assert sorted(await listing(client)) == ["cumin", "ground-cumin"]
    assert (await client.delete("/api/ingredients/merges/ground-cumin")).status_code == 404


async def test_a_reversed_merge_is_refused_with_a_sentence(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    await client.post(
        "/api/ingredients/merges", json={"from_key": "ground-cumin", "to_key": "cumin"}
    )

    resp = await client.post(
        "/api/ingredients/merges", json={"from_key": "cumin", "to_key": "ground-cumin"}
    )

    assert resp.status_code == 409
    assert "unmerge it first" in resp.json()["detail"]


async def test_merging_an_unknown_name_is_not_found(client):
    await recipe(client, "Chili", [("cumin", 1, "tsp")])

    resp = await client.post(
        "/api/ingredients/merges/preview", json={"from_key": "saffron", "to_key": "cumin"}
    )

    assert resp.status_code == 404


async def test_preview_loads_with_kroger_failing(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])
    async with session_factory() as session:
        session.add(AppSettings(id=1, kroger_location_id=STORE))
        session.add(
            IngredientProductMatch(
                canonical_key="ground-cumin",
                location_id=STORE,
                product_id="111",
                user_confirmed=True,
            )
        )
        await session.commit()

    async def no_kroger(*args, **kwargs):
        raise kroger_client.KrogerError("down")

    monkeypatch.setattr(products, "by_ids", no_kroger)

    preview = (
        await client.post(
            "/api/ingredients/merges/preview", json={"from_key": "ground-cumin", "to_key": "cumin"}
        )
    ).json()

    assert preview["product"]["from_side"] == {
        "product": None,
        "hand_picked": True,
        "not_priced": False,
    }
    assert preview["product"]["keeps"] == "from"


async def test_suggestions_can_be_listed_and_turned_down(client):
    await recipe(client, "Chili", [("ground cumin", 2, "tsp"), ("cumin", 1, "tsp")])

    assert len((await client.get("/api/ingredients/suggestions")).json()) == 1
    resp = await client.post(
        "/api/ingredients/suggestions/dismiss", json={"key_a": "ground-cumin", "key_b": "cumin"}
    )
    assert resp.status_code == 204
    # Saying it twice is the same as once.
    await client.post(
        "/api/ingredients/suggestions/dismiss", json={"key_a": "cumin", "key_b": "ground-cumin"}
    )
    assert (await client.get("/api/ingredients/suggestions")).json() == []
