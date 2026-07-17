from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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


class RecipeSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    image_filename: str | None
    prep_minutes: int | None
    cook_minutes: int | None
    servings: int | None


class MealPlanEntryIn(BaseModel):
    plan_date: date
    meal: Meal
    recipe_id: int


class MealPlanEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_date: date
    meal: Meal
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
