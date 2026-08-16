import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const resolve = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

const TOKENS = resolve("./src/styles.css");
const MANIFEST_SOURCE = resolve("./manifest.source.json");
const MANIFEST_PATH = "manifest.webmanifest";

/**
 * The one colour the browser chrome sees, read from the stylesheet that
 * defines it.
 *
 * The PWA manifest and index.html both need the app's background as a literal
 * string, which is how it came to be written out in three files that had no
 * way of disagreeing loudly. Here it is derived instead: --bg in styles.css is
 * the design token, and everything else is generated from it at build time.
 */
function themeColor(): string {
  const css = readFileSync(TOKENS, "utf8");
  const match = /--bg:\s*([^;]+);/.exec(css);
  if (!match) {
    throw new Error(
      `Could not find --bg in ${TOKENS}. It is the source for the PWA theme ` +
        `colour; renaming it means updating this plugin too.`,
    );
  }
  return match[1].trim();
}

/**
 * Writes the theme colour into index.html and emits the web manifest.
 *
 * The manifest deliberately does not live in public/, which Vite copies
 * verbatim: a copied file could not pick the colour up.
 */
function brandMetadata(): Plugin {
  const manifest = () =>
    JSON.stringify(
      {
        ...JSON.parse(readFileSync(MANIFEST_SOURCE, "utf8")),
        theme_color: themeColor(),
        background_color: themeColor(),
      },
      null,
      2,
    );

  return {
    name: "brand-metadata",

    transformIndexHtml(html) {
      return html.replace(
        /(<meta name="theme-color" content=")[^"]*(")/,
        `$1${themeColor()}$2`,
      );
    },

    // Dev has no bundle to emit into, so the manifest is served on request -
    // which also means editing the token shows up on reload, same as the CSS.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== `/${MANIFEST_PATH}`) return next();
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(manifest());
      });
    },

    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_PATH,
        source: manifest(),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), brandMetadata()],
  server: {
    proxy: {
      // In dev the backend runs separately on :8000.
      "/api": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Spies and stubbed globals (notably fetch) are per-test, so one test
    // cannot leave a mocked backend behind for the next.
    restoreMocks: true,
    unstubGlobals: true,
    // Rendering a page and driving it takes far longer under jsdom than the
    // code being tested ever will, and slower on a shared CI runner than here.
    // A generous ceiling keeps that from reading as a failure; a genuinely
    // hung test still fails, just later.
    testTimeout: 20_000,
  },
});
