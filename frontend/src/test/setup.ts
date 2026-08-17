import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library's own auto-cleanup hook
// never registers. Without this, mounted trees pile up across tests and
// queries start matching elements from a previous test.
afterEach(cleanup);

// jsdom implements no object URLs, and the recipe form previews a newly chosen
// photo with one. A fixed string is enough: tests assert that the preview
// points somewhere, never where.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
}

/**
 * jsdom exposes the Storage class but leaves window.localStorage a bare object
 * carrying none of its methods, so every call on it throws TypeError here and
 * nowhere else. Code that persists anything would be untestable, or - worse -
 * would look tested while its try/catch quietly swallowed the environment.
 *
 * A Map is the whole of the contract, and gives tests the one behaviour that
 * matters: a value written by one mount is still there for the next.
 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

if (typeof globalThis.localStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
}

// Storage outlives a render, which is the point of it, so a test that writes
// would otherwise hand its state to whichever test ran next.
afterEach(() => localStorage.clear());
