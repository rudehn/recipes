/**
 * Pasting a shopping list and sending it straight to the Kroger cart.
 *
 * The same rule governs this as the grocery list's send: the cart is
 * write-only, so nothing goes without the review on screen, and the page
 * sends the text and the shopper's own changes rather than the products it
 * shows. What is new is that the review is also where a pasted line is put
 * right, so lines that cannot be ordered stay in place with a way to fix them.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError, type Routes } from "../test/backend";
import {
  cartStatus,
  groceryItem,
  groceryList,
  itemPrice,
  pastedLine,
  pastePlan,
  pricedBackend,
} from "../test/fixtures";
import { renderApp } from "../test/render";

const NOW = new Date(2026, 6, 29, 12, 0);
const WEEK = "/groceries?start=2026-07-27&end=2026-08-02";

const STORE = {
  location_id: "01400765",
  name: "Kroger - Kroger Riverside",
  address: "601 Woodman Dr, Dayton, OH 45431",
  chain: "KROGER",
};

const CONNECTED = cartStatus({ connected: true, connected_at: "2026-07-01T15:00:00Z" });

const milk = pastedLine();
const eggs = pastedLine({
  key: "egg",
  name: "eggs",
  quantity: 2,
  product: itemPrice({
    product_id: "0005",
    description: "Kroger® Grade A Large Eggs",
    size: "12 ct",
    regular: 2.79,
  }),
});
const beef = pastedLine({
  key: "ground-beef",
  name: "ground beef",
  quantity: 2,
  amount: "2 lb",
  product: itemPrice({
    product_id: "0010",
    description: "Kroger® 80/20 Ground Beef",
    size: "1 lb",
    regular: 4.99,
  }),
});
const saffron = pastedLine({
  key: "saffron",
  name: "saffron",
  product: null,
  problem: "no_match",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function withCart(routes: Routes = {}) {
  return pricedBackend({
    "GET /api/pricing/status": { enabled: true, store: STORE },
    "GET /api/grocery-list": groceryList({ items: [groceryItem({ name: "flour" })] }),
    "GET /api/cart/status": CONNECTED,
    ...routes,
  });
}

type User = ReturnType<typeof renderApp>["user"];

/** Open the paste panel and look the text up. */
async function pasteAndFind(user: User, text: string) {
  await user.click(await screen.findByRole("button", { name: "Paste a list" }));
  await user.type(screen.getByLabelText("Your shopping list"), text);
  await user.click(screen.getByRole("button", { name: "Find at Kroger" }));
}

function row(name: string): HTMLElement {
  return screen.getAllByRole("listitem").find((li) => within(li).queryByText(name))!;
}

