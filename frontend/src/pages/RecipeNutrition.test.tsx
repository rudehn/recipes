import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FoodChoice, NutritionLine, RecipeNutrition } from "../api";
import { mockBackend, type Routes } from "../test/backend";
import { recipe } from "../test/fixtures";
import { renderApp } from "../test/render";

const cake = recipe({
  id: 1,
  title: "Almond cake",
  servings: 4,
  ingredients: [
    { id: 10, name: "all-purpose flour", quantity: 1, unit: "cup" },
    { id: 11, name: "almond flour", quantity: 1, unit: "cup" },
    { id: 12, name: "salt, to taste", quantity: null, unit: null },
  ],
});

function line(overrides: Partial<NutritionLine>): NutritionLine {
  return {
    ingredient_id: 0,
    name: "",
    key: "",
    measured: true,
    food: null,
    hand_picked: false,
    grams: null,
    nutrients: null,
    issue: null,
    ...overrides,
  };
}

const FLOUR = line({
  ingredient_id: 10,
  name: "all-purpose flour",
  key: "flour",
  food: {
    fdc_id: 168894,
    description: "Wheat flour, white, all-purpose, enriched, bleached",
    category: "Cereal Grains and Pasta",
  },
  grams: 125,
  nutrients: { kcal: 455, protein_g: 12.9, fat_g: 1.2, carbs_g: 95.4, sodium_mg: 2.5 },
});

const ALMONDS: FoodChoice = {
  fdc_id: 170567,
  description: "Nuts, almonds",
  category: "Nut and Seed Products",
  per_100g: { kcal: 579, protein_g: 21.2, fat_g: 49.9, carbs_g: 21.6, sodium_mg: 1 },
};

const UNCHOSEN = line({ ingredient_id: 11, name: "almond flour", key: "almond-flour", issue: "no_food" });

const CHOSEN = line({
  ingredient_id: 11,
  name: "almond flour",
  key: "almond-flour",
  food: ALMONDS,
  hand_picked: true,
  grams: 143,
  nutrients: { kcal: 828, protein_g: 30.3, fat_g: 71.4, carbs_g: 30.9, sodium_mg: 1.4 },
});

const TO_TASTE = line({ ingredient_id: 12, name: "salt, to taste", key: "salt", measured: false });

const PER_SERVING = { kcal: 320.8, protein_g: 10.8, fat_g: 18.2, carbs_g: 31.6, sodium_mg: 1 };

function nutrition(overrides: Partial<RecipeNutrition>): RecipeNutrition {
  return {
    servings: 4,
    per_serving: PER_SERVING,
    counted: 2,
    total_lines: 2,
    lines: [FLOUR, CHOSEN, TO_TASTE],
    ...overrides,
  };
}

const INCOMPLETE = nutrition({ per_serving: null, counted: 1, lines: [FLOUR, UNCHOSEN, TO_TASTE] });

function withNutrition(answer: RecipeNutrition | (() => RecipeNutrition), extra: Routes = {}) {
  return mockBackend({
    "GET /api/recipes/:id/nutrition": answer,
    "GET /api/recipes/:id": cake,
    ...extra,
  });
}

/** An ingredient's row in the nutrition breakdown, not the ingredient list. */
function breakdownRow(name: string): HTMLElement {
  return screen.getByText(name, { selector: ".nutrition-lines .name" }).closest<HTMLElement>("li")!;
}

