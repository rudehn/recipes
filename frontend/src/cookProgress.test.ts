import { describe, expect, it } from "vitest";

import {
  STALE_AFTER_MS,
  clearProgress,
  freshProgress,
  loadProgress,
  saveProgress,
} from "./cookProgress";

const timer = { id: "t1", step: 1, at: 40, text: "12 minutes", endsAt: 1_000_000 };

describe("cook progress", () => {
  it("is fresh for a recipe never cooked", () => {
    expect(loadProgress(1)).toEqual(freshProgress());
  });

  it("comes back as it was saved", () => {
    saveProgress(1, { step: 2, checked: [5, 6], timers: [timer] }, 1000);
    expect(loadProgress(1, 2000)).toEqual({ step: 2, checked: [5, 6], timers: [timer] });
    expect(loadProgress(2, 2000)).toEqual(freshProgress());
  });

  it("is dropped once stale", () => {
    saveProgress(1, { step: 2, checked: [], timers: [] }, 1000);
    expect(loadProgress(1, 1000 + STALE_AFTER_MS + 1)).toEqual(freshProgress());
    expect(localStorage.getItem("mise:cook:1")).toBeNull();
  });

  it("stores nothing for a cook who has not started", () => {
    saveProgress(1, freshProgress());
    expect(localStorage.getItem("mise:cook:1")).toBeNull();
  });

  it("survives something unreadable", () => {
    localStorage.setItem("mise:cook:1", "{not json");
    expect(loadProgress(1)).toEqual(freshProgress());
    localStorage.setItem("mise:cook:1", JSON.stringify({ savedAt: Date.now(), step: -3, checked: "x" }));
    expect(loadProgress(1)).toEqual(freshProgress());
  });

  it("can be cleared", () => {
    saveProgress(1, { step: 1, checked: [], timers: [] });
    clearProgress(1);
    expect(localStorage.getItem("mise:cook:1")).toBeNull();
  });
});
