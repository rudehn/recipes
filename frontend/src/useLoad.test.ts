import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "./api";
import { errorMessage, useLoad } from "./useLoad";

/** A load whose resolution the test controls, one call at a time. */
function deferredLoad<T>() {
  const settlers: { resolve: (value: T) => void; reject: (cause: unknown) => void }[] = [];
  const load = vi.fn(
    () => new Promise<T>((resolve, reject) => settlers.push({ resolve, reject })),
  );
  return { load, settlers };
}

describe("errorMessage", () => {
  it("prefers the server's own wording", () => {
    expect(errorMessage(new Error("Database is down"))).toBe("Database is down");
  });

  it("falls back for an error with nothing to say", () => {
    expect(errorMessage(new Error(""), "Could not reach the server.")).toBe(
      "Could not reach the server.",
    );
    expect(errorMessage("some string", "Could not reach the server.")).toBe(
      "Could not reach the server.",
    );
  });
});

describe("useLoad", () => {
  it("starts out loading, with nothing to show yet", () => {
    const { load } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("holds the loaded value", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].resolve(["rice"]));

    expect(result.current.data).toEqual(["rice"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps a failure distinct from an empty result", async () => {
    // The whole point of the hook: a page must be able to tell "you have
    // nothing" from "we could not ask".
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(new Error("Database is down")));

    expect(result.current.error).toBe("Database is down");
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("explains an error that carries no message", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject("network down"));

    expect(result.current.error).toBe("Could not reach the server.");
  });

  it("clears an earlier error once a reload succeeds", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));
    await act(async () => settlers[0].reject(new Error("Database is down")));

    act(() => result.current.reload());
    await act(async () => settlers[1].resolve(["rice"]));

    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(["rice"]);
  });

  it("reloads when the loader changes, as a new date range does", async () => {
    const first = vi.fn(() => Promise.resolve(["week one"]));
    const second = vi.fn(() => Promise.resolve(["week two"]));
    const { result, rerender } = renderHook(({ load }) => useLoad(load), {
      initialProps: { load: first },
    });
    await waitFor(() => expect(result.current.data).toEqual(["week one"]));

    rerender({ load: second });

    await waitFor(() => expect(result.current.data).toEqual(["week two"]));
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow response that a newer request has already overtaken", async () => {
    // Stepping through planner weeks quickly must not land on an older week's
    // data just because its request finished last.
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    act(() => result.current.reload());
    await act(async () => settlers[1].resolve(["newest"]));
    await act(async () => settlers[0].resolve(["stale"]));

    expect(result.current.data).toEqual(["newest"]);
  });

  it("ignores a failure that a newer request has already overtaken", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    act(() => result.current.reload());
    await act(async () => settlers[1].resolve(["newest"]));
    await act(async () => settlers[0].reject(new Error("Database is down")));

    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(["newest"]);
  });

  it("lets a page update the data optimistically", async () => {
    // Grocery checkmarks and pantry switches flip before the server confirms.
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));
    await act(async () => settlers[0].resolve(["rice"]));

    act(() => result.current.setData((prev) => [...(prev ?? []), "coffee"]));

    expect(result.current.data).toEqual(["rice", "coffee"]);
  });

  it("drops a response that arrives after the page is gone", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result, unmount } = renderHook(() => useLoad(load));

    unmount();
    await act(async () => settlers[0].resolve(["rice"]));

    expect(result.current.data).toBeNull();
  });
});

/** The failure a browser reports when the request never left the device. */
function unreachable() {
  return new NetworkError(new TypeError("Load failed"));
}

describe("useLoad retrying a server it could not reach", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting rather than reporting a failure it is about to retry", async () => {
    // The whole point: a home-screen launch that beats the VPN up must not
    // flash an error at someone who is about to get their data.
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(unreachable()));

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("recovers without the user ever seeing it", async () => {
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(unreachable()));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => settlers[1].resolve(["rice"]));

    expect(result.current.data).toEqual(["rice"]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("gives up and reports once the retries are spent", async () => {
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(unreachable()));
    await act(() => vi.advanceTimersByTimeAsync(400));
    await act(async () => settlers[1].reject(unreachable()));
    await act(() => vi.advanceTimersByTimeAsync(1200));
    await act(async () => settlers[2].reject(unreachable()));

    expect(load).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBe("Could not reach the server.");
    expect(result.current.loading).toBe(false);
  });

  it("takes an answer the server did give at face value", async () => {
    // A 500 is a considered reply. Asking again just delays the bad news.
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(new Error("Database is down")));

    expect(result.current.error).toBe("Database is down");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retry into a page that has gone away", async () => {
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { unmount } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(unreachable()));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("abandons a pending retry when a newer load starts", async () => {
    // Otherwise the retry lands on top of the range the user just asked for.
    vi.useFakeTimers();
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));

    await act(async () => settlers[0].reject(unreachable()));
    act(() => result.current.reload());
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("useLoad repairing itself when the app comes back", () => {
  /** Pretend the app is in the background, as iOS does when it is switched away. */
  function hide() {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  it("loads again when the app returns to the foreground", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    const { result } = renderHook(() => useLoad(load));
    await act(async () => settlers[0].reject(new Error("Could not reach the server.")));

    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => settlers[1].resolve(["rice"]));

    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(["rice"]);
    expect(result.current.error).toBeNull();
  });

  it("loads again when the connection comes back", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    renderHook(() => useLoad(load));
    await act(async () => settlers[0].reject(new Error("Could not reach the server.")));

    await act(async () => void window.dispatchEvent(new Event("online")));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves a page that loaded fine alone", async () => {
    // Refetching every page on every focus would drop the extra pages of
    // recipes someone loaded before switching away.
    const { load, settlers } = deferredLoad<string[]>();
    renderHook(() => useLoad(load));
    await act(async () => settlers[0].resolve(["rice"]));

    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void window.dispatchEvent(new Event("online")));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("waits for the app to be visible before trying", async () => {
    const { load, settlers } = deferredLoad<string[]>();
    renderHook(() => useLoad(load));
    await act(async () => settlers[0].reject(new Error("Could not reach the server.")));

    hide();
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));

    expect(load).toHaveBeenCalledTimes(1);
  });
});
