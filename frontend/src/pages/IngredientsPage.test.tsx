import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IngredientSummary } from "../api";
import { HttpError, mockBackend } from "../test/backend";
import { staple } from "../test/fixtures";
import { renderApp } from "../test/render";

/** The list as the server sends it: already in name order. */
const list = (...ingredients: IngredientSummary[]) => ({ ingredients, suggestions: [] });

/** The row for a staple, whichever way it is stocked. */
function row(name: string): HTMLElement {
  return screen.getByRole("link", { name }).closest<HTMLElement>(".pantry-item")!;
}

describe("IngredientsPage: staples", () => {
  it("puts staples to restock first, then those in stock", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("coffee", false), staple("olive oil"), staple("rice", false)),
    });
    renderApp("/ingredients");

    expect(await screen.findByText("2 to restock")).toBeInTheDocument();
    const restock = screen.getByRole("region", { name: "To restock" });
    const stocked = screen.getByRole("region", { name: "In stock" });
    expect(within(restock).getAllByRole("link").map((l) => l.textContent)).toEqual(["coffee", "rice"]);
    expect(within(stocked).getAllByRole("link").map((l) => l.textContent)).toEqual(["olive oil"]);
  });

  it("says so when everything is stocked", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByText("Fully stocked")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To restock" })).not.toBeInTheDocument();
  });

  it("suggests what to add when there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": list() });
    renderApp("/ingredients");

    expect(await screen.findByText("No staples yet")).toBeInTheDocument();
  });

  it("links each staple to its ingredient's page", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByRole("link", { name: "rice" })).toHaveAttribute("href", "/ingredients/rice");
  });

  it("adds a staple in stock, then clears the box for the next one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients": list(),
      "POST /api/pantry": { id: 9, name: "olive oil", in_stock: true },
    });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    const box = screen.getByLabelText("Add a staple");
    await user.type(box, "  olive oil  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({ name: "olive oil", in_stock: true });
    expect(box).toHaveValue("");
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("does nothing when the name is blank", async () => {
    const backend = mockBackend({ "GET /api/ingredients": list() });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    await user.type(screen.getByLabelText("Add a staple"), "   ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(backend.requestsTo("POST /api/pantry")).toHaveLength(0);
  });

  it("flips the stock switch immediately, then saves it", async () => {
    const rice = staple("rice");
    let confirmSave: () => void = () => {};
    const backend = mockBackend({
      "GET /api/ingredients": list(rice),
      "PUT /api/pantry/:id": () =>
        new Promise((resolve) => {
          confirmSave = () => resolve({ ...rice.staple, in_stock: false });
        }),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toBeInTheDocument();
    const [request] = backend.requestsTo("PUT /api/pantry/:id");
    expect(request.path).toBe(`/api/pantry/${rice.staple!.id}`);
    expect(request.body).toEqual({ in_stock: false });
    confirmSave();
    await waitFor(() => expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2));
  });

  it("puts the switch back when the server refuses", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("rice")),
      "PUT /api/pantry/:id": new HttpError(500, "Database is down"),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText("Database is down")).toBeInTheDocument();
    expect(within(row("rice")).getByRole("button", { name: /in stock/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports a failed load instead of claiming there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": new HttpError(500, "Database is down") });
    renderApp("/ingredients");

    expect(await screen.findByText(/Couldn't load your ingredients/)).toBeInTheDocument();
    expect(screen.queryByText("No staples yet")).not.toBeInTheDocument();
  });

  it("is where the old pantry address goes", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/pantry");

    expect(await screen.findByRole("heading", { name: "Ingredients" })).toBeInTheDocument();
  });
});
