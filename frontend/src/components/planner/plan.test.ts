import { describe, expect, it } from "vitest";

import { plannedMeal } from "../../test/fixtures";
import { MEALS, byCell, cellKey, isPast } from "./plan";

describe("cellKey", () => {
  it("names a day's meal slot", () => {
    expect(cellKey("2026-07-29", "dinner")).toBe("2026-07-29|dinner");
  });
});

describe("byCell", () => {
  it("groups meals into their day's meal slot, in the order given", () => {
    const a = plannedMeal({
      key: "a",
      plan_date: "2026-07-29",
      meal: "dinner",
    });
    const b = plannedMeal({ key: "b", plan_date: "2026-07-29", meal: "lunch" });
    const c = plannedMeal({
      key: "c",
      plan_date: "2026-07-29",
      meal: "dinner",
    });
    const cells = byCell([a, b, c]);
    expect(cells.get(cellKey("2026-07-29", "dinner"))).toEqual([a, c]);
    expect(cells.get(cellKey("2026-07-29", "lunch"))).toEqual([b]);
    expect(cells.get(cellKey("2026-07-30", "lunch"))).toBeUndefined();
  });
});

describe("isPast", () => {
  const today = new Date(2026, 6, 29, 12, 0);

  it("is true only for days before today", () => {
    expect(isPast("2026-07-28", today)).toBe(true);
    expect(isPast("2026-07-29", today)).toBe(false);
    expect(isPast("2026-07-30", today)).toBe(false);
  });
});

describe("MEALS", () => {
  it("runs in the order a day is eaten", () => {
    expect(MEALS).toEqual(["breakfast", "lunch", "dinner", "snack"]);
  });
});
