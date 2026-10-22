import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LabelChecklist } from "./LabelChecklist";

const labels = [
  { id: 1, name: "Dad" },
  { id: 2, name: "Kids" },
];

function setup(chosen: number[] = []) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  const onCreate = vi.fn(async (name: string) => ({ id: 7, name }));
  const user = userEvent.setup();
  render(
    <div>
      <button>outside</button>
      <LabelChecklist
        labels={labels}
        chosen={chosen}
        onCreate={onCreate}
        onDone={onDone}
        onClose={onClose}
      />
    </div>,
  );
  return { user, onDone, onClose, onCreate };
}

describe("LabelChecklist", () => {
  it("reports the whole set once, when Done is pressed", async () => {
    const { user, onDone, onClose } = setup([1]);

    await user.click(screen.getByRole("checkbox", { name: "Kids" }));
    await user.click(screen.getByRole("checkbox", { name: "Dad" }));
    await user.click(screen.getByRole("checkbox", { name: "Dad" }));
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith([1, 2]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a press outside, and says nothing when nothing changed", async () => {
    const { user, onDone, onClose } = setup([1]);

    await user.click(screen.getByRole("checkbox", { name: "Kids" }));
    await user.click(screen.getByRole("checkbox", { name: "Kids" }));
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, but only once however it is asked", async () => {
    const { user, onDone, onClose } = setup();

    await user.click(screen.getByRole("checkbox", { name: "Dad" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows why a label was refused, and keeps what was typed", async () => {
    const { user, onCreate } = setup();
    onCreate.mockRejectedValueOnce(new Error('There is already a label called "dad".'));

    await user.type(screen.getByRole("textbox", { name: "New label" }), "dad{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("There is already a label");
    expect(screen.getByRole("textbox", { name: "New label" })).toHaveValue("dad");
  });
});
