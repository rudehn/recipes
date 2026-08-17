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

/** The ingredient list row for an ingredient. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>("li")!;
}

/**
 * Put the ingredient rows `top` pixels down the viewport.
 *
 * jsdom lays nothing out: every element reports a zero-sized box at the origin,
 * and every computed length comes back empty. Whether the page scrolls to a
 * marked ingredient is entirely a question about where that row is and how much
 * of the header covers it, so a test about scrolling has to supply both. The
 * scroll margin matches the stylesheet's, which is what the page reads.
 */
function layoutRowsAt(top: number) {
  const HEADER = 88;
  const ROW_HEIGHT = 40;
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    scrollMarginTop: `${HEADER}px`,
  } as CSSStyleDeclaration);
  vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
    top,
    bottom: top + ROW_HEIGHT,
  } as DOMRect);
}

/** The amount shown next to an ingredient, as a cook reads it. */
function amountFor(name: string): string {
  return rowFor(name).querySelector(".qty")!.textContent ?? "";
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

  it("marks the ingredient a grocery line was followed here for", async () => {
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=11");
    await screen.findByText("coconut milk");

    expect(rowFor("coconut milk")).toHaveClass("highlighted");
    expect(rowFor("coconut milk")).toHaveAttribute("aria-current", "true");
    // Marked, not merely different: the rest of the list is left alone.
    expect(rowFor("chicken thighs")).not.toHaveAttribute("aria-current");
    expect(rowFor("salt")).not.toHaveAttribute("aria-current");
  });

  it("scrolls the marked ingredient into view and gives it focus", async () => {
    // The ingredients sit below the photo, so on a phone a highlight on its own
    // lands off screen: arriving from the grocery list would look like nothing
    // happened at all.
    layoutRowsAt(2_000);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=11");
    await screen.findByText("coconut milk");

    expect(scrollIntoView.mock.instances).toEqual([rowFor("coconut milk")]);
    expect(rowFor("coconut milk")).toHaveFocus();
  });

  it("leaves the page where it is when the ingredient is already in view", async () => {
    // Scrolling to a row the cook can already see gains nothing, and takes the
    // recipe's title under the sticky header on the way.
    layoutRowsAt(300);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=11");
    await screen.findByText("coconut milk");

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(rowFor("coconut milk")).toHaveFocus();
  });

  it("scrolls when the ingredient is hidden behind the sticky header", async () => {
    // In view by the viewport's reckoning, under the topbar by the cook's.
    layoutRowsAt(20);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=11");
    await screen.findByText("coconut milk");

    expect(scrollIntoView.mock.instances).toEqual([rowFor("coconut milk")]);
  });

  it("marks every row one grocery line stood for, scrolling to the first", async () => {
    // One canonical ingredient, two lines of the recipe: the merged amount on
    // the grocery list came from both, so both are the answer.
    layoutRowsAt(2_000);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=12&ingredient=10");
    await screen.findByText("chicken thighs");

    expect(rowFor("chicken thighs")).toHaveClass("highlighted");
    expect(rowFor("salt")).toHaveClass("highlighted");
    expect(rowFor("coconut milk")).not.toHaveClass("highlighted");
    expect(scrollIntoView.mock.instances).toEqual([rowFor("chicken thighs")]);
  });

  it("opens as usual when the marked ingredient is no longer in the recipe", async () => {
    // An edit between reading the grocery list and following it. The recipe is
    // still the right page, so nothing is marked and nothing is broken.
    mockBackend({ "GET /api/recipes/:id": curry });
    renderApp("/recipes/1?ingredient=999");

    expect(await screen.findByText("chicken thighs")).toBeVisible();
    expect(document.querySelector(".highlighted")).toBeNull();
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
