"""A recipe's nutrition per serving, or the reasons there is none.

Every measured ingredient has to be counted before a figure is given at all.
A recipe with one ingredient nobody could weigh does not get a slightly low
number; it gets no number and a list of what is in the way. That is stricter
than pricing, which shows "3 of 4 priced" beside its total, and deliberately
so: a price short by one ingredient is still roughly a price, while calories
short by the butter are not roughly anything.

Ingredients a recipe honestly leaves unmeasured - "salt, to taste" - are one
exception, and ingredients a person has said do not count are the other.
Neither is counted, neither blocks the figure, and the page names both beside
it.
"""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import Ingredient, IngredientFoodMatch, Recipe
from ...schemas import (
    FoodChoice,
    FoodOut,
    NutrientsOut,
    NutritionLine,
    RecipeNutrition,
    RecipeRef,
)
from . import foods, weights
from .defaults import default_for, nutrition_key


def nutrients_out(amount: foods.Nutrients) -> NutrientsOut:
    return NutrientsOut(
        kcal=round(amount.kcal, 1),
        protein_g=round(amount.protein_g, 1),
        fat_g=round(amount.fat_g, 1),
        carbs_g=round(amount.carbs_g, 1),
        sodium_mg=round(amount.sodium_mg, 1),
    )


def food_out(food: foods.Food) -> FoodOut:
    return FoodOut(fdc_id=food.fdc_id, description=food.description, category=food.category)


def food_choice(food: foods.Food) -> FoodChoice:
    return FoodChoice(**food_out(food).model_dump(), per_100g=nutrients_out(food.per_100g))


async def hand_picks(session: AsyncSession, keys: set[str]) -> dict[str, int | None]:
    """The foods people chose, by nutrition key. None means "does not count"."""
    if not keys:
        return {}
    rows = await session.execute(
        select(IngredientFoodMatch).where(IngredientFoodMatch.key.in_(keys))
    )
    return {row.key: row.fdc_id for row in rows.scalars()}


async def choose(session: AsyncSession, key: str, fdc_id: int | None) -> None:
    """Say which food an ingredient means, everywhere it is used, or that it
    does not count."""
    row = await session.get(IngredientFoodMatch, key)
    if row is None:
        row = IngredientFoodMatch(key=key)
        session.add(row)
    row.fdc_id = fdc_id
    await session.commit()


async def recipes_using(session: AsyncSession, key: str) -> list[RecipeRef]:
    """Every recipe with an ingredient under this nutrition key, by title.

    What a shared choice reaches, named before it is made. The key is worked
    out from each ingredient's name rather than stored, so this reads every
    ingredient name: one query, and a string function per row.
    """
    rows = await session.execute(
        select(Recipe.id, Recipe.title, Ingredient.name).join(
            Ingredient, Ingredient.recipe_id == Recipe.id
        )
    )
    found = {rid: title for rid, title, name in rows.all() if nutrition_key(name) == key}
    return [
        RecipeRef(id=rid, title=title)
        for rid, title in sorted(found.items(), key=lambda item: (item[1].casefold(), item[0]))
    ]


async def forget(session: AsyncSession, key: str) -> None:
    """Drop a choice, so the ingredient goes back to its default, if any."""
    await session.execute(delete(IngredientFoodMatch).where(IngredientFoodMatch.key == key))
    await session.commit()


async def recipe_nutrition(session: AsyncSession, recipe: Recipe) -> RecipeNutrition:
    keys = [nutrition_key(ing.name) for ing in recipe.ingredients]
    picked = await hand_picks(session, {k for k in keys if k})

    lines: list[NutritionLine] = []
    total = foods.Nutrients()
    counted = 0
    measured = 0
    for ing, key in zip(recipe.ingredients, keys, strict=True):
        line = NutritionLine(ingredient_id=ing.id, name=ing.name, key=key)
        issue = ing.issue
        if ing.quantity is None and issue is None:
            line.measured = False
            lines.append(line)
            continue
        if key in picked and picked[key] is None:
            # A person said it does not count - a garnish, a pinch of
            # something no food list has - so it is left out, and does not
            # stand in the way of the rest. Whatever else is wrong with the
            # row no longer matters to the figure.
            line.skipped = True
            line.hand_picked = True
            lines.append(line)
            continue
        measured += 1

        default = default_for(key)
        fdc_id = picked.get(key, default.fdc_id if default is not None else None)
        # A chosen id the bundled tables no longer hold is no food at all,
        # rather than an error: see usda/README.md.
        chosen = foods.food(fdc_id) if fdc_id is not None else None
        if chosen is not None:
            line.food = food_choice(chosen)
            line.hand_picked = key in picked
        elif issue is None:
            issue = "no_food"

        if issue is None and chosen is not None:
            # A default's hints describe its own food, and mean nothing for a
            # different one a person picked instead.
            hints = default if default is not None and default.fdc_id == chosen.fdc_id else None
            amount = weights.grams(chosen, ing.quantity, ing.unit, ing.name, key, hints)
            if amount is None:
                issue = "unweighable"
            else:
                part = chosen.per_100g.scaled(amount / 100)
                line.grams = round(amount, 1)
                line.nutrients = nutrients_out(part)
                total += part
                counted += 1

        line.issue = issue
        lines.append(line)

    complete = counted > 0 and counted == measured
    per_serving = (
        nutrients_out(total.scaled(1 / recipe.servings))
        if complete and recipe.servings
        else None
    )
    return RecipeNutrition(
        servings=recipe.servings,
        per_serving=per_serving,
        counted=counted,
        total_lines=measured,
        lines=lines,
    )
