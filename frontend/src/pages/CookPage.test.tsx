import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ringAlarm } from "../alarm";
import { PHONE } from "../layout";
import { mockBackend } from "../test/backend";
import { recipe } from "../test/fixtures";
import { renderApp } from "../test/render";
import { setViewportWidth } from "../test/viewport";

vi.mock("../alarm", () => ({ primeAlarm: vi.fn(), ringAlarm: vi.fn() }));

const eggs = recipe({
  id: 11,
  title: "Deviled Eggs",
  servings: 6,
  instructions: [
    "Add the cold eggs to a saucepot and cover with water.",
    "Bring to a boil, then leave the pot covered for about 12 minutes.",
    "Chill the eggs in ice water for 5 minutes.",
  ].join("\n"),
  ingredients: [
    { id: 1, name: "large eggs", quantity: 6, unit: null },
    { id: 2, name: "mayonnaise", quantity: 0.25, unit: "cup" },
    { id: 3, name: "salt", quantity: null, unit: null },
  ],
});

function backend(r = eggs) {
  return mockBackend({ "GET /api/recipes/:id": r });
}

const stepHeading = () => screen.getByRole("heading", { level: 2, name: /^Step/ });

async function cook(route = "/recipes/11/cook") {
  const view = renderApp(route);
  await screen.findByRole("heading", { name: "Deviled Eggs" });
  return view;
}

/** Put a Screen Wake Lock API on the navigator, answering with `sentinel`. */
function giveWakeLock() {
  const sentinel = Object.assign(new EventTarget(), { release: vi.fn(async () => {}) });
  const request = vi.fn(async () => sentinel);
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  return { request, sentinel };
}

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(ringAlarm).mockClear();
});

