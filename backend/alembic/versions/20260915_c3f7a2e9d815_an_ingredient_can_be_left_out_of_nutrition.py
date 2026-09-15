"""An ingredient can be left out of nutrition by choice

A hand choice with no food now means "does not count", for a garnish or a
pinch of something no food list has, so the column becomes nullable. Every
existing row names a food and is unchanged.

Revision ID: c3f7a2e9d815
Revises: b6e2d9f4a1c8
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f7a2e9d815"
down_revision: str | None = "b6e2d9f4a1c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ingredient_food_matches") as batch:
        batch.alter_column("fdc_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    # A choice to leave an ingredient out has nowhere to go in the older
    # schema, so it is dropped and the ingredient goes back to its default.
    op.execute("DELETE FROM ingredient_food_matches WHERE fdc_id IS NULL")
    with op.batch_alter_table("ingredient_food_matches") as batch:
        batch.alter_column("fdc_id", existing_type=sa.Integer(), nullable=False)
