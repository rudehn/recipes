import { describe, expect, it } from "vitest";

import { findDurations, formatClock, splitStep } from "./durations";

/** The durations in a step as [words, seconds] pairs. */
const found = (step: string) => findDurations(step).map((d) => [d.text, d.seconds]);

describe("findDurations", () => {
  it("reads minutes, seconds and hours", () => {
    expect(found("Let bread cool in pan for 10 minutes")).toEqual([["10 minutes", 600]]);
    expect(found("Cook another 30 seconds stirring constantly.")).toEqual([["30 seconds", 30]]);
    expect(found("Rest for 1 hour.")).toEqual([["1 hour", 3600]]);
  });

  it("times the shorter end of a range", () => {
    expect(found("Bake for 45-50 minutes, or until golden")).toEqual([["45-50 minutes", 2700]]);
    expect(found("sauté until tender (4-5 minutes).")).toEqual([["4-5 minutes", 240]]);
    expect(found("cook on high for 3-4 hours or on low for 6-8 hours")).toEqual([
      ["3-4 hours", 10800],
      ["6-8 hours", 21600],
    ]);
    expect(found("simmer 10 to 15 min")).toEqual([["10 to 15 min", 600]]);
    expect(found("bake 20–25 mins")).toEqual([["20–25 mins", 1200]]);
  });

  it("reads numbers written as words", () => {
    expect(found("continue to cook and stir for two minutes more")).toEqual([["two minutes", 120]]);
    expect(found("Rest for forty-five minutes")).toEqual([["forty-five minutes", 2700]]);
    expect(found("Chill for an hour")).toEqual([["an hour", 3600]]);
    expect(found("Stir for a minute")).toEqual([["a minute", 60]]);
    expect(found("Braise for half an hour")).toEqual([["half an hour", 1800]]);
  });

  it("reads fractions and compound times", () => {
    expect(found("Roast 1 ½ hours")).toEqual([["1 ½ hours", 5400]]);
    expect(found("Roast 1½ hours")).toEqual([["1½ hours", 5400]]);
    expect(found("Roast 1 1/2 hours")).toEqual([["1 1/2 hours", 5400]]);
    expect(found("Proof for 1.5 hrs")).toEqual([["1.5 hrs", 5400]]);
    expect(found("Smoke 1 hour 15 minutes")).toEqual([["1 hour 15 minutes", 4500]]);
    expect(found("Smoke 2 hours and 30 minutes")).toEqual([["2 hours and 30 minutes", 9000]]);
  });

  it("reads the adjective form", () => {
    expect(found("Give it a 10-minute rest")).toEqual([["10-minute", 600]]);
  });

  it("leaves alone what is not a timer", () => {
    expect(found("This salsa keeps well, covered, for 3 to 4 days.")).toEqual([]);
    expect(found("Preheat the oven to 350 degrees F (175 degrees C).")).toEqual([]);
    expect(found("Cut the chicken into 1-inch pieces.")).toEqual([]);
    expect(found("Add 2 teaspoons of salt.")).toEqual([]);
    expect(found("After a few minutes, flip the beef")).toEqual([]);
    expect(found("Add the minced garlic")).toEqual([]);
    expect(found("Cook 0 minutes")).toEqual([]);
  });

  it("does not start a match inside a number", () => {
    expect(found("Use 1.5 cups and wait 5 minutes")).toEqual([["5 minutes", 300]]);
  });
});

describe("splitStep", () => {
  it("cuts the step around its durations, losing nothing", () => {
    const step = "Boil for about 12 minutes, then chill 5 minutes.";
    const parts = splitStep(step);
    expect(parts.map((p) => (typeof p === "string" ? p : `[${p.text}]`))).toEqual([
      "Boil for about ",
      "[12 minutes]",
      ", then chill ",
      "[5 minutes]",
      ".",
    ]);
    expect(parts.map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe(step);
  });

  it("is the whole step when it names no time", () => {
    expect(splitStep("Serve warm.")).toEqual(["Serve warm."]);
  });
});

describe("formatClock", () => {
  it("counts down as a kitchen timer does", () => {
    expect(formatClock(720)).toBe("12:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(3750)).toBe("1:02:30");
  });

  it("rounds a part second up, so it never shows 0:00 before it is done", () => {
    expect(formatClock(0.2)).toBe("0:01");
    expect(formatClock(-3)).toBe("0:00");
  });
});
