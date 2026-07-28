import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { page, recipe } from "../test/fixtures";
import { renderApp } from "../test/render";

const curry = recipe({
  id: 1,
  title: "Weeknight chicken curry",
  description: "Fast and warming.",
  servings: 4,
  prep_minutes: 10,
  cook_minutes: 20,
  tags: ["quick", "dinner"],
  instructions: "Season the chicken\n\n  Simmer the sauce  \nServe over rice",
  ingredients: [
    { id: 10, name: "chicken thighs", quantity: 2, unit: "lb" },
    { id: 11, name: "coconut milk", quantity: 0.5, unit: "cup" },
    { id: 12, name: "salt", quantity: null, unit: null },
  ],
});

/** The amount shown next to an ingredient, as a cook reads it. */
function amountFor(name: string): string {
  const row = screen.getByText(name).closest("li")!;
  return row.querySelector(".qty")!.textContent ?? "";
}

describe("RecipeDetailPage", () => {
  it("shows the recipe with its times, servings, and tags", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1");

    expect(await screen.findByRole("heading", { name: "Weeknight chicken curry" })).toBeVisible();
    expect(screen.getByText("Prep 10 min")).toBeInTheDocument();
    expect(screen.getByText("Cook 20 min")).toBeInTheDocument();
    expect(screen.getByText("Serves 4")).toBeInTheDocument();
    expect(screen.getByText("quick")).toBeInTheDocument();
    expect(screen.getByText("dinner")).toBeInTheDocument();
  });

  it("requests the recipe named in the URL", async () => {
    const backend = mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Weeknight chicken curry" });

    expect(backend.requests.map((r) => r.path)).toEqual(["/api/recipes/1"]);
  });

  it("numbers the instruction lines, dropping blank ones", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Weeknight chicken curry" });

    const steps = screen.getAllByRole("listitem").filter((li) => li.closest("ol"));
    expect(steps.map((li) => li.textContent)).toEqual([
      "Season the chicken",
      "Simmer the sauce",
      "Serve over rice",
    ]);
  });

  it("shows amounts as fractions, and nothing for an unquantified ingredient", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1");
    await screen.findByText("chicken thighs");

    expect(amountFor("chicken thighs")).toBe("2 lb");
    expect(amountFor("coconut milk")).toBe("½ cup");
    expect(amountFor("salt")).toBe("");
  });

  it("scales amounts when the cook changes the serving count", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("chicken thighs");

    await user.click(screen.getByRole("button", { name: "More servings" }));

    expect(screen.getByText("5 servings")).toBeInTheDocument();
    expect(amountFor("chicken thighs")).toBe("2½ lb");
    expect(amountFor("coconut milk")).toBe("⅝ cup");
    expect(amountFor("salt")).toBe("");
  });

  it("scales down, and never below one serving", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("chicken thighs");

    const fewer = screen.getByRole("button", { name: "Fewer servings" });
    for (let i = 0; i < 5; i++) await user.click(fewer);

    expect(screen.getByText("1 serving")).toBeInTheDocument();
    expect(amountFor("chicken thighs")).toBe("½ lb");
    expect(amountFor("coconut milk")).toBe("⅛ cup");
  });

  it("scaling is display-only and never saves", async () => {
    const backend = mockBackend({ "GET /api/recipes/:id": curry });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("chicken thighs");

    await user.click(screen.getByRole("button", { name: "More servings" }));

    expect(backend.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("hides the stepper for a recipe with no serving count", async () => {
    // Without a base serving count there is nothing to scale from.
    mockBackend({ "GET /api/recipes/:id": recipe({ id: 1, servings: null }) });
    renderApp("/recipes/1");
    await screen.findByText("chicken thighs");

    expect(screen.queryByRole("button", { name: "More servings" })).not.toBeInTheDocument();
  });

  it("says so when the recipe has no ingredients or instructions", async () => {
    mockBackend({
      "GET /api/recipes/:id": recipe({ id: 1, ingredients: [], instructions: "  \n " }),
    });
    renderApp("/recipes/1");

    expect(await screen.findByText("No ingredients listed.")).toBeInTheDocument();
    expect(screen.getByText("No instructions yet.")).toBeInTheDocument();
  });

  it("deletes after confirming, then returns to the recipe list", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const backend = mockBackend({
      "GET /api/recipes/:id": curry,
      "DELETE /api/recipes/:id": undefined,
      "GET /api/recipes": page([]),
      "GET /api/recipes/tags": [],
    });
    const { user } = renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Weeknight chicken curry" });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete “Weeknight chicken curry”? This also removes it from your meal plan.",
    );
    expect(backend.requestsTo("DELETE /api/recipes/:id")).toHaveLength(1);
    expect(await screen.findByText("Your recipe box is empty")).toBeInTheDocument();
  });

  it("says so when the delete did not happen, rather than nothing at all", async () => {
    // Confirming a warning about the meal plan and then seeing no change is
    // indistinguishable from a tap that missed the button.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockBackend({
      "GET /api/recipes/:id": curry,
      "DELETE /api/recipes/:id": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Weeknight chicken curry" });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weeknight chicken curry" })).toBeVisible();
  });

  it("offers a retry when the recipe could not be fetched", async () => {
    let attempt = 0;
    const backend = mockBackend({
      "GET /api/recipes/:id": () =>
        ++attempt === 1 ? new HttpError(503, "Server is restarting") : curry,
    });
    const { user } = renderApp("/recipes/1");
    await screen.findByText("Server is restarting");

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(
      await screen.findByRole("heading", { name: "Weeknight chicken curry" }),
    ).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/recipes/:id")).toHaveLength(2);
  });

  it("keeps the recipe when the confirmation is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const backend = mockBackend({ "GET /api/recipes/:id": curry });
    const { user } = renderApp("/recipes/1");
    await screen.findByRole("heading", { name: "Weeknight chicken curry" });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(backend.requestsTo("DELETE /api/recipes/:id")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Weeknight chicken curry" })).toBeVisible();
  });

  it("shows the server's message and a way back for a missing recipe", async () => {
    mockBackend({ "GET /api/recipes/:id": new HttpError(404, "Recipe not found") });
    renderApp("/recipes/999");

    expect(await screen.findByText("Recipe not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to recipes" })).toHaveAttribute(
      "href",
      "/recipes",
    );
  });

  it("links to the edit form for this recipe", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1");

    expect(await screen.findByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/recipes/1/edit",
    );
  });
});
