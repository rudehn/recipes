"""Run schema migrations at startup, and adopt databases that predate them.

Alembic owns the schema. The app used to call `Base.metadata.create_all`
instead, which creates missing *tables* and silently ignores everything else -
a new column on an existing table never appeared, which is why a hand-rolled
ALTER had been bolted on next to it.

The delicate part is the handover. Databases built by that old code hold real
data and have no `alembic_version` table, so Alembic would consider them
unmanaged and try to create tables that already exist. Re-creating them is not
an option. Instead they are *stamped* at the revision whose schema they already
match, and then upgraded forward from there like any other database.

`adopt_pre_alembic_database` runs from alembic/env.py rather than from here, so
that the CLI (`alembic upgrade head`) and the app's startup take exactly the
same path.
"""

import logging
from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, inspect

from alembic import command

from .db import engine

log = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_ALEMBIC_INI = _BACKEND_DIR / "alembic.ini"

# The two shapes a database predating Alembic can have.
_INITIAL_SCHEMA = "9c1a7f4b2e05"
_SERVINGS_ADDED = "b3d6e82a41f7"


def alembic_config(connection: Connection) -> Config:
    """Config wired to run on an existing connection instead of opening one."""
    config = Config(_ALEMBIC_INI)
    # alembic.ini's script_location is resolved against the working directory,
    # which is not ours to assume. Pin it to the directory next to this package.
    config.set_main_option("script_location", str(_BACKEND_DIR / "alembic"))
    config.attributes["connection"] = connection
    return config


def _pre_alembic_revision(connection: Connection) -> str | None:
    """Revision a database predating Alembic already matches.

    None means there is nothing to stamp: either the database is already under
    Alembic, or it is empty and every migration should simply run.
    """
    inspector = inspect(connection)
    tables = set(inspector.get_table_names())

    if "alembic_version" in tables:
        return None
    if "recipes" not in tables:
        return None

    # `servings` tells the two apart: create_all could not add a column to an
    # existing table, so an old database has it only if the startup ALTER that
    # this module replaced got to run.
    if "meal_plan_entries" in tables:
        columns = {c["name"] for c in inspector.get_columns("meal_plan_entries")}
        if "servings" in columns:
            return _SERVINGS_ADDED
    return _INITIAL_SCHEMA


def adopt_pre_alembic_database(
    connection: Connection, script_directory: ScriptDirectory
) -> None:
    """Bring a create_all-era database under Alembic without touching its data.

    A no-op for databases Alembic already manages and for empty ones.
    """
    revision = _pre_alembic_revision(connection)
    if revision is None:
        return

    log.info("Adopting pre-Alembic database: stamping revision %s", revision)
    MigrationContext.configure(connection).stamp(script_directory, revision)


def _upgrade(connection: Connection) -> None:
    command.upgrade(alembic_config(connection), "head")


async def run_migrations() -> None:
    """Bring the database up to head. Safe to run on every startup."""
    async with engine.begin() as connection:
        await connection.run_sync(_upgrade)
