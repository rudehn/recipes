import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PHONE, below } from "./layout";
import { resizeViewport, setViewportWidth } from "./test/viewport";
import { useMediaQuery } from "./useMediaQuery";

describe("useMediaQuery", () => {
  it("answers on the first render, without waiting for an effect", () => {
    setViewportWidth(375);
    // No act() wrapping a state update and no waitFor: if this needed either,
    // the phone would paint the wide layout for a frame first.
    expect(renderHook(() => useMediaQuery(below(PHONE))).result.current).toBe(true);
  });

  it("does not match a window wider than the query", () => {
    setViewportWidth(1280);
    expect(renderHook(() => useMediaQuery(below(PHONE))).result.current).toBe(false);
  });

  it("matches exactly at the width, the way max-width does", () => {
    setViewportWidth(PHONE);
    expect(renderHook(() => useMediaQuery(below(PHONE))).result.current).toBe(true);
  });

  it("follows the window across the breakpoint", () => {
    setViewportWidth(1280);
    const { result } = renderHook(() => useMediaQuery(below(PHONE)));
    expect(result.current).toBe(false);

    act(() => resizeViewport(375));
    expect(result.current).toBe(true);

    act(() => resizeViewport(1280));
    expect(result.current).toBe(false);
  });

  it("answers no where there is no matchMedia at all", () => {
    // jsdom's own state, and the one every other test in the suite runs in.
    // Read as a type rather than a value: naming the method is enough to trip
    // the unbound-method rule, and there is nothing here to bind it to.
    expect(typeof window.matchMedia).toBe("undefined");
    expect(renderHook(() => useMediaQuery(below(PHONE))).result.current).toBe(false);
  });
});
