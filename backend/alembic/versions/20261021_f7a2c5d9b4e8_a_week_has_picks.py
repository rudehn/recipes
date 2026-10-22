"""A week has picks

The owner can pick recipes for a week before giving them a day. A pick
belongs to the week's Monday, once per recipe.

Nothing existing changes: the new table starts empty.

Revision ID: f7a2c5d9b4e8
Revises: e6f1b4c8a3d7
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7a2c5d9b4e8"
down_revision: str | None = "e6f1b4c8a3d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_picks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("week_start", "recipe_id"),
    )
    op.create_index(op.f("ix_plan_picks_week_start"), "plan_picks", ["week_start"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_plan_picks_week_start"), table_name="plan_picks")
    op.drop_table("plan_picks")
