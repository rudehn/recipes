import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HttpError,
  mockBackend,
  type MockBackend,
  type MockRequest,
} from "../test/backend";
import { groceryItem, groceryList } from "../test/fixtures";
import { renderApp } from "../test/render";

// A Wednesday, so the default range is Mon 27 Jul - Sun 2 Aug 2026.
const NOW = new Date(2026, 6, 29, 12, 0);

const WEEK = "/groceries?start=2026-07-27&end=2026-08-02";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function loadedRange(backend: MockBackend): [string, string] {
  const last = backend.requestsTo("GET /api/grocery-list").at(-1)!;
  return [last.searchParams.get("start")!, last.searchParams.get("end")!];
}

/** The row for an item, as a shopper sees it: checkbox, name, amounts. */
function row(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>(".grocery-item")!;
}

describe("GroceryPage", () => {
  it("defaults to the current week", async () => {
    const backend = mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp("/groceries");

    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1));
    expect(loadedRange(backend)).toEqual(["2026-07-27", "2026-08-02"]);
    expect(screen.getByText("7 days of meals")).toBeInTheDocument();
  });

  it("uses the range handed over from the planner", async () => {
    const backend = mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp("/groceries?start=2026-08-03&end=2026-08-05");

    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1));
    expect(loadedRange(backend)).toEqual(["2026-08-03", "2026-08-05"]);
    expect(screen.getByText("3 days of meals")).toBeInTheDocument();
  });

  it("counts a single-day range in the singular", async () => {
    mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp("/groceries?start=2026-08-03&end=2026-08-03");

    expect(await screen.findByText("1 day of meals")).toBeInTheDocument();
  });

  it("reloads when the shopper changes the date range", async () => {
    const backend = mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp(WEEK);
    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1));

    // A native date picker sets the value outright rather than typing into it.
    fireEvent.change(screen.getByLabelText(/from/i), { target: { value: "2026-07-29" } });
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-07-29", "2026-08-02"]));

    fireEvent.change(screen.getByLabelText(/to/i), { target: { value: "2026-07-31" } });
    await waitFor(() => expect(loadedRange(backend)).toEqual(["2026-07-29", "2026-07-31"]));
  });

  it("ignores a half-cleared range instead of asking for an open-ended one", async () => {
    const backend = mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp(WEEK);
    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1));

    fireEvent.change(screen.getByLabelText(/from/i), { target: { value: "" } });

    expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1);
    expect(screen.getByLabelText(/from/i)).toHaveValue("2026-07-27");
  });

  it("lists what to buy with the amounts each recipe needs", async () => {
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [
          groceryItem({
            name: "chicken thighs",
            amounts: ["2 lb", "1½ lb"],
            uses: [
              { recipe_id: 1, recipe_title: "Curry", quantity: 2, unit: "lb" },
              { recipe_id: 2, recipe_title: "Tacos", quantity: 1.5, unit: "lb" },
            ],
          }),
        ],
      }),
    });
    renderApp(WEEK);

    await screen.findByText("chicken thighs");
    expect(screen.getByText("To buy")).toBeInTheDocument();
    expect(screen.getByText("1 items")).toBeInTheDocument();
    expect(row("chicken thighs")).toHaveTextContent("· 2 lb + 1½ lb");
    expect(row("chicken thighs")).toHaveTextContent("for Curry, Tacos");
  });

  it("names a recipe once even when it uses the ingredient twice", async () => {
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [
          groceryItem({
            name: "olive oil",
            amounts: ["2 tbsp", "1 tbsp"],
            uses: [
              { recipe_id: 1, recipe_title: "Curry", quantity: 2, unit: "tbsp" },
              { recipe_id: 1, recipe_title: "Curry", quantity: 1, unit: "tbsp" },
            ],
          }),
        ],
      }),
    });
    renderApp(WEEK);

    expect(await screen.findByText("for Curry")).toBeInTheDocument();
  });

  it("shows an unquantified item without a trailing separator", async () => {
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ name: "salt", amounts: [], uses: [] })],
      }),
    });
    renderApp(WEEK);

    await screen.findByText("salt");
    expect(row("salt").textContent).toBe("salt");
  });

  it("keeps pantry restocking in its own section", async () => {
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ name: "chicken thighs" })],
        pantry_restock: [
          groceryItem({ name: "olive oil", amounts: [], from_pantry: true, pantry_item_id: 3 }),
        ],
      }),
    });
    renderApp(WEEK);

    await screen.findByText("olive oil");
    const restock = screen.getByText("Restock pantry").closest<HTMLElement>("section")!;
    expect(within(restock).getByText("olive oil")).toBeInTheDocument();
    expect(within(restock).queryByText("chicken thighs")).not.toBeInTheDocument();
    expect(row("olive oil")).toHaveTextContent("pantry");
  });

  it("ticks an item off immediately, then tells the server", async () => {
    // Waiting for a round trip in a supermarket aisle feels broken.
    let release: () => void = () => {};
    const backend = mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ key: "chicken", name: "chicken thighs", checked: false })],
      }),
      "POST /api/grocery-list/toggle": () => new Promise<undefined>((r) => (release = () => r(undefined))),
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(within(row("chicken thighs")).getByRole("checkbox"));

    expect(within(row("chicken thighs")).getByRole("checkbox")).toBeChecked();
    expect(backend.requestsTo("POST /api/grocery-list/toggle")[0].body).toEqual({
      key: "chicken",
      checked: true,
    });
    release();
  });

  it("unticks an item that was already checked", async () => {
    const backend = mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ key: "chicken", name: "chicken thighs", checked: true })],
      }),
      "POST /api/grocery-list/toggle": undefined,
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(within(row("chicken thighs")).getByRole("checkbox"));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/grocery-list/toggle")[0].body).toEqual({
        key: "chicken",
        checked: false,
      }),
    );
  });

  it("clears every checkmark and reloads", async () => {
    const backend = mockBackend({
      "GET /api/grocery-list": groceryList({ items: [groceryItem()] }),
      "POST /api/grocery-list/clear-checks": undefined,
    });
    const { user } = renderApp(WEEK);
    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Clear checkmarks" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/grocery-list/clear-checks")).toHaveLength(1),
    );
    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(2));
  });

  it("explains an empty list rather than showing a bare page", async () => {
    mockBackend({ "GET /api/grocery-list": groceryList() });
    renderApp(WEEK);

    expect(await screen.findByText("Nothing to buy")).toBeInTheDocument();
  });

  it("reports a failed load instead of claiming there is nothing to buy", async () => {
    mockBackend({ "GET /api/grocery-list": new HttpError(500, "Database is down") });
    renderApp(WEEK);

    expect(await screen.findByText(/Couldn't load your grocery list/)).toBeInTheDocument();
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to buy")).not.toBeInTheDocument();
  });

  it("retries a failed load", async () => {
    let attempt = 0;
    const backend = mockBackend({
      "GET /api/grocery-list": () =>
        ++attempt === 1
          ? new HttpError(503, "Server is restarting")
          : groceryList({ items: [groceryItem({ name: "chicken thighs" })] }),
    });
    const { user } = renderApp(WEEK);
    await screen.findByText(/Couldn't load your grocery list/);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("chicken thighs")).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(2);
  });

  it("keeps a tick the server never took, and says it is unsaved", async () => {
    // Mid-aisle the mark means "it is in the cart". Taking it back because the
    // signal went would lose the one thing the shopper actually did.
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ key: "chicken", name: "chicken thighs" })],
      }),
      "POST /api/grocery-list/toggle": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(within(row("chicken thighs")).getByRole("checkbox"));

    expect(within(row("chicken thighs")).getByRole("checkbox")).toBeChecked();
    expect(await screen.findByText(/1 checkmark not saved yet/)).toBeInTheDocument();
  });

  it("sends the unsaved marks again when asked", async () => {
    let reachable = false;
    let checked = false;
    const backend = mockBackend({
      "GET /api/grocery-list": () =>
        groceryList({
          items: [groceryItem({ key: "chicken", name: "chicken thighs", checked })],
        }),
      "POST /api/grocery-list/toggle": (req: MockRequest) => {
        if (!reachable) return new HttpError(503, "Server is restarting");
        checked = (req.body as { checked: boolean }).checked;
        return undefined;
      },
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");
    await user.click(within(row("chicken thighs")).getByRole("checkbox"));
    await screen.findByText(/1 checkmark not saved yet/);

    reachable = true;
    await user.click(screen.getByRole("button", { name: "Save now" }));

    await waitFor(() =>
      expect(screen.queryByText(/not saved yet/)).not.toBeInTheDocument(),
    );
    expect(within(row("chicken thighs")).getByRole("checkbox")).toBeChecked();
    expect(backend.requestsTo("POST /api/grocery-list/toggle")).toHaveLength(2);
  });

  it("does not let a later reload undo an unsaved tick", async () => {
    // Ticking a second item reloads the list, and the server's copy has never
    // heard of the first tick.
    const backend = mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [
          groceryItem({ key: "chicken", name: "chicken thighs" }),
          groceryItem({ key: "rice", name: "rice" }),
        ],
      }),
      "POST /api/grocery-list/toggle": (req: MockRequest) =>
        (req.body as { key: string }).key === "chicken"
          ? new HttpError(503, "Server is restarting")
          : undefined,
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(within(row("chicken thighs")).getByRole("checkbox"));
    await screen.findByText(/1 checkmark not saved yet/);
    await user.click(within(row("rice")).getByRole("checkbox"));

    await waitFor(() => expect(backend.requestsTo("GET /api/grocery-list")).toHaveLength(2));
    expect(within(row("chicken thighs")).getByRole("checkbox")).toBeChecked();
  });

  it("keeps the list on screen when refreshing it fails", async () => {
    let attempt = 0;
    mockBackend({
      "GET /api/grocery-list": () =>
        ++attempt === 1
          ? groceryList({ items: [groceryItem({ key: "chicken", name: "chicken thighs" })] })
          : new HttpError(503, "Server is restarting"),
      "POST /api/grocery-list/toggle": undefined,
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(within(row("chicken thighs")).getByRole("checkbox"));

    expect(
      await screen.findByText(/Showing the last version that loaded/),
    ).toBeInTheDocument();
    expect(screen.getByText("chicken thighs")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load your grocery list/)).not.toBeInTheDocument();
  });

  it("reports a failure to clear the checkmarks", async () => {
    mockBackend({
      "GET /api/grocery-list": groceryList({
        items: [groceryItem({ name: "chicken thighs" })],
      }),
      "POST /api/grocery-list/clear-checks": new HttpError(503, "Server is restarting"),
    });
    const { user } = renderApp(WEEK);
    await screen.findByText("chicken thighs");

    await user.click(screen.getByRole("button", { name: "Clear checkmarks" }));

    expect(await screen.findByText("Server is restarting")).toBeInTheDocument();
    expect(screen.getByText("chicken thighs")).toBeInTheDocument();
  });
});
