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

/**
 * The tag bar on a phone. Wrapped, a box with a dozen tags put three rows of
 * pills between the search field and the first recipe, and that wall grew
 * with every tag. One row that scrolls sideways costs one row however many
 * tags there are - which no rendered test can see, since jsdom lays nothing
 * out.
 */
describe("the tag bar on a phone", () => {
  const rule = (selector: string) => {
    const match = new RegExp(`(?:^|[\\s}])\\${selector}\\s*\\{([^}]*)\\}`).exec(
      mediaBlock(below(PHONE)),
    );
    expect(match, `the phone block has no ${selector} rule`).not.toBeNull();
    return match![1];
  };

  it("is one row that scrolls sideways rather than wrapping", () => {
    expect(rule(".tag-filter")).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule(".tag-filter")).toMatch(/overflow-x:\s*auto/);
  });

  it("keeps every pill whole instead of squeezing them to fit", () => {
    expect(rule(".tag-filter .tag-pill")).toMatch(/flex:\s*none/);
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

  it("lets the controls beside a recipe's photo be narrower than a file input wants", () => {
    // A file input is as wide as the platform draws it - about 360px in
    // Chrome on a phone - and a flex item will not shrink below its content
    // unless told it may. Beside the photo's preview that ran the column off
    // the screen, and the whole edit form scrolled sideways.
    expect(css).toMatch(/\.image-drop-actions\s*\{[^}]*min-width:\s*0/);
  });
});

/**
 * A recipe's amounts and names, which jsdom lays out no more than it does
 * anything else. Laid out one row at a time, a long amount ("½ teaspoon") was
 * squeezed to the column's minimum and ran into its name - found in real
 * recipes, and only visible in a browser. What is assertable is that the rows
 * still share the list's columns, which is what keeps the amount column as
 * wide as the widest amount.
 */
/**
 * The recipes page's folds: a card per recipe, the recipe on the left and its
 * lines on the right. When the right-hand block was as wide as its longest
 * line, every card's lines started somewhere else and the fold read ragged -
 * visible only laid out, so what is assertable is that the split is the
 * card's, not the content's.
 */
describe("the recipes page's folds", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("splits every card at the same place, whatever its lines say", () => {
    expect(rule(".offer")).toMatch(/display:\s*grid/);
    expect(rule(".offer")).toMatch(/grid-template-columns:\s*minmax\(0,\s*\d+fr\)\s+minmax\(0,\s*\d+fr\)/);
  });

  it("lets no right-hand block size itself to its content", () => {
    for (const selector of [".offer-items", ".attention-groups"]) {
      expect(rule(selector), `${selector} has no rule`).not.toBe("");
      expect(rule(selector)).not.toMatch(/max-width|flex:\s*none/);
    }
  });
});

describe("the ingredient list", () => {
  it("gives every row the list's columns, so names start after the widest amount", () => {
    expect(css).toMatch(/\.ingredient-list\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.ingredient-list li\s*\{[^}]*grid-template-columns:\s*subgrid/);
  });
});
