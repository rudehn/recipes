import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TagCount } from "../api";
import { QuickRow } from "./QuickRow";

const TAGS: TagCount[] = [
  { name: "dinner", count: 12 },
  { name: "quick", count: 9 },
  { name: "vegetarian", count: 7 },
  { name: "blackstone", count: 5 },
  { name: "soup", count: 3 },
  { name: "breakfast", count: 0 },
];

function setup(props: Partial<Parameters<typeof QuickRow>[0]> = {}) {
  const onPickTag = vi.fn();
  const onPickSale = vi.fn();
  render(
    <QuickRow
      tags={TAGS}
      onSale={4}
      saleSelected={false}
      onPickTag={onPickTag}
      onPickSale={onPickSale}
      {...props}
    />,
  );
  return { onPickTag, onPickSale };
}

/** The labels of the row's buttons, left to right, spare (unshown) chips left out. */
function shown() {
  return screen.getAllByRole("button").map((b) => b.textContent);
}

describe("QuickRow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows up to four tags, then On sale, then All tags", async () => {
    const { onPickTag, onPickSale } = setup();
    expect(shown()).toEqual(["dinner12", "quick9", "vegetarian7", "blackstone5", "On sale4", "All tags ▾"]);

    await userEvent.click(screen.getByRole("button", { name: /^quick/ }));
    expect(onPickTag).toHaveBeenCalledWith("quick");
    await userEvent.click(screen.getByRole("button", { name: /^On sale/ }));
    expect(onPickSale).toHaveBeenCalledOnce();
  });

  it("never offers a tag that would leave no recipes", () => {
    setup({ tags: [{ name: "breakfast", count: 0 }, { name: "soup", count: 3 }] });
    expect(shown()).toEqual(["soup3", "On sale4", "All tags ▾"]);
  });

  it("leaves On sale out when sales are unknown, none, or already picked", () => {
    for (const props of [{ onSale: null }, { onSale: 0 }, { saleSelected: true }]) {
      const { unmount } = renderRow(props);
      expect(screen.queryByRole("button", { name: /On sale/ })).toBeNull();
      expect(screen.getByRole("button", { name: /All tags/ })).toBeTruthy();
      unmount();
    }
  });

  it("lists every tag alphabetically under All tags and picks one", async () => {
    const { onPickTag } = setup();
    const toggle = screen.getByRole("button", { name: /All tags/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const panel = screen.getByRole("group", { name: "All tags" });
    const items = within(panel).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      "blackstone5",
      "breakfast0",
      "dinner12",
      "quick9",
      "soup3",
      "vegetarian7",
    ]);
    expect((items[1] as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(items[3]);
    expect(onPickTag).toHaveBeenCalledWith("quick");
    expect(screen.queryByRole("group", { name: "All tags" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps On sale and All tags when only one tag fits", () => {
    // A 300px line, a 120px tail (divider, On sale, All tags) and 100px tags
    // leave 180px: one tag fits, two (200px) do not.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("quick-row") ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("quick-tail")) return 120;
      return this.classList.contains("tag-pill") ? 100 : 0;
    });
    setup();
    expect(shown()).toEqual(["dinner12", "On sale4", "All tags ▾"]);
  });

  it("judges the fit on natural widths even when the first chip is squeezed", () => {
    // Four 100px tags need 400px but only 360px is free, so three belong. The
    // first chip, squeezed by the browser to 60px, reports that width with its
    // name cut (20px shown of 60px); counted at 60 the four would seem to fit.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("quick-row") ? 460 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("quick-tail")) return 100;
      if (this.classList.contains("quick-name")) return this.textContent === "dinner" ? 20 : 0;
      if (this.classList.contains("tag-pill")) return this.textContent?.startsWith("dinner") ? 60 : 100;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("quick-name") && this.textContent === "dinner" ? 60 : 0;
    });
    setup();
    expect(shown()).toEqual(["dinner12", "quick9", "vegetarian7", "On sale4", "All tags ▾"]);
  });

  it("returns focus to All tags when Escape closes the panel", async () => {
    setup();
    const toggle = screen.getByRole("button", { name: /All tags/ });
    await userEvent.click(toggle);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "All tags" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

function renderRow(props: Partial<Parameters<typeof QuickRow>[0]>) {
  return render(
    <QuickRow
      tags={TAGS}
      onSale={4}
      saleSelected={false}
      onPickTag={() => {}}
      onPickSale={() => {}}
      {...props}
    />,
  );
}
