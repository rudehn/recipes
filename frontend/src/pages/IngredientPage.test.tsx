import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest } from "../test/backend";
import { ingredientDetail, ingredientLine, itemPrice } from "../test/fixtures";
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

    expect(await screen.findByRole("heading", { name: "cumin" })).toBeInTheDocument();
    // Navigating to the target's address loads it under its own key.
    await waitFor(() =>
      expect(backend.requestsTo("GET /api/ingredients/:key").map((r) => r.path)).toContain(
        "/api/ingredients/cumin",
      ),
    );
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
    await user.click(screen.getByRole("button", { name: "Unmerge" }));

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")[0].path).toBe(
        "/api/ingredients/merges/ground-cumin",
      ),
    );
    expect(backend.requestsTo("GET /api/ingredients/:key").length).toBeGreaterThan(1);
  });
});
