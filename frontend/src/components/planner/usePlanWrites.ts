import type { Dispatch, SetStateAction } from "react";

import { api, type PlannedMeal } from "../../api";
import type { Action } from "../../useAction";
import {
  classify,
  labelsForNew,
  sameWeekdays,
  type ChangeTarget,
  type LabelFilter,
  type MealChange,
} from "./plan";
import { copies, isOwnCell, type CellRef, type Placing } from "./placing";

/**
 * Every write the planner makes to the week, and what follows each one: the
 * week loaded again, or the saved meal put in place of the loaded one.
 *
 * A repeated meal is changed through its repeat, never as a row of its own:
 * even a day that already has a row (changed on its own before) is still the
 * repeat's, and its Just this day goes through the repeat too. A change from
 * a day on reaches days other than the one shown, so the week is loaded
 * again after any of them.
 */
export function usePlanWrites({
  action,
  filter,
  setEntries,
  reload,
  reloadLabels,
}: {
  /** Runs each write, and holds why the last one failed. */
  action: Action;
  /** The label filter, whose label a meal added under it gets. */
  filter: LabelFilter;
  setEntries: Dispatch<SetStateAction<PlannedMeal[] | null>>;
  /** Loads the week again. */
  reload: () => void;
  /** Loads the labels again, whose counts follow the meals that carry them. */
  reloadLabels: () => void;
}) {
  /**
   * The saved meal in place of the loaded one, which also asks for the cost
   * again: the meal's figure follows its new count.
   */
  function putSaved(saved: PlannedMeal) {
    setEntries((prev) => prev?.map((e) => (e.key === saved.key ? saved : e)) ?? prev);
  }

  /** Loads the week again after a write that went through, and says whether it did. */
  function written(ok: boolean) {
    if (ok) reload();
    return ok;
  }

  /**
   * Plans a recipe on a cell, as a one-off with the recipe's own servings and
   * the selected label; a meal being copied gives its own instead, since the
   * copy is the same meal again. Answers whether it went through.
   */
  async function plan(
    { date, meal }: CellRef,
    recipeId: number,
    {
      servings = null,
      labelIds = labelsForNew(filter),
    }: { servings?: number | null; labelIds?: number[] } = {},
  ): Promise<boolean> {
    const ok = await action.run(() =>
      api.addMealPlanEntry({
        plan_date: date,
        meal,
        recipe_id: recipeId,
        ...(servings !== null && { servings }),
        ...(labelIds.length > 0 && { label_ids: labelIds }),
      }),
    );
    return written(ok);
  }

  /**
   * Puts a recipe or a meal on a cell, by a drag or a press. A recipe is
   * planned there. A meal moves there, or, copied, is planned there again as
   * a one-off with its own servings and labels. A repeated meal's day moves
   * through its repeat, as that day alone: it is somewhere the repeat never
   * goes, so there is nothing to ask. A meal put back where it is stays.
   * Answers whether anything was written.
   */
  async function dropOn(cell: CellRef, p: Placing, altKey: boolean): Promise<boolean> {
    if (p.kind === "recipe") return plan(cell, p.recipe.id);
    const { meal } = p;
    if (isOwnCell(p, cell)) return false;
    if (copies(p, altKey)) {
      const copy = { servings: meal.servings, labelIds: meal.labels.map((l) => l.id) };
      return plan(cell, meal.recipe.id, copy);
    }
    const known = classify(meal);
    const write = known.repeat
      ? () => api.moveRepeatDay(known.repeat.id, known.plan_date, cell.date, cell.meal)
      : () => api.updateMealPlanEntry(known.entry_id, { plan_date: cell.date, meal: cell.meal });
    return written(await action.run(write));
  }

  async function removeEntry(target: ChangeTarget) {
    const write =
      target.length === 2
        ? () => api.removeRepeatDay(target[0].repeat.id, target[0].plan_date, target[1])
        : () => api.deleteMealPlanEntry(target[0].entry_id);
    written(await action.run(write));
  }

  /**
   * Changes a meal's servings, labels or both in one write, which is how a
   * phone's meal sheet sends what it collected. Answers whether it went
   * through.
   */
  async function changeMeal(
    target: ChangeTarget,
    { servings, labelIds }: MealChange,
  ): Promise<boolean> {
    const fields = {
      ...(servings !== undefined && { servings }),
      ...(labelIds !== undefined && { label_ids: labelIds }),
    };
    // The counts beside the labels are asked for again after a label change.
    const labelled = () => labelIds !== undefined && reloadLabels();
    if (target.length === 2) {
      const [meal, scope] = target;
      const ok = await action.run(() =>
        api.changeRepeatDay(meal.repeat.id, meal.plan_date, { scope, ...fields }),
      );
      if (written(ok)) labelled();
      return ok;
    }
    const [{ entry_id }] = target;
    let saved: PlannedMeal | undefined;
    const ok = await action.run(async () => {
      saved = await api.updateMealPlanEntry(entry_id, fields);
    });
    if (ok && saved) {
      putSaved(saved);
      labelled();
    } else {
      reload();
    }
    return ok;
  }

  /** Puts exactly these labels on a meal. */
  const setLabels = (target: ChangeTarget, labelIds: number[]) =>
    void changeMeal(target, { labelIds });

  /**
   * A one-off starts repeating from its day; a repeat's days change from this
   * day on, and Just this day ends it after this day. Choosing what a meal
   * already does changes nothing.
   */
  async function repeat(meal: PlannedMeal, weekdays: number[] | null) {
    if (sameWeekdays(meal.repeat?.weekdays ?? null, weekdays)) return;
    const known = classify(meal);
    let write: () => Promise<unknown>;
    if (!known.repeat) {
      // Just this day on a one-off is what it already is, caught above.
      if (weekdays === null) return;
      write = () => api.startRepeat(known.entry_id, weekdays);
    } else {
      const repeatId = known.repeat.id;
      write =
        weekdays === null
          ? () => api.stopRepeat(repeatId, known.plan_date)
          : () => api.changeRepeatDay(repeatId, known.plan_date, { scope: "from", weekdays });
    }
    written(await action.run(write));
  }

  /** Makes a label, answering it; the labels are loaded again to list it. */
  async function createLabel(name: string) {
    const label = await api.createLabel(name);
    reloadLabels();
    return label;
  }

  return { putSaved, plan, dropOn, removeEntry, changeMeal, setLabels, repeat, createLabel };
}
