/**
 * The planner below the width its week grid needs: a day at a time, and on a
 * phone, sheets for a meal's controls and for the week's picks.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PHONE, WEEK_GRID } from "../layout";
import { HttpError, mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, planCost, recipeSummary } from "../test/fixtures";
import { MEAL_ORDER, loadedRange, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

onWednesday();

describe("PlannerPage", () => {
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
});
