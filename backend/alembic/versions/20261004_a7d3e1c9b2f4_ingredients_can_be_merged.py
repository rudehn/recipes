"""Two names can be one ingredient

The owner can say that "ground cumin" and "cumin" are the same thing to buy,
once, and every part of the app then treats them as one. Merges are kept
here rather than written into recipe text, so a recipe keeps its wording and
a merge can be taken back. Suggested merges the owner turned down are kept
too, so they are not offered again.

Nothing existing changes: both tables start empty.

Revision ID: a7d3e1c9b2f4
Revises: e0ff9c9020c3
Create Date: 2026-10-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d3e1c9b2f4"
down_revision: str | None = "e0ff9c9020c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingredient_merges",
        sa.Column("from_key", sa.String(length=300), nullable=False),
        sa.Column("to_key", sa.String(length=300), nullable=False),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("from_key"),
    )
    op.create_index(op.f("ix_ingredient_merges_to_key"), "ingredient_merges", ["to_key"])
    op.create_table(
        "ingredient_merge_dismissals",
        sa.Column("key_a", sa.String(length=300), nullable=False),
        sa.Column("key_b", sa.String(length=300), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key_a", "key_b"),
    )


def downgrade() -> None:
    op.drop_table("ingredient_merge_dismissals")
    op.drop_index(op.f("ix_ingredient_merges_to_key"), table_name="ingredient_merges")
    op.drop_table("ingredient_merges")
