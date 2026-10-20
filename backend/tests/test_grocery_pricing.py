"""Prices on the grocery list.

The list is the product and prices are a garnish, so most of what is worth
proving here is what happens when Kroger is not available: the list has to
survive every one of those paths intact. The rest is that the total says how
much of the list it actually covers, because a total that quietly omits the
lines it could not match reads exactly like a complete one.
"""

import asyncio
from datetime import date

import httpx
import pytest

from app import config
from app.db import session_factory
from app.models import (
    AppSettings,
    GroceryCheck,
    Ingredient,
    IngredientProductMatch,
    MealPlanEntry,
    PantryItem,
    Recipe,
    RecipeTag,
)
from app.services.kroger import client as kroger
from app.services.kroger import matching, products

LOCATION = "01400765"
DAY = date(2026, 8, 17)

_real_get = httpx.AsyncClient.get


def catalog_entry(
    product_id: str,
    description: str,
    regular: float,
    promo: float | None = None,
    size: str = "5 lb",
    sold_by: str = "UNIT",
    categories: list[str] | None = None,
):
    price: dict = {"regular": regular}
    if promo is not None:
        price["promo"] = promo
    return {
        "productId": product_id,
        "upc": f"upc-{product_id}",
        "description": description,
        "categories": categories or ["Baking Goods"],
        "items": [{"size": size, "soldBy": sold_by, "price": price}],
        "aisleLocations": [{"description": "AISLE 18"}],
    }


CATALOG = {
    "flour": catalog_entry("0001", "Kroger® All Purpose Flour", 2.59),
    "sugar": catalog_entry("0002", "Kroger® Granulated Sugar", 3.99, promo=2.99),
    # A bunch is not a size anything can read, so a recipe's share of it is
    # unknowable and it is costed whole.
    "parsley": catalog_entry("0003", "Parsley", 1.29, size="1 bunch", categories=["Produce"]),
    "chicken thigh": catalog_entry(
        "0004", "Fresh Chicken Thighs", 4.00, size="1 lb", sold_by="WEIGHT",
        categories=["Meat & Seafood"],
    ),
    # Sold loose by the pound, filed under produce, as the live store lists it.
    "jalapeno": catalog_entry(
        "0005", "Fresh Jalapeno Peppers", 1.99, size="1 lb", sold_by="WEIGHT",
        categories=["Produce", "International"],
    ),
    "saffron": None,
}


class FakeCatalog:
    def __init__(self) -> None:
        self.error = False
        self.calls = 0
        self.searches: list[dict] = []
        # How many requests were open at once, at most. Searches for unseen
        # ingredients are meant to go out together.
        self.in_flight = 0
        self.peak_in_flight = 0
        # How long each answer takes, for tests about requests that overlap.
        self.delay = 0.0

    async def respond(self, params: dict | None) -> httpx.Response:
        if self.error:
            raise httpx.ConnectError("no route to host")
        self.calls += 1
        params = params or {}
        self.searches.append(params)
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        # Yield, so concurrent requests overlap the way real ones would.
        await asyncio.sleep(self.delay)
        self.in_flight -= 1
        request = httpx.Request("GET", kroger.API_BASE + "/v1/products")

        if "filter.productId" in params:
            wanted = set(params["filter.productId"].split(","))
            data = [e for e in CATALOG.values() if e and e["productId"] in wanted]
            return httpx.Response(200, json={"data": data}, request=request)

        term = params.get("filter.term", "")
        entry = CATALOG.get(term)
        return httpx.Response(200, json={"data": [entry] if entry else []}, request=request)


@pytest.fixture
def catalog(monkeypatch):
    fake = FakeCatalog()

    async def fake_post(self, path, **kwargs):
        return httpx.Response(
            200,
            json={"access_token": "token-1", "expires_in": 1800},
            request=httpx.Request("POST", kroger.API_BASE + kroger.TOKEN_PATH),
        )

    async def fake_get(self, path, params=None, headers=None, **kwargs):
        if not str(self.base_url).startswith(kroger.API_BASE):
            return await _real_get(self, path, params=params, headers=headers, **kwargs)
        return await fake.respond(params)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "test-id")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(kroger, "_token", None)
    return fake


async def seed(ingredients: list[str], store: bool = True) -> None:
    async with session_factory() as session:
        recipe = Recipe(title="Test bake", servings=4)
        recipe.ingredients = [
            Ingredient(name=name, quantity=1, unit="cup", position=i)
            for i, name in enumerate(ingredients)
        ]
        session.add(recipe)
        await session.flush()
        session.add(MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=recipe.id))
        if store:
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


