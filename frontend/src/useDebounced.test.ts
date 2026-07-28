import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebounced } from "./useDebounced";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useDebounced", () => {
  it("starts at the value it was given, so the first load is not delayed", () => {
    const { result } = renderHook(() => useDebounced("curry"));

    expect(result.current).toBe("curry");
  });

  it("holds the old value until the new one has stopped changing", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 250), {
      initialProps: { value: "" },
    });

    rerender({ value: "cur" });
    tick(200);
    expect(result.current).toBe("");

    tick(50);
    expect(result.current).toBe("cur");
  });

  it("settles once on the last value typed, not on each one along the way", () => {
    // The reason the hook exists: "curry" typed at speed is one request.
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 250), {
      initialProps: { value: "" },
    });
    const seen: string[] = [];

    for (const value of ["c", "cu", "cur", "curr", "curry"]) {
      rerender({ value });
      tick(50);
      seen.push(result.current);
    }
    tick(250);

    expect(seen).toEqual(["", "", "", "", ""]);
    expect(result.current).toBe("curry");
  });

  it("settles back on a value that was typed and then undone", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 250), {
      initialProps: { value: "curry" },
    });

    rerender({ value: "curryx" });
    tick(100);
    rerender({ value: "curry" });
    tick(250);

    expect(result.current).toBe("curry");
  });

  it("respects a caller's own delay", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 1000), {
      initialProps: { value: "" },
    });

    rerender({ value: "curry" });
    tick(500);
    expect(result.current).toBe("");

    tick(500);
    expect(result.current).toBe("curry");
  });
});
