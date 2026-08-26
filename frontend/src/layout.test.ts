/**
 * The guard on the one duplication the token layer cannot absorb.
 *
 * A media query cannot read a custom property, so the two widths in layout.ts
 * are written out in styles.css as well. Nothing makes them agree; these tests
 * make them disagree loudly, which is the same bargain vite.config.ts already
 * strikes for the theme colour.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PHONE, WEEK_GRID, below } from "./layout";

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

  /**
   * WEEK_GRID has no media query of its own - PlannerPage swaps the markup
   * rather than the styling - so what it has to agree with is the grid's own
   * track widths. Widen a track and this fails, which is the moment to decide
   * whether the number moves or the track does.
   */
  it("leaves the week grid before it stops fitting", () => {
    const tracks =
      /\.week-grid\s*\{[^}]*grid-template-columns:\s*(\d+)px repeat\(7,\s*minmax\((\d+)px/.exec(
        css,
      );
    expect(tracks).not.toBeNull();
    const [labels, day] = [Number(tracks![1]), Number(tracks![2])];

    // Eight columns, so seven gaps, inside a page that pays --space-24 either
    // side of itself at this width.
    const grid = labels + 7 * day + 7 * space(6);
    expect(grid + 2 * space(24)).toBeLessThanOrEqual(WEEK_GRID);
  });

  it("puts the phone below the width the week grid needs", () => {
    expect(PHONE).toBeLessThan(WEEK_GRID);
  });
});
