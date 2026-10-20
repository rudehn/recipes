"""Recipe searches are remembered

Opening a recipe from the Recipes page's search is remembered on the server,
so the owner's phone and desktop share one list of recent searches and the
page can offer the tags searched most. Each opening is its own row, an event
log, so a search made twice is two rows and the page reads the distinct ones.

Nothing existing changes: the table starts empty.

Revision ID: c4b8f2d6a1e9
Revises: a7d3e1c9b2f4
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4b8f2d6a1e9"
down_revision: str | None = "a7d3e1c9b2f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recipe_searches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("signature", sa.String(length=1000), nullable=False),
        sa.Column("text", sa.String(length=100), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("ingredients", sa.JSON(), nullable=False),
        sa.Column("on_sale", sa.Boolean(), nullable=False),
        sa.Column("searched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_recipe_searches_signature"), "recipe_searches", ["signature"])
    op.create_index(op.f("ix_recipe_searches_searched_at"), "recipe_searches", ["searched_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_recipe_searches_searched_at"), table_name="recipe_searches")
    op.drop_index(op.f("ix_recipe_searches_signature"), table_name="recipe_searches")
    op.drop_table("recipe_searches")
