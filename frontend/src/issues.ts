/**
 * What each reason a number is doubtful says on screen, in one place.
 *
 * The same reason is met on the grocery list, on a recipe's rows, in its
 * nutrition breakdown, in both cart reviews and in the recipes page's "Needs a
 * look". While each kept its own copy they drifted - one reason read "check
 * the line", "check this line" and "check the recipe line" depending on the
 * page - and a reader who has learned a reason on one page should meet the
 * same words on the next.
 *
 * Lower case throughout: these are tags beside a row or a price, not
 * sentences.
 */

import type { LineIssue, NutritionIssue, PasteProblem } from "./api";

export const ISSUE_LABELS: Record<LineIssue | NutritionIssue, string> = {
  amount_in_name: "amount is in the name",
  no_amount: "no amount",
  // Says where to look, which matters most on the grocery list, where the
  // line on screen is not the line that is wrong.
  check_line: "check the recipe line",
  no_match: "no match",
  unsized: "can't size the amount",
  out_of_stock: "out of stock today",
  no_food: "no food chosen",
  unweighable: "can't weigh the amount",
};

/** The one reason that is the whole recipe's rather than a row's. */
export const NO_SERVINGS_LABEL = "no serving count";

/** Why a pasted line cannot go to the cart as it is. */
export const PASTE_PROBLEM_LABELS: Record<PasteProblem, string> = {
  no_match: ISSUE_LABELS.no_match,
  out_of_stock: ISSUE_LABELS.out_of_stock,
  not_orderable: "Kroger can't take this in a cart",
};

/**
 * "can't size", said against the package when both sides are known: "can't
 * size 9 cups against 10 oz" can be checked, where the bare reason can only be
 * believed.
 */
export function unsizedLabel(amount: string | null | undefined, size: string | null | undefined) {
  return amount && size ? `can't size ${amount} against ${size}` : ISSUE_LABELS.unsized;
}
