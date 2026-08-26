/**
 * How the built app is served, which is not a detail the app can check itself.
 *
 * This one went wrong quietly. The hashed bundles were marked immutable, which
 * is right, but index.html - the only file that names them - was served with
 * no freshness at all, so caches invented their own and a phone went on
 * loading last week's build. Nothing failed: the old bundles were still on
 * disk and still immutable, so the old app worked perfectly. The only symptom
 * was a version from before, on one device, indefinitely.
 *
 * Nothing in a browser test can see this: vitest never runs nginx, and the app
 * has no service worker to notice its own age. So it is asserted against the
 * config that produces it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conf = readFileSync(resolve(process.cwd(), "nginx.conf"), "utf8");

/** The body of a `location <match>` block, braces balanced. */
function location(match: string): string {
  const header = `location ${match} {`;
  const start = conf.indexOf(header);
  expect(start, `nginx.conf has no "${header}"`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = start + header.length - 1; i < conf.length; i++) {
    if (conf[i] === "{") depth++;
    else if (conf[i] === "}" && --depth === 0) {
      return conf.slice(start + header.length, i);
    }
  }
  throw new Error(`Unbalanced braces after "${header}"`);
}

const cacheControl = (block: string) =>
  /add_header\s+Cache-Control\s+"([^"]+)"/.exec(block)?.[1] ?? null;

describe("what the browser is allowed to keep", () => {
  it("lets the hashed bundles be kept forever, because they are", () => {
    const header = cacheControl(location("/assets/"));
    expect(header).toContain("immutable");
    expect(header).toMatch(/max-age=\d{7,}/);
  });

  /**
   * The entry points: unhashed filenames whose content changes under them.
   * A cache with no instruction is entitled to guess, and the usual guess is a
   * tenth of the file's age - so the longer a build survives, the longer the
   * next visitor may keep it.
   */
  it.each(["= /index.html", "= /manifest.webmanifest"])(
    "makes %s ask before reusing it",
    (match) => {
      expect(cacheControl(location(match))).toBe("no-cache");
    },
  );

  /**
   * no-cache, not no-store. The distinction is the whole cost of the fix: the
   * copy may be kept and revalidated, which is a 304 and no body whenever
   * nothing changed. no-store would re-download the page on every launch.
   */
  it("keeps revalidation cheap rather than refusing to store", () => {
    expect(conf).not.toMatch(/Cache-Control\s+"[^"]*no-store/);
  });

  /**
   * The SPA fallback is an internal redirect, so a deep link re-enters the
   * index.html block and is served with its header. Were the fallback to serve
   * the file itself - a root/index pair, or a named location - every route but
   * "/" would go back to having no header at all, which is the shape the bug
   * had.
   */
  it("routes deep links back through the page's own block", () => {
    expect(location("/")).toMatch(/try_files\s+\$uri\s+\/index\.html\s*;/);
  });
});
