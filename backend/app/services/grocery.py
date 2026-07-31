"""Builds the aggregated grocery list for a date range of planned meals.

Ingredients are merged across recipes by normalized name. Quantities are
summed per normalized unit, so "2 cups flour" + "1 cup flour" becomes
"3 cups", while mixed units are listed side by side ("1 cup + 2 tbsp").
Totals are rendered as cooking fractions rather than decimals by
services.quantity, so a scaled half-batch reads "1½ cups", not "1.5 cups".
Ingredients already in the pantry are set aside rather than bought, and
out-of-stock pantry items are added, so a single list covers the whole
shopping trip.
"""

import re
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import GroceryCheck, MealPlanEntry, PantryItem, Recipe
from ..schemas import GroceryItem, GroceryList, GroceryRecipeUse
from .canonical import best_display, canonical_key
from .quantity import format_quantity

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
    "packets": "packet",
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


def scale_factor(entry: MealPlanEntry) -> float:
    """How much to scale this entry's ingredient quantities: planned servings
    over the recipe's own serving count. 1.0 when either side is unset."""
    if entry.servings and entry.recipe.servings:
        return entry.servings / entry.recipe.servings
    return 1.0


# Units whose display form pluralizes with a plain "s" ("2 cans", "3 cups").
# Abbreviations (tbsp, g, lb, oz) stay as-is.
PLURALIZABLE_UNITS = {
    "cup", "can", "clove", "package", "packet", "bunch", "piece", "slice", "pinch",
}


def _format_amounts(per_unit: dict[str | None, float], unitless_uses: int) -> list[str]:
    amounts = []
    for unit, total in per_unit.items():
        if unit is None:
            amounts.append(format_quantity(total))
        else:
            # Amounts of one or less stay singular the way recipes write them:
            # "¼ cup", "1 cup", but "3 cups".
            plural = unit in PLURALIZABLE_UNITS and total > 1
            display_unit = f"{unit}s" if plural else unit
            amounts.append(f"{format_quantity(total)} {display_unit}")
    if not amounts and unitless_uses:
        amounts.append("as needed")
    return amounts


def _needs_buying(pantry: PantryItem | None, checked: bool) -> bool:
    """Whether a pantry-tracked line belongs in the "to buy" section.

    An in-stock staple is nothing to buy, so it is normally set aside. But
    checking an item off is itself what restocks it (routes.grocery.toggle_item
    flips in_stock), so treating every in-stock staple as set aside would move
    the row out from under the user the instant they ticked it - mid-trip, with
    no way to confirm it was bought and no way to untick it. A checked staple
    therefore stays in "to buy" and renders struck through, until the
    checkmarks are cleared.
    """
    return pantry is None or not pantry.in_stock or checked


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
        factor = scale_factor(entry)
        for ing in entry.recipe.ingredients:
            key = item_key(ing.name)
            if not key:
                continue
            name_variants[key].append(ing.name.strip())
            unit = normalize_unit(ing.unit)
            scaled = ing.quantity * factor if ing.quantity is not None else None
            if scaled is not None:
                quantities[key][unit] += scaled
            else:
                no_quantity_uses[key] += 1
            uses[key].append(
                GroceryRecipeUse(
                    recipe_id=entry.recipe.id,
                    recipe_title=entry.recipe.title,
                    quantity=round(scaled, 2) if scaled is not None else None,
                    unit=unit,
                )
            )

    items: list[GroceryItem] = []
    in_pantry: list[GroceryItem] = []
    for key, variants in name_variants.items():
        pantry = pantry_by_key.get(key)
        item = GroceryItem(
            key=key,
            name=best_display(variants),
            amounts=_format_amounts(quantities.get(key, {}), no_quantity_uses[key]),
            uses=uses[key],
            checked=key in checked_keys,
            from_pantry=pantry is not None,
            pantry_item_id=pantry.id if pantry is not None else None,
        )
        # An ingredient already in the pantry is set aside, not dropped: "in
        # stock" says nothing about whether there is enough for the week being
        # planned, and an ingredient that silently never appears is only
        # discovered at the stove. The amounts travel with it so the cook can
        # weigh what the meals need against what the jar holds.
        if _needs_buying(pantry, key in checked_keys):
            items.append(item)
        else:
            in_pantry.append(item)
    items.sort(key=lambda i: normalize_name(i.name))
    in_pantry.sort(key=lambda i: normalize_name(i.name))

    covered_keys = {i.key for i in items} | {i.key for i in in_pantry}
    restock: list[GroceryItem] = []
    for pantry in pantry_items:
        key = item_key(pantry.name)
        if key in covered_keys or not _needs_buying(pantry, key in checked_keys):
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

    return GroceryList(
        start=start,
        end=end,
        items=items,
        in_pantry=in_pantry,
        pantry_restock=restock,
    )
