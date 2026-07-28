"""Alembic environment.

Two ways in, one code path for the actual work:

* the CLI (`uv run alembic upgrade head`) opens its own async engine;
* the app at startup hands us its connection through
  ``config.attributes["connection"]`` (see ``app/migrations.py``).

The URL is never read from alembic.ini - it comes from ``app.config`` so the
CLI and the app can never drift onto different databases.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, pool
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import DATABASE_URL
from app.db import Base
from app.migrations import adopt_pre_alembic_database

# Importing the models registers every table on Base.metadata; without it
# --autogenerate would think the whole schema had been deleted.
from app import models

config = context.config
injected_connection: Connection | None = config.attributes.get("connection")

# Only take over logging when Alembic is driven from the command line. Under
# the app this module is imported mid-startup, and fileConfig would reconfigure
# logging out from under uvicorn - `disable_existing_loggers` defaults to True,
# which silences uvicorn's own loggers for the life of the process.
if injected_connection is None and config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _configure(**kwargs) -> None:
    context.configure(
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        **kwargs,
    )


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it (`alembic upgrade head --sql`)."""
    _configure(
        url=DATABASE_URL,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    # Databases created before Alembic existed have no version table; stamp
    # them at the revision they already match so the upgrade below moves them
    # forward instead of trying to build tables that hold live data.
    adopt_pre_alembic_database(connection, ScriptDirectory.from_config(config))

    _configure(
        connection=connection,
        # SQLite cannot ALTER or DROP most things in place, so batch mode
        # rewrites the table around the change. Ignored on Postgres.
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    engine = create_async_engine(DATABASE_URL, poolclass=pool.NullPool)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
elif injected_connection is not None:
    do_run_migrations(injected_connection)
else:
    asyncio.run(run_async_migrations())
