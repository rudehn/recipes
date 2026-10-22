/**
 * Labels on planned meals, and the label filter.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, planCost, recipeSummary } from "../test/fixtures";
import { cell, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";

onWednesday();

describe("PlannerPage", () => {
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
});