async def fetch(client) -> dict:
    """The list with its prices merged in, the way the page assembles them.

    Two requests since the split: the list itself, which makes no Kroger
    call, and the prices for it, fetched second.
    """
    resp = await client.get(f"/api/grocery-list?start={DAY}&end={DAY}")
    assert resp.status_code == 200
    grocery_list = resp.json()
    resp = await client.get(f"/api/grocery-list/prices?start={DAY}&end={DAY}")
    assert resp.status_code == 200
    prices = resp.json()
    by_key = {line["key"]: line for line in prices["lines"]}
    for item in [*grocery_list["items"], *grocery_list["pantry_restock"]]:
        line = by_key.get(item["key"])
        if line is not None:
            item["price"] = line["price"]
            item["hand_picked"] = line["hand_picked"]
            item["issue"] = line["issue"] or item["issue"]
    grocery_list["pricing"] = prices["pricing"]
    return grocery_list


async def test_lines_carry_a_price_and_the_total_says_what_it_covers(client, catalog):
    """Saffron matches nothing, so the total is over two of three lines and
    has to say so rather than quietly reading as the whole list."""
    await seed(["flour", "sugar", "saffron"])

    body = await fetch(client)

    by_name = {i["name"]: i for i in body["items"]}
    assert by_name["flour"]["price"]["regular"] == 2.59
    assert by_name["flour"]["price"]["description"] == "Kroger® All Purpose Flour"
    assert by_name["saffron"]["price"] is None

    # Sugar is on offer, so the trip pays the promotional price.
    assert by_name["sugar"]["price"]["promo"] == 2.99
    assert body["pricing"]["total"] == round(2.59 + 2.99, 2)
    assert body["pricing"]["priced"] == 2
    assert body["pricing"]["total_lines"] == 3
    assert body["pricing"]["store"]["name"] == "Kroger - Kroger Riverside"


async def test_loose_produce_is_estimated_for_the_amount_not_a_whole_pound(client, catalog):
    """A cup of jalapenos is 90 g of peppers sold loose at $1.99 a pound. The
    list used to charge the whole pound: the floor that stops a teaspoon of
    bacon costing pennies was catching produce, which sells in any amount."""
    await seed(["jalapeno"])

    body = await fetch(client)

    line = {i["name"]: i for i in body["items"]}["jalapeno"]
    assert line["price"]["regular"] == 1.99
    assert line["price"]["estimated"] == 0.39


async def test_the_list_survives_kroger_being_unreachable(client, catalog):
    """The list is the product. An outage takes the prices, not the list."""
    await seed(["flour", "sugar"])
    catalog.error = True

    body = await fetch(client)

    assert [i["name"] for i in body["items"]] == ["flour", "sugar"]
    assert body["pricing"] is None
    assert all(i["price"] is None for i in body["items"])


async def test_a_list_where_nothing_matched_claims_no_total(client, catalog):
    """"$0.00, 0 of 1 priced" says the shopping is free. It is also
    indistinguishable from an outage, since a failed search is skipped inside
    the matcher rather than raised, so the total is withheld instead."""
    await seed(["saffron"])

    body = await fetch(client)

    assert body["pricing"] is None
    assert body["items"][0]["price"] is None


async def test_no_store_chosen_leaves_the_list_alone(client, catalog):
    """Credentials but nowhere to price against. /pricing/status is what tells
    the client to prompt; the list itself just carries no prices."""
    await seed(["flour"], store=False)

    body = await fetch(client)

    assert body["pricing"] is None
    assert body["items"][0]["price"] is None


async def test_pricing_is_absent_without_credentials(client, monkeypatch):
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")
    await seed(["flour"])

    body = await fetch(client)

    assert body["pricing"] is None


async def test_stocked_items_are_not_priced_into_the_trip(client, catalog):
    """An in-pantry item is set aside precisely because it is not being
    bought, so counting it would inflate what the trip costs."""
    await seed(["flour", "sugar"])
    async with session_factory() as session:
        session.add(PantryItem(name="sugar", in_stock=True))
        await session.commit()

    body = await fetch(client)

    assert [i["name"] for i in body["in_pantry"]] == ["sugar"]
    assert body["pricing"]["total"] == 2.59
    assert body["pricing"]["total_lines"] == 1


