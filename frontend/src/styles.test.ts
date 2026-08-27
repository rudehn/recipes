/**
 * The stylesheet invariants no rendered test can see.
 *
 * jsdom has no layout and applies no stylesheet, so a page test cannot notice
 * that a field went back under 16px - and neither can a person, on the laptop
 * where it does nothing. It shows up only on an iPhone, as the app being
 * zoomed in and staying that way, which is a long way from the line that
 * caused it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PHONE, below } from "./layout";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/**
 * The size at which iOS Safari stops zooming the page when a control takes
 * focus. Not a design choice and not ours to change - it is the platform's,
 * and it is written here so the assertions below can say why.
 */
const IOS_ZOOM_FLOOR = 16;

/** Every touch device, whatever its width - see the block itself for why. */
const TOUCH = "(pointer: coarse)";

/** The body of the first @media block matching `query`, braces balanced. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  expect(start, `styles.css has no "@media ${query}" block`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`Unbalanced braces after "@media ${query}"`);
}

function token(name: string): number {
  const match = new RegExp(`${name}:\\s*([\\d.]+)px`).exec(css);
  if (!match) throw new Error(`styles.css declares no ${name}`);
  return Number(match[1]);
}

describe("form controls on a touch screen", () => {
  it("sets them at or above the size iOS zooms below", () => {
    expect(token("--text-control")).toBeGreaterThanOrEqual(IOS_ZOOM_FLOOR);
  });

  it("reaches for that size rather than inheriting the body's", () => {
    // --text-body is deliberately under the floor - it is what the page reads
    // at - which is exactly why a field on a touch screen cannot inherit it.
    expect(token("--text-body")).toBeLessThan(IOS_ZOOM_FLOOR);
    expect(mediaBlock(TOUCH)).toMatch(
      /input,\s*select,\s*textarea\s*\{\s*font-size:\s*var\(--text-control\);\s*\}/,
    );
  });

  /**
   * Asked of the pointer, not the width. An iPad in portrait is 768px across -
   * wider than any phone breakpoint, and zooming exactly the same - so a rule
   * that lived in the phone block would leave the tablet broken and look fixed.
   */
  it("asks about the pointer rather than the width", () => {
    expect(mediaBlock(below(PHONE))).not.toMatch(/input,\s*select,\s*textarea/);
  });

  it("leaves no rule setting one smaller after that", () => {
    for (const block of [mediaBlock(TOUCH), mediaBlock(below(PHONE))]) {
      const rules = [...block.matchAll(/([^{}]*(?:input|select|textarea)[^{}]*)\{([^}]*)\}/g)];
      for (const [, selector, body] of rules) {
        const size = /font-size:\s*([\d.]+)px/.exec(body);
        if (!size) continue;
        expect(
          Number(size[1]),
          `${selector.trim()} sets a font-size iOS will zoom the page for`,
        ).toBeGreaterThanOrEqual(IOS_ZOOM_FLOOR);
      }
    }
  });
});

/**
 * The date fields, which are a different control on the device than anywhere
 * a test can reach.
 *
 * Safari on a phone draws input[type=date] as its own native control, sized to
 * itself, and that size wins over the width the page asks for until the
 * appearance is reset. A desktop WebKit draws the desktop control instead, so
 * this is invisible to a laptop browser and to Playwright's WebKit alike - it
 * was found on an actual iPhone and can only be re-found on one. What is
 * assertable is that the rules that answer it are still here.
 */
describe("date fields", () => {
  const touch = () => mediaBlock(TOUCH);

  it("resets the native appearance that carries the sizing", () => {
    expect(touch()).toMatch(
      /input\[type="date"\]\s*\{[^}]*-webkit-appearance:\s*none/,
    );
    expect(touch()).toMatch(/input\[type="date"\]\s*\{[^}]*[^-]appearance:\s*none/);
  });

  /**
   * The load-bearing one. min-width beats max-width in the cascade, so a
   * control demanding a width of its own cannot be reined in by the max-width
   * backstop below - only by being told its minimum is nothing.
   */
  it("lets the control be narrower than it would choose", () => {
    expect(touch()).toMatch(/input\[type="date"\]\s*\{[^}]*min-width:\s*0/);
  });

  it("keeps a backstop on every control, and the calendar glyph off touch", () => {
    // Weaker than min-width, but it catches the ordinary case of a control
    // simply being given too much room.
    expect(css).toMatch(/input,\s*select,\s*textarea\s*\{[^}]*max-width:\s*100%/);
    // Scoped to a coarse pointer: a mouse-driven browser draws a calendar icon
    // for itself, and resetting the appearance there would throw it away.
    const outside = css.replace(touch(), "");
    expect(outside).not.toMatch(/input\[type="date"\]/);
  });
});

describe("the phone's edges", () => {
  it("pays the safe-area inset on everything the content reaches", () => {
    const phone = mediaBlock(below(PHONE));
    // The top bar and the page are the two elements that span the full width,
    // so in landscape on a notched phone they are the two that run under it.
    for (const selector of [".topbar-inner", ".page"]) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(phone);
      expect(rule, `the phone block has no ${selector} rule`).not.toBeNull();
      expect(rule![1]).toContain("env(safe-area-inset-left)");
      expect(rule![1]).toContain("env(safe-area-inset-right)");
    }
  });

  it("keeps the tab bar clear of the home indicator", () => {
    const bar = /\.tabbar\s*\{([^}]*)\}/.exec(css);
    expect(bar).not.toBeNull();
    expect(bar![1]).toContain("env(safe-area-inset-bottom)");
  });

  it("leaves the page room to scroll clear of the tab bar", () => {
    // Both read --tabbar, so the bar's height and the room left for it cannot
    // be changed apart.
    expect(css).toMatch(/\.tabbar a\s*\{[^}]*min-height:\s*var\(--tabbar\)/);
    expect(mediaBlock(below(PHONE))).toMatch(
      /\.page\s*\{[^}]*padding-bottom:[^;]*var\(--tabbar\)/,
    );
  });
});
