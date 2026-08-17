/**
 * Prices on the grocery list.
 *
 * The point of interest is honesty rather than layout. A total that leaves
 * out the lines it could not match reads exactly like a complete one, so
 * coverage has to be on screen beside it, and the list has to look completely
 * normal when there are no prices at all - which is the state anyone without
 * a Kroger account is permanently in.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockBackend } from "../test/backend";
import { groceryItem, groceryList } from "../test/fixtures";
import { renderApp } from "../test/render";

const NOW = new Date(2026, 6, 29, 12, 0);
const WEEK = "/groceries?start=2026-07-27&end=2026-08-02";

const STORE = {
  location_id: "01400765",
  name: "Kroger - Kroger Riverside",
  address: "601 Woodman Dr, Dayton, OH 45431",
  chain: "KROGER",
};

const flour = groceryItem({
  key: "all-purpose-flour",
  name: "flour",
  price: {
    product_id: "0001",
    description: "Kroger® All Purpose Flour",
    size: "5 lb",
    regular: 2.59,
    promo: null,
    aisle: "AISLE 18",
    estimated: null,
  },
});

const sugar = groceryItem({
  key: "granulated-sugar",
  name: "sugar",
  price: {
    product_id: "0002",
    description: "Kroger® Granulated Sugar",
    size: "4 lb",
    regular: 3.99,
    promo: 2.99,
    aisle: "AISLE 18",
    estimated: null,
  },
});

const saffron = groceryItem({ key: "saffron", name: "saffron" });

const onion = groceryItem({
  key: "onion",
  name: "onion",
  price: {
    product_id: "0001",
    description: "Green Onions",
    size: "1 bunch",
    regular: 1.19,
    promo: null,
    aisle: "PRODUCE",
    estimated: null,
  },
});

/** Best fit first, and deliberately unfiltered: the automatic pick was wrong. */
const ALTERNATIVES = [
  {
    product_id: "0001",
    description: "Green Onions",
    size: "1 bunch",
    regular: 1.19,
    promo: null,
    aisle: "PRODUCE",
    estimated: null,
  },
  {
    product_id: "0002",
    description: "Jumbo Yellow Onions",
    size: "1 lb",
    regular: 1.29,
    promo: null,
    aisle: "PRODUCE TABLE 6",
    estimated: null,
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function withList(list: unknown) {
  return mockBackend({
    "GET /api/pricing/status": { enabled: true, store: STORE },
    "GET /api/grocery-list": list,
  });
}

describe("grocery list pricing", () => {
  it("shows the total with how much of the list it covers", async () => {
    withList(
      groceryList({
        items: [flour, sugar, saffron],
        pricing: { store: STORE, total: 5.58, priced: 2, total_lines: 3 },
      }),
    );

    renderApp(WEEK);

    expect(await screen.findByText("est. $5.58")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 priced/)).toBeInTheDocument();
    expect(screen.getByText(/1 not matched/)).toBeInTheDocument();
    expect(screen.getByText(STORE.name)).toBeInTheDocument();
  });

  it("puts the price and Kroger's own product name on each line", async () => {
    withList(groceryList({ items: [flour], pricing: { store: STORE, total: 2.59, priced: 1, total_lines: 1 } }));

    renderApp(WEEK);

    const row = (await screen.findByText("flour")).closest(".grocery-item")!;
    expect(within(row as HTMLElement).getByText("$2.59")).toBeInTheDocument();
    // Shown exactly as Kroger returns it, never reworded.
    expect(
      within(row as HTMLElement).getByText(/Kroger® All Purpose Flour · 5 lb/),
    ).toBeInTheDocument();
  });

  it("shows the sale price against the regular one", async () => {
    withList(groceryList({ items: [sugar], pricing: { store: STORE, total: 2.99, priced: 1, total_lines: 1 } }));

    renderApp(WEEK);

    const row = (await screen.findByText("sugar")).closest(".grocery-item")!;
    expect(within(row as HTMLElement).getByText("$3.99").tagName).toBe("S");
    expect(within(row as HTMLElement).getByText("$2.99")).toBeInTheDocument();
  });

  it("costs a weight-sold item at its rate, keeping Kroger's price beside it", async () => {
    /*
     * Kroger's "1 lb" on fresh chicken thighs is $4.49 *per pound*, not a
     * pack, so three pounds is $13.47. Counting the shelf figure understated
     * that line by two thirds. Kroger's own price is shown alongside rather
     * than replaced, since altering it is not allowed.
     */
    withList(
      groceryList({
        items: [
          groceryItem({
            key: "chicken-thigh",
            name: "chicken thighs",
            amounts: ["3 lb"],
            price: {
              product_id: "0003",
              description: "Perdue® Fresh Boneless Skinless Chicken Thighs",
              size: "1 lb",
              regular: 4.49,
              promo: null,
              aisle: "MEAT",
              estimated: 13.47,
            },
          }),
        ],
        pricing: { store: STORE, total: 13.47, priced: 1, total_lines: 1 },
      }),
    );

    renderApp(WEEK);

    const row = (await screen.findByText("chicken thighs")).closest(".grocery-item")!;
    expect(within(row as HTMLElement).getByText("$13.47")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(/Perdue® Fresh Boneless Skinless Chicken Thighs · \$4\.49 \/ 1 lb/),
    ).toBeInTheDocument();
  });

  it("leaves an unmatched line with no price rather than a zero", async () => {
    withList(
      groceryList({
        items: [saffron],
        pricing: { store: STORE, total: 2.59, priced: 0, total_lines: 1 },
      }),
    );

    renderApp(WEEK);

    const row = (await screen.findByText("saffron")).closest(".grocery-item")!;
    expect(within(row as HTMLElement).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("offers alternatives when the price is tapped, and pins the one chosen", async () => {
    const backend = mockBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [onion],
        pricing: { store: STORE, total: 1.19, priced: 1, total_lines: 1 },
      }),
      "GET /api/pricing/alternatives": ALTERNATIVES,
      "PUT /api/pricing/match": undefined,
    });

    const { user } = renderApp(WEEK);

    // Nothing is fetched until asked for: the panel costs a search.
    await screen.findByText("onion");
    expect(backend.requestsTo("GET /api/pricing/alternatives")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /Choose a different product/ }));

    const panel = await screen.findByRole("group", { name: "Products for onion" });
    await user.click(within(panel).getByRole("button", { name: /Jumbo Yellow Onions/ }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/pricing/match")).toHaveLength(1),
    );
    expect(backend.requestsTo("PUT /api/pricing/match")[0].body).toEqual({
      canonical_key: "onion",
      product_id: "0002",
    });
  });

  it("marks the product in force among the alternatives", async () => {
    mockBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [onion],
        pricing: { store: STORE, total: 1.19, priced: 1, total_lines: 1 },
      }),
      "GET /api/pricing/alternatives": ALTERNATIVES,
    });

    const { user } = renderApp(WEEK);
    await user.click(
      await screen.findByRole("button", { name: /Choose a different product/ }),
    );

    // Scoped to the panel: the toggle's own label names the product too.
    const panel = await screen.findByRole("group", { name: "Products for onion" });
    expect(within(panel).getByRole("button", { name: /Green Onions/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(panel).getByRole("button", { name: /Jumbo Yellow Onions/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("still lists the product in force when the search misses it", async () => {
    /*
     * Kroger's search is fuzzy and answers a different limit with a different
     * set, so the automatic pick can genuinely be absent from the
     * alternatives to itself - black pepper matched whole peppercorns, which
     * a narrower search for the same term does not return. Without this the
     * panel shows nothing marked as chosen.
     */
    mockBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [onion],
        pricing: { store: STORE, total: 1.19, priced: 1, total_lines: 1 },
      }),
      // The onion the row is actually priced at is not among these.
      "GET /api/pricing/alternatives": [ALTERNATIVES[1]],
    });

    const { user } = renderApp(WEEK);
    await user.click(
      await screen.findByRole("button", { name: /Choose a different product/ }),
    );

    const panel = await screen.findByRole("group", { name: "Products for onion" });
    expect(within(panel).getByRole("button", { name: /Green Onions/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("lets a line with no match be given one", async () => {
    mockBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [saffron],
        pricing: { store: STORE, total: 2.59, priced: 0, total_lines: 1 },
      }),
      "GET /api/pricing/alternatives": ALTERNATIVES,
    });

    const { user } = renderApp(WEEK);

    // The affordance is there precisely because the automatic pass failed.
    const toggle = await screen.findByRole("button", { name: /not priced/ });
    expect(within(toggle).getByText("no match")).toBeInTheDocument();

    await user.click(toggle);
    const panel = await screen.findByRole("group", { name: "Products for saffron" });
    expect(within(panel).getByRole("button", { name: /Green Onions/ })).toBeInTheDocument();
  });

  it("can mark a line as one not to price", async () => {
    const backend = mockBackend({
      "GET /api/pricing/status": { enabled: true, store: STORE },
      "GET /api/grocery-list": groceryList({
        items: [saffron],
        pricing: { store: STORE, total: 2.59, priced: 0, total_lines: 1 },
      }),
      "GET /api/pricing/alternatives": ALTERNATIVES,
      "PUT /api/pricing/match": undefined,
    });

    const { user } = renderApp(WEEK);
    await user.click(await screen.findByRole("button", { name: /not priced/ }));
    const panel = await screen.findByRole("group", { name: "Products for saffron" });
    await user.click(within(panel).getByRole("button", { name: /Don.t price this/ }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/pricing/match")[0].body).toEqual({
        canonical_key: "saffron",
        product_id: null,
      }),
    );
  });

  it("offers no product choice when no store is set", async () => {
    mockBackend({
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/grocery-list": groceryList({ items: [saffron], pricing: null }),
    });

    renderApp(WEEK);

    await screen.findByText("saffron");
    expect(screen.queryByRole("button", { name: /Choose a product/ })).not.toBeInTheDocument();
  });

  it("looks like an ordinary list when there is no pricing at all", async () => {
    withList(groceryList({ items: [saffron], pricing: null }));

    renderApp(WEEK);

    expect(await screen.findByText("saffron")).toBeInTheDocument();
    expect(screen.queryByText(/est\. \$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/priced/)).not.toBeInTheDocument();
  });
});