async def test_a_second_load_does_not_search_again(client, catalog):
    """Matches are pinned, so a reload never searches; and prices are
    remembered for a few minutes, so a reload within them costs no Kroger
    call at all - which is what makes each tick in the aisle instant."""
    await seed(["flour", "sugar"])
    await fetch(client)
    after_first = catalog.calls

    await fetch(client)

    # Two searches plus one batch on the first load; nothing on the second.
    assert after_first == 3
    assert catalog.calls - after_first == 0


async def test_a_price_is_asked_for_again_once_it_has_aged(client, catalog, monkeypatch):
    """The memory is of the last answer, not a history: once it has aged the
    price is fetched again, in one batched call."""
    await seed(["flour", "sugar"])
    await fetch(client)
    monkeypatch.setattr(products, "PRICE_TTL_SECONDS", 0)
    products.forget_prices()
    after_first = catalog.calls

    await fetch(client)

    assert catalog.calls - after_first == 1


async def test_unseen_ingredients_are_searched_for_together(client, catalog):
    """Each search takes most of a second at Kroger's end, so a first load
    with ten new ingredients must not take eight of them."""
    await seed(["flour", "sugar", "saffron"])

    await fetch(client)

    # Three searches went out before any of them was answered.
    assert catalog.peak_in_flight == 3


async def test_the_total_says_what_the_offers_took_off_it(client, catalog):
    """Sugar is discounted from $3.99 to $2.99, so the trip saved a pound."""
    await seed(["flour", "sugar"])

    body = await fetch(client)

    assert body["pricing"]["total"] == round(2.59 + 2.99, 2)
    assert body["pricing"]["saved"] == 1.00


async def test_a_trip_with_no_offers_saved_nothing(client, catalog):
    await seed(["flour"])

    assert (await fetch(client))["pricing"]["saved"] == 0.0


async def test_a_line_already_at_home_is_not_priced_into_the_trip(client, catalog):
    """"Have it" means it is not being bought, so it comes out of the total
    and out of the count the total is quoted against. A tick does not: what
    is in the trolley is still paid for."""
    await seed(["flour", "sugar"])
    async with session_factory() as session:
        session.add(GroceryCheck(key="sugar", status="have"))
        await session.commit()

    body = await fetch(client)

    assert body["pricing"]["total"] == 2.59
    assert body["pricing"]["priced"] == 1
    assert body["pricing"]["total_lines"] == 1
    # Still on the list, in place, so it can be un-said - and still priced,
    # since the product is still what the line means. Only the total leaves
    # it out.
    by_name = {i["name"]: i for i in body["items"]}
    assert by_name["sugar"]["status"] == "have"
    assert by_name["sugar"]["price"]["description"] == "Kroger® Granulated Sugar"


async def test_a_ticked_line_is_still_paid_for(client, catalog):
    await seed(["flour", "sugar"])
    async with session_factory() as session:
        session.add(GroceryCheck(key="sugar", status="bought"))
        await session.commit()

    body = await fetch(client)

    assert body["pricing"]["total"] == round(2.59 + 2.99, 2)
    assert body["pricing"]["total_lines"] == 2


async def test_a_line_says_whether_its_product_was_chosen_by_hand(client, catalog):
    """A remembered choice the shopper cannot see is indistinguishable from a
    guess, and "back to automatic" only makes sense on a line that has left
    it. A line a person marked as not to be priced says so too, rather than
    reading as a miss."""
    await seed(["flour", "sugar", "saffron"])
    async with session_factory() as session:
        session.add(
            IngredientProductMatch(
                canonical_key="sugar", location_id=LOCATION,
                product_id="0002", user_confirmed=True,
            )
        )
        session.add(
            IngredientProductMatch(
                canonical_key="saffron", location_id=LOCATION,
                product_id=None, user_confirmed=True,
            )
        )
        await session.commit()

    by_name = {i["name"]: i for i in (await fetch(client))["items"]}

    assert by_name["flour"]["hand_picked"] is False
    assert by_name["sugar"]["hand_picked"] is True
    assert by_name["saffron"]["hand_picked"] is True
    assert by_name["saffron"]["price"] is None


async def test_forgetting_a_pick_lets_the_matcher_choose_again(client, catalog):
    """The way back from a hand pick - and the only way an automatic pick
    made under older rules gets remade under newer ones."""
    await seed(["flour"])
    async with session_factory() as session:
        session.add(
            IngredientProductMatch(
                canonical_key="flour", location_id=LOCATION,
                product_id=None, user_confirmed=True,
            )
        )
        await session.commit()
    assert (await fetch(client))["items"][0]["price"] is None

    resp = await client.delete("/api/pricing/match?key=flour")

    assert resp.status_code == 204
    line = (await fetch(client))["items"][0]
    assert line["price"]["description"] == "Kroger® All Purpose Flour"
    assert line["hand_picked"] is False


