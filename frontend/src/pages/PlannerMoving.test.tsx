/**
 * Moving and copying meals: by a drag, and by a meal's menu, which is the
 * drag's equivalent for a press and the keyboard.
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DRAG_QUIET_MS, PLACING_TYPE } from "../components/planner/placing";
import { PICKS_PANEL, WEEK_GRID } from "../layout";
import { mockBackend, type MockRequest } from "../test/backend";
import { plannedMeal, page, recipeSummary } from "../test/fixtures";
import { NOW, cell, onWednesday } from "../test/planner";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

onWednesday();

describe("PlannerPage", () => {
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
