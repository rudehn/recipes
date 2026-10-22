/**
 * What the planned week costs, by day, by meal and in all.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, planCost, recipeSummary } from "../test/fixtures";
import { cell, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

onWednesday();

describe("PlannerPage", () => {
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
});
