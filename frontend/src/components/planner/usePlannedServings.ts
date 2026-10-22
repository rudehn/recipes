import { useCallback, useEffect, useRef, useState } from "react";

import { api, type PlannedMeal } from "../../api";
import type { Action } from "../../useAction";

/**
 * A count as it is stored. The recipe's own count is null, so a later edit to
 * the recipe flows through to the meals planned from it.
 */
const asStored = (meal: PlannedMeal, count: number) =>
  count === meal.recipe.servings ? null : count;

/**
 * Planned servings, stepped a tap at a time and saved one write at a time.
 *
 * A tap used to count from the servings the page last loaded, save, and
 * reload. Two taps inside one round trip both counted from four, so a meal
 * tapped up twice landed on five rather than six. Here a tap counts from the
 * tap before it and shows at once, before the server has answered.
 *
 * Only one write per meal is out at a time, carrying the newest count when it
 * leaves, and a tap made meanwhile is sent when it lands. So an older count
 * can never land after a newer one, and a burst of taps costs two writes
 * rather than one each.
 */
export function usePlannedServings(
  run: Action["run"],
  onSaved: (saved: PlannedMeal) => void,
  onFailed: () => void,
) {
  // The count each meal has been stepped to and not yet saved. The ref is
  // what the next tap counts from, so taps between two renders still add up;
  // the state is the same map, for drawing.
  const stepped = useRef(new Map<string, number>());
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const saving = useRef(new Set<string>());

  // The page's newest callbacks, since a write can outlive the render that
  // sent it: one that fails after moving to another week reloads that week.
  const callbacks = useRef({ onSaved, onFailed });
  useEffect(() => {
    callbacks.current = { onSaved, onFailed };
  });

  function set(key: string, count: number | undefined) {
    const next = new Map(stepped.current);
    if (count === undefined) next.delete(key);
    else next.set(key, count);
    stepped.current = next;
    setCounts(next);
  }

  async function save(meal: PlannedMeal, entryId: number) {
    const key = meal.key;
    saving.current.add(key);
    const result: { saved?: PlannedMeal } = {};
    let sent: number | undefined;
    let ok = true;
    // Looked at again after every write: a tap made while it was out goes next.
    while (ok && stepped.current.get(key) !== sent) {
      const count = stepped.current.get(key)!;
      sent = count;
      ok = await run(async () => {
        result.saved = await api.updateMealPlanServings(
          entryId,
          asStored(meal, count),
        );
      });
    }
    saving.current.delete(key);
    // In the same tick as the callback, so the count never flickers back to
    // the loaded one between the two.
    set(key, undefined);
    if (ok && result.saved) callbacks.current.onSaved(result.saved);
    else callbacks.current.onFailed();
  }

  function step(meal: PlannedMeal, delta: number) {
    // Only a stored row has servings of its own to write.
    if (meal.entry_id === null) return;
    const base =
      stepped.current.get(meal.key) ?? meal.servings ?? meal.recipe.servings;
    if (base == null) return;
    set(meal.key, Math.max(1, base + delta));
    if (!saving.current.has(meal.key)) void save(meal, meal.entry_id);
  }

  /** The meals with every count still being saved shown as it will be. */
  const shown = useCallback(
    (meals: PlannedMeal[]) =>
      counts.size === 0
        ? meals
        : meals.map((e) => {
            const count = counts.get(e.key);
            return count === undefined
              ? e
              : { ...e, servings: asStored(e, count) };
          }),
    [counts],
  );

  return { shown, step };
}
