"""Recipes with rows that will price, shop or count wrongly: "Needs a look".

The recipes page lists every recipe something is wrong with, so the fixes can
be made in one sitting rather than met one at a time on the grocery list or
under a recipe's missing nutrition. Each reason says what it stands in the
way of, because the fixes differ: a row the recipe has wrong is edited, a
product is chosen at the store, a food is chosen from USDA's.

Three sources, none of which calls anyone. The recipe-side reasons are
`services.lint`'s string checks over the rows. "Nothing matched" comes from
the picks already made at the chosen store - never a search, for the same
reason the suggestions never search - and only when there is a store to have
matched at. The nutrition reasons are `nutrition.facts`, counted from the
bundled USDA tables, and are there with pricing off as much as on.

It covers the whole box on every visit to the recipes page, so everything it
reads is read once for all the recipes together: the recipes, the store's
unmatched keys, and the foods people chose.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Ingredient, IngredientProductMatch, Recipe
from ..schemas import (
    Affects,
    IngredientIssue,
    LineIssue,
    NutritionIssue,
    RecipeAttention,
    RecipeNutrition,
    RecipeSummary,
)
from . import settings as settings_service
from .identity import Identity
from .kroger.client import enabled
from .nutrition import facts


async def _unmatched(session: AsyncSession) -> set[str]:
    """The keys the chosen store was searched for and had nothing for.

    Empty without pricing or a store, which is not "everything matched" but
    "nothing to say". A key a person settled as not to be priced is settled,
    and is not a fault.
    """
    store = await settings_service.selected_store(session)
    if not enabled() or store is None:
        return set()
    rows = await session.execute(
        select(IngredientProductMatch.canonical_key).where(
            IngredientProductMatch.location_id == store.location_id,
            IngredientProductMatch.product_id.is_(None),
            IngredientProductMatch.user_confirmed.is_(False),
        )
    )
    return set(rows.scalars())


def _issue(
    ing: Ingredient, issue: LineIssue | NutritionIssue, *affects: Affects
) -> IngredientIssue:
    return IngredientIssue(ingredient_id=ing.id, name=ing.name, issue=issue, affects=list(affects))


def _issues(
    recipe: Recipe, nutrition: RecipeNutrition, unmatched: set[str], identity: Identity
) -> list[IngredientIssue]:
    """Every reason in a recipe's rows, in the recipe's order.

    The nutrition side is read off the recipe's own breakdown rather than
    worked out again, so a row the breakdown leaves out - to taste, or said
    not to count - is left out here by the same rule.
    """
    found: list[IngredientIssue] = []
    for ing, line in zip(recipe.ingredients, nutrition.lines, strict=True):
        price = ing.issue or ("no_match" if identity.key(ing.name) in unmatched else None)
        food = line.issue
        if price is not None and price == food:
            # A recipe-side reason is the same reason on both sides: one edit
            # to the row fixes the price and the count together.
            found.append(_issue(ing, price, "price", "nutrition"))
            continue
        if price is not None:
            found.append(_issue(ing, price, "price"))
        if food is not None:
            found.append(_issue(ing, food, "nutrition"))
    return found


async def recipes_needing_a_look(session: AsyncSession) -> list[RecipeAttention]:
    """Recipes with something to fix, the most to fix first."""
    recipes = (await session.execute(select(Recipe))).scalars().unique().all()
    identity = await Identity.of(session)
    unmatched = await _unmatched(session)
    picked = await facts.hand_picks(
        session, {key for recipe in recipes for key in facts.recipe_keys(recipe, identity)}
    )

    found: list[RecipeAttention] = []
    for recipe in recipes:
        nutrition = facts.count_recipe(recipe, picked, identity)
        issues = _issues(recipe, nutrition, unmatched, identity)
        # Only a recipe with something to count has a figure to miss. One
        # made only of things to taste shows no nutrition at all, servings
        # or none, so there is nothing for the count to fix.
        no_servings = not recipe.servings and nutrition.total_lines > 0
        if issues or no_servings:
            found.append(
                RecipeAttention(
                    recipe=RecipeSummary.model_validate(recipe),
                    issues=issues,
                    no_servings=no_servings,
                )
            )
    found.sort(key=lambda r: (-(len(r.issues) + r.no_servings), r.recipe.title.casefold()))
    return found
