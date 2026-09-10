/**
 * Choosing the store prices are quoted against.
 *
 * The states worth pinning down are the three the status endpoint reports:
 * switched off entirely, on but with nowhere to price against, and ready.
 * The middle one is the easiest to render as an empty screen and the hardest
 * for a cook to diagnose, since the app looks configured and simply shows no
 * prices.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { cartStatus } from "../test/fixtures";
import { renderApp } from "../test/render";

const riverside = {
  location_id: "01400765",
  name: "Kroger - Kroger Riverside",
  address: "601 Woodman Dr, Dayton, OH 45431",
  chain: "KROGER",
};

const beavercreek = {
  location_id: "01400811",
  name: "Kroger Marketplace - Beavercreek",
  address: "3165 Dayton Xenia Rd, Beavercreek, OH 45434",
  chain: "KROGER",
};

describe("SettingsPage", () => {
  it("explains itself when pricing has no credentials", async () => {
    mockBackend({ "GET /api/pricing/status": { enabled: false, store: null } });

    renderApp("/settings");

    expect(await screen.findByText("Pricing is switched off")).toBeInTheDocument();
    expect(screen.queryByLabelText("ZIP code")).not.toBeInTheDocument();
  });

  it("keeps the settings link out of the nav until pricing is configured", async () => {
    mockBackend({
      "GET /api/pricing/status": { enabled: false, store: null },
      "GET /api/recipes": { items: [], total: 0, page: 1, per_page: 24 },
      "GET /api/recipes/tags": [],
    });

    renderApp("/recipes");

    await screen.findByRole("link", { name: "Pantry" });
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("offers the settings link once pricing is configured", async () => {
    mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/recipes": { items: [], total: 0, page: 1, per_page: 24 },
      "GET /api/recipes/tags": [],
    });

    renderApp("/recipes");

    expect(await screen.findByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("searches by ZIP and saves the store that is picked", async () => {
    const backend = mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/pricing/stores": [riverside, beavercreek],
      "PUT /api/pricing/store": riverside,
    });

    const { user } = renderApp("/settings");

    await user.type(await screen.findByLabelText("ZIP code"), "45431");
    await user.click(screen.getByRole("button", { name: "Find stores" }));

    const result = await screen.findByText(beavercreek.name);
    expect(screen.getByText(riverside.name)).toBeInTheDocument();

    await user.click(
      within(result.closest(".store-result") as HTMLElement).getByRole("button", {
        name: "Use this store",
      }),
    );

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/pricing/store")).toHaveLength(1),
    );
    expect(backend.requestsTo("PUT /api/pricing/store")[0].body).toEqual({
      location_id: beavercreek.location_id,
    });
    expect(backend.requestsTo("GET /api/pricing/stores")[0].searchParams.get("zip")).toBe(
      "45431",
    );
  });

  it("does not call the server for something that is not a ZIP code", async () => {
    const backend = mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/pricing/stores": [],
    });

    const { user } = renderApp("/settings");

    await user.type(await screen.findByLabelText("ZIP code"), "Dayton");
    await user.click(screen.getByRole("button", { name: "Find stores" }));

    expect(await screen.findByText("Enter a 5-digit ZIP code.")).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/pricing/stores")).toHaveLength(0);
  });

  it("shows the chosen store rather than the search form", async () => {
    mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: riverside },
    });

    renderApp("/settings");

    expect(await screen.findByText(riverside.name)).toBeInTheDocument();
    expect(screen.getByText(riverside.address)).toBeInTheDocument();
    expect(screen.queryByLabelText("ZIP code")).not.toBeInTheDocument();
  });

  it("puts the search back when the store is changed", async () => {
    let store: unknown = riverside;
    mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": () => ({ enabled: true, store }),
      "DELETE /api/pricing/store": () => {
        store = null;
        return undefined;
      },
    });

    const { user } = renderApp("/settings");

    await user.click(await screen.findByRole("button", { name: "Change store" }));

    expect(await screen.findByLabelText("ZIP code")).toBeInTheDocument();
  });

  it("reports a failed lookup instead of showing an empty result list", async () => {
    mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/pricing/stores": new HttpError(502, "Could not reach Kroger"),
    });

    const { user } = renderApp("/settings");

    await user.type(await screen.findByLabelText("ZIP code"), "45431");
    await user.click(screen.getByRole("button", { name: "Find stores" }));

    expect(await screen.findByText("Could not reach Kroger")).toBeInTheDocument();
    expect(screen.queryByText("No stores found near that ZIP code.")).not.toBeInTheDocument();
  });

  it("says so when a ZIP code has no stores near it", async () => {
    mockBackend({
      "GET /api/cart/status": cartStatus({ configured: false }),
      "GET /api/pricing/status": { enabled: true, store: null },
      "GET /api/pricing/stores": [],
    });

    const { user } = renderApp("/settings");

    await user.type(await screen.findByLabelText("ZIP code"), "99999");
    await user.click(screen.getByRole("button", { name: "Find stores" }));

    expect(
      await screen.findByText("No stores found near that ZIP code."),
    ).toBeInTheDocument();
  });

  describe("remembered products", () => {
    const PICKS = [
      {
        key: "all-purpose-flour",
        name: "flour",
        product: {
          product_id: "0001",
          description: "Kroger® All Purpose Flour",
          size: "5 lb",
          regular: 2.59,
          promo: null,
          aisle: "AISLE 18",
          in_stock: true,
          estimated: null,
        },
        hand_picked: false,
        resolved_at: "2026-07-20T12:00:00Z",
      },
      {
        key: "onion",
        name: "onion",
        product: {
          product_id: "0002",
          description: "Jumbo Yellow Onions",
          size: "1 lb",
          regular: 1.29,
          promo: null,
          aisle: "PRODUCE",
          in_stock: true,
          estimated: null,
        },
        hand_picked: true,
        resolved_at: "2026-07-21T12:00:00Z",
      },
      { key: "salt", name: "salt", product: null, hand_picked: true, resolved_at: "2026-07-21T12:00:00Z" },
      { key: "saffron", name: "saffron", product: null, hand_picked: false, resolved_at: "2026-07-21T12:00:00Z" },
    ];

    function withPicks(picks: unknown) {
      return mockBackend({
        "GET /api/cart/status": cartStatus({ configured: false }),
        "GET /api/pricing/status": { enabled: true, store: riverside },
        "GET /api/pricing/matches": picks,
        "DELETE /api/pricing/match": undefined,
      });
    }

    it("lists every pick, saying which were yours and which priced nothing", async () => {
      withPicks(PICKS);
      renderApp("/settings");

      const rows = await screen.findAllByRole("listitem");
      const flour = rows.find((r) => within(r).queryByText("flour"))!;
      expect(within(flour).getByText(/Kroger® All Purpose Flour · 5 lb · \$2\.59/)).toBeInTheDocument();
      expect(within(flour).queryByText("your pick")).not.toBeInTheDocument();
      const onion = rows.find((r) => within(r).queryByText("onion"))!;
      expect(within(onion).getByText("your pick")).toBeInTheDocument();
      const salt = rows.find((r) => within(r).queryByText("salt"))!;
      expect(within(salt).getByText(/not priced, by choice/)).toBeInTheDocument();
      const saffron = rows.find((r) => within(r).queryByText("saffron"))!;
      expect(within(saffron).getByText(/nothing matched/)).toBeInTheDocument();
    });

    it("forgets a pick and reloads the list", async () => {
      const backend = withPicks(PICKS);
      const { user } = renderApp("/settings");

      await user.click(await screen.findByRole("button", { name: "Forget onion" }));

      await waitFor(() => expect(backend.requestsTo("DELETE /api/pricing/match")).toHaveLength(1));
      expect(backend.requestsTo("DELETE /api/pricing/match")[0].searchParams.get("key")).toBe("onion");
      await waitFor(() => expect(backend.requestsTo("GET /api/pricing/matches")).toHaveLength(2));
    });

    it("says so when nothing has been remembered yet", async () => {
      withPicks([]);
      renderApp("/settings");

      expect(await screen.findByText(/nothing remembered yet/i)).toBeInTheDocument();
    });

    it("is not shown before a store is chosen", async () => {
      const backend = mockBackend({
        "GET /api/cart/status": cartStatus({ configured: false }),
        "GET /api/pricing/status": { enabled: true, store: null },
      });
      renderApp("/settings");

      await screen.findByLabelText("ZIP code");
      expect(backend.requestsTo("GET /api/pricing/matches")).toHaveLength(0);
    });
  });
});
