"""Ingredients remember which USDA food a person chose for them

Only hand choices are stored; defaults live in code. Nothing existing needs
a row, so the table starts empty.

Revision ID: b6e2d9f4a1c8
Revises: f1c8d4a7b2e6
Create Date: 2026-09-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6e2d9f4a1c8"
down_revision: str | None = "f1c8d4a7b2e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingredient_food_matches",
        sa.Column("key", sa.String(length=300), nullable=False),
        sa.Column("fdc_id", sa.Integer(), nullable=False),
        sa.Column("chosen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("ingredient_food_matches")
