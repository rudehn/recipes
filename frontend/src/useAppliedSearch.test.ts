import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SEARCH, type Search } from "./recipeSearch";
import { useAppliedSearch } from "./useAppliedSearch";

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

const tagged: Search = { ...EMPTY_SEARCH, tags: ["dinner"] };

describe("useAppliedSearch", () => {
  it("is the search itself while nothing is typed", () => {
    const { result } = renderHook(() => useAppliedSearch(tagged, ""));

    expect(result.current).toBe(tagged);
  });

  it("takes the typing as its text once the typing settles, trimmed", () => {
    const { result, rerender } = renderHook(({ draft }) => useAppliedSearch(tagged, draft), {
      initialProps: { draft: "" },
    });

    rerender({ draft: " curry " });
    expect(result.current).toBe(tagged);

    tick(250);
    expect(result.current).toEqual({ ...tagged, text: "curry" });
  });

  it("leaves a text token alone, whatever is typed", () => {
    const withText: Search = { ...tagged, text: "soup" };
    const { result, rerender } = renderHook(({ draft }) => useAppliedSearch(withText, draft), {
      initialProps: { draft: "" },
    });

    rerender({ draft: "curry" });
    tick(250);

    expect(result.current).toBe(withText);
  });

  it("answers the same object until the search or the settled typing changes", () => {
    const { result, rerender } = renderHook(({ draft }) => useAppliedSearch(tagged, draft), {
      initialProps: { draft: "curry" },
    });
    const first = result.current;

    rerender({ draft: "curry" });

    expect(result.current).toBe(first);
  });
});
