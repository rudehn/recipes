import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Meal, RecipeSummary } from "../api";
import { DRAG_QUIET_MS, PLACING_TYPE } from "../components/planner/placing";
import { SETTLE_MS } from "../components/planner/usePlannedServings";
import { PHONE, PICKS_PANEL, WEEK_GRID } from "../layout";
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
      await user.click(screen.getByRole("button", { name: "Weeknight chicken curry" }));
      await user.click(await screen.findByRole("button", { name: "More servings" }));
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

    /*
     * On a phone a meal in the list is its title, its labels and its ↻, and
     * a tap opens a sheet holding everything else: the stepper and the menu
     * took a third of a 375px card for the few times they are wanted.
     */
    describe("on a phone", () => {
      const dad = { id: 1, name: "Dad" };
      const kids = { id: 2, name: "Kids" };
      const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry", servings: 4 });
      const labelRows = [
        { ...dad, meals: 1 },
        { ...kids, meals: 0 },
      ];

      /** A day of repeat 1, every day, with no row of its own. */
      const repeatDay = (day: string) =>
        plannedMeal({
          entry_id: null,
          key: `r1-${day}`,
          plan_date: day,
          recipe: curry,
          repeat: { id: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], starts_on: "2026-07-20", ends_on: null },
        });

      const sheet = (name: string) => screen.findByRole("dialog", { name });

      it("opens a meal's sheet with its servings, labels, repeat and remove", async () => {
        setViewportWidth(375);
        const meal = plannedMeal({
          entry_id: 3,
          plan_date: "2026-07-30",
          recipe: curry,
          labels: [dad],
        });
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [meal],
          "GET /api/meal-plan/cost": planCost({
            entries: [{ key: "e3", total: 6.2, priced: 9, total_lines: 9 }],
          }),
          "PATCH /api/meal-plan/:id": (req: MockRequest) => ({ ...meal, ...(req.body as object) }),
          "DELETE /api/meal-plan/:id": undefined,
        });
        const { user } = renderApp("/planner");

        // The list has the title and the labels, and no controls of the meal's own.
        const open = await screen.findByRole("button", { name: "Weeknight chicken curry" });
        const card = open.closest<HTMLElement>(".plan-entry")!;
        expect(within(card).getByText("Dad")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "More servings" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();

        await user.click(open);
        const dialog = await sheet("Thursday dinner");
        expect(within(dialog).getByRole("link", { name: "Weeknight chicken curry" })).toHaveAttribute(
          "href",
          "/recipes/5",
        );
        expect(
          await within(dialog).findByRole("img", { name: "$6.20, 9 of 9 ingredients priced" }),
        ).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: /^Repeat/ })).toHaveTextContent(
          "Just this day",
        );
        expect(within(dialog).getByRole("button", { name: "Remove from Thursday" })).toBeVisible();

        // A one-off's servings save as they are tapped, as in a cell.
        await user.click(within(dialog).getByRole("button", { name: "More servings" }));
        expect(within(dialog).getByText("×5")).toBeInTheDocument();
        await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ servings: 5 });

        // Its labels are one write, when the sheet closes.
        const forRow = within(dialog).getByRole("group", { name: "For" });
        expect(within(forRow).getByRole("button", { name: "Dad" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await user.click(within(forRow).getByRole("button", { name: "Kids" }));
        await user.click(within(forRow).getByRole("button", { name: "Dad" }));
        await user.click(within(forRow).getByRole("button", { name: "Dad" }));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1);
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(2));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")[1].body).toEqual({
          label_ids: [1, 2],
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Weeknight chicken curry" }));
        await user.click(
          within(await sheet("Thursday dinner")).getByRole("button", {
            name: "Remove from Thursday",
          }),
        );
        await waitFor(() => expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(1));
        expect(backend.requestsTo("DELETE /api/meal-plan/:id")[0].path).toBe("/api/meal-plan/3");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("makes a label from the sheet and puts it on the meal", async () => {
        setViewportWidth(375);
        const meal = plannedMeal({ entry_id: 3, plan_date: "2026-07-30", recipe: curry });
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "POST /api/labels": { id: 9, name: "Guests" },
          "GET /api/meal-plan": [meal],
          "PATCH /api/meal-plan/:id": (req: MockRequest) => ({ ...meal, ...(req.body as object) }),
        });
        const { user } = renderApp("/planner");

        await user.click(await screen.findByRole("button", { name: "Weeknight chicken curry" }));
        const dialog = await sheet("Thursday dinner");
        await user.click(within(dialog).getByRole("button", { name: "+ New" }));
        // Escape here only puts the field away, and leaves the sheet open.
        await user.keyboard("{Escape}");
        expect(dialog).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "+ New" }));
        await user.type(within(dialog).getByRole("textbox", { name: "New label" }), "Guests{Enter}");

        expect(
          await within(dialog).findByRole("button", { name: "Guests", pressed: true }),
        ).toBeInTheDocument();
        expect(backend.requestsTo("POST /api/labels")[0].body).toEqual({ name: "Guests" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ label_ids: [9] });
      });

      it("labels a repeated meal from the sheet with one question when it closes", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
          "PATCH /api/meal-plan/:id": undefined,
        });
        const { user } = renderApp("/planner");

        // In the list, its ↻ and title.
        const open = await screen.findByRole("button", { name: /Weeknight chicken curry$/ });
        expect(within(open).getByRole("img", { name: "Repeats" })).toHaveTextContent("↻");
        await user.click(open);
        const dialog = await sheet("Thursday dinner");
        expect(within(dialog).getByRole("button", { name: /^Repeat/ })).toHaveTextContent(
          "Every day",
        );
        await user.click(within(dialog).getByRole("button", { name: "More servings" }));
        await user.click(within(dialog).getByRole("button", { name: "More servings" }));
        await user.click(within(dialog).getByRole("button", { name: "Dad" }));
        await user.click(within(dialog).getByRole("button", { name: "Kids" }));
        expect(within(dialog).getByText("×6")).toBeInTheDocument();
        // Changing the days waits for these to be saved, since it is a change
        // of its own from this day on.
        expect(within(dialog).getByRole("button", { name: /^Repeat/ })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        expect(within(dialog).getByRole("button", { name: /^Repeat/ })).toHaveAccessibleDescription(
          "Close to save the changes above, then change its days, move or copy it.",
        );
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);

        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(
          within(dialog).getByRole("group", { name: "Which days get these changes?" }),
        ).toBeInTheDocument();
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
        await user.click(within(dialog).getByRole("button", { name: "From Thu, Jul 30 on" }));

        await waitFor(() =>
          expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
        );
        const [request] = backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day");
        expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30");
        expect(request.body).toEqual({
          scope: "from",
          servings: 6,
          label_ids: [1, 2],
          today: "2026-07-29",
        });
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("closes a repeated meal's sheet without a question when nothing changed", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
        });
        const { user } = renderApp("/planner");

        await user.click(
          await screen.findByRole("button", { name: /Weeknight chicken curry$/ }),
        );
        const dialog = await sheet("Thursday dinner");
        // A count stepped and back, and a label ticked and unticked, is no change.
        await user.click(within(dialog).getByRole("button", { name: "More servings" }));
        await user.click(within(dialog).getByRole("button", { name: "Fewer servings" }));
        await user.click(within(dialog).getByRole("button", { name: "Kids" }));
        await user.click(within(dialog).getByRole("button", { name: "Kids" }));
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
      });

      it("asks which days a repeated meal is removed from, and Cancel keeps it", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "DELETE /api/meal-plan/repeats/:id/days/:day": undefined,
          "DELETE /api/meal-plan/:id": undefined,
        });
        const { user } = renderApp("/planner");

        await user.click(
          await screen.findByRole("button", { name: /Weeknight chicken curry$/ }),
        );
        const dialog = await sheet("Thursday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Remove from Thursday" }));
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        // Back on the sheet, with nothing removed.
        expect(within(dialog).getByRole("button", { name: "Remove from Thursday" })).toBeVisible();

        await user.click(within(dialog).getByRole("button", { name: "Remove from Thursday" }));
        await user.click(within(dialog).getByRole("button", { name: "Just this day" }));

        await waitFor(() =>
          expect(backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day")).toHaveLength(
            1,
          ),
        );
        const [request] = backend.requestsTo("DELETE /api/meal-plan/repeats/:id/days/:day");
        expect(request.path).toBe("/api/meal-plan/repeats/1/days/2026-07-30");
        expect(request.searchParams.get("scope")).toBe("day");
        expect(backend.requestsTo("DELETE /api/meal-plan/:id")).toHaveLength(0);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("repeats a meal from its sheet, and not on a day that has passed", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/meal-plan": [
            plannedMeal({ entry_id: 3, plan_date: "2026-07-30", recipe: curry }),
            plannedMeal({
              entry_id: 4,
              plan_date: "2026-07-27",
              recipe: recipeSummary({ id: 6, title: "Banana bread" }),
            }),
          ],
          "POST /api/meal-plan/:id/repeat": {
            id: 1,
            weekdays: [3],
            starts_on: "2026-07-30",
            ends_on: null,
          },
        });
        const { user } = renderApp("/planner");

        await user.click(await screen.findByRole("button", { name: "Banana bread" }));
        let dialog = await sheet("Monday dinner");
        const past = within(dialog).getByRole("button", { name: /^Repeat/ });
        expect(past).toHaveAttribute("aria-disabled", "true");
        expect(past).toHaveAccessibleDescription("That day has passed");
        await user.click(past);
        expect(within(dialog).queryByRole("button", { name: /^Every/ })).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        await user.click(screen.getByRole("button", { name: "Weeknight chicken curry" }));
        dialog = await sheet("Thursday dinner");
        await user.click(within(dialog).getByRole("button", { name: /^Repeat/ }));
        await user.click(within(dialog).getByRole("button", { name: "Every Thursday" }));

        await waitFor(() =>
          expect(backend.requestsTo("POST /api/meal-plan/:id/repeat")).toHaveLength(1),
        );
        expect(backend.requestsTo("POST /api/meal-plan/:id/repeat")[0].path).toBe(
          "/api/meal-plan/3/repeat",
        );
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("moves and copies a meal to a day and meal chosen in its sheet", async () => {
        setViewportWidth(375);
        const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
        const oneOff = plannedMeal({
          entry_id: 3,
          plan_date: "2026-07-30",
          recipe: curry,
          labels: [dad],
        });
        let moved = false;
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": () => [
            moved ? { ...oneOff, plan_date: "2026-08-01", meal: "lunch" } : oneOff,
            { ...repeatDay("2026-07-28"), servings: 2 },
          ],
          "PATCH /api/meal-plan/:id": () => {
            moved = true;
            return plannedMeal({ entry_id: 3 });
          },
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
          "POST /api/meal-plan/repeats/:id/days/:day/move": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner");
        const open = (name: RegExp) => screen.findByRole("button", { name });

        // A one-off moves to the day and meal chosen; its own cell is no
        // place to move it to.
        await user.click(await open(/^Weeknight chicken curry$/));
        let dialog = await sheet("Thursday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Move to…" }));
        const day = () => within(dialog).getByRole("group", { name: "Day" });
        const meal = () => within(dialog).getByRole("group", { name: "Meal" });
        expect(within(day()).getByRole("button", { name: "Thursday, Jul 30" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(within(meal()).getByRole("button", { name: "Dinner" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
        await user.click(within(day()).getByRole("button", { name: "Saturday, Aug 1" }));
        await user.click(within(meal()).getByRole("button", { name: "Lunch" }));
        // What each day scrolled to held as it was scrolled to.
        const scrolledTo: string[] = [];
        scrolled.mockImplementation(function (this: Element) {
          scrolledTo.push(this.textContent ?? "");
        });
        await user.click(within(dialog).getByRole("button", { name: "Move" }));

        await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({
          plan_date: "2026-08-01",
          meal: "lunch",
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        // Its new day is brought into view, as a placed pick's is, once the
        // week has loaded with it there: a day above it may be shorter now.
        await waitFor(() => expect(scrolledTo.at(-1)).toMatch(/^Sat\s*Aug 1/));
        expect(scrolledTo.at(-1)).toContain("Weeknight chicken curry");

        // A repeated day copies as a one-off with its own servings and labels;
        // Back leaves the sheet as it was.
        await user.click(await open(/^Repeats/));
        dialog = await sheet("Tuesday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Copy to…" }));
        await user.click(within(dialog).getByRole("button", { name: "Back" }));
        expect(within(dialog).getByRole("button", { name: "Copy to…" })).toHaveFocus();
        await user.click(within(dialog).getByRole("button", { name: "Copy to…" }));
        await user.click(within(meal()).getByRole("button", { name: "Breakfast" }));
        await user.click(within(dialog).getByRole("button", { name: "Copy" }));
        await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
        expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
          plan_date: "2026-07-28",
          meal: "breakfast",
          recipe_id: 5,
          servings: 2,
        });

        // And moves through its repeat, that day alone.
        await user.click(await open(/^Repeats/));
        dialog = await sheet("Tuesday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Move to…" }));
        await user.click(within(day()).getByRole("button", { name: "Friday, Jul 31" }));
        await user.click(within(dialog).getByRole("button", { name: "Move" }));
        const moves = () => backend.requestsTo("POST /api/meal-plan/repeats/:id/days/:day/move");
        await waitFor(() => expect(moves()).toHaveLength(1));
        expect(moves()[0].params).toEqual({ id: "1", day: "2026-07-28" });
        expect(moves()[0].body).toEqual({ plan_date: "2026-07-31", meal: "dinner" });
      });

      it("saves a one-off's waiting labels before moving it, and holds a repeated meal's", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/labels": labelRows,
          "GET /api/meal-plan": [
            plannedMeal({ entry_id: 3, plan_date: "2026-07-30", recipe: curry }),
            repeatDay("2026-07-28"),
          ],
          "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3 }),
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner");

        await user.click(await screen.findByRole("button", { name: /^Weeknight chicken curry$/ }));
        let dialog = await sheet("Thursday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Kids" }));
        await user.click(within(dialog).getByRole("button", { name: "Copy to…" }));
        await user.click(within(dialog).getByRole("button", { name: "Lunch" }));
        await user.click(within(dialog).getByRole("button", { name: "Copy" }));
        await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")[0].body).toEqual({ label_ids: [2] });
        // The copy is of the meal as it now is.
        expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
          plan_date: "2026-07-30",
          meal: "lunch",
          recipe_id: 5,
          label_ids: [2],
        });

        await user.click(await screen.findByRole("button", { name: /^Repeats/ }));
        dialog = await sheet("Tuesday dinner");
        await user.click(within(dialog).getByRole("button", { name: "Kids" }));
        for (const name of ["Move to…", "Copy to…"]) {
          const button = within(dialog).getByRole("button", { name });
          expect(button).toHaveAttribute("aria-disabled", "true");
          expect(button).toHaveAccessibleDescription(
            "Close to save the changes above, then change its days, move or copy it.",
          );
          await user.click(button);
        }
        expect(within(dialog).queryByRole("group", { name: "Day" })).not.toBeInTheDocument();
      });

      it("places a pick on a day and meal from the picks sheet", async () => {
        setViewportWidth(375);
        const backend = mockBackend({
          "GET /api/labels": [{ ...kids, meals: 0 }],
          "GET /api/meal-plan": [],
          "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner?label=2");
        await screen.findByText("Jul 27 – Aug 2, 2026");

        // A button, not the strip's toggle: no strip to open beside the week.
        const open = screen.getByRole("button", { name: "Picks" });
        expect(open).not.toHaveAttribute("aria-expanded");
        expect(open).toHaveAttribute("aria-haspopup", "dialog");
        await user.click(open);
        const picks = await sheet("Picks");
        await user.click(
          await within(picks).findByRole("button", { name: /^Weeknight chicken curry/ }),
        );

        const place = await sheet("Place Weeknight chicken curry");
        const day = within(place).getByRole("group", { name: "Day" });
        expect(within(day).getAllByRole("button").map((b) => b.textContent?.[0])).toEqual([
          "M",
          "T",
          "W",
          "T",
          "F",
          "S",
          "S",
        ]);
        // Today, in this week, and dinner.
        expect(within(day).getByRole("button", { name: "Wednesday, Jul 29" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        const meal = within(place).getByRole("group", { name: "Meal" });
        expect(within(meal).getByRole("button", { name: "Dinner" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );

        await user.click(within(day).getByRole("button", { name: "Friday, Jul 31" }));
        await user.click(within(meal).getByRole("button", { name: "Lunch" }));
        expect(within(day).getByRole("button", { name: "Wednesday, Jul 29" })).toHaveAttribute(
          "aria-pressed",
          "false",
        );
        await user.click(within(place).getByRole("button", { name: "Place" }));

        await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
        expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
          plan_date: "2026-07-31",
          meal: "lunch",
          recipe_id: 5,
          label_ids: [2],
        });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
      });

      /* The Picks button is at the top of the list, and the day a pick goes
         to is often days below it: placed out of sight, it would look as if
         nothing had happened. */
      it("brings the day a pick was placed on into view", async () => {
        setViewportWidth(375);
        const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
        mockBackend({
          "GET /api/meal-plan": [],
          "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
          "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        });
        const { user } = renderApp("/planner");
        await screen.findByText("Jul 27 – Aug 2, 2026");
        await waitFor(() => expect(scrolled).toHaveBeenCalled());

        await user.click(screen.getByRole("button", { name: "Picks" }));
        await user.click(
          await within(await sheet("Picks")).findByRole("button", {
            name: /^Weeknight chicken curry/,
          }),
        );
        const place = await sheet("Place Weeknight chicken curry");
        await user.click(within(place).getByRole("button", { name: "Sunday, Aug 2" }));
        scrolled.mockClear();
        await user.click(within(place).getByRole("button", { name: "Place" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
        expect(scrolled).toHaveBeenCalledWith({ block: "start" });
        expect(scrolled.mock.contexts[0]).toHaveTextContent(/^Sun\s*Aug 2/);
      });

      it("leaves the list where it is when a pick could not be placed", async () => {
        setViewportWidth(375);
        const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
        mockBackend({
          "GET /api/meal-plan": [],
          "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
          "POST /api/meal-plan": () => new HttpError(500),
        });
        const { user } = renderApp("/planner");
        await screen.findByText("Jul 27 – Aug 2, 2026");
        await waitFor(() => expect(scrolled).toHaveBeenCalled());

        await user.click(screen.getByRole("button", { name: "Picks" }));
        await user.click(
          await within(await sheet("Picks")).findByRole("button", {
            name: /^Weeknight chicken curry/,
          }),
        );
        const place = await sheet("Place Weeknight chicken curry");
        scrolled.mockClear();
        await user.click(within(place).getByRole("button", { name: "Place" }));

        expect(await within(place).findByRole("alert")).toBeVisible();
        expect(scrolled).not.toHaveBeenCalled();
      });

      it("chooses no day for a pick in a week without today", async () => {
        setViewportWidth(375);
        mockBackend({
          "GET /api/meal-plan": [],
          "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-08-03", recipe: curry }],
        });
        const { user } = renderApp("/planner");
        await user.click(await screen.findByRole("button", { name: "Next week" }));
        await screen.findByText("Aug 3 – Aug 9, 2026");

        await user.click(screen.getByRole("button", { name: "Picks" }));
        await user.click(
          await within(await sheet("Picks")).findByRole("button", {
            name: /^Weeknight chicken curry/,
          }),
        );
        const place = await sheet("Place Weeknight chicken curry");
        expect(within(place).queryByRole("button", { pressed: true, name: /day,/ })).toBeNull();
        expect(within(place).getByRole("button", { name: "Place" })).toBeDisabled();
        await user.click(within(place).getByRole("button", { name: "Tuesday, Aug 4" }));
        expect(within(place).getByRole("button", { name: "Place" })).toBeEnabled();
      });

      it("scrolls the label filter's chips within their row rather than squeezing or wrapping them", async () => {
        // jsdom lays nothing out and applies no media query, so this holds the
        // rule every width shares: the chips' row is what scrolls, sideways,
        // and no chip in it gives up its width or wraps to push the page out
        // instead. The phone's own rule, which runs the row to the screen's
        // edges, is held in styles.test.ts.
        setViewportWidth(375);
        const style = document.createElement("style");
        style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
        document.head.append(style);
        try {
          const many = ["Dad", "Mom", "Kids", "Meal prep", "Packed lunches", "Guests"];
          mockBackend({
            "GET /api/labels": many.map((name, i) => ({ id: i + 1, name, meals: 0 })),
            "GET /api/meal-plan": [],
          });
          renderApp("/planner?label=6");

          const row = await screen.findByRole("group", { name: "Show meals for" });
          await within(row).findByRole("button", { name: "Guests", pressed: true });
          expect(within(row).getAllByRole("button")).toHaveLength(7);
          expect(getComputedStyle(row).overflowX).toBe("auto");
          expect(getComputedStyle(row).maxWidth).toBe("100%");
          for (const chip of within(row).getAllByRole("button")) {
            expect(getComputedStyle(chip).flex).toMatch(/^(none|0 0 auto)$/);
            expect(getComputedStyle(chip).whiteSpace).toBe("nowrap");
          }
        } finally {
          style.remove();
        }
      });
    });

    /* A tablet's agenda has the room the phone does not, and keeps each
       meal's own controls and the Picks strip beside the week. */
    it("keeps the meals' own controls and the Picks strip above a phone's width", async () => {
      setViewportWidth(PHONE + 1);
      mockBackend({
        "GET /api/meal-plan": [plannedMeal({ entry_id: 3, plan_date: "2026-07-30" })],
      });
      renderApp("/planner");

      expect(await screen.findByRole("button", { name: "More servings" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Actions for Weeknight chicken curry" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Weeknight chicken curry" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Picks" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(document.querySelector(".day-agenda")).not.toBeNull();
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
      const { user } = renderApp("/planner");

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
      // On a phone the meal's own figure is in its sheet, beside its servings.
      await user.click(within(wednesday).getByRole("button", { name: "Weeknight chicken curry" }));
      const sheet = await screen.findByRole("dialog", { name: "Wednesday dinner" });
      expect(
        within(sheet).getByRole("img", { name: "at least $6.20, 9 of 11 ingredients priced" }),
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

    /* Beside the title the menu took a third of a grid card's width from
       every line of it, so "Weeknight" broke mid-word and a ↻ was left on a
       line of its own. It shares the stepper's line there instead; with no
       stepper, a line of its own would be an empty one, so it keeps to the
       title's. */
    it("puts a grid meal's menu on its stepper's line, or its title's when it has no stepper", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ plan_date: "2026-07-30", recipe: curry }),
          plannedMeal({
            plan_date: "2026-07-31",
            recipe: recipeSummary({ id: 6, title: "Plain rice", servings: null }),
          }),
        ],
      });
      renderApp("/planner");

      const link = await screen.findByRole("link", { name: "Weeknight chicken curry" });
      expect(link.parentElement).not.toContainElement(
        screen.getByRole("button", { name: "Actions for Weeknight chicken curry" }),
      );
      expect(
        screen
          .getByRole("button", { name: "Actions for Weeknight chicken curry" })
          .closest(".plan-entry-meta"),
      ).toContainElement(screen.getByRole("button", { name: "More servings" }));

      const rice = screen.getByRole("link", { name: "Plain rice" });
      expect(rice.parentElement).toContainElement(
        screen.getByRole("button", { name: "Actions for Plain rice" }),
      );
      expect(rice.closest(".plan-entry")!.querySelector(".plan-entry-meta")).toBeNull();
    });

    /* The agenda's titles have the room the grid's do not, and a menu at the
       end of the stepper's line would hold the cost off the card's edge. */
    it("keeps an agenda meal's menu on its title's line", async () => {
      setViewportWidth(PHONE + 1);
      mockBackend({ "GET /api/meal-plan": [plannedMeal({ plan_date: "2026-07-30", recipe: curry })] });
      renderApp("/planner");

      const link = await screen.findByRole("link", { name: "Weeknight chicken curry" });
      expect(link.parentElement).toContainElement(
        screen.getByRole("button", { name: "Actions for Weeknight chicken curry" }),
      );
      expect(screen.getByRole("button", { name: "More servings" }).closest(".plan-entry-meta"))
        .not.toContainElement(
          screen.getByRole("button", { name: "Actions for Weeknight chicken curry" }),
        );
    });

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
      // Joined to the title's first word, so a narrow card never leaves the
      // ↻ alone on a line above it.
      expect(within(cell("dinner", 3)).getByLabelText("Repeats").nextSibling).toHaveTextContent(
        /^\u2060Weeknight chicken curry$/,
        { normalizeWhitespace: false },
      );

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

    describe("servings", () => {
      // The question waits for the taps to rest, which these tests decide
      // rather than wait on. Only the timeouts are faked, since React
      // schedules its work through setImmediate. Testing Library waits on a
      // timeout after every event and only moves a fake clock it recognises as
      // Jest's, so it is handed Vitest's under that name.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);
        vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
      });

      const settle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
      const question = () => screen.queryByRole("button", { name: "Just this day" });

      it("asks once after a burst of servings taps on a repeated meal", async () => {
        const backend = mockBackend({
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
          "PATCH /api/meal-plan/:id": undefined,
        });
        const { user } = renderApp("/planner");
        const more = await screen.findByRole("button", { name: "More servings" });

        await user.click(more);
        await settle(SETTLE_MS - 300);
        // A tap before the taps have rested starts the wait again.
        await user.click(more);
        await user.click(more);

        // Shown at once, saved only once the question is answered.
        expect(screen.getByText("×7")).toBeInTheDocument();
        await settle(SETTLE_MS - 1);
        expect(question()).not.toBeInTheDocument();
        await settle(1);
        expect(question()).toBeInTheDocument();
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
        expect(screen.getByRole("button", { name: "From Thu, Jul 30 on" })).toBeInTheDocument();

        await user.click(question()!);

        await waitFor(() =>
          expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(1),
        );
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")[0].body).toEqual({
          scope: "day",
          servings: 7,
          today: "2026-07-29",
        });
        expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
        expect(question()).not.toBeInTheDocument();
      });

      it("puts the count back when the servings question is cancelled", async () => {
        const backend = mockBackend({
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
        });
        const { user } = renderApp("/planner");

        await user.click(await screen.findByRole("button", { name: "More servings" }));
        expect(screen.getByText("×5")).toBeInTheDocument();
        await settle(SETTLE_MS);
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.getByText("×4")).toBeInTheDocument();
        expect(question()).not.toBeInTheDocument();
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
      });

      it("asks nothing when the taps end where they began", async () => {
        const backend = mockBackend({
          "GET /api/meal-plan": [repeatDay("2026-07-30")],
          "PATCH /api/meal-plan/repeats/:id/days/:day": undefined,
        });
        const { user } = renderApp("/planner");

        await user.click(await screen.findByRole("button", { name: "More servings" }));
        await user.click(screen.getByRole("button", { name: "Fewer servings" }));
        await settle(SETTLE_MS);

        expect(question()).not.toBeInTheDocument();
        expect(screen.getByText("×4")).toBeInTheDocument();
        expect(backend.requestsTo("PATCH /api/meal-plan/repeats/:id/days/:day")).toHaveLength(0);
      });
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

  describe("picks", () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
    const bread = recipeSummary({ id: 6, title: "Banana bread" });
    const pick = (recipe: RecipeSummary, week_start = "2026-07-27") => ({
      id: recipe.id + 100,
      week_start,
      recipe,
    });

    const panel = () => screen.getByRole("complementary", { name: "Picks" });
    const picks = () => within(panel()).getByRole("list", { name: "This week's picks" });

    it("adds a search result to this week's picks", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [],
        "GET /api/recipes": (req: MockRequest) =>
          page(req.searchParams.get("q") === "curry" ? [curry] : [bread]),
        "POST /api/meal-plan/picks": pick(curry),
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      // Typed and not entered: the typing searches on its own.
      await user.type(within(panel()).getByRole("combobox", { name: "Search recipes" }), "curry");
      await user.click(
        await within(panel()).findByRole("button", { name: "Add Weeknight chicken curry to picks" }),
      );

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan/picks")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan/picks")[0].body).toEqual({
        week_start: "2026-07-27",
        recipe_id: 5,
      });
      expect(await within(picks()).findByText("Weeknight chicken curry")).toBeVisible();
      expect(backend.requestsTo("GET /api/recipes").at(-1)!.searchParams.get("per_page")).toBe("8");
    });

    it("places a pick by pressing it and then a cell", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [pick(curry)],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      const { user } = renderApp("/planner");

      await user.click(await within(panel()).findByRole("button", { name: /^Weeknight chicken curry/ }));
      expect(document.querySelectorAll(".plan-cell.drop-target")).toHaveLength(28);
      await user.click(
        screen.getByRole("button", { name: "Place Weeknight chicken curry on Wed dinner" }),
      );

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-29",
        meal: "dinner",
        recipe_id: 5,
      });
      await waitFor(() => expect(document.querySelector(".drop-target")).toBeNull());
    });

    /* The cell's target lies over its meals, so a press cannot reach them;
       Tab must not either, or it would walk through links and menus a press
       cannot touch before reaching the next target. */
    it("takes the meals under the targets out of reach while placing", async () => {
      const style = document.createElement("style");
      style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
      document.head.append(style);
      try {
        mockBackend({
          "GET /api/meal-plan": [plannedMeal({ plan_date: "2026-07-29", recipe: bread })],
          "GET /api/meal-plan/picks": [pick(curry)],
        });
        const { user } = renderApp("/planner");
        const meal = (await screen.findByRole("link", { name: "Banana bread" })).closest(
          ".plan-entry",
        )!;
        const add = within(cell("dinner", 2)).getByRole("button", { name: "+ Add" });
        expect(meal).not.toHaveAttribute("inert");
        expect(getComputedStyle(add).visibility).not.toBe("hidden");

        await user.click(within(picks()).getByRole("button", { name: /^Weeknight chicken curry/ }));
        expect(meal).toHaveAttribute("inert");
        // Hidden rather than gone, so the cell keeps its size.
        expect(getComputedStyle(add).visibility).toBe("hidden");
        expect(add).not.toHaveAttribute("style");

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(meal).not.toHaveAttribute("inert");
        expect(getComputedStyle(add).visibility).not.toBe("hidden");
      } finally {
        style.remove();
      }
    });

    it("places a pick with the selected label", async () => {
      const backend = mockBackend({
        "GET /api/labels": [{ id: 2, name: "Kids", meals: 0 }],
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [pick(curry)],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      const { user } = renderApp("/planner?label=2");

      await user.click(await within(panel()).findByRole("button", { name: /^Weeknight chicken curry/ }));
      await user.click(
        screen.getByRole("button", { name: "Place Weeknight chicken curry on Fri lunch" }),
      );

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-31",
        meal: "lunch",
        recipe_id: 5,
        label_ids: [2],
      });
    });

    it("makes the whole cell the target, over the meals already in it", async () => {
      mockBackend({
        "GET /api/meal-plan": [plannedMeal({ plan_date: "2026-07-29", recipe: bread })],
        "GET /api/meal-plan/picks": [pick(curry)],
      });
      const { user } = renderApp("/planner");
      await screen.findByRole("link", { name: "Banana bread" });

      await user.click(within(panel()).getByRole("button", { name: /^Weeknight chicken curry/ }));

      // The meal is still shown, and only the cell answers a press.
      const wed = cell("dinner", 2);
      expect(within(wed).getByText("Banana bread")).toBeVisible();
      expect(
        within(wed).getByRole("button", { name: "Place Weeknight chicken curry on Wed dinner" }),
      ).toBeVisible();
    });

    it("fades a pick once it is on the plan and names its days", async () => {
      mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ plan_date: "2026-07-31", meal: "dinner", recipe: curry }),
          plannedMeal({ plan_date: "2026-07-29", meal: "lunch", recipe: curry }),
          plannedMeal({ plan_date: "2026-07-29", meal: "dinner", recipe: curry }),
        ],
        "GET /api/meal-plan/picks": [pick(curry), pick(bread)],
      });
      renderApp("/planner");

      const placed = (await within(picks()).findByText("Weeknight chicken curry")).closest("li")!;
      await waitFor(() => expect(placed).toHaveClass("placed"));
      expect(placed).toHaveTextContent("Wed, Fri");
      const left = within(picks()).getByText("Banana bread").closest("li")!;
      expect(left).not.toHaveClass("placed");
    });

    it("cancels placing with Escape", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [pick(curry)],
      });
      const { user } = renderApp("/planner");

      const choose = await within(panel()).findByRole("button", { name: /^Weeknight chicken curry/ });
      await user.click(choose);
      expect(choose).toHaveAttribute("aria-pressed", "true");
      await user.keyboard("{Escape}");
      expect(choose).toHaveAttribute("aria-pressed", "false");
      expect(document.querySelector(".drop-target")).toBeNull();

      // Pressing the pick again is the other way out.
      await user.click(choose);
      expect(document.querySelectorAll(".drop-target")).toHaveLength(28);
      await user.click(choose);
      expect(document.querySelector(".drop-target")).toBeNull();
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(0);
    });

    it("keeps picks per week", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": (req: MockRequest) =>
          req.searchParams.get("week") === "2026-07-27"
            ? [pick(curry)]
            : [pick(bread, "2026-08-03")],
      });
      const { user } = renderApp("/planner");
      expect(await within(picks()).findByText("Weeknight chicken curry")).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Next week" }));

      expect(await within(picks()).findByText("Banana bread")).toBeVisible();
      expect(within(picks()).queryByText("Weeknight chicken curry")).not.toBeInTheDocument();
      expect(backend.requestsTo("GET /api/meal-plan/picks").at(-1)!.searchParams.get("week")).toBe(
        "2026-08-03",
      );
    });

    it("collapses the panel where it and the grid do not both fit", async () => {
      setViewportWidth(WEEK_GRID + PICKS_PANEL);
      mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [pick(curry)],
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      const toggle = screen.getByRole("button", { name: "Picks" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("complementary", { name: "Picks" })).not.toBeInTheDocument();
      expect(document.querySelector(".week-grid")).not.toBeNull();

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await within(picks()).findByText("Weeknight chicken curry")).toBeVisible();

      // Choosing a pick puts the panel away, so the whole grid can be chosen from.
      await user.click(within(panel()).getByRole("button", { name: /^Weeknight chicken curry/ }));
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.getByRole("button", { name: "Place Weeknight chicken curry on Mon breakfast" }),
      ).toBeVisible();
    });

    it("shows the panel beside the grid where both fit", async () => {
      setViewportWidth(WEEK_GRID + PICKS_PANEL + 1);
      mockBackend({ "GET /api/meal-plan": [], "GET /api/meal-plan/picks": [] });
      renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      expect(panel()).toBeVisible();
      expect(screen.queryByRole("button", { name: "Picks" })).not.toBeInTheDocument();
    });

    it("keeps picks within reach over a tablet's agenda", async () => {
      setViewportWidth(PHONE + 1);
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [pick(curry)],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await user.click(screen.getByRole("button", { name: "Picks" }));
      await user.click(await within(panel()).findByRole("button", { name: /^Weeknight chicken curry/ }));
      await user.click(
        screen.getByRole("button", { name: "Place Weeknight chicken curry on Thu snack" }),
      );

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toMatchObject({
        plan_date: "2026-07-30",
        meal: "snack",
      });
    });

    it("finds recipes in the + Add picker with the Recipes page search box", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/recipes": (req: MockRequest) =>
          page(req.searchParams.get("q") === "banana" ? [bread] : [curry, bread]),
        "POST /api/meal-plan": plannedMeal({ recipe: bread }),
      });
      const { user } = renderApp("/planner");
      await screen.findByText("Jul 27 – Aug 2, 2026");

      await user.click(within(cell("lunch", 1)).getByRole("button", { name: "+ Add" }));
      const dialog = await screen.findByRole("dialog", { name: "Add to lunch" });
      await user.type(within(dialog).getByRole("combobox", { name: "Search recipes" }), "banana");
      await waitFor(() =>
        expect(
          within(dialog).queryByRole("button", { name: /Weeknight chicken curry/ }),
        ).not.toBeInTheDocument(),
      );
      await user.click(within(dialog).getByRole("button", { name: /Banana bread/ }));

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-28",
        meal: "lunch",
        recipe_id: 6,
      });
    });
  });
  /*
   * Every drag has a press and a key equivalent: a meal's menu starts moving
   * or copying it, and the cells are then the targets, as for a pick.
   */
  describe("moving and copying a meal from its menu", () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry", servings: 4 });
    const bread = recipeSummary({ id: 6, title: "Banana bread" });
    const kids = { id: 2, name: "Kids" };

    it("moves a one-off meal to the cell pressed after Move to…", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-29", meal: "dinner", recipe: bread }),
        ],
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3 }),
      });
      const { user } = renderApp("/planner");

      await user.click(await screen.findByRole("button", { name: "Actions for Banana bread" }));
      await user.click(screen.getByRole("menuitem", { name: "Move to…" }));

      expect(screen.getByRole("status")).toHaveTextContent(
        "Choose a day and meal for Banana bread",
      );
      // Every cell but the meal's own, which is no place to move it to.
      expect(document.querySelectorAll(".drop-target")).toHaveLength(27);
      expect(within(cell("dinner", 2)).queryByRole("button", { name: /^Move/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Move Banana bread on Fri lunch" }));

      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      const [request] = backend.requestsTo("PATCH /api/meal-plan/:id");
      expect(request.params.id).toBe("3");
      expect(request.body).toEqual({ plan_date: "2026-07-31", meal: "lunch" });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
    });

    it("moves and copies a repeated meal's day with the keyboard alone", async () => {
      const repeat = { id: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], starts_on: "2026-07-20", ends_on: null };
      const backend = mockBackend({
        "GET /api/labels": [{ ...kids, meals: 1 }],
        "GET /api/meal-plan": [
          plannedMeal({
            entry_id: null,
            key: "r1-2026-07-30",
            plan_date: "2026-07-30",
            recipe: curry,
            repeat,
            servings: 2,
            labels: [kids],
          }),
        ],
        "POST /api/meal-plan/repeats/:id/days/:day/move": plannedMeal({ recipe: curry }),
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      const { user } = renderApp("/planner");
      const actions = await screen.findByRole("button", {
        name: "Actions for Weeknight chicken curry",
      });

      /** Tabs on from wherever focus is to the button named `name`. */
      async function tabTo(name: string) {
        for (let i = 0; i < 40 && document.activeElement?.getAttribute("aria-label") !== name; i++) {
          await user.tab();
        }
        expect(document.activeElement).toHaveAccessibleName(name);
      }

      // Copy to…: the menu's fourth item.
      actions.focus();
      await user.keyboard("{Enter}");
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Copy to…" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(actions).toHaveFocus();
      await tabTo("Copy Weeknight chicken curry on Sat dinner");
      await user.keyboard("{Enter}");

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      // A one-off, with the meal's own servings and labels.
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-08-01",
        meal: "dinner",
        recipe_id: 5,
        servings: 2,
        label_ids: [2],
      });
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));

      // Move to…, and Escape lets go of it before anything is written.
      actions.focus();
      await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");
      expect(screen.getByRole("status")).toHaveTextContent("Weeknight chicken curry");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(document.querySelector(".drop-target")).toBeNull();

      actions.focus();
      await user.keyboard("{Enter}{ArrowDown}{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Move to…" })).toHaveFocus();
      await user.keyboard("{Enter}");
      await tabTo("Move Weeknight chicken curry on Sun dinner");
      await user.keyboard("{Enter}");

      const moves = () => backend.requestsTo("POST /api/meal-plan/repeats/:id/days/:day/move");
      await waitFor(() => expect(moves()).toHaveLength(1));
      // That day alone, through its repeat: nothing to ask.
      expect(moves()[0].params).toEqual({ id: "1", day: "2026-07-30" });
      expect(moves()[0].body).toEqual({ plan_date: "2026-08-02", meal: "dinner" });
      expect(screen.queryByRole("button", { name: "Just this day" })).not.toBeInTheDocument();
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1);
    });
  });

  describe("drag and drop", () => {
    const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry", servings: 4 });
    const bread = recipeSummary({ id: 6, title: "Banana bread" });
    const kids = { id: 2, name: "Kids" };
    const dad = { id: 3, name: "Dad" };

    /**
     * A stand-in for the drag's DataTransfer, which jsdom does not have. One
     * drag's, shared by its events as a browser shares it: what the drag's
     * start puts in is in its types from then on.
     */
    function dataTransfer(data = new Map<string, string>()) {
      return {
        dropEffect: "none",
        effectAllowed: "all",
        get types() {
          return [...data.keys()];
        },
        setData: (type: string, value: string) => void data.set(type, value),
        getData: (type: string) => data.get(type) ?? "",
      };
    }

    /** What a planner drag carries, for a drop with no drag of its own under way. */
    const plannerDrag = () => dataTransfer(new Map([[PLACING_TYPE, "recipe"]]));

    /** The draggable thing a title is shown in: a pick's row, or a meal. */
    const draggable = (title: HTMLElement) => title.closest<HTMLElement>("[draggable=true]")!;

    /**
     * Drags `source` over `target` and lets go there, the events a browser
     * sends in the order it sends them, with Alt held over the target or
     * not. Answers whether the target lit up while it was hovered, and the
     * drop the browser was told to show there: "none" where a drop does
     * nothing.
     */
    function drag(source: HTMLElement, target: HTMLElement, { altKey = false } = {}) {
      const dt = dataTransfer();
      fireEvent.dragStart(source, { dataTransfer: dt });
      fireEvent.dragEnter(target, { dataTransfer: dt, altKey });
      fireEvent.dragOver(target, { dataTransfer: dt, altKey });
      const hovered = { highlighted: target.classList.contains("drop-over"), effect: dt.dropEffect };
      fireEvent.drop(target, { dataTransfer: dt, altKey });
      fireEvent.dragEnd(source, { dataTransfer: dt });
      return hovered;
    }

    it("plans a pick dropped on a cell", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      renderApp("/planner");
      const picks = await screen.findByRole("list", { name: "This week's picks" });
      const title = await within(picks).findByText("Weeknight chicken curry");

      const hovered = drag(draggable(title), cell("dinner", 2));

      expect(hovered).toEqual({ highlighted: true, effect: "copy" });
      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-29",
        meal: "dinner",
        recipe_id: 5,
      });
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
      expect(document.querySelector(".drop-over")).toBeNull();
    });

    it("plans a search result dropped on a cell, with the selected label", async () => {
      const backend = mockBackend({
        "GET /api/labels": [{ ...kids, meals: 0 }],
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [],
        "GET /api/recipes": page([bread]),
        "POST /api/meal-plan": plannedMeal({ recipe: bread }),
      });
      const { user } = renderApp("/planner?label=2");
      const panel = screen.getByRole("complementary", { name: "Picks" });
      await user.type(within(panel).getByRole("combobox", { name: "Search recipes" }), "banana");
      const results = await within(panel).findByRole("list", { name: "Search results" });

      drag(draggable(within(results).getByText("Banana bread")), cell("lunch", 0));

      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-27",
        meal: "lunch",
        recipe_id: 6,
        label_ids: [2],
      });
    });

    it("moves a one-off meal to the cell it is dropped on", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-29", meal: "dinner", recipe: bread }),
        ],
        "PATCH /api/meal-plan/:id": plannedMeal({
          entry_id: 3,
          plan_date: "2026-07-31",
          meal: "lunch",
        }),
      });
      renderApp("/planner");

      const hovered = drag(draggable(await screen.findByText("Banana bread")), cell("lunch", 4));

      expect(hovered).toEqual({ highlighted: true, effect: "move" });
      await waitFor(() => expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(1));
      const [request] = backend.requestsTo("PATCH /api/meal-plan/:id");
      expect(request.params.id).toBe("3");
      expect(request.body).toEqual({ plan_date: "2026-07-31", meal: "lunch" });
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(0);
      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
    });

    it("copies a meal dropped with Alt held, with its own servings and labels", async () => {
      // The meal's labels, not the filter's: a copy is the same meal again.
      const backend = mockBackend({
        "GET /api/labels": [
          { ...kids, meals: 1 },
          { ...dad, meals: 1 },
        ],
        "GET /api/meal-plan": [
          plannedMeal({
            entry_id: 3,
            plan_date: "2026-07-29",
            meal: "dinner",
            recipe: curry,
            servings: 2,
            labels: [kids, dad],
          }),
        ],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3 }),
      });
      renderApp("/planner?label=2");

      const title = await screen.findByText("Weeknight chicken curry");
      const hovered = drag(draggable(title), cell("dinner", 3), { altKey: true });

      expect(hovered.effect).toBe("copy");
      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-07-30",
        meal: "dinner",
        recipe_id: 5,
        servings: 2,
        label_ids: [2, 3],
      });
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
    });

    it("moves only the dragged day of a repeated meal, and copies one as a one-off", async () => {
      const repeat = {
        id: 1,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        starts_on: "2026-07-20",
        ends_on: null,
      };
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({
            entry_id: null,
            key: "r1-2026-07-30",
            plan_date: "2026-07-30",
            recipe: curry,
            repeat,
          }),
          // A day changed on its own has a row, and is still the repeat's.
          plannedMeal({
            entry_id: 8,
            key: "e8",
            plan_date: "2026-07-31",
            recipe: curry,
            repeat,
            servings: 2,
          }),
        ],
        "POST /api/meal-plan/repeats/:id/days/:day/move": plannedMeal({ recipe: curry }),
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 8 }),
      });
      renderApp("/planner");
      await screen.findAllByText("Weeknight chicken curry");
      const meal = (dayIndex: number) =>
        draggable(within(cell("dinner", dayIndex)).getByText("Weeknight chicken curry"));
      const moves = () => backend.requestsTo("POST /api/meal-plan/repeats/:id/days/:day/move");

      expect(drag(meal(3), cell("lunch", 5)).effect).toBe("move");
      await waitFor(() => expect(moves()).toHaveLength(1));
      expect(moves()[0].params).toEqual({ id: "1", day: "2026-07-30" });
      expect(moves()[0].body).toEqual({ plan_date: "2026-08-01", meal: "lunch" });
      // Moving a day is that day alone: nothing to ask.
      expect(screen.queryByRole("button", { name: "Just this day" })).not.toBeInTheDocument();

      await waitFor(() => expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(2));
      drag(meal(4), cell("lunch", 6));
      await waitFor(() => expect(moves()).toHaveLength(2));
      expect(moves()[1].params).toEqual({ id: "1", day: "2026-07-31" });
      expect(moves()[1].body).toEqual({ plan_date: "2026-08-02", meal: "lunch" });

      drag(meal(4), cell("dinner", 6), { altKey: true });
      await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/meal-plan")[0].body).toEqual({
        plan_date: "2026-08-02",
        meal: "dinner",
        recipe_id: 5,
        servings: 2,
      });
      expect(moves()).toHaveLength(2);
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
    });

    it("does nothing for a drop on the meal's own cell or outside the grid", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [
          plannedMeal({ entry_id: 3, plan_date: "2026-07-29", meal: "dinner", recipe: bread }),
        ],
        "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
        "PATCH /api/meal-plan/:id": plannedMeal({ entry_id: 3 }),
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      renderApp("/planner");
      const meal = draggable(await screen.findByText("Banana bread"));
      const picks = screen.getByRole("list", { name: "This week's picks" });
      const pick = draggable(await within(picks).findByText("Weeknight chicken curry"));
      const outside = screen.getByRole("heading", { name: "Planner" });
      const nowhere = { highlighted: false, effect: "none" };

      // Its own cell is no target at all, with Alt held or not.
      expect(drag(meal, cell("dinner", 2))).toEqual(nowhere);
      expect(drag(meal, cell("dinner", 2), { altKey: true })).toEqual(nowhere);
      expect(drag(meal, outside)).toEqual(nowhere);
      expect(drag(pick, outside)).toEqual(nowhere);
      // Nor does a field, which would otherwise take the title as text.
      const search = screen.getByRole("combobox", { name: "Search recipes" });
      const dt = dataTransfer();
      fireEvent.dragStart(pick, { dataTransfer: dt });
      expect(fireEvent.dragOver(search, { dataTransfer: dt })).toBe(false);
      expect(dt.dropEffect).toBe("none");
      fireEvent.dragEnd(pick, { dataTransfer: dt });
      // Nor does a drop with nothing being dragged, after a drag has ended.
      fireEvent.drop(cell("lunch", 0), { dataTransfer: plannerDrag() });

      await act(async () => {});
      expect(backend.requestsTo("PATCH /api/meal-plan/:id")).toHaveLength(0);
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(0);
      expect(backend.requestsTo("GET /api/meal-plan")).toHaveLength(1);
      expect(within(cell("dinner", 2)).getByText("Banana bread")).toBeVisible();
      expect(document.querySelector(".drop-over")).toBeNull();
    });

    it("picks a meal up from anywhere but its menu", async () => {
      // A field in the menu inside a draggable card could not have its text
      // selected: the browser would drag the card instead.
      mockBackend({
        "GET /api/labels": [{ ...kids, meals: 0 }],
        "GET /api/meal-plan": [plannedMeal({ plan_date: "2026-07-29", recipe: bread })],
      });
      const { user } = renderApp("/planner");
      const card = draggable(await screen.findByText("Banana bread"));
      await user.click(screen.getByRole("button", { name: "Actions for Banana bread" }));
      await user.click(screen.getByRole("menuitem", { name: /^Labels/ }));

      fireEvent.pointerDown(screen.getByPlaceholderText(/New label/));
      expect(card).toHaveAttribute("draggable", "false");
      fireEvent.pointerDown(screen.getByRole("link", { name: "Banana bread" }));
      expect(card).toHaveAttribute("draggable", "true");
    });

    it("puts the opened panel away once a pick is picked up, so every cell can be reached", async () => {
      setViewportWidth(WEEK_GRID + PICKS_PANEL);
      mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
      });
      const { user } = renderApp("/planner");
      const toggle = await screen.findByRole("button", { name: "Picks" });
      await user.click(toggle);
      const picks = screen.getByRole("list", { name: "This week's picks" });
      const pick = draggable(await within(picks).findByText("Weeknight chicken curry"));

      fireEvent.dragStart(pick, { dataTransfer: dataTransfer() });

      await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
    });

    it("ends a drag whose row went away while it was dragged, at the pointer's next move", async () => {
      // A browser may never tell a row no longer in the page that its drag
      // ended, so no dragend here: the pointer moving again, once the drag's
      // own events have stopped, is the backstop.
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [],
        "GET /api/recipes": (req: MockRequest) =>
          page(req.searchParams.get("q") === "banana" ? [bread] : [curry]),
        "POST /api/meal-plan": plannedMeal({ recipe: bread }),
      });
      const { user } = renderApp("/planner");
      const panel = screen.getByRole("complementary", { name: "Picks" });
      await user.type(within(panel).getByRole("combobox", { name: "Search recipes" }), "banana");
      const results = await within(panel).findByRole("list", { name: "Search results" });
      const row = draggable(await within(results).findByText("Banana bread"));
      const body = document.querySelector(".planner-body")!;

      const dt = dataTransfer();
      fireEvent.dragStart(row, { dataTransfer: dt });
      // Keys only, so the pointer stays where it was: the box still has focus.
      await user.keyboard("{Backspace>6/}curry");
      await waitFor(() => expect(row).not.toBeInTheDocument());
      expect(body).toHaveClass("dragging");

      // A pointer event while the drag's own events still come is not its
      // end: a browser may send one as a drag starts.
      vi.setSystemTime(NOW.getTime() + DRAG_QUIET_MS);
      fireEvent.dragOver(cell("dinner", 0), { dataTransfer: dt });
      fireEvent.pointerMove(body);
      expect(body).toHaveClass("dragging");

      // Once they have stopped, it is.
      vi.setSystemTime(NOW.getTime() + 2 * DRAG_QUIET_MS + 1);
      fireEvent.pointerMove(body);

      expect(body).not.toHaveClass("dragging");
      fireEvent.drop(cell("lunch", 0), { dataTransfer: plannerDrag() });
      await act(async () => {});
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(0);
    });

    it("ignores a file or text dragged in from elsewhere, even mid-drag", async () => {
      const backend = mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
        "POST /api/meal-plan": plannedMeal({ recipe: curry }),
      });
      renderApp("/planner");
      const picks = await screen.findByRole("list", { name: "This week's picks" });
      const pick = draggable(await within(picks).findByText("Weeknight chicken curry"));

      fireEvent.dragStart(pick, { dataTransfer: dataTransfer() });
      const target = cell("dinner", 2);
      for (const types of [["Files"], ["text/plain"]]) {
        const foreign = { ...dataTransfer(), types };
        expect(fireEvent.dragOver(target, { dataTransfer: foreign })).toBe(true);
        expect(target).not.toHaveClass("drop-over");
        fireEvent.drop(target, { dataTransfer: foreign });
      }

      await act(async () => {});
      expect(backend.requestsTo("POST /api/meal-plan")).toHaveLength(0);
    });

    it("lets go of a pick chosen to place when a drag starts", async () => {
      mockBackend({
        "GET /api/meal-plan": [],
        "GET /api/meal-plan/picks": [{ id: 105, week_start: "2026-07-27", recipe: curry }],
      });
      const { user } = renderApp("/planner");
      const picks = await screen.findByRole("list", { name: "This week's picks" });
      const title = await within(picks).findByText("Weeknight chicken curry");

      await user.click(title);
      expect(document.querySelectorAll(".drop-target")).toHaveLength(28);
      fireEvent.dragStart(draggable(title), { dataTransfer: dataTransfer() });

      expect(document.querySelector(".drop-target")).toBeNull();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});
