/**
 * Connecting a Kroger account so lists can be ordered.
 *
 * This is a second, separate permission from the API key that prices a list,
 * and the states worth pinning down are the three the status endpoint reports:
 * not set up on this server, set up but nobody signed in, and connected. Only
 * the middle one has a button that fixes it, and rendering the first as an
 * inert button is exactly the dead end the panel exists to avoid.
 *
 * The other half is the return trip. The browser comes back from Kroger with
 * a short code in the URL and no message, so the page has to turn every
 * outcome - including changing your mind - into something readable.
 */

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { cartStatus } from "../test/fixtures";
import { renderApp } from "../test/render";

const NOW = new Date(2026, 6, 29, 12, 0);

const PRICING = { enabled: true, store: null };

const SIGN_IN_URL =
  "https://api.kroger.com/v1/connect/oauth2/authorize?scope=cart.basic%3Awrite";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connecting a Kroger cart", () => {
  it("explains the missing setting rather than offering a button that cannot work", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus({ configured: false }),
    });

    renderApp("/settings");

    expect(await screen.findByText("Sending to a cart is switched off")).toBeInTheDocument();
    expect(screen.getByText("KROGER_REDIRECT_URI")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect kroger account/i }),
    ).not.toBeInTheDocument();
  });

  it("offers a sign-in once the server is set up for it", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus(),
    });

    renderApp("/settings");

    expect(
      await screen.findByRole("button", { name: /connect kroger account/i }),
    ).toBeInTheDocument();
    // The distinction the panel is built on: the server's key reads prices, a
    // person's sign-in orders things.
    expect(screen.getByText(/a cart belongs to a person/i)).toBeInTheDocument();
  });

  it("hands the browser to Kroger rather than asking for a password here", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      origin: "https://recipes.test",
      assign,
    } as unknown as Location);

    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus(),
      "GET /api/cart/sign-in": { url: SIGN_IN_URL },
    });

    const { user } = renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: /connect kroger account/i }));

    // A full navigation to Kroger's own origin, where the address bar can be
    // checked, rather than a popup or a frame.
    await waitFor(() => expect(assign).toHaveBeenCalledWith(SIGN_IN_URL));
  });

  it("reports a sign-in that could not even be started", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus(),
      "GET /api/cart/sign-in": new HttpError(503, "Adding to a Kroger cart is not configured"),
    });

    const { user } = renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: /connect kroger account/i }));

    expect(
      await screen.findByText("Adding to a Kroger cart is not configured"),
    ).toBeInTheDocument();
  });

  it("says what happened when the browser comes back connected", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus({
        connected: true,
        connected_at: "2026-07-29T15:42:00Z",
      }),
    });

    renderApp("/settings?kroger=connected");

    expect(
      await screen.findByText(/your kroger account is connected/i),
    ).toBeInTheDocument();
  });

  it("treats changing your mind at Kroger as a decision, not a fault", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus(),
    });

    renderApp("/settings?kroger=declined");

    const banner = await screen.findByText(/nothing was connected/i);
    expect(banner.closest(".error-banner")).toBeNull();
  });

  it("says to try again when a callback did not check out", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus(),
    });

    renderApp("/settings?kroger=stale");

    expect(await screen.findByText(/took too long, or it did not start here/i))
      .toBeInTheDocument();
  });

  it("does not claim a disconnect reaches Kroger's own record", async () => {
    mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": cartStatus({
        connected: true,
        connected_at: "2026-07-01T15:00:00Z",
      }),
    });

    renderApp("/settings");

    // It ends the connection at this end. Only the account holder can
    // withdraw what Kroger has on file, and implying otherwise would be the
    // more comfortable lie.
    expect(await screen.findByText(/kroger keeps its own record/i)).toBeInTheDocument();
  });

  it("forgets the connection and puts the sign-in back", async () => {
    let connected = true;
    const backend = mockBackend({
      "GET /api/pricing/status": PRICING,
      "GET /api/cart/status": () => cartStatus({ connected }),
      "DELETE /api/cart/connection": () => {
        connected = false;
      },
    });

    const { user } = renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    expect(
      await screen.findByRole("button", { name: /connect kroger account/i }),
    ).toBeInTheDocument();
    expect(backend.requestsTo("DELETE /api/cart/connection")).toHaveLength(1);
  });

  it("keeps the panel out of the way until pricing itself is configured", async () => {
    mockBackend({ "GET /api/pricing/status": { enabled: false, store: null } });

    renderApp("/settings");

    // Ordering needs everything pricing needs and a sign-in on top, so
    // offering it first would be a dead end.
    await screen.findByText("Pricing is switched off");
    expect(screen.queryByText("Kroger cart")).not.toBeInTheDocument();
  });
});
