import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TagInput } from "./TagInput";

const BOX = ["chinese", "dinner", "indian", "quick", "weeknight dinner"];

/** The field as a form holds it: labelled, with something after it to leave to. */
function Harness({
  initial = [],
  suggestions = BOX,
  onSubmit = () => {},
}: {
  initial?: string[];
  suggestions?: string[];
  onSubmit?: () => void;
}) {
  const [tags, setTags] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="tags">Tags</label>
      <TagInput id="tags" tags={tags} onChange={setTags} suggestions={suggestions} />
      <button type="button">Next field</button>
    </form>
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const user = userEvent.setup({ delay: null });
  render(<Harness {...props} />);
  return { user, field: screen.getByRole("combobox", { name: "Tags" }) };
}

/** The tags on the field, read off their remove buttons. */
function chosen(): string[] {
  return screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((b) => b.getAttribute("aria-label")!.replace(/^Remove /, ""));
}

function options(): string[] {
  const list = screen.queryByRole("listbox");
  return list ? within(list).getAllByRole("option").map((o) => o.textContent ?? "") : [];
}

describe("TagInput: adding tags", () => {
  it("adds what was typed on Enter, the way the server will store it", async () => {
    const { user, field } = setup();

    await user.type(field, "  Weeknight {Enter}");

    expect(chosen()).toEqual(["weeknight"]);
    expect(field).toHaveValue("");
  });

  it("adds on a comma, and takes a pasted list apart", async () => {
    const { user, field } = setup();

    await user.type(field, "quick,");
    expect(chosen()).toEqual(["quick"]);
    expect(field).toHaveValue("");

    await user.paste("Vegan, Spicy,  sides");
    expect(chosen()).toEqual(["quick", "vegan", "spicy"]);
    // The part after the last comma is still being typed.
    expect(field).toHaveValue("sides");
  });

  it("adds on Tab, and lets focus move on", async () => {
    const { user, field } = setup();

    await user.type(field, "dinner");
    await user.tab();

    expect(chosen()).toEqual(["dinner"]);
    expect(screen.getByRole("button", { name: "Next field" })).toHaveFocus();
  });

  it("keeps what was typed when focus leaves without adding it", async () => {
    // Typing a tag and going straight to Save must not lose it.
    const { user, field } = setup();

    await user.type(field, "fish");
    await user.click(screen.getByRole("button", { name: "Next field" }));

    expect(chosen()).toEqual(["fish"]);
  });

  it("does not add a tag twice", async () => {
    const { user, field } = setup({ initial: ["quick"] });

    await user.type(field, "Quick{Enter}");

    expect(chosen()).toEqual(["quick"]);
    expect(field).toHaveValue("");
  });

  it("keeps Enter from submitting the form, typed or not", async () => {
    // Enter is how a tag is added, so a second press to add another must not
    // save the recipe half-written.
    const onSubmit = vi.fn();
    const { user, field } = setup({ onSubmit });

    await user.type(field, "quick{Enter}{Enter}");

    expect(chosen()).toEqual(["quick"]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves an Enter that is finishing a composed character to the keyboard", async () => {
    // With a Japanese or Chinese keyboard, Enter picks the characters being
    // composed; taking it as "add this tag" would add half a word.
    const { user, field } = setup();
    await user.type(field, "ra");

    fireEvent.keyDown(field, { key: "Enter", isComposing: true });

    expect(chosen()).toEqual([]);
    expect(field).toHaveValue("ra");
  });

  it("stops at the longest tag the server keeps", () => {
    setup();
    expect(screen.getByRole("combobox", { name: "Tags" })).toHaveAttribute("maxLength", "50");
  });
});

describe("TagInput: removing tags", () => {
  it("removes a tag with its x, and puts the cursor back in the field", async () => {
    const { user, field } = setup({ initial: ["quick", "dinner"] });

    await user.click(screen.getByRole("button", { name: "Remove quick" }));

    expect(chosen()).toEqual(["dinner"]);
    expect(field).toHaveFocus();
  });

  it("removes the last tag with Backspace in an empty field", async () => {
    const { user, field } = setup({ initial: ["quick", "dinner"] });

    await user.click(field);
    await user.keyboard("{Backspace}");
    expect(chosen()).toEqual(["quick"]);

    // With something typed, Backspace edits the typing and nothing else.
    await user.keyboard("ab{Backspace}");
    expect(chosen()).toEqual(["quick"]);
    expect(field).toHaveValue("a");
  });
});

describe("TagInput: suggestions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("suggests tags already in the box, best match first, leaving out ones chosen", async () => {
    const { user, field } = setup({ initial: ["chinese"] });

    await user.type(field, "in");

    // Starting with the letters beats merely containing them; "chinese" is
    // already on the recipe, so offering it again would be noise.
    expect(options()).toEqual(["indian", "dinner", "weeknight dinner"]);
  });

  it("keeps the spaces in a suggestion whose middle is picked out", async () => {
    // On a phone an option is a flex box, where each bare run of text is an
    // item of its own and loses the space at its edge: "main course" with
    // "co" picked out showed as "maincourse". One element holds the lot.
    const { user, field } = setup({ suggestions: ["main course"] });

    await user.type(field, "co");

    const option = screen.getByRole("option", { name: "main course" });
    expect(option.childNodes).toHaveLength(1);
    expect(option).toHaveTextContent("main course");
  });

  it("adds a suggestion that is clicked, and keeps the cursor in the field", async () => {
    const { user, field } = setup();

    await user.type(field, "din");
    await user.click(screen.getByRole("option", { name: "dinner" }));

    expect(chosen()).toEqual(["dinner"]);
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves through suggestions with the arrow keys and adds one with Enter", async () => {
    const { user, field } = setup();

    await user.type(field, "din");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "dinner" })).toHaveAttribute("aria-selected", "true");
    expect(field).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "dinner" }).id,
    );

    await user.keyboard("{ArrowDown}");
    expect(field).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "weeknight dinner" }).id,
    );

    await user.keyboard("{ArrowUp}{Enter}");
    expect(chosen()).toEqual(["dinner"]);
  });

  it("adds the highlighted suggestion on Tab rather than the letters typed", async () => {
    const { user, field } = setup();

    await user.type(field, "week");
    await user.keyboard("{ArrowDown}");
    await user.tab();

    expect(chosen()).toEqual(["weeknight dinner"]);
  });

  it("adds what was typed on Enter when no suggestion was moved to", async () => {
    // A suggestion is only taken when chosen: "din" is a tag of its own if
    // that is what was typed.
    const { user, field } = setup();

    await user.type(field, "din{Enter}");

    expect(chosen()).toEqual(["din"]);
  });

  it("opens every suggestion on ArrowDown in an empty field", async () => {
    const { user, field } = setup({ initial: ["quick"] });

    await user.click(field);
    await user.keyboard("{Escape}{ArrowDown}");

    expect(options()).toEqual(["chinese", "dinner", "indian", "weeknight dinner"]);
  });

  it("opens the suggestions when the field is tapped, for a thumb to pick from", async () => {
    const { user, field } = setup();

    await user.click(field);

    expect(options()).toEqual(BOX);
  });

  it("closes the suggestions on Escape", async () => {
    const { user, field } = setup();

    await user.type(field, "din");
    expect(field).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(field).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("is a combobox that names the list it controls", async () => {
    const { user, field } = setup();
    expect(field).toHaveAttribute("aria-autocomplete", "list");
    expect(field).toHaveAttribute("aria-expanded", "false");

    await user.type(field, "d");

    const list = screen.getByRole("listbox");
    expect(field).toHaveAttribute("aria-controls", list.id);
    expect(list).toHaveAccessibleName();
  });

  it("scrolls the suggestions out from behind a phone's keyboard", async () => {
    // The browser scrolls the focused field into view and stops there; the
    // keyboard is not part of the page, so a list hanging below the field
    // sits behind it unless something scrolls on. Here the keyboard leaves
    // 400px of screen, and the list's last row is drawn at 520px.
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    vi.stubGlobal("visualViewport", {
      offsetTop: 0,
      height: 400,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { bottom: this.getAttribute("role") === "listbox" ? 520 : 0 } as DOMRect;
    });
    const { user, field } = setup();

    await user.type(field, "d");

    // Far enough to show the last row with a little room under it, no more.
    expect(scrollBy).toHaveBeenCalledWith({ top: 128 });
  });

  it("leaves the page where it is when the suggestions are already in sight", async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    const { user, field } = setup();

    // jsdom lays nothing out: the list's bottom is at 0, well inside the window.
    await user.type(field, "d");

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("says nothing when the box has no tags to suggest", async () => {
    const { user, field } = setup({ suggestions: [] });

    await user.type(field, "d");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "false");
  });
});

describe("TagInput: telling a screen reader", () => {
  it("announces each tag as it is added and removed", async () => {
    // The field empties as a tag is added, so without this a reader hears
    // nothing happen at all.
    const { user, field } = setup();

    await user.type(field, "quick{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("Added quick");

    await user.keyboard("{Backspace}");
    expect(screen.getByRole("status")).toHaveTextContent("Removed quick");
  });
});
