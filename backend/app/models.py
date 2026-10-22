from datetime import UTC, date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Table,
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

    # The shopper's standing permission to add to their Kroger cart.
    #
    # This is a credential, and the only one the app holds rather than reads
    # from the environment - it cannot live in config because it is granted at
    # runtime by a person clicking through a sign-in. It is stored as Kroger
    # issued it, on the same footing as the database's other contents: this is
    # a single-tenant app on a private host, and encrypting it with a key kept
    # on the same host would move the secret rather than protect it. What that
    # buys is that a leaked backup is a leaked cart, which is why
    # `services.kroger.cart` can forget it on request and does so by itself the
    # moment Kroger says it is dead.
    #
    # Kroger rotates it on every refresh, so the column is written far more
    # often than a settings column suggests.
    kroger_refresh_token: Mapped[str | None] = mapped_column(String(500))
    kroger_connected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # When a list was last sent. The Cart API is write-only - it cannot be
    # read back, and nothing can be removed from it - so this is the only way
    # the app can warn that sending again adds a second copy rather than
    # replacing the first.
    kroger_cart_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

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
    # The page the recipe was imported from, for the link back to it and for
    # noticing when the same page is about to be imported again. Absent for
    # recipes typed in by hand and for everything saved before it was kept.
    # 2048 is the longest link browsers and sitemaps reliably carry, and well
    # past a recipe page with a tail of tracking parameters.
    source_url: Mapped[str | None] = mapped_column(String(2048))
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

    @property
    def source_label(self) -> str | None:
        """The source site's name ("Budget Bytes"), as the search tabs give it.

        Worked out on reading rather than stored, so a site joining the
        allowlist is named properly on every recipe already saved from it.
        """
        if not self.source_url:
            return None
        from .services.recipe_search import site_label

        return site_label(self.source_url)


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
    # The line as the recipe's page wrote it, for re-parsing later. Absent
    # for rows typed by hand and for everything imported before it existed.
    source_line: Mapped[str | None] = mapped_column(String(300))

    recipe: Mapped[Recipe] = relationship(back_populates="ingredients")

    @property
    def issue(self) -> str | None:
        """The recipe-side problem with this row, if any. See services.lint."""
        from .services.lint import ingredient_issue

        return ingredient_issue(self.name, self.quantity, self.unit)


class PlanLabel(Base):
    """A marker the owner puts on planned meals ("Dad", "Kids", "Guests").

    Not the recipe's `tag`, which is for searching recipes: a label belongs
    to a meal on the plan. Names are unique ignoring case; `key` is the
    casefolded name that holds that.
    """

    __tablename__ = "plan_labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    key: Mapped[str] = mapped_column(String(40), unique=True)