describe("CookPage", () => {
  it("opens on the first step, outside the app's navigation", async () => {
    backend();
    await cook();

    expect(stepHeading()).toHaveTextContent("Step 1 of 3");
    expect(screen.getByText("Add the cold eggs to a saucepot and cover with water.")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
    expect(screen.getByRole("button", { name: /Back/ })).toBeDisabled();
  });

  it("lists the ingredients as a checklist, without the amounts in the steps", async () => {
    backend();
    await cook();

    const list = screen.getByRole("region", { name: "Ingredients" });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(list).getByText("¼ cup")).toBeInTheDocument();
  });

  it("moves through the steps and finishes back on the recipe", async () => {
    backend();
    const { user } = await cook();

    await user.click(screen.getByRole("button", { name: /Next step/ }));
    expect(stepHeading()).toHaveTextContent("Step 2 of 3");
    await user.click(screen.getByRole("button", { name: /Next step/ }));
    expect(stepHeading()).toHaveTextContent("Step 3 of 3");
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(stepHeading()).toHaveTextContent("Step 2 of 3");
    await user.click(screen.getByRole("button", { name: "Go to step 3" }));

    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Deviled Eggs" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(localStorage.getItem("mise:cook:11")).toBeNull();
  });

  it("follows the arrow keys", async () => {
    backend();
    const { user } = await cook();

    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(stepHeading()).toHaveTextContent("Step 3 of 3");
    await user.keyboard("{ArrowLeft}");
    expect(stepHeading()).toHaveTextContent("Step 2 of 3");
  });

  it("keeps the step and the ticks through a relaunch, and says so", async () => {
    backend();
    const first = await cook();
    await first.user.click(screen.getByRole("checkbox", { name: /large eggs/ }));
    await first.user.click(screen.getByRole("button", { name: /Next step/ }));
    first.unmount();

    const { user } = await cook();
    expect(stepHeading()).toHaveTextContent("Step 2 of 3");
    expect(screen.getByRole("checkbox", { name: /large eggs/ })).toBeChecked();
    expect(screen.getByText(/Picked up where you left off/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(stepHeading()).toHaveTextContent("Step 1 of 3");
    expect(screen.getByRole("checkbox", { name: /large eggs/ })).not.toBeChecked();
    expect(screen.queryByText(/Picked up where you left off/)).toBeNull();
  });

  it("forgets progress from a day ago", async () => {
    localStorage.setItem(
      "mise:cook:11",
      JSON.stringify({ step: 2, checked: [1], timers: [], savedAt: Date.now() - 24 * 3600_000 }),
    );
    backend();
    await cook();

    expect(stepHeading()).toHaveTextContent("Step 1 of 3");
    expect(screen.queryByText(/Picked up where you left off/)).toBeNull();
  });

  it("lands on the last step when the recipe has since lost some", async () => {
    localStorage.setItem(
      "mise:cook:11",
      JSON.stringify({ step: 7, checked: [], timers: [], savedAt: Date.now() }),
    );
    backend();
    await cook();

    expect(stepHeading()).toHaveTextContent("Step 3 of 3");
  });

  it("scales the amounts to the servings the recipe page was showing", async () => {
    backend();
    await cook("/recipes/11/cook?servings=12");

    const list = screen.getByRole("region", { name: /Ingredients/ });
    expect(within(list).getByText("for 12 servings")).toBeVisible();
    expect(within(list).getByText("½ cup")).toBeInTheDocument();
    expect(within(list).getByText("12")).toBeInTheDocument();
  });

  describe("timers", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it("start from the time written in the step, and ring when done", async () => {
      backend();
      const { user } = await cook();
      await user.click(screen.getByRole("button", { name: /Next step/ }));

      await user.click(screen.getByRole("button", { name: "Start a 12 minutes timer" }));
      const tray = screen.getByRole("region", { name: "Timers" });
      expect(within(tray).getByText("Step 2 · 12 minutes")).toBeVisible();
      expect(within(tray).getByText("12:00")).toBeVisible();

      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(within(tray).getByText("7:00")).toBeVisible();
      expect(ringAlarm).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(7 * 60_000);
      });
      expect(within(tray).getByRole("alert")).toHaveTextContent("Done");
      expect(ringAlarm).toHaveBeenCalled();

      await user.click(within(tray).getByRole("button", { name: "Dismiss the 12 minutes timer" }));
      expect(screen.queryByRole("region", { name: "Timers" })).toBeNull();
    });

    it("stop ringing after a minute, but stay until dismissed", async () => {
      backend();
      const { user } = await cook();
      await user.click(screen.getByRole("button", { name: /Next step/ }));
      await user.click(screen.getByRole("button", { name: "Start a 12 minutes timer" }));

      await act(async () => {
        vi.advanceTimersByTime(12 * 60_000 + 60_500);
      });
      vi.mocked(ringAlarm).mockClear();
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      expect(ringAlarm).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("Done");
    });

    it("take another minute", async () => {
      backend();
      const { user } = await cook();
      await user.click(screen.getByRole("button", { name: /Next step/ }));
      await user.click(screen.getByRole("button", { name: /Next step/ }));
      await user.click(screen.getByRole("button", { name: "Start a 5 minutes timer" }));
      const tray = screen.getByRole("region", { name: "Timers" });

      await user.click(within(tray).getByRole("button", { name: "+1 min" }));
      expect(within(tray).getByText("6:00")).toBeVisible();
    });

    it("keep counting through a relaunch", async () => {
      backend();
      const first = await cook();
      await first.user.click(screen.getByRole("button", { name: /Next step/ }));
      await first.user.click(screen.getByRole("button", { name: "Start a 12 minutes timer" }));
      first.unmount();

      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      await cook();

      const tray = screen.getByRole("region", { name: "Timers" });
      expect(within(tray).getByText("10:00")).toBeVisible();
      // Running, so the step offers the countdown rather than a second timer.
      expect(screen.queryByRole("button", { name: "Start a 12 minutes timer" })).toBeNull();
    });

    it("ask before leaving cook mode while one runs", async () => {
      backend();
      const { user } = await cook();
      await user.click(screen.getByRole("button", { name: /Next step/ }));
      await user.click(screen.getByRole("button", { name: "Start a 12 minutes timer" }));

      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      await user.click(screen.getByRole("link", { name: /Exit/ }));
      expect(confirm).toHaveBeenCalled();
      expect(stepHeading()).toHaveTextContent("Step 2 of 3");

      confirm.mockReturnValue(true);
      await user.click(screen.getByRole("link", { name: /Exit/ }));
      expect(await screen.findByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    });
  });

  describe("the screen", () => {
    it("is held on, and says so", async () => {
      const { request } = giveWakeLock();
      backend();
      await cook();

      expect(request).toHaveBeenCalledWith("screen");
      expect(await screen.findByText("Screen stays on")).toBeVisible();
    });

    it("is let go on leaving", async () => {
      const { sentinel } = giveWakeLock();
      backend();
      const { unmount } = await cook();
      await screen.findByText("Screen stays on");

      unmount();
      expect(sentinel.release).toHaveBeenCalled();
    });

    it("may sleep where the browser cannot hold it", async () => {
      backend();
      await cook();

      expect(screen.getByText("Screen may sleep")).toBeVisible();
    });
  });

  describe("on a phone", () => {
    beforeEach(() => setViewportWidth(PHONE - 330));

    it("shows the step or the ingredients, one at a time", async () => {
      backend();
      const { user } = await cook();

      expect(stepHeading()).toBeVisible();
      expect(screen.queryByRole("checkbox")).toBeNull();

      await user.click(screen.getByRole("tab", { name: /Ingredients/ }));
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
      expect(screen.queryByRole("heading", { name: /^Step/ })).toBeNull();

      await user.click(screen.getByRole("checkbox", { name: /large eggs/ }));
      expect(screen.getByRole("tab", { name: /Ingredients/ })).toHaveTextContent("1/3");

      // Next is still under the thumb, and goes back to the steps.
      await user.click(screen.getByRole("button", { name: /Next step/ }));
      expect(stepHeading()).toHaveTextContent("Step 2 of 3");
    });
  });

  it("says a recipe with no steps has none", async () => {
    backend(recipe({ ...eggs, instructions: "" }));
    await cook();

    expect(screen.getByText(/This recipe has no steps yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });
});
