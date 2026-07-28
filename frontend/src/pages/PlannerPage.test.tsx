import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Meal } from "../api";
import { HttpError, mockBackend, type MockBackend } from "../test/backend";
import { mealPlanEntry, page, recipeSummary } from "../test/fixtures";
import { renderApp } from "../test/render";

// A Wednesday, so "this week" is Mon 27 Jul - Sun 2 Aug 2026 and the planner
// has days on both sides of today.
const NOW = new Date(2026, 6, 29, 12, 0);

const MEAL_ORDER: Meal[] = ["breakfast", "lunch", "dinner", "snack"];

beforeEach(() => {
  // Only Date is faked: user-event drives its own timers and would hang if
  // setTimeout stopped running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The cell for one meal on one day, counted the way the grid lays them out. */
function cell(meal: Meal, dayIndex: number): HTMLElement {
  const cells = document.querySelectorAll<HTMLElement>(".plan-cell");
  return cells[MEAL_ORDER.indexOf(meal) * 7 + dayIndex];
}

function loadedRange(backend: MockBackend): [string, string] {
  const last = backend.requestsTo("GET /api/meal-plan").at(-1)!;
  return [last.searchParams.get("start")!, last.searchParams.get("end")!];
}

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
        mealPlanEntry({
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
        mealPlanEntry({ recipe: recipeSummary({ id: 5, title: "Weeknight chicken curry" }) }),
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
      "POST /api/meal-plan": mealPlanEntry({ recipe: curry }),
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
      "POST /api/meal-plan": mealPlanEntry({ recipe: curry }),
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
        mealPlanEntry({ id: 3, recipe: recipeSummary({ title: "Weeknight chicken curry" }) }),
      ],
      "DELETE /api/meal-plan/:id": undefined,
    });
    const { user } = renderApp("/planner");

    await user.click(
      await screen.findByRole("button", { name: "Remove Weeknight chicken curry" }),
    );

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(1),
    );
    expect(backend.requestsTo("DELETE /api/meal-plan/:id")[0].path).toBe("/api/meal-plan/3");
  });

  describe("planned servings", () => {
    it("starts from the recipe's own serving count", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          mealPlanEntry({ servings: null, recipe: recipeSummary({ servings: 4 }) }),
        ],
      });
      renderApp("/planner");

      expect(await screen.findByText("×4")).toBeInTheDocument();
    });

    it("saves a raised count for this meal only", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          mealPlanEntry({ id: 3, servings: null, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": mealPlanEntry({ id: 3, servings: 5 }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "More servings" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      const [request] = backend.requestsTo("PATCH /api/meal-plan/:id");
      expect(request.path).toBe("/api/meal-plan/3");
      expect(request.body).toEqual({ servings: 5 });
    });

    it("clears the override when it lands back on the recipe's count", async () => {
      // Storing null instead of 4 lets a later edit to the recipe flow through.
      const backend = mockBackend({
        "GET /api/meal-plan": [
          mealPlanEntry({ id: 3, servings: 5, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": mealPlanEntry({ id: 3, servings: null }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Fewer servings" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ servings: null });
    });

    it("never plans fewer than one serving", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          mealPlanEntry({ id: 3, servings: 1, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": mealPlanEntry({ id: 3, servings: 1 }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Fewer servings" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ servings: 1 });
    });

    it("hides the stepper for a recipe with no serving count", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          mealPlanEntry({ servings: null, recipe: recipeSummary({ servings: null }) }),
        ],
      });
      renderApp("/planner");
      await screen.findByRole("link", { name: "Weeknight chicken curry" });

      expect(screen.queryByRole("button", { name: "More servings" })).not.toBeInTheDocument();
    });
  });

  describe("copying last week", () => {
    it("copies from the week before the one being viewed", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "POST /api/meal-plan/copy-week": [mealPlanEntry()],
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await user.click(screen.getByRole("button", { name: /Copy last week/ }));

      await waitFor(() =>
        expect(backend.requestsTo("POST /api/meal-plan/copy-week")).toHaveLength(1),
      );
      expect(backend.requestsTo("POST /api/meal-plan/copy-week")[0].body).toEqual({
        from_start: "2026-07-20",
        to_start: "2026-07-27",
      });
    });

    it("says so when the previous week had nothing left to copy", async () => {
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      mockBackend({
        "GET /api/meal-plan": [],
        "POST /api/meal-plan/copy-week": [],
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await user.click(screen.getByRole("button", { name: /Copy last week/ }));

      await waitFor(() =>
        expect(alert).toHaveBeenCalledWith("Nothing new to copy from last week."),
      );
    });
  });

  it("reports a failed load instead of showing an empty week", async () => {
    mockBackend({ "GET /api/meal-plan": new HttpError(500, "Database is down") });
    renderApp("/planner");

    expect(await screen.findByText(/Couldn't load your meal plan/)).toBeInTheDocument();
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    expect(document.querySelectorAll(".plan-cell")).toHaveLength(0);
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
});
