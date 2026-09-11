"""Ingredients keep the line they were imported from, and mis-parsed rows are re-read

The importer used to give up on a line that started with a label - "Optional:
1 diced ripe avocado" - and save the whole thing as the name with no amount,
so the grocery list said "as needed" and the cart ordered one whatever the
recipe was scaled to. The parser now reads past the label. This keeps the
original line on every row from now on, so a later parser can be run over it
without importing again, and reads the rows that were saved that way once
more with the parser as it is now.

A re-parsed row's grocery key changes ("1-avocado" becomes "avocado"), so any
remembered product, mark, or sent record under the old key is moved to the
new one where nothing is there already. See ADR 2 on why a key change is a
data migration.

Revision ID: f1c8d4a7b2e6
Revises: e3a9c5d17b04
Create Date: 2026-09-11
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1c8d4a7b2e6"
down_revision: str | None = "e3a9c5d17b04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MISPARSED = re.compile(r"^\s*(?:[A-Za-z][A-Za-z ]{0,24}:\s*)?[\d½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]")


def upgrade() -> None:
    with op.batch_alter_table("ingredients") as batch:
        batch.add_column(sa.Column("source_line", sa.String(length=300), nullable=True))

    from app.services.canonical import canonical_key
    from app.services.recipe_import import parse_ingredient_line

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, name FROM ingredients WHERE quantity IS NULL")
    ).all()
    moved: dict[str, str] = {}
    for ingredient_id, name in rows:
        if not _MISPARSED.match(name):
            continue
        parsed = parse_ingredient_line(name)
        if parsed.quantity is None:
            continue
        conn.execute(
            sa.text(
                "UPDATE ingredients SET name = :name, quantity = :quantity, unit = :unit, "
                "source_line = :source WHERE id = :id"
            ),
            {
                "name": parsed.name,
                "quantity": parsed.quantity,
                "unit": parsed.unit,
                "source": name[:300],
                "id": ingredient_id,
            },
        )
        old_key, new_key = canonical_key(name), canonical_key(parsed.name)
        if old_key and new_key and old_key != new_key:
            moved[old_key] = new_key

    for table, key_column in (
        ("ingredient_product_matches", "canonical_key"),
        ("grocery_checks", "key"),
        ("cart_sent_lines", "key"),
    ):
        for old_key, new_key in moved.items():
            taken = conn.execute(
                sa.text(f"SELECT 1 FROM {table} WHERE {key_column} = :key"), {"key": new_key}
            ).first()
            if taken:
                continue
            conn.execute(
                sa.text(f"UPDATE {table} SET {key_column} = :new WHERE {key_column} = :old"),
                {"new": new_key, "old": old_key},
            )


def downgrade() -> None:
    # The re-parsed rows are better than they were and stay that way; only
    # the column goes.
    with op.batch_alter_table("ingredients") as batch:
        batch.drop_column("source_line")
