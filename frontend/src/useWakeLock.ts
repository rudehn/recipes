/**
 * Keep the screen on while the component using this is mounted.
 *
 * A phone propped against the flour bin locks after thirty seconds, and waking
 * it means a clean knuckle and a passcode. The Screen Wake Lock API holds the
 * display on - but the browser drops the lock whenever the page is hidden, so
 * it is asked for again each time the page comes back into view.
 *
 * Answers what actually happened rather than what was asked for, so the page
 * can say "Screen may sleep" honestly: a browser without the API, a denied
 * request (Low Power Mode on iOS), or a lock the system took back.
 */

import { useEffect, useState } from "react";

export type WakeLockState = "on" | "off" | "unsupported";

export function useWakeLock(): WakeLockState {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [state, setState] = useState<WakeLockState>(supported ? "off" : "unsupported");

  useEffect(() => {
    if (!supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let stopped = false;

    async function acquire() {
      if (stopped || sentinel || requesting || document.visibilityState !== "visible") return;
      requesting = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (stopped) {
          void lock.release();
          return;
        }
        sentinel = lock;
        setState("on");
        lock.addEventListener("release", () => {
          if (sentinel !== lock) return;
          sentinel = null;
          if (!stopped) setState("off");
        });
      } catch {
        setState("off");
      } finally {
        requesting = false;
      }
    }

    const onVisibilityChange = () => void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel?.release();
      sentinel = null;
    };
  }, [supported]);

  return state;
}