describe("RecipeDetailPage nutrition", () => {
  it("shows the figure per serving when every ingredient is counted", async () => {
    withNutrition(nutrition({}));
    renderApp("/recipes/1");

    expect(await screen.findByText("321 kcal a serving")).toBeInTheDocument();
    expect(screen.getByText("11 g protein · 18 g fat · 32 g carbs · 1 mg sodium")).toBeInTheDocument();
    // Salt to taste is not counted, and the figure says so.
    expect(screen.getByText("not counting 1 ingredient to taste")).toBeInTheDocument();
  });

  it("keeps a complete breakdown folded until it is asked for", async () => {
    withNutrition(nutrition({}));
    const { user } = renderApp("/recipes/1");
    await screen.findByText("321 kcal a serving");

    const section = document.querySelector("#nutrition")!;
    expect(section).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "How it’s counted" }));

    expect(section).toHaveAttribute("open");
    // A complete figure can still be the wrong food, which only the row shows.
    expect(within(breakdownRow("almond flour")).getByText(/Nuts, almonds/)).toBeInTheDocument();
    expect(within(breakdownRow("almond flour")).getByText(/your choice/)).toBeInTheDocument();
  });

  it("withholds the figure when an ingredient cannot be counted, and says why", async () => {
    withNutrition(INCOMPLETE);
    renderApp("/recipes/1");

    expect(await screen.findByText("Nutrition unavailable")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 ingredients can't be counted")).toBeInTheDocument();
    expect(screen.queryByText(/kcal a serving/)).not.toBeInTheDocument();

    // Open by itself: the reasons are what the reader needs next.
    expect(document.querySelector("#nutrition")).toHaveAttribute("open");
    const almond = breakdownRow("almond flour");
    expect(within(almond).getByText("No food chosen")).toBeInTheDocument();
    expect(within(almond).getByText("no food chosen")).toHaveClass("issue-tag");
    expect(within(breakdownRow("all-purpose flour")).getByText("125 g · 455 kcal")).toBeInTheDocument();
    expect(screen.getByText(/leaves them to taste: salt, to taste\./)).toBeInTheDocument();
  });

  it("says when the recipe does not say how many it serves", async () => {
    withNutrition(nutrition({ servings: null, per_serving: null }));
    renderApp("/recipes/1");

    expect(await screen.findByText("the recipe doesn't say how many it serves")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add the servings" })).toHaveAttribute(
      "href",
      "/recipes/1/edit",
    );
  });

  it("counts an ingredient once a food is chosen for it", async () => {
    let chosen = false;
    const backend = withNutrition(() => (chosen ? nutrition({}) : INCOMPLETE), {
      "GET /api/nutrition/foods": [ALMONDS],
      "PUT /api/nutrition/match": () => {
        chosen = true;
      },
    });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("Nutrition unavailable");

    await user.click(within(breakdownRow("almond flour")).getByRole("button", { name: "Choose food" }));

    const dialog = await screen.findByRole("dialog", { name: "Food for “almond flour”" });
    // Searched for the ingredient before a word is typed.
    await user.click(await within(dialog).findByRole("button", { name: /Nuts, almonds/ }));

    expect(backend.requestsTo("GET /api/nutrition/foods")[0].searchParams.get("q")).toBe(
      "almond flour",
    );
    expect(backend.requestsTo("PUT /api/nutrition/match")[0].body).toEqual({
      key: "almond-flour",
      fdc_id: 170567,
    });
    expect(await screen.findByText("321 kcal a serving")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("goes back to the default food", async () => {
    const backend = withNutrition(nutrition({}), { "DELETE /api/nutrition/match": undefined });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("321 kcal a serving");
    await user.click(screen.getByRole("button", { name: "How it’s counted" }));

    await user.click(within(breakdownRow("almond flour")).getByRole("button", { name: "Use default" }));

    expect(backend.requestsTo("DELETE /api/nutrition/match")[0].searchParams.get("key")).toBe(
      "almond-flour",
    );
  });

  it("sends a problem with the recipe line to the edit page rather than the picker", async () => {
    withNutrition(
      nutrition({
        per_serving: null,
        counted: 1,
        lines: [FLOUR, line({ ...UNCHOSEN, issue: "amount_in_name" }), TO_TASTE],
      }),
    );
    renderApp("/recipes/1");
    await screen.findByText("Nutrition unavailable");

    const row = breakdownRow("almond flour");
    expect(within(row).getByText("amount is in the name")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Edit line" })).toHaveAttribute(
      "href",
      "/recipes/1/edit",
    );
    expect(within(row).queryByRole("button", { name: "Choose food" })).not.toBeInTheDocument();
  });

  it("says nothing about a recipe with nothing measured", async () => {
    withNutrition(nutrition({ per_serving: null, counted: 0, total_lines: 0, lines: [TO_TASTE] }));
    renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Almond cake" });

    expect(screen.queryByText(/Nutrition|kcal/)).not.toBeInTheDocument();
    expect(document.querySelector("#nutrition")).toBeNull();
  });
});
