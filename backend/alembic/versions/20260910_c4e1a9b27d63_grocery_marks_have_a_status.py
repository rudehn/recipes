"""A grocery line can be marked as already at home, not only as bought

The tick was the only mark a line could carry, and it meant "in the trolley":
struck through, still paid for, left out of the cart. There was no way to say
the other thing a shopper says to a list - that there is already enough of it
at home - so people ticked those off too, and the estimate went on counting
them. The boolean becomes a status with two values, "bought" and "have", and a
row is only there at all while one of them applies.

Revision ID: c4e1a9b27d63
Revises: a7c93e105f42
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e1a9b27d63"
down_revision: str | None = "a7c93e105f42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # An unticked row said nothing the absence of a row does not, so those go
    # rather than being carried across as a third value.
    op.execute("DELETE FROM grocery_checks WHERE NOT checked")
    with op.batch_alter_table("grocery_checks") as batch:
        batch.add_column(sa.Column("status", sa.String(length=16), nullable=True))
    op.execute("UPDATE grocery_checks SET status = 'bought'")
    with op.batch_alter_table("grocery_checks") as batch:
        batch.alter_column("status", nullable=False)
        batch.drop_column("checked")


def downgrade() -> None:
    # "have" has no older spelling. Those lines were not bought, so they go
    # back to being to buy, which is what the tick's absence means.
    op.execute("DELETE FROM grocery_checks WHERE status <> 'bought'")
    with op.batch_alter_table("grocery_checks") as batch:
        batch.add_column(sa.Column("checked", sa.Boolean(), nullable=True))
    op.execute("UPDATE grocery_checks SET checked = TRUE")
    with op.batch_alter_table("grocery_checks") as batch:
        batch.alter_column("checked", nullable=False)
        batch.drop_column("status")