meal_plan_entry_labels = Table(
    "meal_plan_entry_labels",
    Base.metadata,
    Column("entry_id", ForeignKey("meal_plan_entries.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("plan_labels.id", ondelete="CASCADE"), primary_key=True),
)

meal_repeat_labels = Table(
    "meal_repeat_labels",
    Base.metadata,
    Column("repeat_id", ForeignKey("meal_repeats.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("plan_labels.id", ondelete="CASCADE"), primary_key=True),
)


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
    # The repeat this row is a change to (a day's own servings), or null for
    # a one-off meal. A linked row replaces the repeat's meal on its day.
    from_repeat_id: Mapped[int | None] = mapped_column(
        ForeignKey("meal_repeats.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recipe: Mapped[Recipe] = relationship(lazy="selectin")
    repeat: Mapped["MealRepeat | None"] = relationship(lazy="selectin")
    labels: Mapped[list[PlanLabel]] = relationship(
        secondary=meal_plan_entry_labels, lazy="selectin", order_by=PlanLabel.key
    )


class PlanPick(Base):
    """A recipe set aside for a week, to be placed on a day later.

    Keyed by the week's Monday and never carried over to the next week.
    """

    __tablename__ = "plan_picks"
    __table_args__ = (UniqueConstraint("week_start", "recipe_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    week_start: Mapped[date] = mapped_column(Date, index=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recipe: Mapped[Recipe] = relationship(lazy="selectin")


class MealRepeat(Base):
    """A meal planned for the same weekdays of every week, from a day on.

    Its days are not stored: the plan service works them out for whatever
    range is asked about, so a repeat is always as long as the owner is
    looking.
    """

    __tablename__ = "meal_repeats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int] = mapped_column(
        ForeignKey("recipes.id", ondelete="CASCADE"), index=True
    )
    meal: Mapped[str] = mapped_column(String(20))
    # Bit 0 is Monday ... bit 6 is Sunday.
    weekdays: Mapped[int] = mapped_column(Integer)
    # Null means the recipe's own serving count.
    servings: Mapped[int | None] = mapped_column(Integer)
    starts_on: Mapped[date] = mapped_column(Date)
    # Inclusive; null means it goes on.
    ends_on: Mapped[date | None] = mapped_column(Date)
    # A change "from this day on" ends a repeat and carries it on in a new
    # row; every row after the first names the first here, so a later change
    # from an earlier day can find the rows that come after it. Null on the
    # first row.
    origin_id: Mapped[int | None] = mapped_column(
        ForeignKey("meal_repeats.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recipe: Mapped[Recipe] = relationship(lazy="selectin")
    skips: Mapped[list["MealRepeatSkip"]] = relationship(lazy="selectin")
    labels: Mapped[list[PlanLabel]] = relationship(
        secondary=meal_repeat_labels, lazy="selectin", order_by=PlanLabel.key
    )


class MealRepeatSkip(Base):
    """A day a repeat does not happen on, though its weekday says it would."""

    __tablename__ = "meal_repeat_skips"
    __table_args__ = (UniqueConstraint("repeat_id", "plan_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    repeat_id: Mapped[int] = mapped_column(ForeignKey("meal_repeats.id", ondelete="CASCADE"))
    plan_date: Mapped[date] = mapped_column(Date)


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
    display, and come back with the price on the same call. 

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
    # The rules the automatic pick was made under; see matching.MATCHER_VERSION.
    # An unconfirmed row from an older version is remade on its next use.
    #
    # The server default is the one the migration adding this column used to
    # stamp existing rows as made under the first rules. It is declared here
    # so the models say what the database already holds; left out, every
    # autogenerate proposed dropping it and `alembic check` never passed.
    matcher_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    resolved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class IngredientFoodMatch(Base):
    """Which USDA food an ingredient means, as a person chose it.

    Only hand choices are stored. The defaults are code
    (`services.nutrition.defaults`), so improving one reaches every recipe at
    once, and nothing here has to be remade when it does. A row is the last
    word on its ingredient until it is deleted, which is the way back to the
    default.

    Keyed by `services.nutrition.defaults.nutrition_key`, which is
    `canonical_key` except where cooking changes the food - see ADR 8.
    """

    __tablename__ = "ingredient_food_matches"

    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    # USDA FoodData Central's id, as in `services/nutrition/usda/foods.csv`.
    # None is a person saying the ingredient does not count - a garnish, a
    # pinch of something - which is a real answer, not a missing one.
    fdc_id: Mapped[int | None] = mapped_column(Integer)
    chosen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


# The two things a shopper can say about a grocery line during a trip. A line
# with no row is simply to buy. "bought" is the tick: it is in the trolley, and
# the trip still pays for it. "have" is the other answer to a line, that there
# is already enough at home - not bought, not paid for, and not ordered.
GROCERY_BOUGHT = "bought"
GROCERY_HAVE = "have"


class GroceryCheck(Base):
    """A mark against a generated grocery line, for the length of one trip.

    Keyed by the normalized item key so a mark survives regenerating the
    list. Both marks live in one row because they are two answers to the
    same question - "does this still need buying?" - and one row cannot hold
    both at once. A line in the pantry is not marked here: the pantry's own
    stock flag is what sets it aside, and a "have" mark on a pantry-tracked
    line restocks it instead.
    """

    __tablename__ = "grocery_checks"

    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    status: Mapped[str] = mapped_column(String(16))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class CartSentLine(Base):
    """A grocery line this app has put in the Kroger cart, and when.

    The cart cannot be read back, so this is the only record there is of
    what went. It is a fact about this app's requests, not about the cart:
    the shopper may have taken the thing out again on kroger.com, and the
    review says "sent" rather than "in your cart" for exactly that reason.
    Its use is to keep a second send from ordering the first send twice.

    Keyed by the grocery line, and cleared with the marks when a new trip
    starts, because a trip is what a cart holds.
    """

    __tablename__ = "cart_sent_lines"

    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    upc: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(String(300))
    quantity: Mapped[int] = mapped_column(Integer)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngredientMerge(Base):
    """Two names the owner says are one ingredient: `from_key` now means `to_key`.

    Keys are `services.canonical.canonical_key` values. A `to_key` is never
    itself a `from_key`: merging the target onward later repoints every row
    at it, so looking a key up is one step and never follows a chain. See
    ADR 10, and `services.identity`, the only reader.
    """

    __tablename__ = "ingredient_merges"

    from_key: Mapped[str] = mapped_column(String(300), primary_key=True)
    to_key: Mapped[str] = mapped_column(String(300), index=True)
    merged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngredientMergeDismissal(Base):
    """A suggested merge the owner said was wrong, so it is not offered again.

    Stored as an ordered pair (`key_a` < `key_b`) so the same two names are
    one row whichever way round the suggestion pointed.
    """

    __tablename__ = "ingredient_merge_dismissals"

    key_a: Mapped[str] = mapped_column(String(300), primary_key=True)
    key_b: Mapped[str] = mapped_column(String(300), primary_key=True)
    dismissed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RecipeSearch(Base):
    """One time a recipe was opened from a search on the Recipes page.

    An event log, so the same search made twice is two rows: recent searches
    are the distinct searches, newest first, and a tag's popularity is how
    many rows hold it. `ingredients` are identity keys, resolved through
    merges again when read - which is why what makes two rows the same
    search is worked out on reading rather than stored. Rows past the
    history window are pruned when a new one is written.
    """

    __tablename__ = "recipe_searches"

    id: Mapped[int] = mapped_column(primary_key=True)
    text: Mapped[str] = mapped_column(String(100))
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    ingredients: Mapped[list[str]] = mapped_column(JSON, default=list)
    on_sale: Mapped[bool] = mapped_column(Boolean, default=False)
    searched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )
