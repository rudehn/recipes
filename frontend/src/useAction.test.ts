import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NetworkError } from "./api";
import { useAction } from "./useAction";

describe("useAction", () => {
  it("starts with nothing to report", () => {
    const { result } = renderHook(() => useAction());

    expect(result.current.error).toBeNull();
  });

  it("answers true and stays quiet when the write goes through", async () => {
    const { result } = renderHook(() => useAction());

    let went: boolean | undefined;
    await act(async () => {
      went = await result.current.run(() => Promise.resolve());
    });

    expect(went).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("reports the server's own words rather than throwing", async () => {
    // The alternative is an unhandled rejection and a screen that does not
    // change, which reads as a tap that missed.
    const { result } = renderHook(() => useAction());

    let went: boolean | undefined;
    await act(async () => {
      went = await result.current.run(() =>
        Promise.reject(new Error("olive oil is already in your pantry.")),
      );
    });

    expect(went).toBe(false);
    expect(result.current.error).toBe("olive oil is already in your pantry.");
  });

  it("explains an unreachable server in words meant for a person", async () => {
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new NetworkError(new TypeError("x"))));
    });

    expect(result.current.error).toBe("Could not reach the server.");
  });

  it("falls back when the failure has nothing to say", async () => {
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("")));
    });

    expect(result.current.error).toBe("That did not go through.");
  });

  it("undoes what the page drew when the write did not happen", async () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Database is down")), undo);
    });

    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("leaves the page alone when the write succeeds", async () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run(() => Promise.resolve(), undo);
    });

    expect(undo).not.toHaveBeenCalled();
  });

  it("clears an earlier failure once a write succeeds", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Database is down")));
    });

    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });

    expect(result.current.error).toBeNull();
  });
});
