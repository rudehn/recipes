import type { DayCost, EntryCost, Meal, PlannedMeal } from "../../api";
import { toISODate } from "../../dates";

export const MEALS: Meal[] = ["breakfast", "lunch", "dinner", "snack"];

/** The meals of one day's one meal slot, keyed by cellKey. */
export type Cells = Map<string, PlannedMeal[]>;

/** Where a day's one meal slot is found in Cells. */
export const cellKey = (date: string, meal: Meal) => `${date}|${meal}`;

/** The meals grouped into their day's meal slots, in the order given. */
export function byCell(meals: PlannedMeal[]): Cells {
  const map: Cells = new Map();
  for (const e of meals) {
    const key = cellKey(e.plan_date, e.meal);
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return map;
}

/** Whether a day (as an ISO date) is before today's. */
export const isPast = (iso: string, today: Date = new Date()) =>
  iso < toISODate(today);

/** What either layout can do to an entry already in a cell. */
export interface EntryActions {
  onRemove: (entryId: number) => void;
  onChangeServings: (meal: PlannedMeal, delta: number) => void;
}

/** A figure and how much of it is priced, which a day and a meal both carry. */
export type Costed = Pick<DayCost, "total" | "priced" | "total_lines">;

/** What each day and each planned meal costs, for the layouts to look up. */
export interface Costs {
  days: Map<string, DayCost>;
  entries: Map<string, EntryCost>;
}

export const money = (n: number) => `$${n.toFixed(2)}`;

/** Whether a figure has anything priced in it to show. */
export const priced = (cost: Costed | undefined): cost is Costed =>
  cost !== undefined && cost.priced > 0;

export interface LayoutProps extends EntryActions {
  days: Date[];
  byCell: Cells;
  costs: Costs;
  /** Opens the picker on the day and meal that asked for it. */
  onAdd: (cell: { date: string; meal: Meal }) => void;
}
