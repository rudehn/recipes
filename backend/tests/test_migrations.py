"""Migrations, and the handover from the create_all era.

The risk these cover is data loss: a database built before Alembic existed has
no `alembic_version` table, and treating it as a fresh one would mean creating
tables that already hold recipes. Every test here runs against its own
throwaway SQLite file rather than the shared test database.
"""

from collections.abc import Callable

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command
from app.db import Base
from app.migrations import _upgrade, alembic_config

INITIAL_SCHEMA = "9c1a7f4b2e05"


@pytest.fixture
def db_url(tmp_path) -> str:
    return f"sqlite+aiosqlite:///{tmp_path}/migrate.db"


async def run(db_url: str, fn: Callable[[Connection], object]):
    """Run a sync callable against its own connection, as the app does."""
    engine = create_async_engine(db_url)
    try:
        async with engine.begin() as conn:
            return await conn.run_sync(fn)
    finally:
        await engine.dispose()


def upgrade_to(revision: str) -> Callable[[Connection], None]:
    def apply(conn: Connection) -> None:
        command.upgrade(alembic_config(conn), revision)

    return apply


def downgrade_to(revision: str) -> Callable[[Connection], None]:
    def apply(conn: Connection) -> None:
        command.downgrade(alembic_config(conn), revision)

    return apply


def forget_alembic(conn: Connection) -> None:
    """Turn a migrated database back into a create_all-era one."""
    conn.execute(text("DROP TABLE alembic_version"))


def current_revision(conn: Connection) -> str | None:
    return MigrationContext.configure(conn).get_current_revision()


def head_revision(conn: Connection) -> str:
    script = ScriptDirectory.from_config(alembic_config(conn))
    return script.get_current_head()


def columns_of(table: str) -> Callable[[Connection], set[str]]:
    return lambda conn: {c["name"] for c in inspect(conn).get_columns(table)}


def seed_recipe(conn: Connection) -> None:
    conn.execute(
        text(
            "INSERT INTO recipes (id, title, description, instructions,"
            " created_at, updated_at)"
            " VALUES (1, 'Carbonara', '', 'Boil water', '2026-07-01', '2026-07-01')"
        )
    )
    conn.execute(
        text(
            "INSERT INTO meal_plan_entries (plan_date, meal, recipe_id, created_at)"
            " VALUES ('2026-07-02', 'dinner', 1, '2026-07-01')"
        )
    )


def recipe_titles(conn: Connection) -> list[str]:
    return [r[0] for r in conn.execute(text("SELECT title FROM recipes"))]


async def test_upgrade_builds_the_schema_the_models_describe(db_url):
    """Guards against migrations and models drifting apart."""
    await run(db_url, _upgrade)

    def differences(conn: Connection):
        context = MigrationContext.configure(conn, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    assert await run(db_url, differences) == []


async def test_fresh_database_lands_on_head(db_url):
    await run(db_url, _upgrade)

    assert await run(db_url, current_revision) == await run(db_url, head_revision)


async def test_upgrade_is_idempotent(db_url):
    await run(db_url, _upgrade)
    await run(db_url, _upgrade)

    assert await run(db_url, current_revision) == await run(db_url, head_revision)


async def test_pre_alembic_database_keeps_its_data(db_url):
    """The production case: current schema, real rows, no alembic_version."""
    await run(db_url, upgrade_to("head"))
    await run(db_url, forget_alembic)
    await run(db_url, seed_recipe)

    await run(db_url, _upgrade)

    assert await run(db_url, recipe_titles) == ["Carbonara"]
    assert await run(db_url, current_revision) == await run(db_url, head_revision)


async def test_pre_alembic_database_without_servings_is_upgraded(db_url):
    """An older deployment that never ran the startup ALTER still catches up."""
    await run(db_url, upgrade_to(INITIAL_SCHEMA))
    await run(db_url, forget_alembic)
    await run(db_url, seed_recipe)
    assert "servings" not in await run(db_url, columns_of("meal_plan_entries"))

    await run(db_url, _upgrade)

    assert "servings" in await run(db_url, columns_of("meal_plan_entries"))
    assert await run(db_url, recipe_titles) == ["Carbonara"]
    assert await run(db_url, current_revision) == await run(db_url, head_revision)


async def test_downgrade_returns_to_the_initial_schema(db_url):
    await run(db_url, _upgrade)

    await run(db_url, downgrade_to(INITIAL_SCHEMA))

    assert "servings" not in await run(db_url, columns_of("meal_plan_entries"))
    assert await run(db_url, current_revision) == INITIAL_SCHEMA
