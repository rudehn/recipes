/**
 * The link from a grocery line to the recipe that asked for it.
 *
 * Both ends live here so the query parameter is named in one place. A grocery
 * row and the recipe page agreeing on it is the whole of the feature, and a
 * renamed parameter would not fail loudly - the recipe would simply open with
 * nothing marked, which reads like a page that never had the feature.
 *
 * Ingredients travel as repeated `ingredient` parameters rather than one joined
 * value. A recipe can call for the same canonical ingredient twice ("kosher
 * salt" and "salt" are one grocery line), and repetition is a shape
 * URLSearchParams already reads and writes - there is no separator to agree on,
 * and nothing to escape.
 */

const INGREDIENT_PARAM = "ingredient";

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
