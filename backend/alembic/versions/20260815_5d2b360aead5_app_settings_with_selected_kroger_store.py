"""App settings, holding the Kroger store prices are quoted against

The app's first stored setting. One row, pinned to id 1: this is a
single-tenant app with no users, so there is nothing to hang a preference
off. The Products API returns no price without a locationId, so this table
is what moves pricing from configured to usable.

Revision ID: 5d2b360aead5
Revises: b3d6e82a41f7
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5d2b360aead5"
down_revision: str | None = "b3d6e82a41f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kroger_location_id", sa.String(length=32), nullable=True),
        sa.Column("kroger_location_name", sa.String(length=200), nullable=True),
        sa.Column("kroger_location_address", sa.String(length=300), nullable=True),
        sa.Column("kroger_location_chain", sa.String(length=100), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
