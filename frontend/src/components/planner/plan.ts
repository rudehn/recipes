import type { DayCost, EntryCost, Label, Meal, PlannedMeal, Repeat, Scope } from "../../api";
import { formatDate, formatDay, fromISODate, toISODate } from "../../dates";

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

/**
 * Which label's meals the planner shows. One label at a time, or none for
 * Everything; `unlabelled` keeps the meals with no label in view (dimmed)
 * while a label is selected.
 */
export interface LabelFilter {
  label: number | null;
  unlabelled: boolean;
}

export const EVERYTHING: LabelFilter = { label: null, unlabelled: true };

/** Reads the filter from the URL; anything unreadable is Everything. */
export function filterFromParams(p: URLSearchParams): LabelFilter {
  const id = Number(p.get("label"));
  if (!Number.isInteger(id) || id <= 0) return EVERYTHING;
  return { label: id, unlabelled: p.get("unlabelled") !== "0" };
}

/** Writes the filter into `p`, leaving out whatever is at its default. */
export function writeFilter(f: LabelFilter, p: URLSearchParams): URLSearchParams {
  p.delete("label");
  p.delete("unlabelled");
  if (f.label !== null) {
    p.set("label", String(f.label));
    if (!f.unlabelled) p.set("unlabelled", "0");
  }
  return p;
}

/**
 * The meals the filter shows, in the order given. With a label selected, its
 * meals show as usual, unlabelled ones show dimmed (unless switched off), and
 * meals carrying only other labels are left out.
 */
export function shownMeals(
  meals: PlannedMeal[],
  f: LabelFilter,
): { meal: PlannedMeal; dimmed: boolean }[] {
  if (f.label === null) return meals.map((meal) => ({ meal, dimmed: false }));
  const out: { meal: PlannedMeal; dimmed: boolean }[] = [];
  for (const meal of meals) {
    if (meal.labels.some((l) => l.id === f.label)) out.push({ meal, dimmed: false });
    else if (f.unlabelled && meal.labels.length === 0) out.push({ meal, dimmed: true });
  }
  return out;
}

/** The labels a meal placed under this filter starts with, whichever way it is added. */
export const labelsForNew = (f: LabelFilter): number[] => (f.label === null ? [] : [f.label]);

/** Whether a day (as an ISO date) is before today's. */
export const isPast = (iso: string, today: Date = new Date()) =>
  iso < toISODate(today);

/** A day's weekday as a repeat counts them: 0 is Monday, 6 is Sunday. */
export const weekdayOf = (iso: string) => (fromISODate(iso).getDay() + 6) % 7;

/** A day the way a repeat's choices name it: "Wed, Oct 28". */
export const dayName = (iso: string) => {
  const d = fromISODate(iso);
  return `${formatDay(d)}, ${formatDate(d)}`;
};

export type OneOffMeal = PlannedMeal & { repeat: null };
export type RepeatedMeal = PlannedMeal & { repeat: Repeat };

/**
 * A meal, and which of its days a change to it covers. A one-off has only its
 * own day. A repeated meal's change always carries the owner's answer to Just
 * this day or From this day on, so no caller can apply either one for them by
 * leaving it out.
 */
export type ChangeTarget = [meal: OneOffMeal] | [meal: RepeatedMeal, scope: Scope];

/** The target of a change to `meal`; a repeated meal without a scope is a mistake, and throws. */
export function changeTarget(meal: PlannedMeal, scope?: Scope): ChangeTarget {
  if (meal.repeat === null) return [{ ...meal, repeat: null }];
  if (scope === undefined) {
    throw new Error(`A change to a repeated meal needs a scope (${meal.key}).`);
  }
  return [{ ...meal, repeat: meal.repeat }, scope];
}

/**
 * What either layout can do to an entry already in a cell.
 *
 * A repeated meal is changed through its repeat, for its own day or from it
 * on, so the changes that can be either take a ChangeTarget.
 */
export interface EntryActions {
  onRemove: (target: ChangeTarget) => void;
  onChangeServings: (meal: PlannedMeal, delta: number) => void;
  /** The answer to a repeated meal's settled servings: its scope, or null to put them back. */
  onAnswerServings: (meal: PlannedMeal, scope: Scope | null) => void;
  /** Puts exactly these labels on a meal. */
  onSetLabels: (target: ChangeTarget, labelIds: number[]) => void;
  /** Repeats a meal on these weekdays from its day on; null for its day alone. */
  onRepeat: (meal: PlannedMeal, weekdays: number[] | null) => void;
  /** Makes a label, answering it, or rejecting with the reason it was refused. */
  onCreateLabel: (name: string) => Promise<Label>;
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
  /** The keys of meals shown dimmed, which are otherwise as usable as any. */
  dimmed: Set<string>;
  /** The keys of repeated meals whose new servings wait on Just this day or From this day on. */
  asking: ReadonlySet<string>;
  /** Every label, for the meals' checklists. */
  labels: Label[];
  /** Opens the picker on the day and meal that asked for it. */
  onAdd: (cell: { date: string; meal: Meal }) => void;
}