describe("pasting a list into the Kroger cart", () => {
  it("is offered even when no meals are planned", async () => {
    withCart({ "GET /api/grocery-list": groceryList() });

    renderApp(WEEK);

    // An empty week is exactly when a list from somewhere else is likely.
    expect(await screen.findByRole("button", { name: "Paste a list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to cart" })).not.toBeInTheDocument();
  });

  it("is not offered before an account is connected", async () => {
    withCart({ "GET /api/cart/status": cartStatus() });

    renderApp(WEEK);

    expect(await screen.findByText(/order this list from kroger/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Paste a list" })).not.toBeInTheDocument();
  });

  it("looks the text up and shows every line before anything is sent", async () => {
    const backend = withCart({
      "POST /api/cart/paste/preview": pastePlan({ lines: [milk, eggs, beef] }),
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk{enter}eggs x2{enter}2 lb ground beef");

    expect(await screen.findByText("Kroger® Grade A Large Eggs · 12 ct ·", { exact: false }))
      .toBeInTheDocument();
    expect(backend.requestsTo("POST /api/cart/paste/preview")[0].body).toEqual({
      text: "milk\neggs x2\n2 lb ground beef",
    });
    expect(within(row("eggs")).getByText("2×")).toBeInTheDocument();
    // The amount the count covers, so "2×" can be checked against "2 lb".
    expect(within(row("ground beef")).getByText("for 2 lb")).toBeInTheDocument();
    // 3.29 + 2 × 2.79 + 2 × 4.99
    expect(screen.getByText(/3 items to send · about \$18\.85/)).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/cart/paste/add")).toHaveLength(0);
  });

  it("keeps a line nothing matched in its place, with a way to choose one", async () => {
    let chosen = false;
    const backend = withCart({
      "POST /api/cart/paste/preview": () =>
        pastePlan({
          lines: [
            milk,
            chosen
              ? { ...saffron, problem: null, hand_picked: true, product: itemPrice({ product_id: "0099", description: "McCormick® Saffron" }) }
              : saffron,
          ],
        }),
      "GET /api/pricing/alternatives": [
        itemPrice({ product_id: "0099", description: "McCormick® Saffron", size: "0.06 oz" }),
      ],
      "PUT /api/pricing/match": () => {
        chosen = true;
      },
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk{enter}saffron");

    const line = await waitFor(() => row("saffron"));
    expect(within(line).getByText(/nothing at your store matched/i)).toBeInTheDocument();
    // Nothing to count, so no count to change.
    expect(within(line).queryByRole("button", { name: "More saffron" })).not.toBeInTheDocument();
    expect(screen.getByText(/1 item to send/)).toBeInTheDocument();

    await user.click(within(line).getByRole("button", { name: /choose a product for saffron/i }));
    const dialog = await screen.findByRole("dialog");
    // A pasted line that is not wanted is taken off instead; "no product"
    // would be remembered and unprice every recipe using it.
    expect(within(dialog).queryByText(/don.t price this/i)).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: /McCormick® Saffron/ }));

    await waitFor(() => expect(screen.getByText(/2 items to send/)).toBeInTheDocument());
    expect(backend.requestsTo("PUT /api/pricing/match")[0].body).toEqual({
      canonical_key: "saffron",
      product_id: "0099",
    });
    expect(backend.requestsTo("POST /api/cart/paste/preview")).toHaveLength(2);
  });

  it("sends the text with the counts changed and the lines taken off", async () => {
    const backend = withCart({
      "POST /api/cart/paste/preview": pastePlan({ lines: [milk, eggs, beef, saffron] }),
      "POST /api/cart/paste/add": { added: 2, skipped: ["saffron"], sent_at: "2026-07-29T16:05:00Z" },
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk{enter}eggs x2{enter}2 lb ground beef{enter}saffron");

    await user.click(await screen.findByRole("button", { name: "More eggs" }));
    await user.click(screen.getByRole("button", { name: "Take ground beef off this order" }));
    expect(within(row("ground beef")).getByText("Taken off this order")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox"), "DELIVERY");
    await user.click(screen.getByRole("button", { name: "Send 2 items to Kroger" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/cart/paste/add")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/cart/paste/add")[0].body).toEqual({
      text: "milk\neggs x2\n2 lb ground beef\nsaffron",
      modality: "DELIVERY",
      quantities: { egg: 3 },
      removed: ["ground-beef"],
    });
    // The server's count, not the one on screen, and the way to the cart it
    // cannot read back.
    expect(await screen.findByText(/2 items added to your Kroger cart, 1 left off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your cart" })).toBeInTheDocument();
  });

  it("puts a line taken off back", async () => {
    withCart({ "POST /api/cart/paste/preview": pastePlan({ lines: [milk, eggs] }) });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk{enter}eggs");

    await user.click(await screen.findByRole("button", { name: "Take milk off this order" }));
    expect(screen.getByText(/1 item to send/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Put milk back" }));

    expect(screen.getByText(/2 items to send/)).toBeInTheDocument();
  });

  it("names the lines left out because they were already ticked", async () => {
    withCart({
      "POST /api/cart/paste/preview": pastePlan({ lines: [eggs], ticked: ["milk", "bread"] }),
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "[x] milk{enter}[x] bread{enter}eggs");

    expect(
      await screen.findByText("Left out because they were ticked off: milk, bread."),
    ).toBeInTheDocument();
  });

  it("says why a list could not be looked up", async () => {
    withCart({
      "POST /api/cart/paste/preview": new HttpError(409, "Choose a Kroger store in Settings first"),
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk");

    expect(
      await screen.findByText("Choose a Kroger store in Settings first"),
    ).toBeInTheDocument();
    // The text is still there to try again with.
    expect(screen.getByLabelText("Your shopping list")).toHaveValue("milk");
  });

  it("goes back to the text to edit it", async () => {
    withCart({ "POST /api/cart/paste/preview": pastePlan({ lines: [milk] }) });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk");
    await user.click(await screen.findByRole("button", { name: "Edit list" }));

    expect(screen.getByLabelText("Your shopping list")).toHaveValue("milk");
  });

  it("keeps the text when the panel is closed before sending", async () => {
    withCart();

    const { user } = renderApp(WEEK);
    await user.click(await screen.findByRole("button", { name: "Paste a list" }));
    await user.type(screen.getByLabelText("Your shopping list"), "milk");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Paste a list" }));

    expect(screen.getByLabelText("Your shopping list")).toHaveValue("milk");
  });

  it("forgets the text once it has been sent", async () => {
    withCart({
      "POST /api/cart/paste/preview": pastePlan({ lines: [milk] }),
      "POST /api/cart/paste/add": { added: 1, skipped: [], sent_at: "2026-07-29T16:05:00Z" },
    });

    const { user } = renderApp(WEEK);
    await pasteAndFind(user, "milk");
    await user.click(await screen.findByRole("button", { name: "Send 1 item to Kroger" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await user.click(await screen.findByRole("button", { name: "Paste a list" }));

    expect(screen.getByLabelText("Your shopping list")).toHaveValue("");
  });

  it("will not look up an empty list", async () => {
    withCart();

    const { user } = renderApp(WEEK);
    await user.click(await screen.findByRole("button", { name: "Paste a list" }));

    expect(screen.getByRole("button", { name: "Find at Kroger" })).toBeDisabled();
  });
});
