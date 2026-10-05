import { describe, expect, it } from "vitest";

import { matchesSearch, proposeDirection, summaryLine } from "./ingredients";
import { ingredientSummary, itemPrice, staple } from "./test/fixtures";

describe("summaryLine", () => {
  it("says how many recipes, which product at what price, and whether it is counted", () => {
    const cumin = ingredientSummary({
      recipe_count: 3,
      product: { status: "picked", product: itemPrice({ description: "McCormick Ground Cumin", regular: 3.49 }) },
      food: { status: "default", food: null },
    });
    expect(summaryLine(cumin)).toBe("3 recipes · McCormick Ground Cumin $3.49 · counted");
  });

  it("names the offer price when there is one", () => {
    const flour = ingredientSummary({
      product: { status: "auto", product: itemPrice({ description: "Flour", regular: 2.59, promo: 1.99 }) },
    });
    expect(summaryLine(flour)).toBe("1 recipe · Flour $1.99 · counted");
  });

  it("says what is missing rather than leaving it out", () => {
    const fries = ingredientSummary({
      recipe_count: 0,
      product: { status: "no_match", product: null },
      food: { status: "none", food: null },
    });
    expect(summaryLine(fries)).toBe("no recipes · no match · no food chosen");
  });

  it("says a food is missing when any of its lines has none, whatever its own food", () => {
    // Rice counts by default, and "cooked rice" is a food of its own with none.
    const rice = ingredientSummary({ food: { status: "default", food: null }, problems: ["no_food"] });
    expect(summaryLine(rice)).toBe("1 recipe · no food chosen");
  });

  it("says nothing about the store with pricing off", () => {
    expect(summaryLine(ingredientSummary({ product: null }))).toBe("1 recipe · counted");
  });

  it("keeps a picked product's standing when its price could not be fetched", () => {
    expect(summaryLine(ingredientSummary({ product: { status: "picked", product: null } }))).toBe(
      "1 recipe · product picked · counted",
    );
  });
});

describe("matchesSearch", () => {
  it("matches the name and every name merged into it", () => {
    const cumin = ingredientSummary({ name: "cumin", also_called: ["ground cumin"] });
    expect(matchesSearch(cumin, "CUM")).toBe(true);
    expect(matchesSearch(cumin, "ground")).toBe(true);
    expect(matchesSearch(cumin, "paprika")).toBe(false);
    expect(matchesSearch(cumin, "  ")).toBe(true);
  });
});

describe("proposeDirection", () => {
  const cumin = ingredientSummary({ key: "cumin", name: "cumin", recipe_count: 1 });
  const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", recipe_count: 3 });

  it("merges the more specific name into the more general one", () => {
    expect(proposeDirection(cumin, ground).map((i) => i.key)).toEqual(["ground-cumin", "cumin"]);
    expect(proposeDirection(ground, cumin).map((i) => i.key)).toEqual(["ground-cumin", "cumin"]);
  });

  it("prefers a staple as the one that survives", () => {
    const kept = staple("Ground Cumin", true, { key: "ground-cumin" });
    expect(proposeDirection(cumin, kept).map((i) => i.key)).toEqual(["cumin", "ground-cumin"]);
  });

  it("prefers the name with a hand-picked product next", () => {
    const picked = { ...ground, product: { status: "picked" as const, product: null } };
    expect(proposeDirection(cumin, picked).map((i) => i.key)).toEqual(["cumin", "ground-cumin"]);
  });
});
