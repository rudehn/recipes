"""Merging two names into one ingredient, and taking a merge back.

A merge has to carry what was decided about the merged-away name to the
name that survives - its product at each store, its food, its staple, and
this trip's ticks and cart lines - or the owner's earlier work is lost the
moment they tidy up. Where both names had a decision and no rule can choose,
the merge asks rather than guessing. And a merge that would make a cycle or
point at nothing is refused with a sentence the page can show.
"""

import pytest
from sqlalchemy import select

from app.db import session_factory
from app.models import (
    CartSentLine,
    GroceryCheck,
    IngredientFoodMatch,
    IngredientMerge,
    IngredientProductMatch,
    PantryItem,
)
from app.schemas import MergeChoices
from app.services import merges
from app.services.identity import Identity

STORE = "01400765"
OTHER_STORE = "01400999"


async def recipe(client, *names: str) -> None:
    resp = await client.post(
        "/api/recipes",
        json={
            "title": names[0],
            "ingredients": [{"name": n, "quantity": 1, "unit": "tsp"} for n in names],
        },
    )
    assert resp.status_code == 201, resp.text


async def add(*rows) -> None:
    async with session_factory() as session:
        session.add_all(rows)
        await session.commit()


async def do_merge(from_key: str, to_key: str, **choices) -> None:
    async with session_factory() as session:
        await merges.merge(session, from_key, to_key, MergeChoices(**choices))


async def rows(model) -> list:
    async with session_factory() as session:
        return list((await session.execute(select(model))).scalars())


def product(key: str, product_id: str | None, hand: bool, store: str = STORE):
    return IngredientProductMatch(
        canonical_key=key, location_id=store, product_id=product_id, user_confirmed=hand
    )


async def test_a_product_moves_to_a_target_that_has_none(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=False))

    await do_merge("ground-cumin", "cumin")

    assert [(r.canonical_key, r.product_id) for r in await rows(IngredientProductMatch)] == [
        ("cumin", "111")
    ]


async def test_a_hand_pick_beats_an_automatic_one_at_each_store(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        product("ground-cumin", "111", hand=True),
        product("cumin", "222", hand=False),
        product("ground-cumin", "333", hand=False, store=OTHER_STORE),
        product("cumin", "444", hand=True, store=OTHER_STORE),
    )

    await do_merge("ground-cumin", "cumin")

    found = {
        (r.canonical_key, r.location_id): r.product_id for r in await rows(IngredientProductMatch)
    }
    assert found == {("cumin", STORE): "111", ("cumin", OTHER_STORE): "444"}


async def test_two_different_hand_picks_need_a_choice(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=True), product("cumin", "222", hand=True))

    with pytest.raises(merges.MergeNeedsChoice) as refused:
        await do_merge("ground-cumin", "cumin")
    assert refused.value.needs == ["product"]
    assert await rows(IngredientMerge) == []

    await do_merge("ground-cumin", "cumin", product="from")
    assert [r.product_id for r in await rows(IngredientProductMatch)] == ["111"]


async def test_foods_move_with_their_state_words(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        IngredientFoodMatch(key="ground-cumin", fdc_id=170923),
        IngredientFoodMatch(key="cooked-ground-cumin", fdc_id=None),
    )

    await do_merge("ground-cumin", "cumin")

    assert {(r.key, r.fdc_id) for r in await rows(IngredientFoodMatch)} == {
        ("cumin", 170923),
        ("cooked-cumin", None),
    }


async def test_two_staples_become_the_one_chosen(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        PantryItem(name="Ground Cumin", in_stock=False), PantryItem(name="Cumin", in_stock=True)
    )

    with pytest.raises(merges.MergeNeedsChoice) as refused:
        await do_merge("ground-cumin", "cumin")
    assert refused.value.needs == ["staple"]

    await do_merge("ground-cumin", "cumin", staple="from")
    assert [(p.name, p.in_stock) for p in await rows(PantryItem)] == [("Ground Cumin", False)]


async def test_one_staple_is_left_alone_and_now_covers_both(client):
    await recipe(client, "ground cumin", "cumin")
    await add(PantryItem(name="Ground Cumin", in_stock=True))

    await do_merge("ground-cumin", "cumin")

    assert [p.name for p in await rows(PantryItem)] == ["Ground Cumin"]
    async with session_factory() as session:
        assert (await Identity.of(session)).key("Ground Cumin") == "cumin"


async def test_ticks_and_cart_lines_follow_mid_trip(client):
    await recipe(client, "ground cumin", "cumin")
    await add(
        GroceryCheck(key="ground-cumin", status="bought"),
        GroceryCheck(key="cumin", status="have"),
        CartSentLine(key="ground-cumin", upc="0001", description="Ground Cumin", quantity=1),
    )

    await do_merge("ground-cumin", "cumin")

    assert [(c.key, c.status) for c in await rows(GroceryCheck)] == [("cumin", "have")]
    assert [(c.key, c.upc) for c in await rows(CartSentLine)] == [("cumin", "0001")]


async def test_merging_onward_repoints_earlier_merges(client):
    await recipe(client, "ground cumin", "cumin", "cumin seed")
    await do_merge("ground-cumin", "cumin")

    await do_merge("cumin", "cumin-seed")

    assert {(m.from_key, m.to_key) for m in await rows(IngredientMerge)} == {
        ("ground-cumin", "cumin-seed"),
        ("cumin", "cumin-seed"),
    }


@pytest.mark.parametrize(
    "from_key, to_key, message",
    [
        ("cumin", "cumin", "cannot be merged into itself"),
        ("ground-cumin", "paprika", "already merged"),
        ("cumin", "ground-cumin", "already merged"),
    ],
)
async def test_refusals(client, from_key, to_key, message):
    await recipe(client, "ground cumin", "cumin", "paprika")
    await do_merge("ground-cumin", "cumin")

    with pytest.raises(merges.MergeRefused, match=message):
        await do_merge(from_key, to_key)


async def test_an_unknown_name_cannot_be_merged(client):
    await recipe(client, "cumin")

    with pytest.raises(merges.MergeUnknown):
        await do_merge("saffron", "cumin")


async def test_unmerge_deletes_the_merge_and_nothing_else(client):
    await recipe(client, "ground cumin", "cumin")
    await add(product("ground-cumin", "111", hand=True))
    await do_merge("ground-cumin", "cumin")

    async with session_factory() as session:
        await merges.unmerge(session, "ground-cumin")
        assert (await Identity.of(session)).key("ground cumin") == "ground-cumin"

    assert await rows(IngredientMerge) == []
    assert [(r.canonical_key, r.product_id) for r in await rows(IngredientProductMatch)] == [
        ("cumin", "111")
    ]


async def test_unmerging_what_is_not_merged_is_unknown(client):
    async with session_factory() as session:
        with pytest.raises(merges.MergeUnknown):
            await merges.unmerge(session, "cumin")
