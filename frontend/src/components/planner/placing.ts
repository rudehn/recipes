import type { DragEvent } from "react";

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

/** Whether `cell` is where the meal being placed already is, which is no place to put it. */
export const isOwnCell = (p: Placing, { date, meal }: CellRef) =>
  p.kind === "meal" && p.meal.plan_date === date && p.meal.meal === meal;

/**
 * The target each cell is while `p` is being placed, or null when nothing
 * is, or when the cell is the placed meal's own: that is no place to put it,
 * and the meal and its menu stay in reach there.
 */
export function cellTarget(
  p: Placing | null,
  cell: CellRef,
  onPlace: (cell: CellRef) => void,
): CellTarget | null {
  if (!p || isOwnCell(p, cell)) return null;
  return { name: placeName(p, cell), onPlace: () => onPlace(cell) };
}

/**
 * Whether placing `p` makes a new meal: a recipe always does, and a meal
 * does when it is copied, by its own choice or by Alt (Option) held as it
 * is dropped. Otherwise the meal moves.
 */
export const copies = (p: Placing, altKey: boolean) =>
  p.kind === "recipe" || p.copy || altKey;

/** What a cell does while something is dragged over the plan. */
export interface CellDrop {
  /** The drop a browser shows for the pointer: a copy, or a move. */
  effect: (altKey: boolean) => "copy" | "move";
  onDrop: (altKey: boolean) => void;
}

/**
 * The drop each cell is while `p` is dragged, or null when nothing is, or
 * when the cell is the dragged meal's own: a meal let go where it started
 * stays as it was, so that cell does not take the drop at all.
 */
export function cellDrop(
  p: Placing | null,
  cell: CellRef,
  onDrop: (cell: CellRef, altKey: boolean) => void,
): CellDrop | null {
  if (!p || isOwnCell(p, cell)) return null;
  return {
    effect: (altKey) => (copies(p, altKey) ? "copy" : "move"),
    onDrop: (altKey) => onDrop(cell, altKey),
  };
}

/**
 * The type every drag of the planner's own carries, which tells it from a
 * file or text dragged in from elsewhere: those carry only their own types.
 */
export const PLACING_TYPE = "application/x-mise-placing";

/** Whether a drag is one of the planner's own, started by startDrag. */
export const isPlacingDrag = (data: DataTransfer | null) =>
  data !== null && Array.from(data.types).includes(PLACING_TYPE);

/**
 * Starts dragging `p` from where the drag began, and ends it with null when
 * the drag ends. The page keeps what is dragged; the browser is given only
 * its title, since some will not start a drag that carries nothing, and a
 * title is all a drop outside the page should get.
 *
 * The end is heard on the element itself rather than through React, which
 * hears only what reaches its root: a row the list redraws while it is
 * dragged is no longer there, and its drag would never end.
 */
export function startDrag(event: DragEvent, p: Placing, onDrag: (p: Placing | null) => void) {
  event.dataTransfer.effectAllowed = p.kind === "recipe" ? "copy" : "copyMove";
  event.dataTransfer.setData("text/plain", placingTitle(p));
  event.dataTransfer.setData(PLACING_TYPE, p.kind);
  event.currentTarget.addEventListener("dragend", () => onDrag(null), { once: true });
  onDrag(p);
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
