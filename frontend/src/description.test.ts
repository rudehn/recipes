import { describe, expect, it } from "vitest";

import { descriptionParagraphs, firstParagraph } from "./description";

describe("descriptionParagraphs", () => {
  it("splits at blank lines", () => {
    expect(descriptionParagraphs("Fast and warming.\n\nNotes: Freezes well.")).toEqual([
      "Fast and warming.",
      "Notes: Freezes well.",
    ]);
  });

  it("counts a line of only spaces as blank, and several blank lines as one", () => {
    expect(descriptionParagraphs("One.\n  \n\n\nTwo.")).toEqual(["One.", "Two."]);
  });

  it("keeps a single line break inside a paragraph", () => {
    expect(descriptionParagraphs("Notes: Freezes.\nThaw overnight.")).toEqual([
      "Notes: Freezes.\nThaw overnight.",
    ]);
  });

  it("drops the space around each paragraph, and has none for empty text", () => {
    expect(descriptionParagraphs("  \nOne.  \n\n")).toEqual(["One."]);
    expect(descriptionParagraphs("")).toEqual([]);
  });

  it("reads Windows line endings the same way", () => {
    expect(descriptionParagraphs("One.\r\n\r\nTwo.")).toEqual(["One.", "Two."]);
  });
});

describe("firstParagraph", () => {
  it("is the description up to its first blank line", () => {
    expect(firstParagraph("Fast and warming.\n\nNotes: Freezes well.")).toBe("Fast and warming.");
  });

  it("is empty for an empty description", () => {
    expect(firstParagraph("")).toBe("");
  });
});
