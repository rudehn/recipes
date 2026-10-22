import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { plannedMeal, recipeSummary } from "../../test/fixtures";
import { MealMenu } from "./MealMenu";

const WINDOW_HEIGHT = 667;
const MENU_HEIGHT = 120;

/** Opens the menu for a button whose bottom edge is `bottom` px down a phone. */
async function openAt(bottom: number, height = MENU_HEIGHT) {
  vi.stubGlobal("innerHeight", WINDOW_HEIGHT);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: bottom - 20,
    bottom,
    left: 300,
    right: 330,
    width: 30,
    height: 20,
    x: 300,
    y: bottom - 20,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
  const user = userEvent.setup();
  render(
    <MealMenu
      meal={plannedMeal({ recipe: recipeSummary({ title: "Curry" }) })}
      labels={[]}
      onCreateLabel={vi.fn()}
      onSetLabels={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Actions for Curry" }));
  return screen.getByRole("menu");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MealMenu placement", () => {
  it("opens down when the space below fits it", async () => {
    const menu = await openAt(100);
    expect(menu.style.top).toBe("104px");
    expect(menu.style.bottom).toBe("");
  });

  it("opens up when only the space above fits it", async () => {
    const menu = await openAt(WINDOW_HEIGHT - 40);
    expect(menu.style.bottom).toBe(`${WINDOW_HEIGHT - (WINDOW_HEIGHT - 60) + 4}px`);
    expect(menu.style.top).toBe("");
    expect(menu.style.maxHeight).toBe(`${WINDOW_HEIGHT - 60 - 12}px`);
  });

  it("takes the side with more room, capped to it, when neither fits", async () => {
    // 325px below the button, 298px above, and a popover of 400px.
    const menu = await openAt(330, 400);
    expect(menu.style.top).toBe("334px");
    expect(menu.style.maxHeight).toBe("325px");
  });
});
