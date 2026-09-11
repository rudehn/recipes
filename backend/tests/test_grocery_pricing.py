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

    async def respond(self, params: dict | None) -> httpx.Response:
        if self.error:
            raise httpx.ConnectError("no route to host")
        self.calls += 1
        params = params or {}
        self.searches.append(params)
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        # Yield, so concurrent requests overlap the way real ones would.
        await asyncio.sleep(0)
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


async def suggestions(client) -> dict:
    resp = await client.get("/api/recipes/suggestions")
    assert resp.status_code == 200
    return resp.json()


async def test_offers_are_listed_as_the_recipes_they_would_go_into(client, catalog):
    """Built from matches that exist only because a list was opened. Nothing
    is searched for, so this notices an offer rather than gathering a
    catalogue. And it answers as recipes rather than ingredients: a discount
    on sugar is only interesting as a reason to bake something."""
    await seed(["flour", "sugar"])
    await fetch(client)

    body = (await suggestions(client))["on_sale"]
    assert [r["recipe"]["title"] for r in body] == ["Test bake"]
    # Flour is matched but not discounted, so only sugar is an offer.
    assert [s["name"] for s in body[0]["on_sale"]] == ["sugar"]
    assert body[0]["on_sale"][0]["price"]["promo"] == 2.99
    assert body[0]["on_sale"][0]["price"]["regular"] == 3.99
    assert body[0]["ingredient_count"] == 2


async def test_recipes_with_more_of_themselves_on_offer_come_first(client, catalog):
    """Two of two ingredients discounted is a reason to cook the thing; one of
    three is a coincidence. A recipe with nothing on offer is not listed."""
    await seed(["flour", "sugar", "saffron"])
    await fetch(client)
    async with session_factory() as session:
        for title, names in [("Sugar cookies", ["sugar"]), ("Plain bread", ["flour"])]:
            recipe = Recipe(title=title, servings=4)
            recipe.ingredients = [
                Ingredient(name=n, quantity=1, unit="cup", position=i)
                for i, n in enumerate(names)
            ]
            session.add(recipe)
        await session.commit()

    body = (await suggestions(client))["on_sale"]

    assert [r["recipe"]["title"] for r in body] == ["Sugar cookies", "Test bake"]


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


async def test_offers_are_empty_before_anything_has_been_matched(client, catalog):
    """No searching happens here, so with nothing matched there is nothing to
    re-price - not an error, just an empty shelf."""
    await seed(["flour"], store=True)

    assert (await suggestions(client))["on_sale"] == []


async def test_offers_are_empty_rather_than_an_error_without_a_store(client, catalog):
    await seed(["flour"], store=False)

    assert (await suggestions(client))["on_sale"] == []


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


async def test_plan_cost_is_null_without_a_store(client, catalog):
    await seed([], store=False)

    assert await plan_cost(client) is None


async def test_plan_cost_refuses_a_range_that_runs_backwards(client, catalog):
    await seed([])

    resp = await client.get(f"/api/meal-plan/cost?start={DAY}&end=2026-08-01")

    assert resp.status_code == 422


# ---------------------------------------------------------- suggestions ---


async def test_cheap_recipes_are_those_under_the_median_per_serving(client, catalog):
    """Below the median across the box, never against a price history. Only
    answered from products already decided on: nothing here searches."""
    await seed(["flour", "sugar"])
    await fetch(client)
    await make_recipe("Flatbread", [("flour", 1, "cup")], servings=4)
    await make_recipe("Cake", [("flour", 2, "cup"), ("sugar", 2, "cup")], servings=4)
    await make_recipe("Candy", [("sugar", 4, "cup")], servings=2)
    searches_before = catalog.calls
    requests_before = len(catalog.searches)

    body = await suggestions(client)

    # Per serving: Flatbread $0.04, "Test bake" from `seed` at a cup of each
    # $0.10, Cake $0.20, Candy $0.53 (200 g of sugar a cup against a 5 lb bag
    # at the sale price). The median of four is $0.15, so two are under it.
    assert [c["recipe"]["title"] for c in body["cheap"]] == ["Flatbread", "Test bake"]
    assert body["cheap"][0]["per_serving"] == 0.04
    assert body["median_per_serving"] == 0.15
    # One batched price lookup, and not one search.
    assert catalog.calls - searches_before <= 2
    assert all("filter.term" not in c for c in catalog.searches[requests_before:])


