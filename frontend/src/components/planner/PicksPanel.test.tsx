import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlannedMeal } from "../../api";
import { HttpError, mockBackend } from "../../test/backend";
import { page, plannedMeal, recipeSummary } from "../../test/fixtures";
import { renderInRouter } from "../../test/render";
import { PicksPanel } from "./PicksPanel";
import { PLACING_TYPE, placedDays, type Placing } from "./placing";

const curry = recipeSummary({ id: 5, title: "Weeknight chicken curry" });
const bread = recipeSummary({ id: 6, title: "Banana bread" });
const WEEK = "2026-07-27";
const pick = (recipe = curry) => ({ id: recipe.id + 100, week_start: WEEK, recipe });

/** The panel with the page's half of placing: it holds what the panel asks for. */
function renderPanel({ meals = [] }: { meals?: PlannedMeal[] } = {}) {
  const onPlacing = vi.fn();
  const onDrag = vi.fn();
  function Page() {
    const [placing, setPlacing] = useState<Placing | null>(null);
    return (
      <PicksPanel
        week={WEEK}
        meals={meals}
        placing={placing}
        onPlacing={(next) => {
          onPlacing(next);
          setPlacing(next);
        }}
        onDrag={onDrag}
      />
    );
  }
  const rendered = renderInRouter(<Page />);
  return { ...rendered, onPlacing, onDrag };
}

const picks = () => screen.getByRole("list", { name: "This week's picks" });
const searchBox = () => screen.getByRole("combobox", { name: "Search recipes" });

afterEach(() => vi.restoreAllMocks());