# ---------------------------------------------------------- recipe cost ---


async def make_recipe(title: str, ingredients: list[tuple], servings: int | None = 4) -> int:
    async with session_factory() as session:
        recipe = Recipe(title=title, servings=servings)
        recipe.ingredients = [
            Ingredient(name=name, quantity=quantity, unit=unit, position=i)
            for i, (name, quantity, unit) in enumerate(ingredients)
        ]
        session.add(recipe)
        await session.flush()
        recipe_id = recipe.id
        await session.commit()
        return recipe_id


async def cost_of(client, recipe_id: int) -> dict | None:
    resp = await client.get(f"/api/recipes/{recipe_id}/cost")
    assert resp.status_code == 200
    return resp.json()


async def test_a_recipe_is_costed_by_the_share_of_each_package_it_uses(client, catalog):
    """Two cups of flour is 250 g of a 2268 g bag: 11% of $2.59. A pound
    and a half of chicken sold by the pound is a pound and a half at the
    rate, with no floor - a costing is not a purchase."""
    await seed([])
    recipe_id = await make_recipe(
        "Chicken pie",
        [("flour", 2, "cup"), ("chicken thigh", 1.5, "lb")],
        servings=4,
    )

    body = await cost_of(client, recipe_id)

    by_name = {line["name"]: line for line in body["lines"]}
    assert by_name["flour"]["cost"] == 0.29
    assert by_name["flour"]["whole_package"] is False
    assert by_name["chicken thigh"]["cost"] == 6.0
    assert body["total"] == 6.29
    assert body["per_serving"] == 1.57
    assert body["priced"] == 2
    assert body["total_lines"] == 2
    assert body["store"]["name"] == "Kroger - Kroger Riverside"


async def test_an_amount_that_cannot_be_related_is_costed_whole_and_says_so(client, catalog):
    """"1 bunch parsley" against a bunch is right costed whole; "2 sprigs"
    against the same bunch would be ten times too much. Nothing can tell
    them apart, so the line carries the reason rather than hiding it."""
    await seed([])
    recipe_id = await make_recipe("Tabbouleh", [("parsley", 1, "bunch")])

    body = await cost_of(client, recipe_id)

    assert body["lines"][0]["cost"] == 1.29
    assert body["lines"][0]["whole_package"] is True


async def test_an_ingredient_with_no_amount_is_not_priced(client, catalog):
    """"Sugar, to taste" costed as a four pound bag would be wrong by a
    factor of a thousand, and the total would still look plausible."""
    await seed([])
    recipe_id = await make_recipe("Tea", [("sugar", None, None), ("flour", 1, "cup")])

    body = await cost_of(client, recipe_id)

    by_name = {line["name"]: line for line in body["lines"]}
    assert by_name["sugar"]["cost"] is None
    assert body["priced"] == 1
    assert body["total_lines"] == 2


async def test_a_recipe_without_servings_has_a_total_but_no_per_serving(client, catalog):
    await seed([])
    recipe_id = await make_recipe("Stock", [("flour", 1, "cup")], servings=None)

    body = await cost_of(client, recipe_id)

    assert body["total"] == 0.14
    assert body["per_serving"] is None


async def test_a_recipe_cost_is_null_without_a_store(client, catalog):
    await seed([], store=False)
    recipe_id = await make_recipe("Bread", [("flour", 1, "cup")])

    assert await cost_of(client, recipe_id) is None


async def test_a_recipe_cost_line_names_its_ingredient_and_who_chose_its_product(
    client, catalog
):
    """So the recipe page can offer the grocery list's correction: each line
    says which ingredient it is, and whether a person has already decided."""
    await seed([])
    recipe_id = await make_recipe("Paella", [("flour", 1, "cup"), ("saffron", 1, "tsp")])

    by_name = {line["name"]: line for line in (await cost_of(client, recipe_id))["lines"]}
    assert by_name["saffron"]["key"] == "saffron"
    assert by_name["saffron"]["product"] is None
    assert by_name["saffron"]["hand_picked"] is False

    resp = await client.put(
        "/api/pricing/match", json={"canonical_key": "saffron", "product_id": None}
    )
    assert resp.status_code == 204

    by_name = {line["name"]: line for line in (await cost_of(client, recipe_id))["lines"]}
    assert by_name["saffron"]["hand_picked"] is True


# ------------------------------------------------------------ plan cost ---


