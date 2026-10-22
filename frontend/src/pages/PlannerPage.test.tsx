import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Meal } from "../api";
import { WEEK_GRID } from "../layout";
import { HttpError, mockBackend, type MockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, planCost, recipeSummary } from "../test/fixtures";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

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

  describe("planned servings", () => {
    it("starts from the recipe's own serving count", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ servings: null, recipe: recipeSummary({ servings: 4 }) }),
        ],
      });
      renderApp("/planner");

      expect(await screen.findByText("×4")).toBeInTheDocument();
    });

    it("saves a raised count for this meal only", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, servings: null, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3, servings: 5 }),
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
          plannedMeal({ entry_id: 3, servings: 5, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3, servings: null }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Fewer servings" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ servings: null });
    });

    it("never plans fewer than one serving", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, servings: 1, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3, servings: 1 }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Fewer servings" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ servings: 1 });
    });

    it("counts every tap however fast, and saves them in the order they were made", async () => {
      // Each tap used to count from the servings the page had loaded, so two
      // taps before the reload both asked for five and the second was lost.
      const recipe = recipeSummary({ servings: 4 });
      let stored: number | null = null;
      const held: (() => void)[] = [];
      const backend = mockBackend({
        "GET /api/meal-plan": () => [plannedMeal({ entry_id: 3, servings: stored, recipe })],
        "PATCH /api/meal-plan/:id": (req: MockRequest) =>
          new Promise((resolve) =>
            held.push(() => {
              stored = (req.body as { servings: number | null }).servings;
              resolve(plannedMeal({ entry_id: 3, servings: stored, recipe }));
            }),
          ),
      });
      const { user } = renderApp("/planner");
      const more = await screen.findByRole("button", { name: "More servings" });

      await user.click(more);
      await user.click(more);

      // Shown at once, before the server has answered either tap.
      expect(screen.getByText("×6")).toBeInTheDocument();
      // One write at a time, so an older one can never land after a newer.
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1);

      held.shift()!();
      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(2));
      held.shift()!();

      await waitFor(() => expect(stored).toBe(6));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id").map((r) => r.body)).toEqual([
        { servings: 5 },
        { servings: 6 },
      ]);
      expect(screen.getByText("×6")).toBeInTheDocument();
    });

    it("puts the count back when the server refuses it", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, servings: null, recipe: recipeSummary({ servings: 4 }) }),
        ],
        "PATCH /api/meal-plan/:id": new HttpError(503, "Server is restarting"),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "More servings" }));

      expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
      expect(screen.getByText("×4")).toBeInTheDocument();
    });

    it("hides the stepper for a recipe with no serving count", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ servings: null, recipe: recipeSummary({ servings: null }) }),
        ],
      });
      renderApp("/planner");
      await screen.findByRole("link", { name: "Weeknight chicken curry" });

      expect(screen.queryByRole("button", { name: "More servings" })).not.toBeInTheDocument();
    });
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
  /**
   * The same week, narrow enough that seven columns of it no longer fit.
   *
   * The grid was 988px wide inside a 343px window: two days visible at a time,
   * with a sticky label column taking a third of what was left, and the week's
   * own controls scrolled off the side. A day at a time instead, which is the
   * direction a phone reads in.
   */
  describe("below the width the week grid needs", () => {
    /** The rows of one day card, in the order the day is eaten. */
    function agendaDay(dayIndex: number): HTMLElement {
      return document.querySelectorAll<HTMLElement>(".agenda-day")[dayIndex];
    }

    it("lays the week out as a day at a time", async () => {
      setViewportWidth(375);
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      expect(document.querySelector(".week-grid")).toBeNull();
      expect(document.querySelectorAll(".agenda-day")).toHaveLength(7);
    });

    it("gives every day all four of its meals", async () => {
      setViewportWidth(375);
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      expect(
        [...agendaDay(0).querySelectorAll(".meal-label")].map((l) => l.textContent),
      ).toEqual(MEAL_ORDER);
      // The same twenty-eight cells the grid has, arranged the other way round.
      expect(document.querySelectorAll(".plan-cell")).toHaveLength(28);
    });

    it("heads each day with its own date", async () => {
      setViewportWidth(375);
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      const heads = [...document.querySelectorAll(".agenda-day .day-head")];
      expect(heads.map((h) => h.querySelector(".dow")?.textContent)).toEqual([
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
        "Sun",
      ]);
      expect(heads[0]).toHaveTextContent("Jul 27");
    });

    it("marks today's card, not a column", async () => {
      setViewportWidth(375);
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      const today = document.querySelectorAll(".agenda-day.today");
      expect(today).toHaveLength(1);
      expect(today[0]).toHaveTextContent("Jul 29");
      expect(within(today[0] as HTMLElement).getByText("Today")).toBeVisible();
    });

    it("puts a planned meal in the right day's row", async () => {
      setViewportWidth(375);
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({
            plan_date: "2026-07-30",
            meal: "dinner",
            recipe: recipeSummary({ title: "Weeknight chicken curry" }),
          }),
        ],
      });
      renderApp("/planner");

      await screen.findByText("Weeknight chicken curry");
      // Thursday, the fourth card.
      expect(agendaDay(3)).toHaveTextContent("Weeknight chicken curry");
      expect(agendaDay(2)).not.toHaveTextContent("Weeknight chicken curry");
    });

    it("plans a recipe into the meal whose add button was pressed", async () => {
      setViewportWidth(375);
      const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/recipes": page([curry]),
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      // Friday's lunch: the third row of the fifth card.
      const lunch = agendaDay(4).querySelectorAll<HTMLElement>(".agenda-meal")[1];
      await user.click(within(lunch).getByRole("button", { name: "+ Add" }));
      expect(await screen.findByRole("heading", { name: "Add to lunch" })).toBeVisible();
      await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-31",
        meal: "lunch",
        recipe_id: 5,
      });
    });

    it("still steps between weeks", async () => {
      setViewportWidth(375);
      const backend = mockBackend({ "GET /api/meal-plan": [] });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await user.click(screen.getByRole("button", { name: "Next week" }));

      await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-08-03", "2026-08-09"]));
      expect(document.querySelectorAll(".agenda-day")).toHaveLength(7);
    });

    it("opens the phone's week at today", async () => {
      setViewportWidth(375);
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      expect(scrolled).toHaveBeenCalledWith({ block: "start" });
      expect(scrolled.mock.contexts[0]).toHaveTextContent("Wed");
    });

    it("opens another week at its Monday", async () => {
      setViewportWidth(375);
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      mockBackend({ "GET /api/meal-plan": [] });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");
      scrolled.mockClear();

      await user.click(screen.getByRole("button", { name: "Next week" }));
      await screen.findByText("Aug 3 – Aug 9, 2026");
      expect(scrolled).not.toHaveBeenCalled();
    });

    it("scrolls to today once the week's meals are in, and not on a reload", async () => {
      setViewportWidth(375);
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      let release: () => void = () => {};
      const backend = mockBackend({
        "GET /api/meal-plan": () =>
          new Promise((resolve) => {
            release = () =>
              resolve([plannedMeal({ entry_id: 3, plan_date: "2026-07-27", servings: 2 })]);
          }),
        "PATCH /api/meal-plan/:id": () => new HttpError(500),
      });
      const { user } = renderApp("/planner");
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(1));
      await screen.findByText("Jul 27 – Aug 2, 2026");
      expect(scrolled).not.toHaveBeenCalled();

      release();
      await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
      expect(scrolled.mock.contexts[0]).toHaveTextContent("Wed");
      expect(document.querySelector(".plan-entry")).not.toBeNull();

      // A failed servings write asks for the same week again.
      await user.click(screen.getAllByRole("button", { name: "More servings" })[0]);
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
      release();
      await screen.findByText("Server Error");
      expect(scrolled).toHaveBeenCalledTimes(1);
    });

    it("scrolls to today again when Today brings back the current week", async () => {
      setViewportWidth(375);
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      mockBackend({ "GET /api/meal-plan": [] });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");
      await waitFor(() => expect(scrolled).toHaveBeenCalled());

      await user.click(screen.getByRole("button", { name: "Next week" }));
      await screen.findByText("Aug 3 – Aug 9, 2026");
      scrolled.mockClear();
      await user.click(screen.getByRole("button", { name: "Today" }));
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
      expect(scrolled.mock.contexts[0]).toHaveTextContent("Wed");
    });

    /* The grid is what a tablet in portrait gets, and the width it needs is
       the width WEEK_GRID names. */
    it("keeps the grid at exactly the width it fits in", async () => {
      setViewportWidth(WEEK_GRID + 1);
      mockBackend({ "GET /api/meal-plan": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      expect(document.querySelector(".week-grid")).not.toBeNull();
      expect(document.querySelector(".day-agenda")).toBeNull();
    });
  });

  describe("what the week costs", () => {
    it("shows what cooking the week costs against what shopping for it costs", async () => {
      // Two numbers on purpose: cooking prices the share of each package the
      // meals use, shopping prices whole packages, and the gap is the pantry
      // surplus.
      mockBackend({
        "GET /api/meal-plan": [plannedMeal()],
        "GET /api/meal-plan/cost": planCost({
          total: 61.2,
          priced: 40,
          total_lines: 44,
          days: [{ plan_date: "2026-07-27", total: 61.2, priced: 40, total_lines: 44 }],
          grocery_total: 84.1,
        }),
      });
      renderApp("/planner");

      expect(await screen.findByText("est. $61.20 to cook")).toBeInTheDocument();
      expect(screen.getByText("40 of 44 ingredients priced")).toBeInTheDocument();
      expect(screen.getByText("about $84.10 to shop for, in whole packages")).toBeInTheDocument();
    });

    it("asks again when a meal is added, since the answer changed", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/cost": null,
        "GET /api/recipes": page([recipeSummary({ id: 5, title: "Weeknight chicken curry" })]),
        "GET /api/recipes/tags": [],
        "POST /api/meal-plan": plannedMeal({
          recipe: recipeSummary({ id: 5, title: "Weeknight chicken curry" }),
        }),
      });
      const { user } = renderApp("/planner");
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan/cost")).toHaveLength(1));

      await user.click(within(cell("dinner", 0)).getByRole("button", { name: "+ Add" }));
      await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));

      await waitFor(() =>
        expect(backend.requestsTo("GET /api/meal-plan/cost").length).toBeGreaterThan(1),
      );
    });

    it("looks like the ordinary planner without pricing", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [plannedMeal()],
        "GET /api/meal-plan/cost": null,
      });
      renderApp("/planner");

      await screen.findByText("Weeknight chicken curry");
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan/cost")).toHaveLength(1));
      expect(screen.queryByText(/to cook/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    });

    /** The heading of one day, in either layout. */
    function dayHead(dayIndex: number): HTMLElement {
      return document.querySelectorAll<HTMLElement>(".day-head")[dayIndex];
    }

    it("heads each day with what its meals cost", async () => {
      mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-27" })],
        "GET /api/meal-plan/cost": planCost({
          days: [{ plan_date: "2026-07-27", total: 12.4, priced: 4, total_lines: 4 }],
          entries: [{ key: "e3", total: 12.4, priced: 4, total_lines: 4 }],
        }),
      });
      renderApp("/planner");

      expect(
        await within(dayHead(0)).findByRole("img", { name: "$12.40, 4 of 4 ingredients priced" }),
      ).toHaveTextContent(/^\$12\.40$/);
      expect(dayHead(1)).not.toHaveTextContent("$");
    });

    it("says a day with unpriced ingredients costs at least its figure", async () => {
      // A plus rather than a bare number: the figure is a floor, and read
      // plain it would claim to be the whole.
      mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-28" })],
        "GET /api/meal-plan/cost": planCost({
          days: [{ plan_date: "2026-07-28", total: 6.2, priced: 9, total_lines: 11 }],
          entries: [{ key: "e3", total: 6.2, priced: 9, total_lines: 11 }],
        }),
      });
      renderApp("/planner");

      const figure = await within(dayHead(1)).findByRole("img", {
        name: "at least $6.20, 9 of 11 ingredients priced",
      });
      expect(figure).toHaveTextContent(/^\$6\.20\+$/);
      expect(figure).toHaveAttribute("title", "at least $6.20, 9 of 11 ingredients priced");
    });

    it("puts each meal's cost on the line with its servings", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-27", meal: "breakfast" }),
          plannedMeal({ entry_id: 4, plan_date: "2026-07-27", meal: "dinner" }),
        ],
        "GET /api/meal-plan/cost": planCost({
          days: [{ plan_date: "2026-07-27", total: 9.1, priced: 7, total_lines: 9 }],
          entries: [
            { key: "e3", total: 2.9, priced: 3, total_lines: 3 },
            { key: "e4", total: 6.2, priced: 4, total_lines: 6 },
          ],
        }),
      });
      renderApp("/planner");

      const breakfast = await within(cell("breakfast", 0)).findByRole("img", {
        name: "$2.90, 3 of 3 ingredients priced",
      });
      const dinner = within(cell("dinner", 0)).getByRole("img", {
        name: "at least $6.20, 4 of 6 ingredients priced",
      });
      expect(breakfast.parentElement).toContainElement(
        within(cell("breakfast", 0)).getByRole("button", { name: "More servings" }),
      );
      expect(dinner.parentElement).toContainElement(
        within(cell("dinner", 0)).getByRole("button", { name: "More servings" }),
      );
    });

    it("still costs a meal whose recipe has no serving count", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-27", recipe: recipeSummary({ servings: null }) }),
        ],
        "GET /api/meal-plan/cost": planCost({
          days: [{ plan_date: "2026-07-27", total: 3.1, priced: 2, total_lines: 2 }],
          entries: [{ key: "e3", total: 3.1, priced: 2, total_lines: 2 }],
        }),
      });
      renderApp("/planner");

      expect(
        await within(cell("dinner", 0)).findByRole("img", {
          name: "$3.10, 2 of 2 ingredients priced",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "More servings" })).not.toBeInTheDocument();
    });

    it("shows no figure for a meal or a day with nothing priced", async () => {
      // Any number there would be invented.
      const backend = mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-27" })],
        "GET /api/meal-plan/cost": planCost({
          total: 0,
          priced: 0,
          total_lines: 5,
          days: [{ plan_date: "2026-07-27", total: 0, priced: 0, total_lines: 5 }],
          entries: [{ key: "e3", total: 0, priced: 0, total_lines: 5 }],
        }),
      });
      renderApp("/planner");

      await screen.findByText("Weeknight chicken curry");
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan/cost")).toHaveLength(1));
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    });

    it("follows a changed serving count once the cost comes back", async () => {
      const recipe = recipeSummary({ servings: 4 });
      let stored: number | null = null;
      mockBackend({
        "GET /api/meal-plan": () => [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-27", servings: stored, recipe }),
        ],
        "PATCH /api/meal-plan/:id": (req: MockRequest) => {
          stored = (req.body as { servings: number | null }).servings;
          return plannedMeal({ entry_id: 3, plan_date: "2026-07-27", servings: stored, recipe });
        },
        // A dollar a serving, so the figure says which count it was priced at.
        "GET /api/meal-plan/cost": () => {
          const total = stored ?? 4;
          return planCost({
            days: [{ plan_date: "2026-07-27", total, priced: 2, total_lines: 2 }],
            entries: [{ key: "e3", total, priced: 2, total_lines: 2 }],
          });
        },
      });
      const { user } = renderApp("/planner");
      await within(cell("dinner", 0)).findByRole("img", {
        name: "$4.00, 2 of 2 ingredients priced",
      });

      await user.click(screen.getByRole("button", { name: "More servings" }));

      expect(
        await within(cell("dinner", 0)).findByRole("img", {
          name: "$5.00, 2 of 2 ingredients priced",
        }),
      ).toBeInTheDocument();
    });

    it("costs each day and meal in the agenda too", async () => {
      setViewportWidth(375);
      mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-29" })],
        "GET /api/meal-plan/cost": planCost({
          days: [{ plan_date: "2026-07-29", total: 6.2, priced: 9, total_lines: 11 }],
          entries: [{ key: "e3", total: 6.2, priced: 9, total_lines: 11 }],
        }),
      });
      renderApp("/planner");

      // Wednesday, the third card, and today.
      await screen.findByText("Weeknight chicken curry");
      const wednesday = document.querySelectorAll<HTMLElement>(".agenda-day")[2];
      const head = within(wednesday).getByRole("heading");
      expect(
        await within(head).findByRole("img", {
          name: "at least $6.20, 9 of 11 ingredients priced",
        }),
      ).toBeInTheDocument();
      expect(within(head).getByText("Today")).toBeVisible();
      const meal = wednesday.querySelector<HTMLElement>(".plan-entry")!;
      expect(
        within(meal).getByRole("img", { name: "at least $6.20, 9 of 11 ingredients priced" }),
      ).toBeInTheDocument();
    });
  });
  describe("labels", () => {
    const dad = { id: 1, name: "Dad" };
    const kids = { id: 2, name: "Kids" };
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });

    it("shows a meal's labels after its title, and nothing for an unlabelled meal", async () => {
      mockBackend({
        "GET /api/labels": [],
        "GET /api/meal-plan": [
          plannedMeal({ plan_date: "2026-07-27", recipe: curry, labels: [dad, kids] }),
          plannedMeal({
            plan_date: "2026-07-28",
            recipe: recipeSummary({ id: 6, title: "Plain rice" }),
          }),
        ],
      });
      renderApp("/planner");
      await screen.findByText("Plain rice");

      const labelled = cell("dinner", 0);
      expect(within(labelled).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
        "Dad",
        "Kids",
      ]);
      expect(within(cell("dinner", 1)).queryByRole("list")).not.toBeInTheDocument();
    });

    describe("the filter", () => {
      const labelRows = [
        { ...dad, meals: 1 },
        { ...kids, meals: 0 },
      ];
      const dadMeal = plannedMeal({
        plan_date: "2026-07-27",
        recipe: recipeSummary({ id: 5, title: "Dad curry" }),
        labels: [dad],
      });
      const kidsMeal = plannedMeal({
        plan_date: "2026-07-28",
        recipe: recipeSummary({ id: 6, title: "Kids pasta" }),
        labels: [kids],
      });
      const plainMeal = plannedMeal({
        plan_date: "2026-07-29",
        recipe: recipeSummary({ id: 7, title: "Plain rice" }),
      });

      it("shows no filter row until a label exists", async () => {
        mockBackend({ "GET /api/labels": [], "GET /api/meal-plan": [plainMeal] });
        renderApp("/planner");
        await screen.findByText("Plain rice");
        expect(screen.queryByRole("button", { name: "Everything" })).not.toBeInTheDocument();
      });

      it("dims unlabelled meals, hides other labels' and keeps the choice in the URL", async () => {
        mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [dadMeal, kidsMeal, plainMeal],
        });
        const { user } = renderApp("/planner");
        await screen.findByText("Plain rice");
        expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");

        await user.click(screen.getByRole("button", { name: "Dad" }));
        expect(screen.getByText("Dad curry")).toBeVisible();
        expect(screen.queryByText("Kids pasta")).not.toBeInTheDocument();
        const rice = screen.getByText("Plain rice");
        expect(rice.closest(".plan-entry")).toHaveClass("dimmed");
        expect(screen.getByText("Dad curry").closest(".plan-entry")).not.toHaveClass("dimmed");

        await user.click(screen.getByRole("checkbox", { name: "Include unlabelled meals" }));
        expect(screen.queryByText("Plain rice")).not.toBeInTheDocument();
      });

      it("keeps the filter across a reload", async () => {
        mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [dadMeal, kidsMeal, plainMeal],
        });
        renderApp("/planner?label=1&unlabelled=0");
        // The chips wait on the labels request, which may land after the week.
        expect(await screen.findByRole("button", { name: "Dad" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await screen.findByText("Dad curry");
        expect(screen.getByRole("checkbox", { name: "Include unlabelled meals" })).not.toBeChecked();
        expect(screen.queryByText("Plain rice")).not.toBeInTheDocument();
      });

      it("falls back to Everything when the label in the URL no longer exists", async () => {
        mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [dadMeal, kidsMeal],
        });
        renderApp("/planner?label=99");
        expect(await screen.findByRole("button", { name: "Everything" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(await screen.findByText("Kids pasta")).toBeVisible();
        expect(screen.getByText("Dad curry")).toBeVisible();
      });

      it("honours the URL's filter while the labels are still loading", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const backend = mockBackend({
          "GET /api/labels": async () => {
            await held;
            return labelRows;
          },
          "GET /api/meal-plan": [dadMeal, kidsMeal],
          "GET /api/recipes": page([recipeSummary({ id: 5, title: "Weeknight chicken curry" })]),
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner?label=1");
        expect(await screen.findByText("Dad curry")).toBeVisible();
        expect(screen.queryByText("Kids pasta")).not.toBeInTheDocument();

        await user.click(within(cell("lunch", 4)).getByRole("button", { name: "+ Add" }));
        await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));
        await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
        expect(backend.requestsTo("POST /api/meal-plan")[0].body).toMatchObject({ label_ids: [1] });
        release();
        await screen.findByRole("button", { name: "Dad" });
      });

      it("labels a meal added while a label is selected, and not otherwise", async () => {
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [],
          "GET /api/recipes": page([recipeSummary({ id: 5, title: "Weeknight chicken curry" })]),
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner?label=2");
        await screen.findByRole("button", { name: "Kids" });

        await user.click(within(cell("lunch", 4)).getByRole("button", { name: "+ Add" }));
        await user.click(await screen.findByRole("button", { name: /Weeknight chicken curry/ }));
        await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
        expect(backend.requestsTo("POST /api/meal-plan")[0].body).toMatchObject({ label_ids: [2] });
      });

      it("leaves the costs and the Grocery list link on the whole plan", async () => {
        mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [dadMeal, kidsMeal],
          "GET /api/meal-plan/cost": planCost({ total: 12.5, priced: 3, total_lines: 4 }),
        });
        const { user } = renderApp("/planner");
        await screen.findByText("Kids pasta");
        await user.click(screen.getByRole("button", { name: "Dad" }));

        expect(await screen.findByText(/est\. \$12\.50 to cook/)).toBeVisible();
        expect(screen.getByRole("link", { name: /Grocery list/ })).toHaveAttribute(
          "href",
          "/groceries?start=2026-07-27&end=2026-08-02",
        );
      });
    });

    it("labels a one-off meal once the checklist closes", async () => {
      const backend = mockBackend({
        "GET /api/labels": [
          { ...dad, meals: 0 },
          { ...kids, meals: 0 },
        ],
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-27", recipe: curry }),
        ],
        "PATCH /api/meal-plan/:id": (req: MockRequest) => ({
          ...plannedMeal({ entry_id: 3, plan_date: "2026-07-27", recipe: curry }),
          labels: [dad, kids],
          ...(req.body as object),
        }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Actions for Weeknight chicken curry" }));
      await user.click(screen.getByRole("menuitem", { name: "Labels…" }));
      await user.click(await screen.findByRole("checkbox", { name: "Dad" }));
      await user.click(screen.getByRole("checkbox", { name: "Kids" }));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
      await user.keyboard("{Escape}");

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      const patch = backend.requestsTo("PATCH /api/meal-plan/:id")[0];
      expect(patch.path).toBe("/api/meal-plan/3");
      expect(patch.body).toEqual({ label_ids: [1, 2] });
      expect(await within(cell("dinner", 0)).findByText("Kids")).toBeInTheDocument();
    });

    it("makes a new label from the checklist and ticks it", async () => {
      const backend = mockBackend({
        "GET /api/labels": [{ ...dad, meals: 0 }],
        "POST /api/labels": { id: 9, name: "Guests" },
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-27", recipe: curry }),
        ],
        "PATCH /api/meal-plan/:id": () => ({
          ...plannedMeal({ entry_id: 3, plan_date: "2026-07-27", recipe: curry }),
          labels: [{ id: 9, name: "Guests" }],
        }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Actions for Weeknight chicken curry" }));
      await user.click(screen.getByRole("menuitem", { name: "Labels…" }));
      await user.type(await screen.findByRole("textbox", { name: "New label" }), "Guests{Enter}");

      expect(await screen.findByRole("checkbox", { name: "Guests" })).toBeChecked();
      expect(backend.requestsTo("POST /api/labels")[0].body).toEqual({ name: "Guests" });

      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ label_ids: [9] });
    });
  });

  describe("repeating meals", () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry", servings: 4 });
    const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

    /** One day of repeat 1, with no row of its own unless `entry_id` is given. */
    function repeatDay(day: string, overrides: Parameters<typeof plannedMeal>[0] = {}) {
      return plannedMeal({
        entry_id: null,
        key: `r1-${day}`,
        plan_date: day,
        recipe: curry,
        repeat: { id: 1, weekdays: EVERY_DAY, starts_on: "2026-07-20", ends_on: null },
        ...overrides,
      });
    }

    async function openMenu(user: ReturnType<typeof renderApp>["user"]) {
      await user.click(
        await screen.findByRole("button", { name: "Actions for Weeknight chicken curry" }),
      );
    }

    it("marks a repeated meal and leaves a one-off plain", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          repeatDay("2026-07-30"),
          plannedMeal({
            plan_date: "2026-07-31",
            recipe: recipeSummary({ id: 6, title: "Plain rice" }),
          }),
        ],
      });
      renderApp("/planner");
      await screen.findByText("Plain rice");

      const repeated = within(cell("dinner", 3)).getByText("Weeknight chicken curry");
      expect(repeated.closest(".plan-entry")).toHaveClass("repeated");
      expect(within(cell("dinner", 3)).getByLabelText("Repeats")).toHaveTextContent("↻");

      const plain = screen.getByText("Plain rice").closest(".plan-entry")!;
      expect(plain).not.toHaveClass("repeated");
      expect(within(cell("dinner", 4)).queryByLabelText("Repeats")).not.toBeInTheDocument();
    });

    it("turns a one-off into a repeat from its menu", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-29", recipe: curry })],
        "POST /api/meal-plan/:id/repeat": {
          id: 1,
          weekdays: [2],
          starts_on: "2026-07-29",
          ends_on: null,
        },
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Repeat…" }));
      await user.click(screen.getByRole("button", { name: "Every Wednesday" }));

      await waitFor(() =>
        expect(backend.requestsTo("POST /api/meal-plan/:id/repeat")).toHaveLength(1),
      );
      const [request] = backend.requestsTo("POST /api/meal-plan/:id/repeat");
      expect(request.path).toBe("/api/meal-plan/3/repeat");
      expect(request.body).toEqual({ weekdays: [2], today: "2026-07-29" });
      // The repeat fills days the page has not drawn yet.
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
    });

    it("changes a repeat's days from that day on without asking", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Repeat…" }));
      await user.click(screen.getByRole("button", { name: "Weekdays from Thu, Jul 30 on" }));

      await waitFor(() =>
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
      );
      const [request] = backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day");
      expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30");
      expect(request.body).toEqual({
        scope: "from",
        weekdays: [0, 1, 2, 3, 4],
        today: "2026-07-29",
      });
      expect(screen.queryByRole("button", { name: "Just this day" })).not.toBeInTheDocument();
    });

    it("stops a repeat after its day when Just this day is chosen", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "POST /api/meal-plan/repeats/:id/days/:day/stop": plannedMeal({
          entry_id: 8,
          plan_date: "2026-07-30",
          recipe: curry,
        }),
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Repeat…" }));
      await user.click(screen.getByRole("button", { name: "Just this day" }));

      await waitFor(() =>
        expect(backend.requestsTo("POST /api/meal-plan/repeats/:id/days/:day/stop")).toHaveLength(
          1,
        ),
      );
      const [request] = backend.requestsTo("POST /api/meal-plan/repeats/:id/days/:day/stop");
      expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30/stop");
      expect(request.body).toEqual({ today: "2026-07-29" });
    });

    it("asks once whether removing a repeated meal is for the day or from it on", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "DELETE /api/meal-plan/repeats/:id/days/:day": undefined,
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Remove" }));
      expect(backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Just this day" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "From Thu, Jul 30 on" }));

      await waitFor(() =>
        expect(backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
      );
      const [request] = backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day");
      expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30");
      expect(Object.fromEntries(request.searchParams)).toEqual({
        scope: "from",
        today: "2026-07-29",
      });
      expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(0);
    });

    it("removes a day changed on its own through its repeat, not as a one-off", async () => {
      // A day with servings of its own has a row, but is still the repeat's.
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30", { entry_id: 8, key: "e8", servings: 2 })],
        "DELETE /api/meal-plan/repeats/:id/days/:day": undefined,
        "DELETE /api/meal-plan/:id": undefined,
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Remove" }));
      await user.click(screen.getByRole("button", { name: "Just this day" }));

      await waitFor(() =>
        expect(backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
      );
      expect(
        backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")[0].searchParams.get(
          "scope",
        ),
      ).toBe("day");
      expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(0);
    });

    it("leaves a repeated meal as it was when the question is cancelled", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "DELETE /api/meal-plan/repeats/:id/days/:day": undefined,
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Remove" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("button", { name: "Just this day" })).not.toBeInTheDocument();
      expect(screen.getByText("Weeknight chicken curry")).toBeInTheDocument();
      expect(backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
    });

    it("labels a repeated meal once, after the checklist closes and the question is answered", async () => {
      const dad = { id: 1, name: "Dad" };
      const kids = { id: 2, name: "Kids" };
      const backend = mockBackend({
        "GET /api/labels": [
          { ...dad, meals: 0 },
          { ...kids, meals: 0 },
        ],
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
        "PATCH /api/meal-plan/:id": undefined,
      });
      const { user } = renderApp("/planner");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Labels…" }));
      await user.click(await screen.findByRole("checkbox", { name: "Dad" }));
      await user.click(screen.getByRole("checkbox", { name: "Kids" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Just this day" }));

      await waitFor(() =>
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
      );
      const [request] = backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day");
      expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30");
      expect(request.body).toEqual({ scope: "day", label_ids: [1, 2], today: "2026-07-29" });
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
    });

    it("asks once after a burst of servings taps on a repeated meal", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
        "PATCH /api/meal-plan/:id": undefined,
      });
      const { user } = renderApp("/planner");
      const more = await screen.findByRole("button", { name: "More servings" });

      await user.click(more);
      await user.click(more);
      await user.click(more);

      // Shown at once, saved only once the question is answered.
      expect(screen.getByText("×7")).toBeInTheDocument();
      const day = await screen.findByRole(
        "button",
        { name: "Just this day" },
        { timeout: 2000 },
      );
      expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "From Thu, Jul 30 on" })).toBeInTheDocument();

      await user.click(day);

      await waitFor(() =>
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
      );
      expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")[0].body).toEqual({
        scope: "day",
        servings: 7,
        today: "2026-07-29",
      });
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Just this day" })).not.toBeInTheDocument();
    });

    it("puts the count back when the servings question is cancelled", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [repeatDay("2026-07-30")],
        "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "More servings" }));
      expect(screen.getByText("×5")).toBeInTheDocument();
      await user.click(
        await screen.findByRole("button", { name: "Cancel" }, { timeout: 2000 }),
      );

      expect(screen.getByText("×4")).toBeInTheDocument();
      expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
    });

    it("does not offer From this day on for a past day", async () => {
      // Monday, two days before today.
      mockBackend({ "GET /api/meal-plan": [repeatDay("2026-07-27")] });
      const { user } = renderApp("/planner");

      await openMenu(user);
      const repeat = screen.getByRole("menuitem", { name: "Repeat…" });
      expect(repeat).toHaveAttribute("aria-disabled", "true");
      expect(repeat).toHaveAttribute("title", "That day has passed");
      await user.click(repeat);
      expect(screen.queryByRole("button", { name: /^Every/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole("menuitem", { name: "Remove" }));
      expect(screen.getByRole("button", { name: "Just this day" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^From/ })).not.toBeInTheDocument();
    });
  });
});
