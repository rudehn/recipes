/**
 * The matchMedia jsdom does not have.
 *
 * jsdom implements no layout and so no media queries at all, which leaves
 * useMediaQuery answering "nothing matches" - the wide layout, and the one
 * every test that does not call this describes. A test about the phone has to
 * say it is about the phone, and this is how it says it.
 *
 * Only "(max-width: Npx)" is understood, because that is the only shape
 * layout.ts produces. Anything else throws rather than quietly answering no:
 * a query this cannot evaluate is a test that would pass for the wrong reason.
 */

import { vi } from "vitest";

const MAX_WIDTH = /^\(max-width:\s*(\d+)px\)$/;

interface Registered {
  query: string;
  list: MediaQueryList;
  listeners: Set<(event: MediaQueryListEvent) => void>;
}

let width = 0;
let registered: Registered[] = [];

function matches(query: string): boolean {
  const limit = MAX_WIDTH.exec(query);
  if (!limit) {
    throw new Error(
      `setViewportWidth understands "(max-width: Npx)" and was given ${JSON.stringify(query)}.`,
    );
  }
  return width <= Number(limit[1]);
}

/**
 * Render as though the window were `px` wide.
 *
 * Call before rendering. Any previous stub and its subscribers are dropped, so
 * a test starts from nothing the way it would in its own window.
 */
export function setViewportWidth(px: number): void {
  width = px;
  registered = [];

  vi.stubGlobal("matchMedia", (query: string) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const list = {
      media: query,
      get matches() {
        return matches(query);
      },
      addEventListener: (_: "change", fn: (event: MediaQueryListEvent) => void) =>
        void listeners.add(fn),
      removeEventListener: (_: "change", fn: (event: MediaQueryListEvent) => void) =>
        void listeners.delete(fn),
      // The deprecated pair, and dispatchEvent, are not implemented: nothing in
      // the app reaches for them, and a stub that answers calls the real thing
      // would never see is a way to pass a test the browser would fail.
    } as unknown as MediaQueryList;
    registered.push({ query, list, listeners });
    return list;
  });
}

/**
 * Resize the window a test has already stubbed, notifying whatever subscribed.
 *
 * Separate from setViewportWidth because a subscriber holds the MediaQueryList
 * it was given: replacing the stub would leave React listening to an object
 * nothing will ever tell about the change.
 */
export function resizeViewport(px: number): void {
  width = px;
  for (const { query, list, listeners } of registered) {
    const event = { matches: matches(query), media: query } as MediaQueryListEvent;
    for (const listener of listeners) listener.call(list, event);
  }
}