async def plan_cost(client, start=DAY, end=DAY) -> dict | None:
    resp = await client.get(f"/api/meal-plan/cost?start={start}&end={end}")
    assert resp.status_code == 200
    return resp.json()


async def test_a_week_of_meals_is_costed_at_its_planned_servings(client, catalog):
    """The recipe serves four and is planned for eight, so the week uses
    twice the flour. The grocery total for the same days rides along: it
    buys the whole bag, and the gap is what stays in the cupboard."""
    await seed([])
    recipe_id = await make_recipe("Bread", [("flour", 2, "cup")], servings=4)
    async with session_factory() as session:
        session.add(
            MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=recipe_id, servings=8)
        )
        await session.commit()

    body = await plan_cost(client)

    assert body["total"] == 0.57
    assert body["priced"] == 1
    assert body["total_lines"] == 1
    assert body["days"] == [
        {"plan_date": str(DAY), "total": 0.57, "priced": 1, "total_lines": 1}
    ]
    assert body["grocery_total"] == 2.59


async def test_each_planned_meal_is_costed_on_its_own_as_well_as_in_its_day(client, catalog):
    """The planner puts a figure on every meal, not only on its day, so the
    entries a day is summed from come back too. Each carries its own
    coverage: the paella's saffron matched nothing, so its figure is a floor
    and has to be able to say so."""
    await seed([])
    bread = await make_recipe("Bread", [("flour", 2, "cup")], servings=4)
    paella = await make_recipe("Paella", [("flour", 1, "cup"), ("saffron", 1, "tsp")])
    async with session_factory() as session:
        loaf = MealPlanEntry(plan_date=DAY, meal="breakfast", recipe_id=bread, servings=8)
        rice = MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=paella)
        session.add_all([loaf, rice])
        await session.commit()
        loaf_id, rice_id = loaf.id, rice.id

    body = await plan_cost(client)

    # Keyed, since `seed` plans an empty recipe on the same day.
    by_entry = {entry["entry_id"]: entry for entry in body["entries"]}
    assert by_entry[loaf_id] == {"entry_id": loaf_id, "total": 0.57, "priced": 1, "total_lines": 1}
    assert by_entry[rice_id] == {"entry_id": rice_id, "total": 0.14, "priced": 1, "total_lines": 2}
    assert body["days"] == [
        {"plan_date": str(DAY), "total": 0.71, "priced": 2, "total_lines": 3}
    ]


async def test_plan_cost_is_null_without_a_store(client, catalog):
    await seed([], store=False)

    assert await plan_cost(client) is None


async def test_plan_cost_refuses_a_range_that_runs_backwards(client, catalog):
    await seed([])

    resp = await client.get(f"/api/meal-plan/cost?start={DAY}&end=2026-08-01")

    assert resp.status_code == 422


# ---------------------------------------------------------- suggestions ---


async def test_the_old_suggestions_endpoint_is_gone(client):
    assert (await client.get("/api/recipes/suggestions")).status_code != 200


# ----------------------------------------------------- list then prices ---


async def test_the_list_itself_makes_no_kroger_call(client, catalog):
    """The list is served from the database alone and the prices fetched
    second, so the page never waits on Kroger to show what to buy."""
    await seed(["flour", "sugar"])

    resp = await client.get(f"/api/grocery-list?start={DAY}&end={DAY}")

    assert resp.status_code == 200
    assert catalog.calls == 0
    assert resp.json()["pricing"] is None
    assert all(i["price"] is None for i in resp.json()["items"])


async def test_prices_are_keyed_to_the_lines_they_belong_to(client, catalog):
    await seed(["flour", "sugar", "saffron"])

    resp = await client.get(f"/api/grocery-list/prices?start={DAY}&end={DAY}")

    assert resp.status_code == 200
    body = resp.json()
    by_key = {line["key"]: line for line in body["lines"]}
    assert by_key["flour"]["price"]["regular"] == 2.59
    assert by_key["saffron"]["price"] is None
    assert by_key["saffron"]["issue"] == "no_match"
    assert body["pricing"]["priced"] == 2


async def test_prices_are_empty_rather_than_an_error_without_a_store(client, catalog):
    await seed(["flour"], store=False)

    resp = await client.get(f"/api/grocery-list/prices?start={DAY}&end={DAY}")

    assert resp.status_code == 200
    assert resp.json()["pricing"] is None
    assert resp.json()["lines"][0]["price"] is None


# ------------------------------------------------------------- issues ---


