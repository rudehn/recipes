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
import { describe, expect, it, vi } from "vitest";

import { HttpError, mockBackend, type MockRequest } from "../test/backend";
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

  it("always offers the settings link, since labels are managed there", async () => {
    mockBackend({
      "GET /api/pricing/status": { enabled: false, store: null },
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
    it("points to the ingredients for the products that have been picked", async () => {
      mockBackend({
        "GET /api/cart/status": cartStatus({ configured: false }),
        "GET /api/pricing/status": { enabled: true, store: riverside },
      });
      renderApp("/settings");

      // The nav has an Ingredients link too; this one is the page's own.
      const link = await within(screen.getByRole("main")).findByRole("link", { name: "Ingredients" });
      expect(link).toHaveAttribute("href", "/ingredients?view=all");
      expect(screen.queryByText("Remembered products")).not.toBeInTheDocument();
    });

    it("has no pointer before a store is chosen", async () => {
      mockBackend({
        "GET /api/cart/status": cartStatus({ configured: false }),
        "GET /api/pricing/status": { enabled: true, store: null },
      });
      renderApp("/settings");

      await screen.findByLabelText("ZIP code");
      expect(within(screen.getByRole("main")).queryByRole("link", { name: "Ingredients" })).not.toBeInTheDocument();
    });
  });

  describe("labels", () => {
    const labels = [
      { id: 1, name: "Dad", meals: 12 },
      { id: 2, name: "Kids", meals: 1 },
    ];

    function backendWithLabels(extra = {}) {
      return mockBackend({
        "GET /api/pricing/status": { enabled: false, store: null },
        "GET /api/labels": labels,
        ...extra,
      });
    }

    it("lists each label with the meals it is on", async () => {
      backendWithLabels();
      renderApp("/settings");

      const dad = (await screen.findByText("Dad")).closest("li")!;
      expect(dad).toHaveTextContent("12 meals");
      expect(screen.getByText("Kids").closest("li")).toHaveTextContent("1 meal");
    });

    it("renames a label in place", async () => {
      const backend = backendWithLabels({
        "PATCH /api/labels/:id": (req: MockRequest) => ({ id: 1, ...(req.body as object) }),
      });
      const { user } = renderApp("/settings");

      await user.click(await screen.findByRole("button", { name: "Rename Dad" }));
      const field = screen.getByRole("textbox", { name: "New name for Dad" });
      await user.clear(field);
      await user.type(field, "Daddy{Enter}");

      await waitFor(() => expect(backend.requestsTo("PATCH /api/labels/:id")).toHaveLength(1));
      const patch = backend.requestsTo("PATCH /api/labels/:id")[0];
      expect(patch.path).toBe("/api/labels/1");
      expect(patch.body).toEqual({ name: "Daddy" });
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "New name for Dad" })).not.toBeInTheDocument(),
      );
    });

    it("says so when a rename is refused", async () => {
      backendWithLabels({
        "PATCH /api/labels/:id": new HttpError(409, 'There is already a label called "Kids".'),
      });
      const { user } = renderApp("/settings");

      await user.click(await screen.findByRole("button", { name: "Rename Dad" }));
      const field = screen.getByRole("textbox", { name: "New name for Dad" });
      await user.clear(field);
      await user.type(field, "Kids{Enter}");

      expect(await screen.findByText(/There is already a label/)).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "New name for Dad" })).toBeInTheDocument();
    });

    it("deletes after confirming, saying how many meals it is on", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const backend = backendWithLabels({ "DELETE /api/labels/:id": undefined });
      const { user } = renderApp("/settings");

      await user.click(await screen.findByRole("button", { name: "Delete Dad" }));

      expect(confirm).toHaveBeenCalledWith("Delete “Dad”? It is on 12 meals.");
      await waitFor(() => expect(backend.requestsTo("DELETE /api/labels/:id")).toHaveLength(1));
      expect(backend.requestsTo("DELETE /api/labels/:id")[0].path).toBe("/api/labels/1");
    });

    it("says one meal in the singular, and keeps the label when the confirm is dismissed", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const backend = backendWithLabels({ "DELETE /api/labels/:id": undefined });
      const { user } = renderApp("/settings");

      await user.click(await screen.findByRole("button", { name: "Delete Kids" }));

      expect(confirm).toHaveBeenCalledWith("Delete “Kids”? It is on 1 meal.");
      expect(backend.requestsTo("DELETE /api/labels/:id")).toHaveLength(0);
    });
  });
});
