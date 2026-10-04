import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAutoGrow } from "./useAutoGrow";

function Field({ value }: { value: string }) {
  const field = useAutoGrow(value);
  return <textarea ref={field} value={value} readOnly aria-label="Field" />;
}

/**
 * jsdom lays nothing out, so the heights the hook reads are supplied: the
 * text's own height, and a 1px border top and bottom around the field.
 */
function layOut(textHeight: number) {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(textHeight);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(50);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(52);
}

describe("useAutoGrow", () => {
  it("makes the field as tall as what is written in it, borders included", () => {
    layOut(120);
    render(<Field value="Smoky and rich." />);

    expect(screen.getByLabelText("Field").style.height).toBe("122px");
  });

  it("fits again as the text changes", () => {
    layOut(60);
    const { rerender } = render(<Field value="Smoky." />);

    layOut(200);
    rerender(<Field value={"Smoky.\n\nNotes: Freezes well."} />);

    expect(screen.getByLabelText("Field").style.height).toBe("202px");
  });

  it("fits again when the window changes width, which wraps the lines anew", () => {
    layOut(60);
    render(<Field value="Smoky and rich." />);

    layOut(140);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("Field").style.height).toBe("142px");
  });
});
