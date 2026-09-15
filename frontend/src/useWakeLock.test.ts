import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWakeLock } from "./useWakeLock";

function lockable(request: () => Promise<unknown>) {
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
}

function sentinel() {
  return Object.assign(new EventTarget(), { release: vi.fn(async () => {}) });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useWakeLock", () => {
  it("is unsupported without the API", () => {
    const { result } = renderHook(() => useWakeLock());
    expect(result.current).toBe("unsupported");
  });

  it("holds the screen on, and lets go on unmount", async () => {
    const lock = sentinel();
    const request = vi.fn(async () => lock);
    lockable(request);

    const { result, unmount } = renderHook(() => useWakeLock());
    await waitFor(() => expect(result.current).toBe("on"));
    expect(request).toHaveBeenCalledWith("screen");

    unmount();
    expect(lock.release).toHaveBeenCalled();
  });

  it("asks again when the page comes back after the browser dropped it", async () => {
    const first = sentinel();
    const second = sentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    lockable(request);

    const { result } = renderHook(() => useWakeLock());
    await waitFor(() => expect(result.current).toBe("on"));

    // What a browser does to a hidden page's lock.
    act(() => {
      setVisibility("hidden");
      first.dispatchEvent(new Event("release"));
    });
    expect(result.current).toBe("off");

    act(() => setVisibility("visible"));
    await waitFor(() => expect(result.current).toBe("on"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("is off when the request is refused", async () => {
    lockable(vi.fn(async () => Promise.reject(new DOMException("Low battery", "NotAllowedError"))));

    const { result } = renderHook(() => useWakeLock());
    await waitFor(() => expect(result.current).toBe("off"));
  });
});