describe("PicksPanel", () => {
  it("asks for no recipes until there is a search", async () => {
    const backend = mockBackend({ "GET /api/meal-plan/picks": [pick()] });
    renderPanel();

    expect(await within(picks()).findByText("Weeknight chicken curry")).toBeVisible();
    expect(backend.requestsTo("GET /api/recipes")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
  });

  it("says how to start when the week has no picks", async () => {
    mockBackend({ "GET /api/meal-plan/picks": [] });
    renderPanel();

    expect(await screen.findByText(/Search for a recipe and press \+/)).toBeVisible();
  });

  it("marks a result already picked instead of offering it again", async () => {
    mockBackend({
      "GET /api/meal-plan/picks": [pick(curry)],
      "GET /api/recipes": page([curry, bread]),
    });
    const { user } = renderPanel();
    await within(picks()).findByText("Weeknight chicken curry");

    await user.type(searchBox(), "b");
    const results = await screen.findByRole("list", { name: "Search results" });

    expect(
      await within(results).findByRole("button", { name: "Add Banana bread to picks" }),
    ).toBeVisible();
    expect(
      within(results).queryByRole("button", { name: "Add Weeknight chicken curry to picks" }),
    ).not.toBeInTheDocument();
    expect(within(results).getByTitle("In this week's picks")).toBeVisible();
  });

  it("removes a pick without touching the plan", async () => {
    const backend = mockBackend({
      "GET /api/meal-plan/picks": [pick(curry), pick(bread)],
      "DELETE /api/meal-plan/picks/:id": undefined,
    });
    const { user } = renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Remove Weeknight chicken curry from picks" }),
    );

    await waitFor(() =>
      expect(within(picks()).queryByText("Weeknight chicken curry")).not.toBeInTheDocument(),
    );
    expect(within(picks()).getByText("Banana bread")).toBeVisible();
    expect(backend.requestsTo("DELETE /api/meal-plan/picks/:id")[0].params.id).toBe("105");
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/meal-plan/picks",
      "DELETE /api/meal-plan/picks/105",
    ]);
  });

  it("says so when a pick could not be added", async () => {
    mockBackend({
      "GET /api/meal-plan/picks": [],
      "GET /api/recipes": page([bread]),
      "POST /api/meal-plan/picks": new HttpError(500, "The server is down."),
    });
    const { user } = renderPanel();
    await screen.findByText(/Search for a recipe/);

    await user.type(searchBox(), "bread");
    await user.click(await screen.findByRole("button", { name: "Add Banana bread to picks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The server is down.");
  });

  it("presses a pick or a result to place it, and again to stop", async () => {
    mockBackend({
      "GET /api/meal-plan/picks": [pick(curry)],
      "GET /api/recipes": page([bread]),
    });
    const { user, onPlacing } = renderPanel();

    const chosen = await within(picks()).findByRole("button", { name: /^Weeknight chicken curry/ });
    await user.click(chosen);
    expect(onPlacing).toHaveBeenLastCalledWith({ kind: "recipe", recipe: curry });
    expect(chosen).toHaveAttribute("aria-pressed", "true");

    await user.type(searchBox(), "bread");
    const results = await screen.findByRole("list", { name: "Search results" });
    await user.click(await within(results).findByRole("button", { name: /^Banana bread/ }));
    expect(onPlacing).toHaveBeenLastCalledWith({ kind: "recipe", recipe: bread });
    expect(chosen).toHaveAttribute("aria-pressed", "false");

    await user.click(within(results).getByRole("button", { name: /^Banana bread/ }));
    expect(onPlacing).toHaveBeenLastCalledWith(null);
  });

  it("drags a pick or a result whole, giving the browser its title and the planner's mark", async () => {
    mockBackend({
      "GET /api/meal-plan/picks": [pick(curry)],
      "GET /api/recipes": page([bread]),
    });
    const { user, onDrag } = renderPanel();
    const dataTransfer = { effectAllowed: "all", setData: vi.fn() };

    const row = (await within(picks()).findByText("Weeknight chicken curry")).closest("li")!;
    expect(row).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(row, { dataTransfer });
    expect(onDrag).toHaveBeenLastCalledWith({ kind: "recipe", recipe: curry });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "Weeknight chicken curry");
    expect(dataTransfer.setData).toHaveBeenCalledWith(PLACING_TYPE, "recipe");
    expect(dataTransfer.effectAllowed).toBe("copy");
    fireEvent.dragEnd(row, { dataTransfer });
    expect(onDrag).toHaveBeenLastCalledWith(null);

    await user.type(searchBox(), "bread");
    const results = await screen.findByRole("list", { name: "Search results" });
    fireEvent.dragStart(within(results).getByText("Banana bread").closest("li")!, { dataTransfer });
    expect(onDrag).toHaveBeenLastCalledWith({ kind: "recipe", recipe: bread });
  });

  it("picks a recipe chosen from the suggestions, rather than leaving the planner", async () => {
    const backend = mockBackend({
      "GET /api/meal-plan/picks": [],
      "GET /api/recipes": page([curry]),
      "GET /api/recipes/suggest": { ingredients: [], tags: [], recipes: [{ id: 5, title: curry.title }] },
      "POST /api/meal-plan/picks": pick(),
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { user } = renderPanel();

    await user.type(searchBox(), "curry");
    await user.click(await screen.findByRole("option", { name: "Weeknight chicken curry" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/meal-plan/picks")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/meal-plan/picks")[0].body).toEqual({
      week_start: WEEK,
      recipe_id: 5,
    });
    expect(await within(picks()).findByText("Weeknight chicken curry")).toBeVisible();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("placedDays", () => {
  it("names each day a recipe is on once, in week order", () => {
    const meals = [
      plannedMeal({ plan_date: "2026-08-02", recipe: curry }),
      plannedMeal({ plan_date: "2026-07-28", recipe: curry, meal: "lunch" }),
      plannedMeal({ plan_date: "2026-07-28", recipe: curry }),
      plannedMeal({ plan_date: "2026-07-29", recipe: bread }),
    ];

    expect(placedDays(curry.id, meals)).toEqual(["Tue", "Sun"]);
    expect(placedDays(99, meals)).toEqual([]);
  });
});
