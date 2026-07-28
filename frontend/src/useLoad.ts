/**
 * Loading state for a page's initial fetch, with failure kept distinct from
 * emptiness.
 *
 * Pages used to swallow load errors into an empty value (`.catch(() => [])`),
 * which renders a backend outage as "you have no recipes" - the one message a
 * self-hosted app must never show by accident. Here a failure sets `error` and
 * leaves `data` null, so a page can tell "nothing yet" from "could not ask".
 *
 * A failure that never reached the server is retried a couple of times before
 * it is reported at all, and a page left showing one repairs itself when the
 * app returns to the foreground. Between them, the common case - a home-screen
 * launch racing the VPN - resolves without the user seeing anything.
 *
 * `data` stays settable so pages can apply an optimistic update before the
 * server confirms it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { NetworkError } from "./api";

/**
 * How long to wait before each further attempt at a request that never reached
 * the server.
 *
 * Sized for the case that causes it: launching from the iOS home screen while
 * Tailscale is still bringing the tunnel up, which takes a second or two. The
 * page stays on its loading state throughout, so a tunnel that connects in
 * time is invisible rather than an error the user has to dismiss. Two waits
 * bound the delay before a genuine outage is reported at about 1.6s.
 */
const RETRY_DELAYS_MS = [400, 1200];

export interface Load<T> {
  /** The loaded value, or null before the first success. */
  data: T | null;
  setData: Dispatch<SetStateAction<T | null>>;
  /** Message from the failed load, or null when the last attempt succeeded. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * Run `load` on mount and whenever its identity changes, so callers control
 * refetching by memoizing it (`useCallback(() => api.groceryList(a, b), [a, b])`).
 */
export function useLoad<T>(load: () => Promise<T>): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Only the newest request may write state. Without this, switching the
  // grocery date range twice quickly can let the first response land last and
  // overwrite the range the user is actually looking at.
  const latest = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reload = useCallback(() => {
    const attempt = ++latest.current;
    clearTimeout(retryTimer.current);
    setLoading(true);

    const tryLoad = (retries: number) => {
      load().then(
        (result) => {
          if (attempt !== latest.current) return;
          setData(result);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
          if (attempt !== latest.current) return;
          if (cause instanceof NetworkError && retries < RETRY_DELAYS_MS.length) {
            retryTimer.current = setTimeout(() => {
              if (attempt !== latest.current) return;
              tryLoad(retries + 1);
            }, RETRY_DELAYS_MS[retries]);
            return;
          }
          setError(errorMessage(cause, "Could not reach the server."));
          setLoading(false);
        },
      );
    };

    tryLoad(0);
  }, [load]);

  useEffect(reload, [reload]);

  // A stale request must not resolve into an unmounted page either, and a retry
  // must not outlive the page that wanted it.
  useEffect(
    () => () => {
      ++latest.current;
      clearTimeout(retryTimer.current);
    },
    [],
  );

  /**
   * Try a failed load again when the app comes back to life.
   *
   * iOS discards a standalone web app aggressively, so returning to it often
   * means a fresh launch whose first request lost a race with the network.
   * Coming back to the foreground, or regaining a connection, is the moment
   * that request would now succeed - and it saves the user pressing a button
   * to be told what the app could have found out for itself.
   *
   * Only a page that is already showing a failure does this. Refetching every
   * page on every focus would also throw away state the user built up, like
   * the extra pages of recipes behind "Load more".
   */
  const failed = error !== null;
  useEffect(() => {
    if (!failed) return;
    const repair = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", repair);
    window.addEventListener("online", repair);
    return () => {
      document.removeEventListener("visibilitychange", repair);
      window.removeEventListener("online", repair);
    };
  }, [failed, reload]);

  return { data, setData, error, loading, reload };
}