async def test_a_line_says_why_its_number_is_doubtful(client, catalog):
    """One vocabulary for both halves: the recipe side needs no store and
    rides on the list; the product side rides on the prices."""
    await seed([])
    salsa = await make_recipe(
        "Salsa",
        [
            ("Optional: 1 diced ripe avocado", None, None),
            ("lettuce", None, None),
            ("saffron", 1, "g"),
            ("flour", 6, "packet"),
        ],
    )
    async with session_factory() as session:
        session.add(MealPlanEntry(plan_date=DAY, meal="dinner", recipe_id=salsa))
        await session.commit()

    listed = (await client.get(f"/api/grocery-list?start={DAY}&end={DAY}")).json()
    by_key = {i["key"]: i["issue"] for i in listed["items"]}
    assert by_key["1-avocado"] == "amount_in_name"
    assert by_key["lettuce"] == "no_amount"
    assert by_key["saffron"] is None
    assert by_key["flour"] is None

    body = await fetch(client)
    by_key = {i["key"]: i["issue"] for i in body["items"]}
    assert by_key["1-avocado"] == "amount_in_name"
    assert by_key["saffron"] == "no_match"
    # Six packets against a five pound bag cannot be related.
    assert by_key["flour"] == "unsized"


async def test_a_line_left_unpriced_on_purpose_is_not_a_problem(client, catalog):
    await seed(["saffron"])
    async with session_factory() as session:
        await matching.confirm(session, "saffron", LOCATION, None)

    body = await fetch(client)

    assert body["items"][0]["issue"] is None


async def test_recipes_needing_a_look_are_listed_with_their_rows(client, catalog):
    """The same checks grouped by recipe, plus what the store could not match
    - from picks already made, never a search."""
    await seed(["flour", "saffron"])
    await fetch(client)
    salsa = await make_recipe(
        "Salsa", [("Optional: 1 diced ripe avocado", None, None), ("flour", 1, "cup")]
    )
    await make_recipe("Bread", [("flour", 2, "cup")])
    calls_before = catalog.calls

    resp = await client.get("/api/recipes/attention")

    assert resp.status_code == 200
    body = resp.json()
    assert [r["recipe"]["title"] for r in body] == ["Test bake", "Salsa"]
    # Saffron has no food to count it as either, which is a second fault
    # with its own fix; see test_attention.
    assert [(i["name"], i["issue"], i["affects"]) for i in body[0]["issues"]] == [
        ("saffron", "no_match", ["price"]),
        ("saffron", "no_food", ["nutrition"]),
    ]
    assert body[1]["recipe"]["id"] == salsa
    assert [(i["name"], i["issue"], i["affects"]) for i in body[1]["issues"]] == [
        ("Optional: 1 diced ripe avocado", "amount_in_name", ["price", "nutrition"])
    ]
    assert catalog.calls == calls_before


# ------------------------------------------------------- sale percentages ---


