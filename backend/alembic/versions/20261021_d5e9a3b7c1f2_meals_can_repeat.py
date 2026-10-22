"""Meals can repeat

The owner can plan a meal for chosen weekdays of every week instead of
placing it week by week. A repeat is one row; its days are worked out when
the plan is read, and a day can be skipped without ending the repeat. A
planned row can say which repeat it changes (a day's own servings). A change
"from this day on" ends the repeat and carries it on in a new row, which
names the first row it continues.

Nothing existing changes: the new tables start empty and every existing
meal stays a one-off.

Revision ID: d5e9a3b7c1f2
Revises: c4b8f2d6a1e9
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5e9a3b7c1f2"
down_revision: str | None = "c4b8f2d6a1e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "meal_repeats",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("meal", sa.String(length=20), nullable=False),
        sa.Column("weekdays", sa.Integer(), nullable=False),
        sa.Column("servings", sa.Integer(), nullable=True),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("ends_on", sa.Date(), nullable=True),
        sa.Column("origin_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["origin_id"], ["meal_repeats.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_meal_repeats_recipe_id"), "meal_repeats", ["recipe_id"])
    op.create_index(op.f("ix_meal_repeats_origin_id"), "meal_repeats", ["origin_id"])
    op.create_table(
        "meal_repeat_skips",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("repeat_id", sa.Integer(), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.ForeignKeyConstraint(["repeat_id"], ["meal_repeats.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("repeat_id", "plan_date"),
    )
    with op.batch_alter_table("meal_plan_entries") as batch:
        batch.add_column(sa.Column("from_repeat_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_meal_plan_entries_from_repeat_id_meal_repeats",
            "meal_repeats",
            ["from_repeat_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_index(op.f("ix_meal_plan_entries_from_repeat_id"), ["from_repeat_id"])


def downgrade() -> None:
    with op.batch_alter_table("meal_plan_entries") as batch:
        batch.drop_index(op.f("ix_meal_plan_entries_from_repeat_id"))
        batch.drop_constraint(
            "fk_meal_plan_entries_from_repeat_id_meal_repeats", type_="foreignkey"
        )
        batch.drop_column("from_repeat_id")
    op.drop_table("meal_repeat_skips")
    op.drop_index(op.f("ix_meal_repeats_origin_id"), table_name="meal_repeats")
    op.drop_index(op.f("ix_meal_repeats_recipe_id"), table_name="meal_repeats")
    op.drop_table("meal_repeats")
