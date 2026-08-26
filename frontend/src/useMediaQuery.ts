import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query currently matches.
 *
 * For the two places where a breakpoint changes the markup rather than the
 * styling - the navigation moving to the bottom of the screen, and the
 * planner becoming an agenda - because neither is a restyling of the same
 * elements. A week grid is row-major (a meal, then its seven days) and an
 * agenda is day-major (a day, then its four meals); CSS can reflow a layout
 * but it cannot turn one of those into the other.
 *
 * useSyncExternalStore rather than useState plus an effect, so the first
 * render already knows the answer. An effect would paint the desktop layout
 * for a frame and then swap it, which on a phone is the layout jump this
 * whole change exists to remove.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      // jsdom has no layout and no matchMedia, so under test every query
      // simply does not match and pages render their wide layout. That is the
      // right default: it is the one the existing tests describe.
      const list = window.matchMedia?.(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const matches = useCallback(() => window.matchMedia?.(query).matches ?? false, [query]);

  return useSyncExternalStore(subscribe, matches, () => false);
}
