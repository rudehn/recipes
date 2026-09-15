/**
 * The app shell, which is to say: can you get to the other four sections.
 *
 * On a phone the answer used to be no. The five links measured 387px laid out
 * as a row of pills in the top bar, on a screen 375px wide, so Settings sat
 * past the right-hand edge - and because the row overflowed, every page in the
 * app scrolled sideways and the browser zoomed out to fit. The tab bar is what
 * that overflow was traded for, and these are the tests that say so.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PHONE } from "./layout";
import { mockBackend } from "./test/backend";
import { renderApp } from "./test/render";
import { setViewportWidth } from "./test/viewport";

const SECTIONS = ["Recipes", "Planner", "Groceries", "Pantry"];

/** Pricing off, which is the common case and hides the Settings link. */
function plainBackend() {
  return mockBackend({
    "GET /api/pricing/status": { enabled: false, store: null },
    "GET /api/recipes": { items: [], total: 0, page: 1, per_page: 24 },
    "GET /api/recipes/tags": [],
  });
}

function priced() {
  return mockBackend({
    "GET /api/pricing/status": {
      enabled: true,
      store: { location_id: "1", name: "Kroger", address: "1 Main St", chain: "KROGER" },
    },
    "GET /api/recipes": { items: [], total: 0, page: 1, per_page: 24 },
    "GET /api/recipes/tags": [],
  });
}

/** The one nav on the page, whichever of the two layouts rendered it. */
function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sections" });
}

describe("App shell", () => {
  describe("on a wide window", () => {
    it("puts the sections in the top bar", async () => {
      plainBackend();
      renderApp("/recipes");

      expect(nav()).toHaveClass("nav");
      expect(document.querySelector(".tabbar")).toBeNull();
    });

    it("still lists every section", async () => {
      plainBackend();
      renderApp("/recipes");

      for (const label of SECTIONS) {
        expect(within(nav()).getByRole("link", { name: label })).toBeInTheDocument();
      }
    });
  });

  describe("on a phone", () => {
    it("moves the sections to a tab bar along the bottom", () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/recipes");

      expect(nav()).toHaveClass("tabbar");
      expect(document.querySelector(".nav")).toBeNull();
    });

    it("leaves no section off the screen", () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/recipes");

      // The visible words, in order. textContent would carry the glyph too,
      // which is the one part of a tab that is not meant to be read.
      expect([...nav().querySelectorAll(".nav-label")].map((n) => n.textContent)).toEqual(
        SECTIONS,
      );
    });

    /**
     * The bug in one test. Settings is the fifth link, and the fifth link was
     * the one that sat past the edge of the screen - so of the whole nav it is
     * the one that has to be reachable, not merely present.
     */
    it("reaches Settings, which used to sit off the edge", async () => {
      setViewportWidth(375);
      priced();
      renderApp("/recipes");

      const settings = await within(nav()).findByRole("link", { name: "Settings" });
      expect(settings).toHaveAttribute("href", "/settings");
    });

    it("hides Settings while pricing is off, as the top bar does", async () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/recipes");

      await waitFor(() =>
        expect(within(nav()).getAllByRole("link")).toHaveLength(SECTIONS.length),
      );
      expect(within(nav()).queryByRole("link", { name: "Settings" })).toBeNull();
    });

    /**
     * The glyph is decoration beside a word that already says it. Left
     * readable it would be announced too, and "book Recipes" is a section
     * nobody named.
     */
    it("names a tab by its label alone", () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/recipes");

      const tab = within(nav()).getByRole("link", { name: "Recipes" });
      expect(tab.querySelector(".nav-glyph")).toHaveAttribute("aria-hidden");
    });

    it("marks the section being viewed", () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/pantry");

      expect(within(nav()).getByRole("link", { name: "Pantry" })).toHaveClass("active");
    });

    it("keeps the app's name in the top bar, which now has room for it", () => {
      setViewportWidth(375);
      plainBackend();
      renderApp("/recipes");

      expect(screen.getByText("Mise")).toBeVisible();
    });
  });

  it("steps aside for cook mode, which has the whole screen", async () => {
    setViewportWidth(375);
    mockBackend({
      "GET /api/recipes/:id": {
        id: 1,
        title: "Curry",
        description: "",
        image_filename: null,
        prep_minutes: null,
        cook_minutes: null,
        servings: null,
        tags: [],
        instructions: "Simmer",
        ingredients: [],
      },
    });
    renderApp("/recipes/1/cook");

    expect(await screen.findByRole("heading", { name: "Curry" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
    expect(screen.queryByText("Mise")).toBeNull();
  });

  it("hands over at the width the stylesheet does", () => {
    setViewportWidth(PHONE);
    plainBackend();
    renderApp("/recipes");

    expect(nav()).toHaveClass("tabbar");
  });
});
