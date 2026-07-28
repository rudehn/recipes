"""Initial schema

Baseline: the schema as `Base.metadata.create_all` built it before Alembic
existed, minus `meal_plan_entries.servings` (added in the next revision).
Databases created by that old startup path are stamped at one of these two
revisions rather than re-created - see app/migrations.py.

Revision ID: 9c1a7f4b2e05
Revises:
Create Date: 2026-07-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9c1a7f4b2e05"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recipes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("image_filename", sa.String(length=255), nullable=True),
        sa.Column("prep_minutes", sa.Integer(), nullable=True),
        sa.Column("cook_minutes", sa.Integer(), nullable=True),
        sa.Column("servings", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_recipes_title"), "recipes", ["title"])

    op.create_table(
        "recipe_tags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("recipe_id", "name"),
    )
    op.create_index(op.f("ix_recipe_tags_name"), "recipe_tags", ["name"])
    op.create_index(op.f("ix_recipe_tags_recipe_id"), "recipe_tags", ["recipe_id"])

    op.create_table(
        "ingredients",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=True),
        sa.Column("unit", sa.String(length=50), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ingredients_recipe_id"), "ingredients", ["recipe_id"])

    op.create_table(
        "meal_plan_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("meal", sa.String(length=20), nullable=False),
        sa.Column("recipe_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_meal_plan_entries_plan_date"), "meal_plan_entries", ["plan_date"]
    )
    op.create_index(
        op.f("ix_meal_plan_entries_recipe_id"), "meal_plan_entries", ["recipe_id"]
    )

    op.create_table(
        "pantry_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("in_stock", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )

    op.create_table(
        "grocery_checks",
        sa.Column("key", sa.String(length=300), nullable=False),
        sa.Column("checked", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("grocery_checks")
    op.drop_table("pantry_items")
    op.drop_index(op.f("ix_meal_plan_entries_recipe_id"), "meal_plan_entries")
    op.drop_index(op.f("ix_meal_plan_entries_plan_date"), "meal_plan_entries")
    op.drop_table("meal_plan_entries")
    op.drop_index(op.f("ix_ingredients_recipe_id"), "ingredients")
    op.drop_table("ingredients")
    op.drop_index(op.f("ix_recipe_tags_recipe_id"), "recipe_tags")
    op.drop_index(op.f("ix_recipe_tags_name"), "recipe_tags")
    op.drop_table("recipe_tags")
    op.drop_index(op.f("ix_recipes_title"), "recipes")
    op.drop_table("recipes")
