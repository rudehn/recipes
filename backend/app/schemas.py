from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

Meal = Literal["breakfast", "lunch", "dinner", "snack"]


class PricingStatus(BaseModel):
    """Whether the Kroger integration is configured.

    `enabled` being false is a normal state, not a failure: pricing is opt-in
    and the rest of the app does not depend on it.
    """

    enabled: bool


class IngredientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)


class IngredientOut(IngredientIn):
    model_config = ConfigDict(from_attributes=True)

    id: int


class RecipeIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    instructions: str = ""
    prep_minutes: int | None = Field(default=None, ge=0)
    cook_minutes: int | None = Field(default=None, ge=0)
    servings: int | None = Field(default=None, ge=1)
    ingredients: list[IngredientIn] = []
    tags: list[str] = []

    def normalized_tags(self) -> list[str]:
        seen: dict[str, None] = {}
        for tag in self.tags:
            cleaned = tag.strip().lower()[:50]
            if cleaned:
                seen.setdefault(cleaned, None)
        return list(seen)


class RecipeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    instructions: str
    image_filename: str | None
    prep_minutes: int | None
    cook_minutes: int | None
    servings: int | None
    created_at: datetime
    updated_at: datetime
    ingredients: list[IngredientOut]
    tags: list[str]


class RecipeSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    image_filename: str | None
    prep_minutes: int | None
    cook_minutes: int | None
    servings: int | None
    tags: list[str] = []


class RecipePage(BaseModel):
    """One page of recipes plus the numbers a pager needs.

    `total` counts everything matching the filters, not the page, so the client
    can say how much is left without asking for it.
    """

    items: list[RecipeSummary]
    total: int
    page: int
    per_page: int


class TagCount(BaseModel):
    """A tag and how many recipes carry it, for the filter bar.

    The bar can no longer be derived from the loaded recipes now that a page is
    only ever part of the collection.
    """

    name: str
    count: int


class MealPlanEntryIn(BaseModel):
    plan_date: date
    meal: Meal
    recipe_id: int
    servings: int | None = Field(default=None, ge=1)


class MealPlanEntryUpdate(BaseModel):
    # None resets to the recipe's own serving count.
    servings: int | None = Field(default=None, ge=1)


class MealPlanEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_date: date
    meal: Meal
    servings: int | None
    recipe: RecipeSummary


class PantryItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    in_stock: bool = True


class PantryItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    in_stock: bool | None = None


class PantryItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    in_stock: bool


class GroceryRecipeUse(BaseModel):
    recipe_id: int
    recipe_title: str
    quantity: float | None
    unit: str | None


class GroceryItem(BaseModel):
    key: str
    name: str
    # Aggregated amounts, one entry per distinct unit (e.g. "2 cups" + "1 tbsp").
    amounts: list[str]
    uses: list[GroceryRecipeUse]
    checked: bool
    # True when this line comes from the pantry restock list, not a recipe.
    from_pantry: bool = False
    pantry_item_id: int | None = None


class GroceryList(BaseModel):
    start: date
    end: date
    items: list[GroceryItem]
    # Planned ingredients already stocked in the pantry: nothing to buy by
    # default, but shown with their amounts so the cook can decide otherwise.
    in_pantry: list[GroceryItem]
    pantry_restock: list[GroceryItem]


class GroceryToggle(BaseModel):
    key: str
    checked: bool


class ImportRequest(BaseModel):
    url: HttpUrl


class RecipeSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=100)


class RecipeDraft(BaseModel):
    """Parsed but unsaved recipe returned by the URL importer and the recipe
    search; the client prefills the form with it so the user can review before
    saving."""

    title: str
    description: str = ""
    instructions: str = ""
    prep_minutes: int | None = None
    cook_minutes: int | None = None
    servings: int | None = None
    ingredients: list[IngredientIn] = []
    image_url: str | None = None
    source_url: str
    # Human-readable name of the site this came from ("Budget Bytes"), for the
    # comparison tabs. Falls back to the bare host for anything off the
    # allowlist. Set by the caller, which is what knows the allowlist.
    source_label: str = ""


class ImageFromUrl(BaseModel):
    url: HttpUrl


class CopyWeekRequest(BaseModel):
    from_start: date
    to_start: date
