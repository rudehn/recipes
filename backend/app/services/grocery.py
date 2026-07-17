"""Builds the aggregated grocery list for a date range of planned meals.

Ingredients are merged across recipes by normalized name. Quantities are
summed per normalized unit, so "2 cups flour" + "1 cup flour" becomes
"3 cups", while mixed units are listed side by side ("1 cup + 2 tbsp").
Pantry items that are in stock are dropped from the list; out-of-stock
pantry items are added so a single list covers the whole shopping trip.
"""

import re
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import GroceryCheck, Ingredient, MealPlanEntry, PantryItem, Recipe
from ..schemas import GroceryItem, GroceryList, GroceryRecipeUse
from .canonical import best_display, canonical_key

UNIT_ALIASES = {
    "tablespoon": "tbsp", "tablespoons": "tbsp", "tbsps": "tbsp", "tbs": "tbsp",
    "teaspoon": "tsp", "teaspoons": "tsp", "tsps": "tsp",
    "cups": "cup", "c": "cup",
    "gram": "g", "grams": "g", "gr": "g",
    "kilogram": "kg", "kilograms": "kg",
    "milliliter": "ml", "milliliters": "ml",
    "liter": "l", "liters": "l", "litre": "l", "litres": "l",
    "ounce": "oz", "ounces": "oz",
    "pound": "lb", "pounds": "lb", "lbs": "lb",
    "cloves": "clove",
    "cans": "can",
    "packages": "package", "pkg": "package",
    "bunches": "bunch",
    "pieces": "piece", "pcs": "piece",
    "slices": "slice",
    "pinches": "pinch",
}


def normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).casefold()


def normalize_unit(unit: str | None) -> str | None:
    if unit is None:
        return None
    u = re.sub(r"\s+", " ", unit.strip()).casefold().rstrip(".")
    if not u:
        return None
    return UNIT_ALIASES.get(u, u)


# Merge key for grocery items and pantry matching; also the identity that
# checked-off state is stored under. See services.canonical for the rules.
item_key = canonical_key


def format_quantity(q: float) -> str:
    if q == int(q):
        return str(int(q))
    return f"{q:g}"


# Units whose display form pluralizes with a plain "s" ("2 cans", "3 cups").
# Abbreviations (tbsp, g, lb, oz) stay as-is.
PLURALIZABLE_UNITS = {"cup", "can", "clove", "package", "bunch", "piece", "slice", "pinch"}


def _format_amounts(per_unit: dict[str | None, float], unitless_uses: int) -> list[str]:
    amounts = []
    for unit, total in per_unit.items():
        if unit is None:
            amounts.append(format_quantity(total))
        else:
            display_unit = f"{unit}s" if unit in PLURALIZABLE_UNITS and total != 1 else unit
            amounts.append(f"{format_quantity(total)} {display_unit}")
    if not amounts and unitless_uses:
        amounts.append("as needed")
    return amounts


async def build_grocery_list(
    session: AsyncSession, start: date, end: date
) -> GroceryList:
    entries = (
        await session.execute(
            select(MealPlanEntry)
            .where(MealPlanEntry.plan_date >= start, MealPlanEntry.plan_date <= end)
            .join(MealPlanEntry.recipe)
            .join(Recipe.ingredients, isouter=True)
        )
    ).unique().scalars().all()

    pantry_items = (await session.execute(select(PantryItem))).scalars().all()
    pantry_by_key = {canonical_key(p.name): p for p in pantry_items}

    checks = (await session.execute(select(GroceryCheck))).scalars().all()
    checked_keys = {c.key for c in checks if c.checked}

    # key -> aggregation state
    name_variants: dict[str, list[str]] = defaultdict(list)
    quantities: dict[str, dict[str | None, float]] = defaultdict(lambda: defaultdict(float))
    no_quantity_uses: dict[str, int] = defaultdict(int)
    uses: dict[str, list[GroceryRecipeUse]] = defaultdict(list)

    for entry in entries:
        for ing in entry.recipe.ingredients:
            key = item_key(ing.name)
            if not key:
                continue
            name_variants[key].append(ing.name.strip())
            unit = normalize_unit(ing.unit)
            if ing.quantity is not None:
                quantities[key][unit] += ing.quantity
            else:
                no_quantity_uses[key] += 1
            uses[key].append(
                GroceryRecipeUse(
                    recipe_id=entry.recipe.id,
                    recipe_title=entry.recipe.title,
                    quantity=ing.quantity,
                    unit=unit,
                )
            )

    items: list[GroceryItem] = []
    for key, variants in name_variants.items():
        name = best_display(variants)
        pantry = pantry_by_key.get(key)
        if pantry is not None and pantry.in_stock:
            # Already stocked; nothing to buy.
            continue
        items.append(
            GroceryItem(
                key=key,
                name=name,
                amounts=_format_amounts(quantities.get(key, {}), no_quantity_uses[key]),
                uses=uses[key],
                checked=key in checked_keys,
                from_pantry=pantry is not None,
                pantry_item_id=pantry.id if pantry is not None else None,
            )
        )
    items.sort(key=lambda i: normalize_name(i.name))

    covered_keys = {i.key for i in items}
    restock: list[GroceryItem] = []
    for pantry in pantry_items:
        key = item_key(pantry.name)
        if pantry.in_stock or key in covered_keys:
            continue
        restock.append(
            GroceryItem(
                key=key,
                name=pantry.name,
                amounts=[],
                uses=[],
                checked=key in checked_keys,
                from_pantry=True,
                pantry_item_id=pantry.id,
            )
        )
    restock.sort(key=lambda i: normalize_name(i.name))

    return GroceryList(start=start, end=end, items=items, pantry_restock=restock)
