"""Recipes remember the page they were imported from

The importer always knew the link and dropped it on save, so a recipe could
not link back to its original and the same page could be imported twice
without anything noticing. Recipes now keep it.

Nothing existing can be filled in: the links were never stored anywhere, so
every recipe saved before this starts with none, and the edit form is where
one can be added by hand.

Revision ID: e0ff9c9020c3
Revises: c3f7a2e9d815
Create Date: 2026-10-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e0ff9c9020c3"
down_revision: str | None = "c3f7a2e9d815"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("recipes") as batch:
        batch.add_column(sa.Column("source_url", sa.String(length=2048), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("recipes") as batch:
        batch.drop_column("source_url")
