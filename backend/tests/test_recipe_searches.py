"""The searches a recipe was opened from are remembered on the server.

Recent searches are the distinct searches in an event log, newest first, and
the most-searched tags count the log's rows. Typed text is kept as typed, and
an ingredient named by a search follows the owner's merges when it is read
back, so an old entry never goes stale.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.db import session_factory
from app.models import IngredientMerge, RecipeSearch
from app.services.search_history import tag_frequency


async def record(client, **search) -> None:
    resp = await client.post("/api/recipes/searches", json=search)
    assert resp.status_code == 204, resp.text


async def recent(client, **params) -> list[dict]:
    resp = await client.get("/api/recipes/searches", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def entry(text="", tags=(), ingredients=(), on_sale=False) -> dict:
    return {
        "text": text,
        "tags": list(tags),
        "ingredients": [{"key": k, "name": n} for k, n in ingredients],
        "on_sale": on_sale,
    }


def without_signature(rows: list[dict]) -> list[dict]:
    return [{k: v for k, v in row.items() if k != "signature"} for row in rows]


async def test_a_recorded_search_comes_back_as_recent(client):
    await record(client, text="curry", tags=["dinner"], on_sale=True)

    rows = await recent(client)

    assert without_signature(rows) == [entry("curry", ["dinner"], on_sale=True)]
    assert rows[0]["signature"]


async def test_the_same_search_twice_is_listed_once_at_the_top(client):
    await record(client, tags=["dinner", "quick"])
    await record(client, text="soup")
    await record(client, tags=["QUICK", "dinner"])

    rows = await recent(client)

    assert without_signature(rows) == [entry(tags=["quick", "dinner"]), entry("soup")]


async def test_an_empty_search_is_not_recorded(client):
    await record(client)
    await record(client, text="   ")

    assert await recent(client) == []


async def test_forgetting_a_search_removes_every_time_it_was_made(client):
    await record(client, tags=["dinner"])
    await record(client, text="soup")
    await record(client, tags=["dinner"])
    rows = await recent(client)
    dinner = next(r for r in rows if r["tags"] == ["dinner"])

    resp = await client.delete("/api/recipes/searches", params={"signature": dinner["signature"]})

    assert resp.status_code == 204
    assert without_signature(await recent(client)) == [entry("soup")]
    async with session_factory() as session:
        assert len((await session.execute(select(RecipeSearch))).scalars().all()) == 1


async def test_text_is_kept_exactly_as_typed(client):
    await record(client, text='  100% "egg roll"  ')

    assert (await recent(client))[0]["text"] == '100% "egg roll"'


async def test_recent_names_ingredients_and_follows_merges(client):
    await client.post(
        "/api/recipes",
        json={
            "title": "Chili",
            "servings": 2,
            "ingredients": [{"name": "Cumin", "quantity": 1, "unit": "tsp"}],
        },
    )
    await record(client, ingredients=["ground-cumin", "mystery-root"])
    async with session_factory() as session:
        session.add(IngredientMerge(from_key="ground-cumin", to_key="cumin"))
        await session.commit()

    rows = await recent(client)

    assert without_signature(rows) == [
        entry(ingredients=[("cumin", "Cumin"), ("mystery-root", "mystery root")])
    ]


async def test_searches_older_than_sixty_days_are_dropped(client):
    async with session_factory() as session:
        session.add(
            RecipeSearch(
                signature="old",
                text="old",
                tags=["stale"],
                ingredients=[],
                on_sale=False,
                searched_at=datetime.now(UTC) - timedelta(days=61),
            )
        )
        await session.commit()
    assert await recent(client) == []
    await record(client, text="new")

    assert [r["text"] for r in await recent(client)] == ["new"]
    async with session_factory() as session:
        rows = (await session.execute(select(RecipeSearch.signature))).scalars().all()
        assert "old" not in rows
        assert len(rows) == 1


async def test_tags_are_counted_once_per_row_inside_the_window(client):
    await record(client, tags=["dinner", "quick"])
    await record(client, tags=["dinner"], on_sale=True)
    await record(client, tags=["dinner"])
    await record(client, tags=["dinner"])

    async with session_factory() as session:
        counts = await tag_frequency(session)

    assert dict(counts) == {"dinner": 4, "quick": 1}


async def test_the_limit_is_bounded(client):
    for limit in (0, 9):
        resp = await client.get("/api/recipes/searches", params={"limit": limit})
        assert resp.status_code == 422
