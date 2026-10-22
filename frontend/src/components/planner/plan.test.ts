import { describe, expect, it } from "vitest";

import { plannedMeal } from "../../test/fixtures";
import {
  EVERYTHING,
  MEALS,
  byCell,
  cellKey,
  filterFromParams,
  isPast,
  labelsForNew,
  shownMeals,
  writeFilter,
} from "./plan";

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

describe("shownMeals", () => {
  const DAD = { id: 1, name: "Dad" };
  const MOM = { id: 2, name: "Mom" };
  const dad = plannedMeal({ key: "dad", labels: [DAD] });
  const mom = plannedMeal({ key: "mom", labels: [MOM] });
  const both = plannedMeal({ key: "both", labels: [MOM, DAD] });
  const none = plannedMeal({ key: "none", labels: [] });

  it("shows the chosen label's meals, dims unlabelled ones and hides the rest", () => {
    expect(shownMeals([dad, mom, both, none], { label: DAD.id, unlabelled: true })).toEqual([
      { meal: dad, dimmed: false },
      { meal: both, dimmed: false },
      { meal: none, dimmed: true },
    ]);
    expect(shownMeals([dad, mom, none], { label: DAD.id, unlabelled: false })).toEqual([
      { meal: dad, dimmed: false },
    ]);
  });

  it("shows every meal undimmed under Everything", () => {
    expect(shownMeals([dad, none], EVERYTHING)).toEqual([
      { meal: dad, dimmed: false },
      { meal: none, dimmed: false },
    ]);
  });
});

describe("the filter in the URL", () => {
  it("reads a label and the unlabelled switch, defaulting to Everything with unlabelled on", () => {
    expect(filterFromParams(new URLSearchParams(""))).toEqual({ label: null, unlabelled: true });
    expect(filterFromParams(new URLSearchParams("label=3&unlabelled=0"))).toEqual({
      label: 3,
      unlabelled: false,
    });
    expect(filterFromParams(new URLSearchParams("label=abc"))).toEqual(EVERYTHING);
  });

  it("writes only what differs from the default, leaving other params alone", () => {
    const p = writeFilter({ label: 3, unlabelled: false }, new URLSearchParams("x=1"));
    expect(p.toString()).toBe("x=1&label=3&unlabelled=0");
    expect(writeFilter({ label: 3, unlabelled: true }, new URLSearchParams("unlabelled=0")).toString()).toBe("label=3");
    expect(writeFilter(EVERYTHING, new URLSearchParams("label=3&unlabelled=0&x=1")).toString()).toBe("x=1");
  });
});

describe("labelsForNew", () => {
  it("is the selected label, or none under Everything", () => {
    expect(labelsForNew({ label: 3, unlabelled: true })).toEqual([3]);
    expect(labelsForNew(EVERYTHING)).toEqual([]);
  });
});
