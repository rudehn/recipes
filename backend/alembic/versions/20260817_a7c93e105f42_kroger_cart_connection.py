"""The shopper's standing permission to add to their Kroger cart

Pricing reads the catalog on the app's own token. Writing to a cart needs the
shopper's, granted through a browser sign-in and good for months, so unlike
every other token in this app it has to survive a restart. That is the whole
reason these columns exist.

`kroger_cart_sent_at` is not bookkeeping. The Cart API cannot be read back and
nothing can be removed from it, so a second send adds a second copy of the
list. Knowing when the last one went is the only way the app can say so.

Revision ID: a7c93e105f42
Revises: f845e479b503
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c93e105f42"
down_revision: str | None = "f845e479b503"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column("kroger_refresh_token", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("kroger_connected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("kroger_cart_sent_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "kroger_cart_sent_at")
    op.drop_column("app_settings", "kroger_connected_at")
    op.drop_column("app_settings", "kroger_refresh_token")
