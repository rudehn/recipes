/**
 * What the Ingredients pages say about an ingredient, in one place.
 *
 * The list and the ingredient's own page describe the same facts, and two
 * copies of the wording drift apart; the recipe-side reasons already did
 * once, which is why `issues.ts` exists. The words for what is wrong come
 * from there.
 */

import type { IngredientProblem, IngredientSummary } from "./api";
import { ISSUE_LABELS } from "./issues";

const money = (n: number) => `$${n.toFixed(2)}`;

/** The muted line under a name: its recipes, its standing at the store, its food. */
export function summaryLine(item: IngredientSummary): string {
  const count = item.recipe_count;
  const parts = [count === 0 ? "no recipes" : `${count} recipe${count === 1 ? "" : "s"}`];

  const standing = item.product;
  if (standing) {
    const picked = standing.status === "picked" || standing.status === "auto";
    if (picked && standing.product) {
      const p = standing.product;
      parts.push(`${p.description} ${money(p.promo ?? p.regular)}`);
    } else if (picked) {
      parts.push("product picked");
    } else if (standing.status === "not_priced") {
      parts.push("not priced");
    } else if (standing.status === "no_match") {
      parts.push(ISSUE_LABELS.no_match);
    }
  }

  // Also when only a line lacks one: "cooked rice" is a food of its own, and
  // "counted" beside the row's "no food chosen" tag said two things at once.
  const food = item.food.status;
  const missing = food === "none" || item.problems.includes("no_food");
  parts.push(missing ? ISSUE_LABELS.no_food : food === "skipped" ? "doesn't count" : "counted");
  return parts.join(" · ");
}

export const PROBLEM_LABELS: Record<IngredientProblem, string> = {
  merge: "might be a duplicate",
  no_match: ISSUE_LABELS.no_match,
  no_food: ISSUE_LABELS.no_food,
  fix_line: "line to fix",
};

/**
 * The Needs a look groups an ingredient can fall under, in the order they are
 * worked through. Suggested merges come first and are listed from the
 * suggestions themselves, not from here.
 */
export const PROBLEM_GROUPS: readonly (readonly [IngredientProblem, string])[] = [
  ["no_match", "No product at your store"],
  ["no_food", "No food for nutrition"],
  ["fix_line", "Recipe lines to fix"],
];

/** Whether a search finds an ingredient, by its name or any merged into it. */
export function matchesSearch(item: IngredientSummary, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return true;
  return [item.name, ...item.also_called].some((name) => name.toLocaleLowerCase().includes(wanted));
}

/**
 * Which way to propose a merge: [the name going away, the one that survives].
 *
 * A staple survives first, because its name is the one on the shopping list
 * and in the cupboard; then a hand-picked product, because that choice is
 * the owner's work; then the name with fewer words, the more general one
 * ("cumin" over "ground cumin"); then the one more recipes use. The dialog
 * offers Swap whatever this proposes.
 */
export function proposeDirection(
  a: IngredientSummary,
  b: IngredientSummary,
): [IngredientSummary, IngredientSummary] {
  const weight = (i: IngredientSummary) =>
    [
      i.staple ? 1 : 0,
      i.product?.status === "picked" ? 1 : 0,
      -i.key.split("-").length,
      i.recipe_count,
    ] as const;
  const [wa, wb] = [weight(a), weight(b)];
  for (let n = 0; n < wa.length; n++) {
    if (wa[n] !== wb[n]) return wa[n] > wb[n] ? [b, a] : [a, b];
  }
  return a.key < b.key ? [b, a] : [a, b];
}
