/**
 * Repeating meals: making one, and changing it for a day or from a day on.
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SETTLE_MS } from "../components/planner/usePlannedServings";
import { PHONE } from "../layout";
import { mockBackend } from "../test/backend";
import { plannedMeal, recipeSummary } from "../test/fixtures";
import { NOW, cell, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

onWednesday();

describe("PlannerPage", () => {
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
});
