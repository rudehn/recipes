/**
 * Prices on the grocery list.
 *
 * The point of interest is honesty rather than layout. A total that leaves
 * out the lines it could not match reads exactly like a complete one, so
 * coverage has to be on screen beside it, and the list has to look completely
 * normal when there are no prices at all - which is the state anyone without
 * a Kroger account is permanently in.
 */

import { screen, within } from "@testing-library/react";
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
  },
});

const saffron = groceryItem({ key: "saffron", name: "saffron" });

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

  it("looks like an ordinary list when there is no pricing at all", async () => {
    withList(groceryList({ items: [saffron], pricing: null }));

    renderApp(WEEK);

    expect(await screen.findByText("saffron")).toBeInTheDocument();
    expect(screen.queryByText(/est\. \$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/priced/)).not.toBeInTheDocument();
  });
});
