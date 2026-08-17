/**
 * Sending the grocery list to a Kroger cart.
 *
 * What is worth proving here follows from the one thing this page cannot do:
 * read the cart back. Nothing can be checked afterwards and nothing can be
 * removed, so every test is about what reaches Kroger and whether the shopper
 * saw it first. Nothing may be sent without the review on screen, the review
 * may never describe a trip other than the one about to go, and the app must
 * not claim to know what ended up in a cart it cannot see.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError, mockBackend, type Routes } from "../test/backend";
import { cartLine, cartPlan, cartStatus, groceryItem, groceryList } from "../test/fixtures";
import { renderApp } from "../test/render";

const NOW = new Date(2026, 6, 29, 12, 0);
const WEEK = "/groceries?start=2026-07-27&end=2026-08-02";

const STORE = {
  location_id: "01400765",
  name: "Kroger - Kroger Riverside",
  address: "601 Woodman Dr, Dayton, OH 45431",
  chain: "KROGER",
};

const flour = groceryItem({ key: "all-purpose-flour", name: "flour" });
const sugar = groceryItem({ key: "granulated-sugar", name: "sugar" });

const CONNECTED = cartStatus({ connected: true, connected_at: "2026-07-01T15:00:00Z" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function withCart(routes: Routes = {}) {
  return mockBackend({
    "GET /api/pricing/status": { enabled: true, store: STORE },
    "GET /api/pricing/sales": [],
    "GET /api/grocery-list": groceryList({ items: [flour, sugar] }),
    "GET /api/cart/status": CONNECTED,
    ...routes,
  });
}

/** Open the review, which is the only way to reach the send button. */
async function openReview(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: "Send to cart" }));
}