async def listing(client, **params) -> dict:
    resp = await client.get("/api/recipes", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def sale_percents(client, **params) -> dict[str, int | None]:
    return {r["title"]: r["sale_percent"] for r in (await listing(client, **params))["items"]}


async def test_a_recipe_mostly_on_offer_carries_its_sale_percent(client, catalog):
    """A recipe of only sugar is as discounted as sugar is: 2.99 against 3.99
    is 25.06% off, and the ribbon rounds down rather than promising 26."""
    await seed(["sugar"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])

    assert await sale_percents(client) == {"Sugar cookies": 25, "Test bake": 25}


async def test_a_small_discount_does_not_make_a_recipe_on_sale(client, catalog):
    """A cup of sugar is 200 g of a 2268 g bag: $0.35 regular, $0.26 today.
    Eight cups of flour is 1000 g of a $2.59 bag: $1.14. The 9 cents off
    $1.49 is 5.9%, under the 15% it takes."""
    await seed(["flour", "sugar"])
    await fetch(client)
    await make_recipe("Flour heavy", [("sugar", 1, "cup"), ("flour", 8, "cup")])

    assert (await sale_percents(client))["Flour heavy"] is None


async def test_a_recipe_mostly_unpriced_is_never_on_sale(client, catalog):
    """Sugar is 25% off, but saffron never matched: half the recipe is
    unknown, and a discount on the half that is known proves nothing."""
    await seed(["sugar", "saffron"])
    await fetch(client)
    await make_recipe("Saffron cake", [("sugar", 1, "cup"), ("saffron", 1, "g")])

    assert (await sale_percents(client))["Saffron cake"] is None


async def test_the_on_sale_filter_keeps_only_recipes_on_sale(client, catalog):
    await seed(["flour", "sugar", "saffron"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    await make_recipe("Plain bread", [("flour", 1, "cup")])

    body = await listing(client, on_sale=True)

    assert [r["title"] for r in body["items"]] == ["Sugar cookies"]
    assert body["total"] == 1


async def test_the_ingredient_filter_and_the_on_sale_filter_both_apply(client, catalog):
    """Flour heavy uses sugar but is only 5.9% off, so it is in the sugar
    list and out of the sugar list on sale; flour-only Plain bread is on
    neither."""
    await seed(["flour", "sugar"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    await make_recipe("Flour heavy", [("sugar", 1, "cup"), ("flour", 8, "cup")])
    await make_recipe("Plain bread", [("flour", 1, "cup")])

    using_sugar = {r["title"] for r in (await listing(client, ingredient=["sugar"]))["items"]}
    on_sale = await listing(client, ingredient=["sugar"], on_sale=True)
    both = {r["title"] for r in on_sale["items"]}

    assert {"Sugar cookies", "Flour heavy"} <= using_sugar
    assert "Plain bread" not in using_sugar
    assert "Sugar cookies" in both
    assert "Flour heavy" not in both
    assert "Plain bread" not in both


async def test_biggest_sale_sorts_by_percent_then_title(client, catalog):
    """Sugar alone is 25%. Adding a cup of flour ($0.14 at regular) dilutes
    the 9 cents off $0.49 to 17.8%, so 17. Test bake has saffron, so it is
    not on sale and sorts with the rest, A-Z."""
    await seed(["flour", "sugar", "saffron"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    await make_recipe("Apple sugar cookies", [("sugar", 1, "cup")])
    await make_recipe("Sugar bread", [("sugar", 1, "cup"), ("flour", 1, "cup")])
    await make_recipe("Plain bread", [("flour", 1, "cup")])

    body = await listing(client, sort="sale")

    assert [(r["title"], r["sale_percent"]) for r in body["items"]] == [
        ("Apple sugar cookies", 25),
        ("Sugar cookies", 25),
        ("Sugar bread", 17),
        ("Plain bread", None),
        ("Test bake", None),
    ]


async def test_the_list_answers_without_sale_data_when_kroger_is_down(
    client, catalog, monkeypatch
):
    await seed(["sugar"])
    await fetch(client)

    async def down(*args, **kwargs):
        raise kroger.KrogerError("down")

    monkeypatch.setattr(products, "by_ids", down)

    assert await sale_percents(client) == {"Test bake": None}
    assert (await listing(client, on_sale=True))["total"] == 0
    assert [r["title"] for r in (await listing(client, sort="sale"))["items"]] == ["Test bake"]


async def test_facets_and_suggestions_answer_without_sale_data_when_kroger_is_down(
    client, catalog, monkeypatch
):
    await seed(["sugar"])
    await fetch(client)
    cookies = await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    async with session_factory() as session:
        session.add(RecipeTag(recipe_id=cookies, name="sweet"))
        await session.commit()

    # Sugar is on offer, so with Kroger up the outage below is what changes it.
    assert (await client.get("/api/recipes/facets")).json()["on_sale"] >= 1

    async def down(*args, **kwargs):
        raise kroger.KrogerError("down")

    monkeypatch.setattr(products, "by_ids", down)

    facets = await client.get("/api/recipes/facets")
    suggested = await client.get("/api/recipes/suggest", params={"text": "sug"})
    sweet = await client.get("/api/recipes/suggest", params={"text": "swe"})

    assert facets.status_code == 200, facets.text
    # No sale data, not "none on sale": the page shows no On sale chip.
    assert facets.json()["on_sale"] is None
    assert facets.json()["tags"] == [{"name": "sweet", "count": 1}]
    assert suggested.status_code == 200, suggested.text
    assert [i["name"] for i in suggested.json()["ingredients"]] == ["sugar"]
    assert [r["title"] for r in suggested.json()["recipes"]] == ["Sugar cookies"]
    assert sweet.json()["tags"] == [{"name": "sweet", "count": 1}]


async def test_no_store_means_nothing_is_on_sale(client, catalog):
    await seed(["sugar"], store=False)

    assert await sale_percents(client) == {"Test bake": None}
    assert (await listing(client, on_sale=True))["total"] == 0


async def test_facets_count_the_recipes_on_sale_within_the_filters(client, catalog):
    await seed(["flour", "sugar"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    await make_recipe("Plain bread", [("flour", 1, "cup")])

    everything = await client.get("/api/recipes/facets")
    narrowed = await client.get("/api/recipes/facets", params={"q": "bread"})

    # Sugar cookies and the fixture's Test bake are on sale; bread is not.
    assert everything.json()["on_sale"] == 2
    assert narrowed.json()["on_sale"] == 0


# ------------------------------------------- sale data never holds the list ---


async def cold_prices(client) -> None:
    """Picks made and Sugar cookies on offer, with no price remembered yet."""
    await seed(["sugar"])
    await fetch(client)
    await make_recipe("Sugar cookies", [("sugar", 1, "cup")])
    products.forget_prices()


async def test_the_list_answers_without_sale_data_while_kroger_hangs(
    client, catalog, monkeypatch
):
    """A Kroger that never answers costs the list a bounded wait, not its
    own ten second timeout. The lookup is not abandoned: when it does answer,
    the next list has its prices."""
    await cold_prices(client)
    release = asyncio.Event()
    lookups: list[asyncio.Task] = []
    real_by_ids = products.by_ids

    async def hanging(product_ids, location_id):
        lookups.append(asyncio.current_task())
        await release.wait()
        return await real_by_ids(product_ids, location_id)

    monkeypatch.setattr(products, "by_ids", hanging)

    body = await asyncio.wait_for(listing(client), timeout=3)
    facets = await asyncio.wait_for(client.get("/api/recipes/facets"), timeout=3)

    assert {r["title"]: r["sale_percent"] for r in body["items"]} == {
        "Sugar cookies": None,
        "Test bake": None,
    }
    assert facets.json()["on_sale"] is None
    # The facets did not start a second lookup, or wait on the first again.
    assert len(lookups) == 1

    release.set()
    await lookups[0]

    assert await sale_percents(client) == {"Sugar cookies": 25, "Test bake": 25}


async def test_requests_made_together_share_one_kroger_lookup(client, catalog):
    """The page asks for the list and the facets at once; on a cold memory
    they would otherwise fetch the same products twice."""
    await cold_prices(client)
    catalog.delay = 0.05
    before = catalog.calls

    listed, facets = await asyncio.gather(listing(client), client.get("/api/recipes/facets"))

    assert listed["items"][0]["sale_percent"] == 25
    assert facets.json()["on_sale"] == 2
    assert catalog.calls - before == 1


async def test_a_product_kroger_no_longer_carries_is_not_asked_for_every_list(
    client, catalog
):
    """A pick whose product Kroger stopped returning is remembered as absent
    for as long as a price is, rather than asked about on every request."""
    await cold_prices(client)
    await make_recipe("Gone", [("vanilla", 1, "tsp")])
    async with session_factory() as session:
        session.add(
            IngredientProductMatch(
                canonical_key="vanilla",
                location_id=LOCATION,
                product_id="0099",
                user_confirmed=True,
                matcher_version=matching.MATCHER_VERSION,
            )
        )
        await session.commit()
    await listing(client)
    before = catalog.calls

    await listing(client)
    await listing(client, page=2)

    assert catalog.calls == before


async def test_an_outage_is_remembered_for_a_while(client, catalog, monkeypatch):
    """A failed lookup is not retried on every request: the page fires
    several at once, and each would wait on Kroger again. Once the memory has
    passed, the next request asks again."""
    await cold_prices(client)
    attempts = 0

    async def down(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        raise kroger.KrogerError("down")

    monkeypatch.setattr(products, "by_ids", down)

    await listing(client)
    await client.get("/api/recipes/facets")
    assert attempts == 1

    monkeypatch.setattr(products, "UNREACHABLE_SECONDS", 0)
    await listing(client)
    assert attempts == 2


async def test_suggestions_ask_kroger_nothing_unless_on_sale_is_picked(client, catalog):
    """Without the On sale token the suggestions never use sale data, so
    computing it would only be a wait."""
    await cold_prices(client)
    before = catalog.calls

    resp = await client.get("/api/recipes/suggest", params={"text": "sug"})

    assert resp.status_code == 200
    assert catalog.calls == before


async def test_a_new_pick_changes_the_sale_at_once(client, catalog):
    """Nothing about a recipe's sale is remembered beyond its products'
    prices, so picking another product shows on the next list."""
    await cold_prices(client)
    assert (await sale_percents(client))["Sugar cookies"] == 25

    async with session_factory() as session:
        await matching.confirm(session, "sugar", LOCATION, "0001")

    assert (await sale_percents(client))["Sugar cookies"] is None
