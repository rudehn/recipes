/**
 * The planner's week: its days and meals, the weeks either side, and the plain
 * writes and failures of a meal added from a cell or removed.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { plannedMeal, page, recipeSummary } from "../test/fixtures";
import { MEAL_ORDER, cell, loadedRange, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";

onWednesday();

describe("PlannerPage", () => {
  it("shows the week containing today, Monday first", async () => {
    const backend = mockBackend({ "GET /api/meal-plan": [] });
    renderApp("/planner");

    await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(1));
    expect(loadedRange(backend)).toEqual(["2026-07-27", "2026-08-02"]);
    expect(screen.getByText("Jul 27 – Aug 2, 2026")).toBeInTheDocument();

    const dayHeads = document.querySelectorAll(".day-head .dow");
    expect([...dayHeads].map((d) => d.textContent)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("marks today's column", async () => {
    mockBackend({ "GET /api/meal-plan": [] });
    renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    const today = document.querySelectorAll(".day-head.today");
    expect(today).toHaveLength(1);
    expect(today[0]).toHaveTextContent("Jul 29");
  });

  it("has a row for every meal of the day", async () => {
    mockBackend({ "GET /api/meal-plan": [] });
    renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    expect([...document.querySelectorAll(".meal-label")].map((l) => l.textContent)).toEqual(
      MEAL_ORDER,
    );
    expect(document.querySelectorAll(".plan-cell")).toHaveLength(28);
  });

  it("puts a planned meal in its own day and meal cell", async () => {
    mockBackend({
      "GET /api/meal-plan": [
        plannedMeal({
          plan_date: "2026-07-29",
          meal: "dinner",
          recipe: recipeSummary({ id: 5, title: "Weeknight chicken curry" }),
        }),
      ],
    });
    renderApp("/planner");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(cell("dinner", 2)).toHaveTextContent("Weeknight chicken curry");
    expect(cell("lunch", 2)).not.toHaveTextContent("Weeknight chicken curry");
    expect(cell("dinner", 1)).not.toHaveTextContent("Weeknight chicken curry");
  });

  it("links a planned meal to its recipe", async () => {
    mockBackend({
      "GET /api/meal-plan": [
        plannedMeal({ recipe: recipeSummary({ id: 5, title: "Weeknight chicken curry" }) }),
      ],
    });
    renderApp("/planner");

    expect(await screen.findByRole("link", { name: "Weeknight chicken curry" })).toHaveAttribute(
      "href",
      "/recipes/5",
    );
  });

  it("steps back and forward a week at a time", async () => {
    const backend = mockBackend({ "GET /api/meal-plan": [] });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-07-20", "2026-07-26"]));

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-08-03", "2026-08-09"]));
  });

  it("comes back to this week", async () => {
    const backend = mockBackend({ "GET /api/meal-plan": [] });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-07-20", "2026-07-26"]));

    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-07-27", "2026-08-02"]));
  });

  it("carries the week being viewed into the grocery list", async () => {
    mockBackend({ "GET /api/meal-plan": [] });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(screen.getByRole("button", { name: "Next week" }));

    expect(screen.getByRole("link", { name: /grocery list/i })).toHaveAttribute(
      "href",
      "/groceries?start=2026-08-03&end=2026-08-09",
    );
  });

  it("plans a recipe into the cell whose add button was pressed", async () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    const backend = mockBackend({
      "GET /api/meal-plan": [],
      "GET /api/recipes": page([curry, recipeSummary({ id: 6, title: "Banana bread" })]),
      "POST /api/meal-plan": plannedMeal({ recipe: curry }),
    });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(within(cell("lunch", 4)).getByRole("button", { name: "+ Add" }));
    expect(await screen.findByRole("heading", { name: "Add to lunch" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));

    await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
      plan_date: "2026-07-31",
      meal: "lunch",
      recipe_id: 5,
    });
  });

  it("closes the picker and reloads the week after planning a meal", async () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    const backend = mockBackend({
      "GET /api/meal-plan": [],
      "GET /api/recipes": page([curry]),
      "POST /api/meal-plan": plannedMeal({ recipe: curry }),
    });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(within(cell("dinner", 0)).getByRole("button", { name: "+ Add" }));
    await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Add to dinner" })).not.toBeInTheDocument(),
    );
    expect(backend.requestsTo("GET /api/meal-plan").length).toBeGreaterThan(1);
  });

  it("removes a planned meal", async () => {
    const backend = mockBackend({
      "GET /api/meal-plan": [
        plannedMeal({ entry_id: 3, recipe: recipeSummary({ title: "Weeknight chicken curry" }) }),
      ],
      "DELETE /api/meal-plan/:id": undefined,
    });
    const { user } = renderApp("/planner");

    await user.click(
      await screen.findByRole("button", { name: "Actions for Weeknight chicken curry" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(1),
    );
    expect(backend.requestsTo("DELETE /api/meal-plan/:id")[0].path).toBe("/api/meal-plan/3");
  });

  it("no longer has a Copy last week button", async () => {
    mockBackend({ "GET /api/meal-plan": [] });
    renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    expect(screen.queryByRole("button", { name: /Copy last week/ })).not.toBeInTheDocument();
  });

  it("reports a failed load instead of showing an empty week", async () => {
    mockBackend({ "GET /api/meal-plan": new HttpError(500, "Database is down") });
    renderApp("/planner");

    expect(await screen.findByText(/Couldn't load your meal plan/)).toBeInTheDocument();
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    expect(document.querySelectorAll(".plan-cell")).toHaveLength(0);
  });

  it("keeps the planner's wider page when its first load fails", async () => {
    // The width hangs on .planner-page; were it on the grid, a failed load
    // would drop the page back to the others' width.
    mockBackend({ "GET /api/meal-plan": new HttpError(500, "Database is down") });
    renderApp("/planner");
    await screen.findByText(/Couldn't load your meal plan/);

    expect(document.querySelector("main.page > .planner-page")).not.toBeNull();
  });

  it("retries a failed load", async () => {
    let attempt = 0;
    const backend = mockBackend({
      "GET /api/meal-plan": () =>
        ++attempt === 1 ? new HttpError(503, "Server is restarting") : [],
    });
    const { user } = renderApp("/planner");
    await screen.findByText(/Couldn't load your meal plan/);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(document.querySelectorAll(".plan-cell")).toHaveLength(28));
    expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2);
  });

  it("says so when a meal could not be planned, and keeps the picker open", async () => {
    // Silently closing the picker would look exactly like a meal that was
    // planned, and the week would come back without it.
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    mockBackend({
      "GET /api/meal-plan": [],
      "GET /api/recipes": page([curry]),
      "POST /api/meal-plan": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp("/planner");
    await screen.findByText("Jul 27 – Aug 2, 2026");

    await user.click(within(cell("dinner", 0)).getByRole("button", { name: "+ Add" }));
    await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add to dinner" })).toBeVisible();
  });

  it("says so when a planned meal could not be removed", async () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    mockBackend({
      "GET /api/meal-plan": [plannedMeal({ entry_id: 9, plan_date: "2026-07-27", meal: "dinner", recipe: curry })],
      "DELETE /api/meal-plan/:id": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp("/planner");
    await screen.findByText("Weeknight chicken curry");

    await user.click(within(cell("dinner", 0)).getByRole("button", { name: /actions for/i }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    expect(screen.getByText("Weeknight chicken curry")).toBeInTheDocument();
  });

  it("keeps the week on screen when a refresh fails", async () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    let attempt = 0;
    mockBackend({
      "GET /api/meal-plan": () =>
        ++attempt === 1
          ? [plannedMeal({ entry_id: 9, plan_date: "2026-07-27", meal: "dinner", recipe: curry })]
          : new HttpError(503, "Server is restarting"),
      "DELETE /api/meal-plan/:id": undefined,
    });
    const { user } = renderApp("/planner");
    await screen.findByText("Weeknight chicken curry");

    await user.click(within(cell("dinner", 0)).getByRole("button", { name: /actions for/i }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(await screen.findByText(/Showing the last version that loaded/)).toBeInTheDocument();
    expect(document.querySelectorAll(".plan-cell")).toHaveLength(28);
    expect(screen.queryByText(/Couldn't load your meal plan/)).not.toBeInTheDocument();
  });
});