describe("sending the grocery list to a Kroger cart", () => {
  it("says nothing at all when the server is not set up for it", async () => {
    withCart({ "GET /api/cart/status": cartStatus({ configured: false }) });

    renderApp(WEEK);

    expect(await screen.findByText("flour")).toBeInTheDocument();
    // A control that can never work is not information. The settings page is
    // where the setup is explained.
    expect(screen.queryByRole("button", { name: "Send to cart" })).not.toBeInTheDocument();
    expect(screen.queryByText(/order this list from kroger/i)).not.toBeInTheDocument();
  });

  it("offers to connect an account when nobody has signed in", async () => {
    withCart({ "GET /api/cart/status": cartStatus() });

    renderApp(WEEK);

    expect(await screen.findByText(/order this list from kroger/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect your account/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("button", { name: "Send to cart" })).not.toBeInTheDocument();
  });

  it("sends nothing until the review has been seen", async () => {
    const backend = withCart({ "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }) });

    const { user } = renderApp(WEEK);
    await openReview(user);

    expect(await screen.findByText(/Kroger® All Purpose Flour/)).toBeInTheDocument();
    // Opening it costs a look and nothing more.
    expect(backend.requestsTo("POST /api/cart/add")).toHaveLength(0);
  });

  it("shows the quantity beside each product, since it is not always one", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({
        lines: [
          cartLine({ name: "flour", quantity: 3 }),
          cartLine({
            name: "sugar",
            description: "Kroger® Granulated Sugar",
            size: "4 lb",
            quantity: 1,
          }),
        ],
      }),
    });

    const { user } = renderApp(WEEK);
    await openReview(user);

    const lines = await screen.findAllByRole("listitem");
    const flourLine = lines.find((li) => within(li).queryByText("flour"))!;
    expect(within(flourLine).getByText("3×")).toBeInTheDocument();
    expect(within(flourLine).getByText(/5 lb/)).toBeInTheDocument();
  });

  it("names the lines it cannot order rather than counting them", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({
        lines: [cartLine()],
        skipped: ["saffron", "bay leaf"],
      }),
    });

    const { user } = renderApp(WEEK);
    await openReview(user);

    // A count is not something a shopper can shop from.
    expect(await screen.findByText(/saffron, bay leaf/)).toBeInTheDocument();
  });

  it("sends the range and how it is to be collected", async () => {
    const backend = withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine(), cartLine({ name: "sugar" })] }),
      "POST /api/cart/add": { added: 2, skipped: [], sent_at: "2026-07-29T16:05:00Z" },
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.click(await screen.findByRole("button", { name: /send 2 items to kroger/i }));

    await waitFor(() => expect(backend.requestsTo("POST /api/cart/add")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/cart/add")[0].body).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
      modality: "PICKUP",
    });
  });

  it("can ask for delivery instead", async () => {
    const backend = withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }),
      "POST /api/cart/add": { added: 1, skipped: [], sent_at: "2026-07-29T16:05:00Z" },
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.selectOptions(await screen.findByLabelText(/collect by/i), "DELIVERY");
    await user.click(screen.getByRole("button", { name: /send 1 item to kroger/i }));

    await waitFor(() => expect(backend.requestsTo("POST /api/cart/add")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/cart/add")[0].body).toMatchObject({
      modality: "DELIVERY",
    });
  });

  it("reports what the server says went, not what was on screen", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine(), cartLine({ name: "sugar" })] }),
      // The server re-plans as it sends, and one line no longer resolved.
      "POST /api/cart/add": {
        added: 1,
        skipped: ["sugar"],
        sent_at: "2026-07-29T16:05:00Z",
      },
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.click(await screen.findByRole("button", { name: /send 2 items to kroger/i }));

    expect(await screen.findByText(/1 item added to your kroger cart/i)).toBeInTheDocument();
    expect(screen.getByText(/1 left off/i)).toBeInTheDocument();
  });

  it("points at Kroger rather than claiming to know what is in the cart", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }),
      "POST /api/cart/add": { added: 1, skipped: [], sent_at: "2026-07-29T16:05:00Z" },
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.click(await screen.findByRole("button", { name: /send 1 item to kroger/i }));

    const link = await screen.findByRole("link", { name: /open your cart/i });
    expect(link).toHaveAttribute("href", "https://www.kroger.com/cart");
  });

  it("warns that a second send adds to the first", async () => {
    withCart({
      "GET /api/cart/status": cartStatus({
        connected: true,
        last_sent_at: "2026-07-29T15:42:00Z",
      }),
    });

    renderApp(WEEK);

    // Nothing can be removed from a Kroger cart, so this is the only warning
    // there can be.
    expect(await screen.findByText(/adds to that cart rather than replacing it/i))
      .toBeInTheDocument();
  });

  it("keeps the list when a send fails, and says so", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }),
      "POST /api/cart/add": new HttpError(502, "Could not reach Kroger"),
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.click(await screen.findByRole("button", { name: /send 1 item to kroger/i }));

    expect(await screen.findByText("Could not reach Kroger")).toBeInTheDocument();
    // The review is still on screen with the line in it, rather than having
    // been cleared by a send that did not happen.
    expect(within(screen.getByRole("list")).getByText("flour")).toBeInTheDocument();
    // Still offered, since nothing went.
    expect(screen.getByRole("button", { name: /send 1 item to kroger/i })).toBeEnabled();
  });

  it("asks the server again when a checkmark changes under an open review", async () => {
    const backend = withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }),
      "POST /api/grocery-list/toggle": undefined,
      "GET /api/grocery-list": () =>
        groceryList({
          items: [
            { ...flour, checked: backend.requestsTo("POST /api/grocery-list/toggle").length > 0 },
            sugar,
          ],
        }),
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await screen.findByText(/Kroger® All Purpose Flour/);
    const before = backend.requestsTo("GET /api/cart/preview").length;

    await user.click(screen.getAllByRole("checkbox")[0]);

    // A review built from the old checkmarks describes a trip that is no
    // longer the one about to be ordered.
    await waitFor(() =>
      expect(backend.requestsTo("GET /api/cart/preview").length).toBeGreaterThan(before),
    );
  });

  it("does not read as a success when the send added nothing", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({ lines: [cartLine()] }),
      // The line went out of stock between the review and the send.
      "POST /api/cart/add": { added: 0, skipped: ["flour"], sent_at: null },
    });

    const { user } = renderApp(WEEK);
    await openReview(user);
    await user.click(await screen.findByRole("button", { name: /send 1 item to kroger/i }));

    // "0 items added" would leave a shopper waiting at a collection point for
    // an empty order.
    const banner = await screen.findByText(/nothing was added to your kroger cart/i);
    expect(banner.closest(".error-banner")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /open your cart/i })).not.toBeInTheDocument();
  });

  it("says so plainly when nothing on the list can be ordered", async () => {
    withCart({
      "GET /api/cart/preview": cartPlan({ lines: [], skipped: ["flour", "sugar"] }),
    });

    const { user } = renderApp(WEEK);
    await openReview(user);

    expect(await screen.findByText(/nothing here can be ordered from kroger yet/i))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send .* to kroger/i })).not.toBeInTheDocument();
  });
});
