"""Which Kroger product an ingredient means, at one store

Kroger's product search is fuzzy and returns identical requests in a
different order, so the choice has to be pinned or the same ingredient
prices differently on every page load. A null product_id records that a
search found nothing confident, so it is not paid for again.

Revision ID: f845e479b503
Revises: 5d2b360aead5
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f845e479b503"
down_revision: str | None = "5d2b360aead5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingredient_product_matches",
        sa.Column("canonical_key", sa.String(length=300), nullable=False),
        sa.Column("location_id", sa.String(length=32), nullable=False),
        sa.Column("product_id", sa.String(length=32), nullable=True),
        sa.Column("user_confirmed", sa.Boolean(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("canonical_key", "location_id"),
    )


def downgrade() -> None:
    op.drop_table("ingredient_product_matches")
