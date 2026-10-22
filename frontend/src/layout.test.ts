/**
 * The guard on the one duplication the token layer cannot absorb.
 *
 * A media query cannot read a custom property, so the widths in layout.ts are
 * written out in styles.css as well. Nothing makes them agree; these tests
 * make them disagree loudly, which is the same bargain vite.config.ts already
 * strikes for the theme colour.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PHONE, PICKS_PANEL, PICKS_STRIP, WEEK_GRID, below } from "./layout";

// From the project root: vitest runs there, and import.meta.url is not a file
// URL under the jsdom environment these tests share with the page tests.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/** A --space-N token's value, which is also its name. */
function space(step: number): number {
  const match = new RegExp(`--space-${step}:\\s*(\\d+)px`).exec(css);
  if (!match) throw new Error(`styles.css declares no --space-${step}`);
  return Number(match[1]);
}

describe("layout", () => {
  it("names every width the stylesheet changes shape at", () => {
    const inCss = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(inCss.length).toBeGreaterThan(0);
    for (const width of inCss) {
      expect([PHONE, WEEK_GRID]).toContain(width);
    }
  });

  it("builds the query the stylesheet is written in", () => {
    expect(css).toContain(`@media ${below(PHONE)}`);
  });

  /** The week grid's own least width: its label column, seven days and their gaps. */
  function weekGrid(): number {
    const tracks =
      /\.week-grid\s*\{[^}]*grid-template-columns:\s*(\d+)px repeat\(7,\s*minmax\((\d+)px/.exec(
        css,
      );
    expect(tracks).not.toBeNull();
    const [labels, day] = [Number(tracks![1]), Number(tracks![2])];
    // Eight columns, so seven gaps.
    return labels + 7 * day + 7 * space(6);
  }

  /** The planner's column for its Picks, as `selector` sets it, and the gap after it. */
  function picksColumn(selector: string): { width: number; gap: number } {
    const rule = new RegExp(
      `${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*grid-template-columns:\\s*(\\d+)px minmax\\(0, 1fr\\)`,
    ).exec(css);
    expect(rule).not.toBeNull();
    const gap = /\.planner-body\s*\{[^}]*\bgap:\s*var\(--space-(\d+)\)/.exec(css);
    expect(gap).not.toBeNull();
    return { width: Number(rule![1]), gap: space(Number(gap![1])) };
  }

  /**
   * WEEK_GRID has no media query of its own - PlannerPage swaps the markup
   * rather than the styling - so what it has to agree with is the grid's own
   * track widths, with the Picks strip beside them. Widen a track and this
   * fails, which is the moment to decide whether the number moves or the
   * track does.
   */
  it("leaves the week grid before it stops fitting", () => {
    const strip = picksColumn(".planner-body.picks-collapsed");
    expect(strip.width).toBe(PICKS_STRIP);
    // Inside a page that pays --space-24 either side of itself at this width.
    expect(weekGrid() + strip.width + strip.gap + 2 * space(24)).toBeLessThanOrEqual(WEEK_GRID);
  });

  it("opens the Picks panel beside the grid only where both fit", () => {
    const panel = picksColumn(".planner-body");
    expect(panel.width).toBe(PICKS_PANEL);
    expect(weekGrid() + panel.width + panel.gap + 2 * space(24)).toBeLessThanOrEqual(
      WEEK_GRID + PICKS_PANEL,
    );
  });

  it("widens the planner's page to the width its panel and grid open at", () => {
    const width = /--width-planner:\s*(\d+)px/.exec(css);
    expect(width).not.toBeNull();
    expect(Number(width![1])).toBe(WEEK_GRID + PICKS_PANEL);
  });

  it("puts the phone below the width the week grid needs", () => {
    expect(PHONE).toBeLessThan(WEEK_GRID);
  });
});