async def test_a_half_costed_recipe_is_not_called_cheap(client, catalog):
    """Saffron never matches, so Risotto is half priced - which is not the
    same as half price."""
    await seed(["flour", "sugar", "saffron"])
    await fetch(client)
    await make_recipe("Risotto", [("saffron", 1, "g"), ("flour", 1, "cup")], servings=4)
    await make_recipe("Flatbread", [("flour", 1, "cup")], servings=4)
    await make_recipe("Cake", [("flour", 2, "cup"), ("sugar", 2, "cup")], servings=4)

    body = await suggestions(client)

    assert "Risotto" not in [c["recipe"]["title"] for c in body["cheap"]]


async def test_too_few_costed_recipes_means_no_median(client, catalog):
    """"Below the median of two" is just "the cheaper one"."""
    await seed(["flour"])
    await fetch(client)
    await make_recipe("Flatbread", [("flour", 1, "cup")], servings=4)

    body = await suggestions(client)

    assert body["cheap"] == []
    assert body["median_per_serving"] is None


async def test_recipes_mostly_in_the_pantry_are_suggested_without_kroger(client, monkeypatch):
    """The one signal that needs no price at all, so it answers even when
    pricing is off."""
    monkeypatch.setattr(config, "KROGER_CLIENT_ID", "")
    monkeypatch.setattr(config, "KROGER_CLIENT_SECRET", "")
    await make_recipe("Pasta", [("pasta", 1, "lb"), ("olive oil", 2, "tbsp"), ("garlic", 2, None)])
    await make_recipe(
        "Curry", [("chicken", 1, "lb"), ("rice", 1, "cup"), ("curry paste", 2, "tbsp")]
    )
    async with session_factory() as session:
        for name in ["Pasta", "Olive oil", "garlic", "rice"]:
            session.add(PantryItem(name=name, in_stock=True))
        await session.commit()

    body = await suggestions(client)

    assert [p["recipe"]["title"] for p in body["pantry"]] == ["Pasta"]
    assert body["pantry"][0]["in_pantry"] == 3
    assert body["pantry"][0]["total_lines"] == 3
    assert body["on_sale"] == []
    assert body["cheap"] == []


# ------------------------------------------------------ remembered picks ---


async def test_every_remembered_pick_can_be_seen_together(client, catalog):
    await seed(["flour", "sugar", "saffron"])
    await fetch(client)
    async with session_factory() as session:
        await matching.confirm(session, "sugar", LOCATION, "0002")

    resp = await client.get("/api/pricing/matches")

    assert resp.status_code == 200
    body = {p["key"]: p for p in resp.json()}
    assert body["flour"]["hand_picked"] is False
    assert body["flour"]["product"]["description"] == "Kroger® All Purpose Flour"
    assert body["sugar"]["hand_picked"] is True
    assert body["saffron"]["product"] is None
    assert body["saffron"]["name"] == "saffron"


async def test_remembered_picks_need_a_store(client, catalog):
    await seed([], store=False)

    assert (await client.get("/api/pricing/matches")).status_code == 409


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
    assert [r["recipe"]["title"] for r in body] == ["Salsa", "Test bake"]
    assert body[0]["recipe"]["id"] == salsa
    assert [(i["name"], i["issue"]) for i in body[0]["issues"]] == [
        ("Optional: 1 diced ripe avocado", "amount_in_name")
    ]
    assert [(i["name"], i["issue"]) for i in body[1]["issues"]] == [("saffron", "no_match")]
    assert catalog.calls == calls_before
