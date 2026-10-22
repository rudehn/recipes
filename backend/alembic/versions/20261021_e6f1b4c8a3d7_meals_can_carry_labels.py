"""Meals can carry labels

The owner can mark planned meals with labels of their own ("Dad", "Kids").
A label is a name, unique ignoring case; a one-off meal and a repeat each
link to the labels they carry.

Nothing existing changes: the new tables start empty and every existing
meal carries no label.

Revision ID: e6f1b4c8a3d7
Revises: d5e9a3b7c1f2
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6f1b4c8a3d7"
down_revision: str | None = "d5e9a3b7c1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_labels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    op.create_table(
        "meal_plan_entry_labels",
        sa.Column("entry_id", sa.Integer(), nullable=False),
        sa.Column("label_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["entry_id"], ["meal_plan_entries.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["label_id"], ["plan_labels.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("entry_id", "label_id"),
    )
    op.create_table(
        "meal_repeat_labels",
        sa.Column("repeat_id", sa.Integer(), nullable=False),
        sa.Column("label_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["repeat_id"], ["meal_repeats.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["label_id"], ["plan_labels.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("repeat_id", "label_id"),
    )


def downgrade() -> None:
    op.drop_table("meal_repeat_labels")
    op.drop_table("meal_plan_entry_labels")
    op.drop_table("plan_labels")
