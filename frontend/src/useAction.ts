/**
 * The other half of `useLoad`: what a page does when a write fails.
 *
 * Writes on these pages were bare `await api.something()` calls, so a failure
 * was an unhandled rejection and the screen simply did not change. A tap that
 * silently did nothing is indistinguishable from a tap that missed, and where
 * the page had already drawn the result - the pantry's in-stock switch - it
 * was worse than nothing: the change looked saved, and the next load quietly
 * took it back.
 *
 * So a write reports its failure and puts the screen back. The one exception
 * is the grocery list, which keeps failed checkmarks instead of undoing them,
 * because a tick there records something that happened in the real world.
 */

import { useCallback, useState } from "react";

import { errorMessage } from "./useLoad";

export interface Action {
  /** Message from the last failed write, or null once one succeeds. */
  error: string | null;
  /**
   * Run `write`, reporting a failure rather than throwing it. `undo` puts the
   * screen back when the server did not take the change. Answers whether it
   * did, so a caller only navigates or reloads on success.
   */
  run: (write: () => Promise<unknown>, undo?: () => void) => Promise<boolean>;
}

export function useAction(): Action {
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (write: () => Promise<unknown>, undo?: () => void) => {
    setError(null);
    try {
      await write();
      return true;
    } catch (cause) {
      setError(errorMessage(cause, "That did not go through."));
      undo?.();
      return false;
    }
  }, []);

  return { error, run };
}
