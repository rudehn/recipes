/**
 * What the planner's page tests share: the day they are on, and how they
 * find a cell of the week.
 */

import { afterEach, beforeEach, vi } from "vitest";

import type { Meal } from "../api";
import type { MockBackend } from "./backend";

/**
 * A Wednesday, so "this week" is Mon 27 Jul - Sun 2 Aug 2026 and the planner
 * has days on both sides of today.
 */
export const NOW = new Date(2026, 6, 29, 12, 0);

export const MEAL_ORDER: Meal[] = ["breakfast", "lunch", "dinner", "snack"];

/** Puts every test in the file on NOW. */
export function onWednesday() {
  beforeEach(() => {
    // Only Date is faked: user-event drives its own timers and would hang if
    // setTimeout stopped running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

/** The cell for one meal on one day, counted the way the grid lays them out. */
export function cell(meal: Meal, dayIndex: number): HTMLElement {
  const cells = document.querySelectorAll<HTMLElement>(".plan-cell");
  return cells[MEAL_ORDER.indexOf(meal) * 7 + dayIndex];
}

/** The days the week was last loaded for, as the request asked for them. */
export function loadedRange(backend: MockBackend): [string, string] {
  const last = backend.requestsTo("GET /api/meal-plan").at(-1)!;
  return [last.searchParams.get("start")!, last.searchParams.get("end")!];
}
