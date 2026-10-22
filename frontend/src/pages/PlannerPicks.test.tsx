/**
 * The week's picks beside the planner, and placing them with a press.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RecipeSummary } from "../api";
import { PHONE, PICKS_PANEL, WEEK_GRID } from "../layout";
import { mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, recipeSummary } from "../test/fixtures";
import { cell, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

onWednesday();

describe("PlannerPage", () => {
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
});
