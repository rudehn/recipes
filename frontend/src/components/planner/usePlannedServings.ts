import { useCallback, useEffect, useRef, useState } from "react";

import { api, type PlannedMeal, type Scope } from "../../api";
import type { Action } from "../../useAction";
import { classify } from "./plan";

/**
 * A count as it is stored. The recipe's own count is null, so a later edit to
 * the recipe flows through to the meals planned from it.
 */
export const asStored = (meal: PlannedMeal, count: number) =>
  count === meal.recipe.servings ? null : count;

/** How long a repeated meal's taps must rest before they are asked about. */
export const SETTLE_MS = 800;

/**
 * Planned servings, stepped a tap at a time and saved one write at a time.
 *
 * A tap used to count from the servings the page last loaded, save, and
 * reload. Two taps inside one round trip both counted from four, so a meal
 * tapped up twice landed on five rather than six. Here a tap counts from the
 * tap before it and shows at once, before the server has answered.
 *
 * A one-off meal has only one write per meal out at a time, carrying the
 * newest count when it leaves, and a tap made meanwhile is sent when it lands.
 * So an older count can never land after a newer one, and a burst of taps
 * costs two writes rather than one each.
 *
 * A repeated meal has a question to ask before it can save anything (Just
 * this day, or From this day on), and asking it on every tap would make a
 * stepper unusable. So its taps are collected, and once they have rested for
 * SETTLE_MS the meal joins `asking` and its count waits there, shown but not
 * saved, for `answer`. A tap meanwhile puts the question away until the taps
 * rest again.
 */
export function usePlannedServings(
  meals: PlannedMeal[] | null,
  run: Action["run"],
  onSaved: (saved: PlannedMeal) => void,
  reload: () => void,
) {
  // The count each meal has been stepped to and not yet saved. The ref is
  // what the next tap counts from, so taps between two renders still add up;
  // the state is the same map, for drawing.
  const stepped = useRef(new Map<string, number>());
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const saving = useRef(new Set<string>());

  // A repeated meal's servings as loaded, before its first tap, so a burst
  // that ends where it began asks nothing.
  const before = useRef(new Map<string, number | null>());
  const resting = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [asking, setAsking] = useState<ReadonlySet<string>>(() => new Set());
  // Repeated meals whose count was saved, and the count, kept on screen until
  // the week comes back: the write answers nothing to draw instead.
  const landed = useRef(new Map<string, number>());

  // The page's newest callbacks, since a write can outlive the render that
  // sent it: one that fails after moving to another week reloads that week.
  const callbacks = useRef({ onSaved, reload });
  useEffect(() => {
    callbacks.current = { onSaved, reload };
  });

  useEffect(() => {
    const timers = resting.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  function set(key: string, count: number | undefined) {
    const next = new Map(stepped.current);
    if (count === undefined) {
      next.delete(key);
      before.current.delete(key);
    } else next.set(key, count);
    stepped.current = next;
    setCounts(next);
  }

  function ask(key: string, on: boolean) {
    setAsking((prev) => {
      if (prev.has(key) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // The week has come back: a saved count gives way to the meal as loaded,
  // unless it was stepped again since.
  useEffect(() => {
    if (landed.current.size === 0) return;
    const next = new Map(stepped.current);
    for (const [key, count] of landed.current) {
      if (next.get(key) === count) {
        next.delete(key);
        before.current.delete(key);
      }
    }
    landed.current.clear();
    stepped.current = next;
    setCounts(next);
  }, [meals]);

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
        result.saved = await api.updateMealPlanEntry(entryId, {
          servings: asStored(meal, count),
        });
      });
    }
    saving.current.delete(key);
    // In the same tick as the callback, so the count never flickers back to
    // the loaded one between the two.
    set(key, undefined);
    if (ok && result.saved) callbacks.current.onSaved(result.saved);
    // An earlier count in the burst may have landed, so the week is asked
    // for again rather than assumed to be what was loaded.
    else callbacks.current.reload();
  }

  /** Waits for a repeated meal's taps to rest, then asks about them. */
  function settle(meal: PlannedMeal) {
    const key = meal.key;
    clearTimeout(resting.current.get(key));
    ask(key, false);
    resting.current.set(
      key,
      setTimeout(() => {
        resting.current.delete(key);
        const count = stepped.current.get(key);
        if (count === undefined) return;
        if (asStored(meal, count) === before.current.get(key)) set(key, undefined);
        else ask(key, true);
      }, SETTLE_MS),
    );
  }

  function step(meal: PlannedMeal, delta: number) {
    const base =
      stepped.current.get(meal.key) ?? meal.servings ?? meal.recipe.servings;
    if (base == null) return;
    const known = classify(meal);
    if (known.repeat !== null) {
      if (!stepped.current.has(meal.key)) before.current.set(meal.key, meal.servings);
      set(meal.key, Math.max(1, base + delta));
      settle(meal);
      return;
    }
    set(meal.key, Math.max(1, base + delta));
    if (!saving.current.has(meal.key)) void save(meal, known.entry_id);
  }

  /**
   * Saves a repeated meal's waiting count for the scope chosen, or puts it
   * back for null. A save loads the week again, since a change from a day on
   * reaches days other than the one shown; a refused one puts the count back.
   */
  async function answer(meal: PlannedMeal, scope: Scope | null) {
    const key = meal.key;
    ask(key, false);
    const count = stepped.current.get(key);
    if (count === undefined || meal.repeat === null) return;
    if (scope === null) {
      set(key, undefined);
      return;
    }
    const repeatId = meal.repeat.id;
    const ok = await run(() =>
      api.changeRepeatDay(repeatId, meal.plan_date, {
        scope,
        servings: asStored(meal, count),
      }),
    );
    if (ok) {
      landed.current.set(key, count);
      callbacks.current.reload();
    } else if (stepped.current.get(key) === count) {
      set(key, undefined);
    }
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

  return { shown, step, asking, answer };
}
