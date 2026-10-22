import type { Meal, PlannedMeal, RecipeSummary } from "../../api";
import { formatDay, fromISODate } from "../../dates";

/**
 * What is being put on the plan, between choosing it and choosing its cell: a
 * recipe (a pick or a search result), or a meal already on the plan, moved or
 * copied. Click to place holds one while the cells wait to be chosen; a drag
 * holds one while it is in the air.
 */
export type Placing =
  | { kind: "recipe"; recipe: RecipeSummary }
  | { kind: "meal"; meal: PlannedMeal; copy: boolean };

/** A day's one meal slot, the way a cell names where it is. */
export interface CellRef {
  date: string;
  meal: Meal;
}

/** What a cell does while something is being placed. */
export interface CellTarget {
  /** The cell's accessible name while it is a target: "Place Curry on Wed dinner". */
  name: string;
  onPlace: () => void;
}

/** The recipe being placed, by its title. */
export const placingTitle = (p: Placing) =>
  p.kind === "recipe" ? p.recipe.title : p.meal.recipe.title;

const verbOf = (p: Placing) => (p.kind === "recipe" ? "Place" : p.copy ? "Copy" : "Move");

/** What placing `p` on a cell would be called, for the cell to be named by. */
export function placeName(p: Placing, { date, meal }: CellRef): string {
  return `${verbOf(p)} ${placingTitle(p)} on ${formatDay(fromISODate(date))} ${meal}`;
}

/** The target each cell is while `p` is being placed, or null when nothing is. */
export function cellTarget(
  p: Placing | null,
  cell: CellRef,
  onPlace: (cell: CellRef) => void,
): CellTarget | null {
  return p && { name: placeName(p, cell), onPlace: () => onPlace(cell) };
}

/**
 * The days of the week a recipe is planned on, as short weekday names in week
 * order, each once however many of its meals it is in. Worked out from the
 * plan each time rather than kept with the pick, so moving or removing a meal
 * is reflected without anything else to update.
 */
export function placedDays(recipeId: number, meals: PlannedMeal[]): string[] {
  const days = new Set(meals.filter((m) => m.recipe.id === recipeId).map((m) => m.plan_date));
  return [...days].sort().map((iso) => formatDay(fromISODate(iso)));
}
