import { describe, expect, it } from "vitest";

import { chipsThatFit } from "./chipFit";

const line = { gap: 4, plus: 30 };

describe("chipsThatFit", () => {
  it("keeps every chip when they all fit and there is nothing left to count", () => {
    expect(chipsThatFit({ ...line, widths: [50, 50, 50], total: 3, room: 158 })).toBe(3);
  });

  it("leaves room for the count beside the chips it keeps", () => {
    // 3 chips are 158 wide and fit alone, but "+2" needs 34 more beside them.
    expect(chipsThatFit({ ...line, widths: [50, 50, 50], total: 5, room: 180 })).toBe(2);
    expect(chipsThatFit({ ...line, widths: [50, 50, 50], total: 5, room: 192 })).toBe(3);
  });

  it("gives up a chip to the count rather than wrapping it onto a line alone", () => {
    // Dropping the third chip makes room for "+1" where both would not fit.
    expect(chipsThatFit({ ...line, widths: [80, 60, 70], total: 3, room: 200 })).toBe(2);
  });

  it("keeps the first chip however narrow the line, to be cut short instead", () => {
    expect(chipsThatFit({ ...line, widths: [300, 50], total: 4, room: 100 })).toBe(1);
  });

  it("keeps them all where nothing has been laid out to measure", () => {
    // jsdom, or a card not yet on screen: every width is zero.
    expect(chipsThatFit({ gap: 0, plus: 0, widths: [0, 0, 0], total: 5, room: 0 })).toBe(3);
  });

  it("is nothing for no chips", () => {
    expect(chipsThatFit({ ...line, widths: [], total: 0, room: 200 })).toBe(0);
  });
});
