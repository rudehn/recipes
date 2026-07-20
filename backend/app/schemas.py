from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

Meal = Literal["breakfast", "lunch", "dinner", "snack"]


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
    # Lets the client search recipes by what's in them.
    ingredient_names: list[str] = []


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


class ImageFromUrl(BaseModel):
    url: HttpUrl


class CopyWeekRequest(BaseModel):
    from_start: date
    to_start: date
