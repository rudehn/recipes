import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const resolve = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

const TOKENS = resolve("./src/styles.css");
const MANIFEST_SOURCE = resolve("./manifest.source.json");
const MANIFEST_PATH = "manifest.webmanifest";

const stylesheet = () => readFileSync(TOKENS, "utf8");

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
  const match = /--bg:\s*([^;]+);/.exec(stylesheet());
  if (!match) {
    throw new Error(
      `Could not find --bg in ${TOKENS}. It is the source for the PWA theme ` +
        `colour; renaming it means updating this plugin too.`,
    );
  }
  return match[1].trim();
}

/** The same token again, as the dark theme redefines it. */
function darkThemeColor(): string {
  // Loose about the rest of the query on purpose. It only has to find the
  // block that answers "dark"; pinning the exact text would break the build
  // over an added condition or a reordered one.
  const match =
    /@media[^{]*prefers-color-scheme:\s*dark[^{]*\{[\s\S]*?--bg:\s*([^;]+);/.exec(
      stylesheet(),
    );
  if (!match) {
    throw new Error(
      `Could not find --bg inside the dark theme block in ${TOKENS}. The dark ` +
        `theme-color meta is generated from it.`,
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
      return html
        .replace(
          /(<meta name="theme-color" content=")[^"]*(")/,
          `$1${themeColor()}$2`,
        )
        .replace(
          /(<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content=")[^"]*(")/,
          `$1${darkThemeColor()}$2`,
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

const HEADING = /\/\*\s*-+\s*(.+?)\s*-+\s*\*\//;
const DECLARATION = /^\s*(--[\w-]+):\s*(.+?);\s*$/;

/** The :root block, as the groups its section comments already divide it into. */
function parseTokens(css: string) {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!root) return [];

  const groups: { name: string; tokens: { name: string; value: string }[] }[] = [];
  let current = { name: "Tokens", tokens: [] as { name: string; value: string }[] };

  for (const line of root[1].split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      if (current.tokens.length > 0) groups.push(current);
      current = { name: heading[1], tokens: [] };
      continue;
    }
    const declaration = DECLARATION.exec(line);
    if (declaration) {
      current.tokens.push({ name: declaration[1], value: declaration[2] });
    }
  }
  if (current.tokens.length > 0) groups.push(current);
  return groups;
}

/**
 * Exposes the token block to the styleguide as `virtual:design-tokens`.
 *
 * The page could import the stylesheet with ?raw and parse it in the browser,
 * but that ships 23kB of CSS text to do work that only ever has one answer -
 * and vitest stubs CSS modules, so ?raw arrives empty under test. Parsing here
 * gives the page plain data, keeps the styleguide honest (it renders whatever
 * the stylesheet actually declares), and works the same in dev, build and test.
 */
const VIRTUAL_ID = "virtual:design-tokens";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

function designTokens(): Plugin {
  return {
    name: "design-tokens",

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },

    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(parseTokens(stylesheet()))};`;
    },

    // Editing a token should move the styleguide on the next reload, the same
    // as editing any other part of the stylesheet does.
    handleHotUpdate({ file, server, modules }) {
      if (file !== TOKENS) return undefined;
      const virtual = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (!virtual) return undefined;
      server.moduleGraph.invalidateModule(virtual);
      return [...modules, virtual];
    },
  };
}

export default defineConfig({
  plugins: [react(), brandMetadata(), designTokens()],
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
