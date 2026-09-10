"""An automatic match records which rules chose it

Rows are pinned, so an automatic answer would otherwise keep its product
forever, however the ranking improved after it was made. With the version
on the row, an unconfirmed match from older rules is searched again on its
next use, and a hand pick is left alone.

Every existing automatic row was made under the first rules.

Revision ID: d7f2b81c4e95
Revises: c4e1a9b27d63
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7f2b81c4e95"
down_revision: str | None = "c4e1a9b27d63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ingredient_product_matches") as batch:
        batch.add_column(
            sa.Column("matcher_version", sa.Integer(), nullable=False, server_default="1")
        )


def downgrade() -> None:
    with op.batch_alter_table("ingredient_product_matches") as batch:
        batch.drop_column("matcher_version")
