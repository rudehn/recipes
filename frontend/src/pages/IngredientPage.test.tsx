import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest } from "../test/backend";
import { ingredientDetail, ingredientLine, itemPrice, mergeSuggestion } from "../test/fixtures";
import { renderApp } from "../test/render";

const cumin = ingredientDetail({
  key: "cumin",
  name: "cumin",
  also_called: ["ground cumin"],
  merged: [{ key: "ground-cumin", name: "ground cumin" }],
  recipe_count: 2,
  lines: [
    ingredientLine({ ingredient_id: 11, recipe_id: 4, recipe_title: "Chili", name: "ground cumin", quantity: 2, unit: "tsp" }),
    ingredientLine({ ingredient_id: 12, recipe_id: 5, recipe_title: "Salsa", name: "cumin", quantity: 0.75, unit: "tsp" }),
  ],
  product: { status: "picked", product: itemPrice({ product_id: "111", description: "McCormick Ground Cumin", regular: 3.49 }) },
  food: { status: "default", food: { fdc_id: 170923, description: "Spices, cumin seed", category: "Spices", per_100g: { kcal: 375, protein_g: 18, fat_g: 22, carbs_g: 44, sodium_mg: 168 } } },
});

describe("IngredientPage", () => {
  it("shows the ingredient whole: names, staple, product, food and lines", async () => {
    mockBackend({ "GET /api/ingredients/:key": cumin });
    renderApp("/ingredients/cumin");

    expect(await screen.findByRole("heading", { name: "cumin" })).toBeInTheDocument();
    expect(screen.getByText(/Also called/)).toHaveTextContent("ground cumin");
    expect(screen.getByText("McCormick Ground Cumin")).toBeInTheDocument();
    expect(screen.getByText(/your pick/)).toBeInTheDocument();
    expect(screen.getByText("Spices, cumin seed")).toBeInTheDocument();
    const used = screen.getByRole("region", { name: "Used in" });
    expect(within(used).getByRole("link", { name: /2 tsp ground cumin/ })).toHaveAttribute(
      "href",
      "/recipes/4?ingredient=11",
    );
    expect(within(used).getByText("Chili")).toBeInTheDocument();
  });

  it("says when the product was matched automatically rather than picked", async () => {
    mockBackend({
      "GET /api/ingredients/:key": { ...cumin, product: { ...cumin.product!, status: "auto" } },
    });
    renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    const store = screen.getByRole("region", { name: "At your store" });
    expect(within(store).getByText(/automatic/)).toBeInTheDocument();
    expect(within(store).queryByText(/your pick/)).not.toBeInTheDocument();
  });

  it("says a product was matched automatically even when its price could not be fetched", async () => {
    mockBackend({
      "GET /api/ingredients/:key": { ...cumin, product: { status: "auto", product: null } },
    });
    renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    expect(screen.getByText("Matched automatically; its price could not be fetched")).toBeInTheDocument();
  });

  it("keeps an ingredient stocked, and stops", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": () => cumin,
      "POST /api/pantry": { id: 7, name: "cumin", in_stock: true },
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: /Keep stocked/ }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({ name: "cumin", in_stock: true });
  });

  it("stops keeping a staple stocked", async () => {
    const stocked = { ...cumin, staple: { id: 7, name: "Cumin", in_stock: true } };
    const backend = mockBackend({
      "GET /api/ingredients/:key": stocked,
      "DELETE /api/pantry/:id": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Stop keeping stocked" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/pantry/:id")[0].path).toBe("/api/pantry/7"));
  });

  it("goes back to the staples when the staple was all there was of it", async () => {
    // No recipe uses it, so once it is not a staple there is no page for it.
    const saffron = ingredientDetail({
      key: "saffron",
      name: "Saffron",
      recipe_count: 0,
      lines: [],
      staple: { id: 9, name: "Saffron", in_stock: true },
    });
    let deleted = false;
    const backend = mockBackend({
      "GET /api/ingredients/:key": () =>
        deleted ? new HttpError(404, "No ingredient called that.") : saffron,
      "DELETE /api/pantry/:id": () => {
        deleted = true;
      },
      "GET /api/ingredients": { ingredients: [], suggestions: [] },
    });
    const { user } = renderApp("/ingredients/saffron");
    await screen.findByRole("heading", { name: "Saffron" });

    await user.click(screen.getByRole("button", { name: "Stop keeping stocked" }));

    expect(await screen.findByRole("heading", { name: "Ingredients" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Staples/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("No ingredient called that")).not.toBeInTheDocument();
    expect(backend.requestsTo("DELETE /api/pantry/:id")[0].path).toBe("/api/pantry/9");
  });

  it("goes back to the automatic product", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "DELETE /api/pricing/match": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Back to automatic" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/pricing/match")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/pricing/match")[0].searchParams.get("key")).toBe("cumin");
  });

  it("says it does not count, for every recipe", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "PUT /api/nutrition/match": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "It doesn’t count" }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/nutrition/match")[0].body).toEqual({ key: "cumin", fdc_id: null }),
    );
  });

  it("gives each food its lines are counted as a row of its own", async () => {
    const rawRice = { fdc_id: 168877, description: "Rice, white, long-grain, raw", category: "Grains", per_100g: { kcal: 365, protein_g: 7, fat_g: 1, carbs_g: 80, sodium_mg: 5 } };
    const cookedRice = { fdc_id: 168878, description: "Rice, white, long-grain, cooked", category: "Grains", per_100g: { kcal: 130, protein_g: 3, fat_g: 0, carbs_g: 28, sodium_mg: 1 } };
    const rice = ingredientDetail({
      key: "rice",
      name: "Rice",
      food: { status: "default", food: rawRice },
      foods: [
        { key: "rice", state: null, status: "default", food: rawRice },
        { key: "cooked-rice", state: "cooked", status: "none", food: null },
      ],
      problems: ["no_food"],
    });
    const backend = mockBackend({
      "GET /api/ingredients/:key": rice,
      "GET /api/nutrition/foods": [cookedRice],
      "GET /api/nutrition/uses": [],
      "PUT /api/nutrition/match": undefined,
    });
    const { user } = renderApp("/ingredients/rice");
    await screen.findByRole("heading", { name: "Rice" });

    const own = screen.getByRole("group", { name: "Rice" });
    const cooked = screen.getByRole("group", { name: "cooked rice" });
    expect(within(own).getByText("Rice, white, long-grain, raw")).toBeInTheDocument();
    expect(within(cooked).getByText("No food chosen")).toBeInTheDocument();

    await user.click(within(cooked).getByRole("button", { name: "Choose food" }));
    const dialog = await screen.findByRole("dialog", { name: "Food for “cooked rice”" });
    await user.click(await within(dialog).findByRole("button", { name: /Rice, white, long-grain, cooked/ }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/nutrition/match")[0].body).toEqual({ key: "cooked-rice", fdc_id: 168878 }),
    );
    expect(backend.requestsTo("GET /api/nutrition/foods")[0].searchParams.get("q")).toBe("cooked rice");
  });

  it("says it does not count, and goes back to the default, for the row it is pressed on", async () => {
    const rice = ingredientDetail({
      key: "rice",
      name: "rice",
      foods: [
        { key: "rice", state: null, status: "default", food: null },
        { key: "cooked-rice", state: "cooked", status: "skipped", food: null },
      ],
    });
    const backend = mockBackend({
      "GET /api/ingredients/:key": rice,
      "PUT /api/nutrition/match": undefined,
      "DELETE /api/nutrition/match": undefined,
    });
    const { user } = renderApp("/ingredients/rice");
    await screen.findByRole("heading", { name: "rice" });

    await user.click(within(screen.getByRole("group", { name: "cooked rice" })).getByRole("button", { name: "Back to default" }));
    await user.click(within(screen.getByRole("group", { name: "rice" })).getByRole("button", { name: "It doesn’t count" }));

    await waitFor(() => expect(backend.requestsTo("PUT /api/nutrition/match")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/nutrition/match")[0].searchParams.get("key")).toBe("cooked-rice");
    expect(backend.requestsTo("PUT /api/nutrition/match")[0].body).toEqual({ key: "rice", fdc_id: null });
  });

  it("hides the store with pricing off", async () => {
    mockBackend({ "GET /api/ingredients/:key": { ...cumin, product: null } });
    renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    expect(screen.queryByRole("region", { name: "At your store" })).not.toBeInTheDocument();
  });

  it("moves to the target's address when opened under a merged name", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": ({ params }: MockRequest) =>
        params.key === "ground-cumin" ? { ...cumin, redirected_from: "ground-cumin" } : cumin,
    });
    renderApp("/ingredients/ground-cumin");

    // Navigating to the target's address loads it under its own key.
    await waitFor(() =>
      expect(backend.requestsTo("GET /api/ingredients/:key").map((r) => r.path)).toContain(
        "/api/ingredients/cumin",
      ),
    );
    expect(await screen.findByRole("heading", { name: "cumin" })).toBeInTheDocument();
  });

  it("says so when there is no such ingredient, with a way back", async () => {
    mockBackend({ "GET /api/ingredients/:key": new HttpError(404, "No ingredient called that.") });
    renderApp("/ingredients/saffron");

    expect(await screen.findByText("No ingredient called that")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All ingredients" })).toHaveAttribute("href", "/ingredients?view=all");
  });

  it("reports any other failure as a failed load", async () => {
    mockBackend({ "GET /api/ingredients/:key": new HttpError(500, "Database is down") });
    renderApp("/ingredients/cumin");

    expect(await screen.findByText("Database is down")).toBeInTheDocument();
  });
});

