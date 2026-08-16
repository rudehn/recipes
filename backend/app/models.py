from datetime import UTC, date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


# The only row app_settings ever holds. See AppSettings.
SETTINGS_ID = 1


class AppSettings(Base):
    """Application-wide settings, of which there is exactly one row.

    This app is single-tenant and has no users, so there is nothing to hang a
    preference off. The id is pinned to a constant rather than left to
    autoincrement, which makes "the settings" a plain `session.get` and stops
    a second row appearing to compete with the first.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=SETTINGS_ID)

    # The Kroger store prices are quoted against. The Products API returns no
    # price at all without a locationId, so this is what moves pricing from
    # configured to usable, and everything downstream reads it.
    #
    # The name and address are kept beside it only so the chosen store can be
    # shown without spending a Locations call, which is capped at 1,600 a day
    # against the Products API's 10,000. They are Kroger's data and are stored
    # and displayed exactly as returned.
    kroger_location_id: Mapped[str | None] = mapped_column(String(32))
    kroger_location_name: Mapped[str | None] = mapped_column(String(200))
    kroger_location_address: Mapped[str | None] = mapped_column(String(300))
    kroger_location_chain: Mapped[str | None] = mapped_column(String(100))

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Recipe(Base):
    __tablename__ = "recipes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(200), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    # One instruction step per line.
    instructions: Mapped[str] = mapped_column(Text, default="")
    image_filename: Mapped[str | None] = mapped_column(String(255))
    prep_minutes: Mapped[int | None] = mapped_column(Integer)
    cook_minutes: Mapped[int | None] = mapped_column(Integer)
    servings: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    ingredients: Mapped[list["Ingredient"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
        order_by="Ingredient.position",
        lazy="selectin",
    )
    tag_rows: Mapped[list["RecipeTag"]] = relationship(
        cascade="all, delete-orphan",
        order_by="RecipeTag.name",
        lazy="selectin",
    )

    @property
    def tags(self) -> list[str]:
        return [t.name for t in self.tag_rows]


class RecipeTag(Base):
    __tablename__ = "recipe_tags"
    __table_args__ = (UniqueConstraint("recipe_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int] = mapped_column(
        ForeignKey("recipes.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(50), index=True)


class Ingredient(Base):
    __tablename__ = "ingredients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int] = mapped_column(
        ForeignKey("recipes.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str | None] = mapped_column(String(50))
    position: Mapped[int] = mapped_column(Integer, default=0)

    recipe: Mapped[Recipe] = relationship(back_populates="ingredients")


class MealPlanEntry(Base):
    __tablename__ = "meal_plan_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_date: Mapped[date] = mapped_column(Date, index=True)
    # breakfast | lunch | dinner | snack
    meal: Mapped[str] = mapped_column(String(20))
    recipe_id: Mapped[int] = mapped_column(
        ForeignKey("recipes.id", ondelete="CASCADE"), index=True
    )
    # Servings to cook; null means the recipe's own serving count. Grocery
    # quantities scale by servings / recipe.servings.
    servings: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recipe: Mapped[Recipe] = relationship(lazy="selectin")


class PantryItem(Base):
    __tablename__ = "pantry_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    in_stock: Mapped[bool] = mapped_column(Boolean, default=True)


class IngredientProductMatch(Base):
    """Which Kroger product an ingredient means, at one store.

    Not a cache, and not an optimization. Kroger's product search is fuzzy and
    returns results in a different order for identical requests, so without a
    pinned choice the same ingredient resolves to a different product - and a
    different price - on every page load.

    Deliberately minimal. This records a *preference*, not a copy of Kroger's
    catalog: the description, size and price are theirs, are needed only for
    display, and come back with the price on the same call. The acceptable-use
    policy forbids gathering response data into a database, and the line
    between a stored preference and a stored catalog is only ever how many
    columns are here.

    A null `product_id` is a real answer rather than a missing row: it records
    that a search ran and found nothing confident, so the search is not paid
    for again on every render. Correcting one by hand (see the match UI) is
    what sets `user_confirmed`, and a confirmed row is never overwritten.
    """

    __tablename__ = "ingredient_product_matches"

    # services.canonical.canonical_key, the same identity the grocery list
    # merges on and checked-off state is stored under.
    canonical_key: Mapped[str] = mapped_column(String(300), primary_key=True)
    location_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    product_id: Mapped[str | None] = mapped_column(String(32))
    user_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    resolved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class GroceryCheck(Base):
    """Checked-off state for generated grocery list items, keyed by the
    normalized item key so checks survive regenerating the list."""

    __tablename__ = "grocery_checks"

    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    checked: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
