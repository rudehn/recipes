import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { pantryItem } from "../test/fixtures";
import { renderApp } from "../test/render";

/** The row for a staple, whichever way it is currently stocked. */
function row(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>(".pantry-item")!;
}

describe("PantryPage", () => {
  it("lists the staples and how many need restocking", async () => {
    mockBackend({
      "GET /api/pantry": [
        pantryItem({ id: 1, name: "olive oil", in_stock: true }),
        pantryItem({ id: 2, name: "rice", in_stock: false }),
        pantryItem({ id: 3, name: "coffee", in_stock: false }),
      ],
    });
    renderApp("/pantry");

    await screen.findByText("olive oil");
    expect(screen.getByText("2 items to restock")).toBeInTheDocument();
    expect(within(row("olive oil")).getByRole("button", { name: /in stock/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("counts a single restock in the singular", async () => {
    mockBackend({ "GET /api/pantry": [pantryItem({ in_stock: false })] });
    renderApp("/pantry");

    expect(await screen.findByText("1 item to restock")).toBeInTheDocument();
  });

  it("says so when everything is stocked", async () => {
    mockBackend({ "GET /api/pantry": [pantryItem({ in_stock: true })] });
    renderApp("/pantry");

    expect(await screen.findByText("Fully stocked")).toBeInTheDocument();
  });

  it("suggests what to add when the pantry is empty", async () => {
    mockBackend({ "GET /api/pantry": [] });
    renderApp("/pantry");

    expect(await screen.findByText("No pantry staples yet")).toBeInTheDocument();
  });

  it("adds a staple in stock, then clears the box for the next one", async () => {
    const backend = mockBackend({
      "GET /api/pantry": [],
      "POST /api/pantry": pantryItem({ name: "olive oil" }),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("No pantry staples yet");

    const box = screen.getByPlaceholderText(/add a staple/i);
    await user.type(box, "  olive oil  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({
      name: "olive oil",
      in_stock: true,
    });
    expect(box).toHaveValue("");
    expect(backend.requestsTo("GET /api/pantry")).toHaveLength(2);
  });

  it("does nothing when the name is blank", async () => {
    const backend = mockBackend({ "GET /api/pantry": [] });
    const { user } = renderApp("/pantry");
    await screen.findByText("No pantry staples yet");

    await user.type(screen.getByPlaceholderText(/add a staple/i), "   ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(backend.requestsTo("POST /api/pantry")).toHaveLength(0);
  });

  it("explains why a staple could not be added, keeping what was typed", async () => {
    mockBackend({
      "GET /api/pantry": [],
      "POST /api/pantry": new HttpError(409, "olive oil is already in your pantry."),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("No pantry staples yet");

    await user.type(screen.getByPlaceholderText(/add a staple/i), "olive oil");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("olive oil is already in your pantry.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/add a staple/i)).toHaveValue("olive oil");
  });

  it("flips the stock switch immediately, then saves it", async () => {
    // Marking a staple out of stock is what puts it on the grocery list, and
    // it is usually done standing in front of the cupboard.
    const stored = [pantryItem({ id: 4, name: "rice", in_stock: true })];
    // Held open so the switch can be checked before the server has answered.
    let confirmSave: () => void = () => {};
    const backend = mockBackend({
      "GET /api/pantry": () => stored,
      "PUT /api/pantry/:id": () =>
        new Promise((resolve) => {
          confirmSave = () => {
            stored[0] = { ...stored[0], in_stock: false };
            resolve(stored[0]);
          };
        }),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toBeInTheDocument();
    const [request] = backend.requestsTo("PUT /api/pantry/:id");
    expect(request.path).toBe("/api/pantry/4");
    expect(request.body).toEqual({ in_stock: false });

    confirmSave();
    await waitFor(() => expect(backend.requestsTo("GET /api/pantry")).toHaveLength(2));
    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toBeInTheDocument();
  });

  it("puts a staple back in stock", async () => {
    const backend = mockBackend({
      "GET /api/pantry": [pantryItem({ id: 4, name: "rice", in_stock: false })],
      "PUT /api/pantry/:id": pantryItem({ id: 4, name: "rice", in_stock: true }),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(within(row("rice")).getByRole("button", { name: /out of stock/i }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/pantry/:id")[0].body).toEqual({ in_stock: true }),
    );
  });

  it("removes a staple", async () => {
    const backend = mockBackend({
      "GET /api/pantry": [pantryItem({ id: 4, name: "rice" })],
      "DELETE /api/pantry/:id": undefined,
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(screen.getByRole("button", { name: "Delete rice" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/pantry/:id")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/pantry/:id")[0].path).toBe("/api/pantry/4");
    expect(backend.requestsTo("GET /api/pantry")).toHaveLength(2);
  });

  it("reports a failed load instead of claiming the pantry is empty", async () => {
    mockBackend({ "GET /api/pantry": new HttpError(500, "Database is down") });
    renderApp("/pantry");

    expect(await screen.findByText(/Couldn't load your pantry/)).toBeInTheDocument();
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    expect(screen.queryByText("No pantry staples yet")).not.toBeInTheDocument();
  });

  it("retries a failed load", async () => {
    let attempt = 0;
    const backend = mockBackend({
      "GET /api/pantry": () =>
        ++attempt === 1 ? new HttpError(503, "Server is restarting") : [pantryItem({ name: "rice" })],
    });
    const { user } = renderApp("/pantry");
    await screen.findByText(/Couldn't load your pantry/);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("rice")).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/pantry")).toHaveLength(2);
  });

  it("puts the switch back when the server did not take the change", async () => {
    // A switch left reading "out of stock" that the server never heard about
    // silently drops the staple from the next grocery list.
    mockBackend({
      "GET /api/pantry": [pantryItem({ id: 4, name: "rice", in_stock: true })],
      "PUT /api/pantry/:id": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(row("rice")).getByRole("button", { name: /in stock/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("says so when a staple could not be removed", async () => {
    mockBackend({
      "GET /api/pantry": [pantryItem({ id: 4, name: "rice" })],
      "DELETE /api/pantry/:id": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(screen.getByRole("button", { name: "Delete rice" }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    expect(screen.getByText("rice")).toBeInTheDocument();
  });

  it("keeps the staples on screen when a refresh fails", async () => {
    let attempt = 0;
    mockBackend({
      "GET /api/pantry": () =>
        ++attempt === 1
          ? [pantryItem({ id: 4, name: "rice", in_stock: true })]
          : new HttpError(503, "Server is restarting"),
      "PUT /api/pantry/:id": undefined,
    });
    const { user } = renderApp("/pantry");
    await screen.findByText("rice");

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText(/Showing the last version that loaded/)).toBeInTheDocument();
    expect(screen.getByText("rice")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load your pantry/)).not.toBeInTheDocument();
  });
});