describe("IngredientPage: unmerging", () => {
  it("confirms, says what the old name loses, and unmerges", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": cumin,
      "DELETE /api/ingredients/merges/:key": undefined,
    });
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });

    await user.click(screen.getByRole("button", { name: "Unmerge ground cumin" }));
    expect(screen.getByText(/starts fresh/)).toBeInTheDocument();
    // In the dialog's padded body, not against its edges.
    expect(screen.getByText(/starts fresh/).closest(".modal-body")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Unmerge" }));

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")[0].path).toBe(
        "/api/ingredients/merges/ground-cumin",
      ),
    );
    expect(backend.requestsTo("GET /api/ingredients/:key").length).toBeGreaterThan(1);
  });
});

describe("IngredientPage: suggested merges", () => {
  it("lists what it might be the same as, and opens the preview for one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": { ...cumin, merged: [], also_called: [], suggestions: [mergeSuggestion({ from_key: "cumin-seed", from_name: "cumin seed" })] },
      "GET /api/ingredients": { ingredients: [], suggestions: [] },
      "POST /api/ingredients/merges/preview": {
        from_key: "cumin-seed", from_name: "cumin seed", to_key: "cumin", to_name: "cumin",
        recipes: [], product: null, food: null, staple: null, needs: [],
      },
    });
    const { user } = renderApp("/ingredients/cumin");

    const group = await screen.findByRole("region", { name: "Might be the same as" });
    await user.click(within(group).getByRole("button", { name: "Merge" }));

    expect(await screen.findByText("Merge cumin seed into cumin")).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[0].body).toEqual({
      from_key: "cumin-seed",
      to_key: "cumin",
    });
  });

  it("opens the preview straight away when a link asks for a merge", async () => {
    mockBackend({
      "GET /api/ingredients/:key": { ...ingredientDetail({ key: "ground-cumin", name: "ground cumin" }) },
      "GET /api/ingredients": { ingredients: [], suggestions: [] },
      "POST /api/ingredients/merges/preview": {
        from_key: "ground-cumin", from_name: "ground cumin", to_key: "cumin", to_name: "cumin",
        recipes: [], product: null, food: null, staple: null, needs: [],
      },
    });
    renderApp("/ingredients/ground-cumin?merge=cumin");

    expect(await screen.findByText("Merge ground cumin into cumin")).toBeInTheDocument();
  });
});

