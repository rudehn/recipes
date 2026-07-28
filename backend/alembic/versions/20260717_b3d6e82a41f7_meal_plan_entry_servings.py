"""Meal plan entries get their own serving count

Null means "cook the recipe's own serving count". Previously applied by a
hand-rolled ALTER at startup; this is the same change as a real revision.

Revision ID: b3d6e82a41f7
Revises: 9c1a7f4b2e05
Create Date: 2026-07-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3d6e82a41f7"
down_revision: str | None = "9c1a7f4b2e05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meal_plan_entries", sa.Column("servings", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    # Batch mode so SQLite (which rewrites the table) works too.
    with op.batch_alter_table("meal_plan_entries") as batch:
        batch.drop_column("servings")
