import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RepeatMenu } from "./RepeatMenu";

const TUESDAY = "2026-08-04";
const WEDNESDAY = "2026-07-29";

function open(props: { day: string; current: number[] | null; past?: boolean }) {
  const onChoose = vi.fn();
  const user = userEvent.setup();
  render(<RepeatMenu past={false} {...props} onChoose={onChoose} />);
  return { onChoose, user };
}

/** The choices, in order, by the names they are announced with. */
function expectChoices(names: string[]) {
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(names.length);
  buttons.forEach((b, i) => expect(b).toHaveAccessibleName(names[i]));
}

describe("RepeatMenu", () => {
  it("offers the weekday of the meal's own day", () => {
    open({ day: TUESDAY, current: null });
    expectChoices(["Just this day", "Every Tuesday", "Weekdays", "Every day", "Custom…"]);
    expect(screen.getByRole("button", { name: "Just this day" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says a repeated meal's days change from its day on, and marks the current ones", () => {
    open({ day: WEDNESDAY, current: [0, 1, 2, 3, 4] });
    expectChoices([
      "Just this day",
      "Every Wednesday from Wed, Jul 29 on",
      "Weekdays from Wed, Jul 29 on",
      "Every day from Wed, Jul 29 on",
      "Custom…",
    ]);
    expect(
      screen.getByRole("button", { name: "Weekdays from Wed, Jul 29 on" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Just this day" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("says under a repeated meal's Just this day that it ends the repeat", () => {
    open({ day: WEDNESDAY, current: [0, 1, 2, 3, 4] });
    expect(screen.getByRole("button", { name: "Just this day" })).toHaveAccessibleDescription(
      "Stops repeating after Wed, Jul 29",
    );
    expect(screen.getByText("Stops repeating after Wed, Jul 29")).toBeVisible();
  });

  it("gives a one-off's Just this day no line under it", () => {
    open({ day: WEDNESDAY, current: null });
    const just = screen.getByRole("button", { name: "Just this day" });
    expect(just).toHaveTextContent(/^Just this day$/);
    expect(just).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/Stops repeating/)).not.toBeInTheDocument();
  });

  it("answers a pattern's weekdays, and null for Just this day", async () => {
    const { onChoose, user } = open({ day: TUESDAY, current: null });
    await user.click(screen.getByRole("button", { name: "Every Tuesday" }));
    await user.click(screen.getByRole("button", { name: "Weekdays" }));
    await user.click(screen.getByRole("button", { name: "Every day" }));
    await user.click(screen.getByRole("button", { name: "Just this day" }));
    expect(onChoose.mock.calls).toEqual([
      [[1]],
      [[0, 1, 2, 3, 4]],
      [[0, 1, 2, 3, 4, 5, 6]],
      [null],
    ]);
  });

  it("starts Custom from the repeat's own weekdays", async () => {
    const { onChoose, user } = open({ day: WEDNESDAY, current: [0, 2, 4] });
    await user.click(screen.getByRole("button", { name: "Custom…" }));

    const pressed = screen
      .getAllByRole("button", { pressed: true })
      .map((b) => b.getAttribute("aria-label"));
    expect(pressed).toEqual(["Monday", "Wednesday", "Friday"]);
    expect(screen.getByText("Mon, Wed, Fri from Wed, Jul 29 on")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tuesday" }));
    await user.click(screen.getByRole("button", { name: "Friday" }));
    expect(screen.getByText("Mon, Tue, Wed from Wed, Jul 29 on")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith([0, 1, 2]);
  });

  it("names a custom set that is one of the patterns", async () => {
    const { user } = open({ day: WEDNESDAY, current: [0, 1, 2, 3, 4, 5] });
    await user.click(screen.getByRole("button", { name: "Custom…" }));
    await user.click(screen.getByRole("button", { name: "Sunday" }));
    expect(screen.getByText("Every day from Wed, Jul 29 on")).toBeInTheDocument();
  });

  it("starts Custom from the meal's own weekday for a one-off", async () => {
    const { user } = open({ day: TUESDAY, current: null });
    await user.click(screen.getByRole("button", { name: "Custom…" }));
    expect(
      screen.getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Tuesday"]);
  });

  it("says the meal's own day stays as it is when Custom leaves it out", async () => {
    const { onChoose, user } = open({ day: TUESDAY, current: null });
    await user.click(screen.getByRole("button", { name: "Custom…" }));
    expect(screen.queryByText(/stays as it is/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tuesday" }));
    await user.click(screen.getByRole("button", { name: "Monday" }));
    expect(screen.getByText("This Tuesday stays as it is")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith([0]);
  });

  it("will not save Custom with no day chosen", async () => {
    const { onChoose, user } = open({ day: TUESDAY, current: null });
    await user.click(screen.getByRole("button", { name: "Custom…" }));
    await user.click(screen.getByRole("button", { name: "Tuesday" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("offers nothing to choose on a day that has passed", () => {
    open({ day: WEDNESDAY, current: [2], past: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByText("That day has passed")).toBeInTheDocument();
  });
});
