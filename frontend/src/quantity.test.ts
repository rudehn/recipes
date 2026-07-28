import { describe, expect, it } from "vitest";

import { formatAmount, formatQuantity, parseQuantity } from "./quantity";

describe("formatAmount", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [12, "12"],
    [0.5, "½"],
    [0.25, "¼"],
    [0.75, "¾"],
    [0.125, "⅛"],
    [1.5, "1½"],
    [2.25, "2¼"],
    [3.75, "3¾"],
  ])("writes %s as %s", (value, expected) => {
    expect(formatAmount(value)).toBe(expected);
  });

  it.each([
    [1 / 3, "⅓"],
    [2 / 3, "⅔"],
    [0.33, "⅓"],
    [0.67, "⅔"],
    [1 / 6, "⅙"],
    [2 + 2 / 3, "2⅔"],
  ])("keeps thirds and sixths readable at %s", (value, expected) => {
    // The cases decimals handle worst: 0.3333 stored, or 0.33 typed.
    expect(formatAmount(value)).toBe(expected);
  });

  it.each([
    [0.35, "0.35"],
    [0.3, "0.3"],
    [2.05, "2.05"],
  ])("leaves %s decimal when no fraction is close", (value, expected) => {
    expect(formatAmount(value)).toBe(expected);
  });

  it.each([
    [0.2, "0.2"],
    [1.4, "1.4"],
    [0.6, "0.6"],
  ])("leaves the fifth %s decimal", (value, expected) => {
    // No measuring spoon has a ⅖ on it, and serving-scaling produces fifths
    // often enough that snapping to them would be noise.
    expect(formatAmount(value)).toBe(expected);
  });

  it("rounds values a hair under a whole number up to it", () => {
    expect(formatAmount(0.999)).toBe("1");
    expect(formatAmount(2.004)).toBe("2");
    expect(formatAmount(1.996)).toBe("2");
  });

  it("keeps negatives decimal so the sign survives", () => {
    // Unreachable via the API, but a glyph would drop the sign silently.
    expect(formatAmount(-0.5)).toBe("-0.5");
  });
});

describe("formatQuantity", () => {
  it("appends the unit", () => {
    expect(formatQuantity(1.5, "cups")).toBe("1½ cups");
  });

  it("shows a bare amount when there is no unit", () => {
    expect(formatQuantity(3, null)).toBe("3");
  });

  it("shows nothing for an unquantified ingredient", () => {
    // "salt, to taste" has neither amount nor unit.
    expect(formatQuantity(null, null)).toBe("");
    expect(formatQuantity(null, "tsp")).toBe("");
  });
});

describe("parseQuantity", () => {
  it.each([
    ["1", 1],
    ["2.5", 2.5],
    [".5", 0.5],
    ["  3  ", 3],
  ])("reads the plain number %s", (text, expected) => {
    expect(parseQuantity(text)).toBe(expected);
  });

  it.each([
    ["3/4", 0.75],
    ["1 1/2", 1.5],
    ["1/3", 1 / 3],
  ])("reads the typed fraction %s", (text, expected) => {
    expect(parseQuantity(text)).toBeCloseTo(expected, 10);
  });

  it.each([
    ["½", 0.5],
    ["¾", 0.75],
    ["1½", 1.5],
    ["2⅔", 2 + 2 / 3],
    ["1 ¼", 1.25],
  ])("reads the glyph %s, with or without a space", (text, expected) => {
    expect(parseQuantity(text)).toBeCloseTo(expected, 10);
  });

  it("accepts every glyph the importer can produce, including fifths", () => {
    // formatAmount never writes ⅖, but an imported recipe may have carried one
    // in from the source site, and editing must not reject it.
    expect(parseQuantity("⅖")).toBeCloseTo(0.4, 10);
    expect(parseQuantity("⅐")).toBeNaN();
  });

  it("returns null for blank input rather than zero", () => {
    // Blank means "to taste"; zero would claim the recipe needs none of it.
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("   ")).toBeNull();
  });

  it.each(["abc", "1 cup", "3/", "two"])("returns NaN for unparseable %s", (text) => {
    expect(parseQuantity(text)).toBeNaN();
  });

  it("returns NaN for a zero denominator instead of Infinity", () => {
    expect(parseQuantity("1/0")).toBeNaN();
  });

  it("round-trips what formatAmount writes", () => {
    // The recipe form shows stored amounts through formatAmount and reads them
    // back through parseQuantity on save; a mismatch would drift the value on
    // every edit.
    for (const value of [0.25, 1 / 3, 0.5, 0.75, 1.5, 2 + 2 / 3, 3, 12]) {
      expect(parseQuantity(formatAmount(value))).toBeCloseTo(value, 2);
    }
  });
});
