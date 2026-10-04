/**
 * The links into a recipe that land on one of its ingredients.
 *
 * Both ends live here so each query parameter is named in one place. A
 * grocery row or a "Needs a look" line and the recipe page agreeing on it is
 * the whole of the feature, and a renamed parameter would not fail loudly -
 * the recipe would simply open with nothing marked, which reads like a page
 * that never had the feature.
 *
 * Ingredients travel as repeated `ingredient` parameters rather than one joined
 * value. A recipe can call for the same canonical ingredient twice ("kosher
 * salt" and "salt" are one grocery line), and repetition is a shape
 * URLSearchParams already reads and writes - there is no separator to agree on,
 * and nothing to escape.
 */

const INGREDIENT_PARAM = "ingredient";
const NUTRITION_PARAM = "nutrition";

/** Where a recipe's name on the grocery list points. */
export function recipeIngredientPath(
  recipeId: number,
  ingredientIds: readonly number[],
): string {
  if (ingredientIds.length === 0) return `/recipes/${recipeId}`;
  const params = new URLSearchParams(
    ingredientIds.map((id) => [INGREDIENT_PARAM, String(id)]),
  );
  return `/recipes/${recipeId}?${params}`;
}

/**
 * The ingredient ids the recipe page should mark, as strings: they are compared
 * against ids from the URL, which has no numbers in it.
 */
export function highlightedIngredients(params: URLSearchParams): ReadonlySet<string> {
  return new Set(params.getAll(INGREDIENT_PARAM));
}

/**
 * Where an ingredient's nutrition problem points: its line in the recipe's
 * nutrition breakdown, which is where a food is chosen, rather than its row in
 * the ingredient list, which says nothing about nutrition. One ingredient, since
 * a breakdown line is one row of the recipe.
 */
export function recipeNutritionPath(recipeId: number, ingredientId: number): string {
  return `/recipes/${recipeId}?${new URLSearchParams([[NUTRITION_PARAM, String(ingredientId)]])}`;
}

/** The ingredient id whose nutrition line the recipe page should open at, as a string. */
export function highlightedNutritionLine(params: URLSearchParams): string | null {
  return params.get(NUTRITION_PARAM);
}
