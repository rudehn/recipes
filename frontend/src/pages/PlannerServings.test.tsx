/**
 * A planned meal's servings, stepped in its cell.
 */

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, recipeSummary } from "../test/fixtures";
import { onWednesday } from "../test/planner";
import { renderApp } from "../test/render";

onWednesday();

describe("PlannerPage", () => {
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
});