describe("IngredientPage: fixing lines", () => {
  const beans = ingredientDetail({
    key: "can-black-bean",
    name: "can black beans, drained and rinsed",
    lines: [
      ingredientLine({
        ingredient_id: 31,
        recipe_id: 4,
        recipe_title: "Chili",
        name: "can black beans, drained and rinsed",
        quantity: 15,
        unit: "oz",
        issue: null,
      }),
    ],
  });

  const moved = { id: 31, recipe_id: 4, name: "black beans, drained and rinsed", quantity: 15, unit: "oz", issue: null, key: "black-bean" };
  const tacos = ingredientLine({ ingredient_id: 32, recipe_id: 6, recipe_title: "Tacos", name: "can black beans", quantity: 1, unit: null });

  it("edits a line in place, and says where it moved to", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": { ...beans, lines: [...beans.lines, tacos] },
      "PATCH /api/recipe-ingredients": [
        { id: 31, recipe_id: 4, name: "black beans, drained and rinsed", quantity: 15, unit: "oz", issue: null, key: "black-bean" },
      ],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getAllByRole("button", { name: "Fix" })[0]);
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "black beans, drained and rinsed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(backend.requestsTo("PATCH /api/recipe-ingredients")).toHaveLength(1));
    expect(backend.requestsTo("PATCH /api/recipe-ingredients")[0].body).toEqual({
      lines: [{ id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }],
    });
    const link = await screen.findByRole("link", { name: "black beans, drained and rinsed" });
    expect(link).toHaveAttribute("href", "/ingredients/black-bean");
    // One sentence in one piece: the banner lays out each of its children as
    // a separate item, so loose words and links were spread across its width.
    expect(
      screen.getByText(
        (_, el) => el?.tagName === "SPAN" && el.textContent === "Now shops as black beans, drained and rinsed.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves what was happening on one ingredient behind when following a link to another", async () => {
    const blackBeans = ingredientDetail({
      key: "black-bean",
      name: "black beans",
      lines: [ingredientLine({ ingredient_id: 31, recipe_id: 4, recipe_title: "Chili", name: "black beans, drained and rinsed", quantity: 15, unit: "oz" })],
    });
    mockBackend({
      "GET /api/ingredients/:key": ({ params }: MockRequest) =>
        params.key === "black-bean" ? blackBeans : { ...beans, lines: [...beans.lines, tacos] },
      "PATCH /api/recipe-ingredients": [moved],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });
    await user.click(screen.getAllByRole("button", { name: "Fix" })[0]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(await screen.findByRole("link", { name: "black beans, drained and rinsed" }));

    expect(await screen.findByRole("heading", { name: "black beans" })).toBeInTheDocument();
    expect(screen.queryByText(/Now shops as/)).not.toBeInTheDocument();
  });

  it("goes to the new ingredient when the fixed line was the last one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": beans,
      "PATCH /api/recipe-ingredients": [moved],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(backend.requestsTo("GET /api/ingredients/:key").some((r) => r.params.key === "black-bean")).toBe(true),
    );
  });

  it("refuses a quantity it cannot read, and sends nothing", async () => {
    const backend = mockBackend({ "GET /api/ingredients/:key": beans });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    const qty = screen.getByLabelText("Quantity");
    await user.clear(qty);
    await user.type(qty, "abc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Quantities are numbers or fractions like 1 1/2.")).toBeInTheDocument();
    expect(backend.requestsTo("PATCH /api/recipe-ingredients")).toHaveLength(0);
  });

  it("keeps the exact quantity when it was not touched", async () => {
    const third = { ...beans, lines: [{ ...beans.lines[0], quantity: 0.33 }] };
    const backend = mockBackend({
      "GET /api/ingredients/:key": third,
      "PATCH /api/recipe-ingredients": [{ ...moved, key: "can-black-bean", quantity: 0.33 }],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(backend.requestsTo("PATCH /api/recipe-ingredients")[0].body).toMatchObject({ lines: [{ quantity: 0.33 }] }),
    );
  });

  it("reads a line again without saving it", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": beans,
      "POST /api/recipe-ingredients/reread": [
        {
          id: 31,
          before: { id: 31, name: "can black beans, drained and rinsed", quantity: 15, unit: "oz" },
          after: { id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" },
          from_source: false,
        },
      ],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));
    await user.click(screen.getByRole("button", { name: "Read it again" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("black beans, drained and rinsed"));
    expect(backend.requestsTo("PATCH /api/recipe-ingredients")).toHaveLength(0);
  });

  it("shows what the website wrote, when it was kept", async () => {
    mockBackend({
      "GET /api/ingredients/:key": {
        ...beans,
        lines: [{ ...beans.lines[0], source_line: "1 (15 oz) can black beans, drained and rinsed" }],
      },
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Fix" }));

    expect(screen.getByText(/The website wrote: 1 \(15 oz\) can black beans/)).toBeInTheDocument();
  });

  it("reads all the lines again, and saves the ones that changed together", async () => {
    const two = {
      ...beans,
      lines: [beans.lines[0], ingredientLine({ ingredient_id: 32, recipe_id: 6, recipe_title: "Tacos", name: "black beans", quantity: 1, unit: "can" })],
    };
    const backend = mockBackend({
      "GET /api/ingredients/:key": two,
      "POST /api/recipe-ingredients/reread": [
        { id: 31, before: { id: 31, name: "can black beans, drained and rinsed", quantity: 15, unit: "oz" }, after: { id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }, from_source: false },
        { id: 32, before: { id: 32, name: "black beans", quantity: 1, unit: "can" }, after: { id: 32, name: "black beans", quantity: 1, unit: "can" }, from_source: false },
      ],
      "PATCH /api/recipe-ingredients": [],
    });
    const { user } = renderApp("/ingredients/can-black-bean");
    await screen.findByRole("heading", { name: /can black beans/ });

    await user.click(screen.getByRole("button", { name: "Read all 2 lines again" }));
    expect(await screen.findByText("unchanged")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(backend.requestsTo("PATCH /api/recipe-ingredients")[0].body).toEqual({
        lines: [{ id: 31, name: "black beans, drained and rinsed", quantity: 15, unit: "oz" }],
      }),
    );
  });
});
