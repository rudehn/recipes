"""Remember which grocery lines were sent to the Kroger cart

The cart cannot be read back, so until now the only guard against ordering
a list twice was a note saying when it last went. Recording each line that
went lets a second send leave those out, which is the closest thing to
"already in your cart" the app can honestly offer.

Revision ID: e3a9c5d17b04
Revises: d7f2b81c4e95
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3a9c5d17b04"
down_revision: str | None = "d7f2b81c4e95"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "cart_sent_lines",
        sa.Column("key", sa.String(length=300), nullable=False),
        sa.Column("upc", sa.String(length=32), nullable=False),
        sa.Column("description", sa.String(length=300), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("cart_sent_lines")
