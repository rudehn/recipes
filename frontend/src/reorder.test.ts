import { describe, expect, it } from "vitest";

import { dropIndex, moveItem } from "./reorder";

describe("moveItem", () => {
  it("moves an item down", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the list alone for a move to where it already is", () => {
    const items = ["a", "b"];
    expect(moveItem(items, 1, 1)).toEqual(["a", "b"]);
    expect(items).toEqual(["a", "b"]);
  });
});

describe("dropIndex", () => {
  // Rows 40px tall, their middles at 20, 60, 100 and 140.
  const middles = [20, 60, 100, 140];

  it("stays put until the row is half way over a neighbour", () => {
    expect(dropIndex(middles, 1, 60)).toBe(1);
    expect(dropIndex(middles, 1, 99)).toBe(1);
    expect(dropIndex(middles, 1, 21)).toBe(1);
  });

  it("takes a neighbour's place once past its middle", () => {
    expect(dropIndex(middles, 1, 101)).toBe(2);
    expect(dropIndex(middles, 1, 19)).toBe(0);
  });

  it("goes to either end when dragged beyond it", () => {
    expect(dropIndex(middles, 0, 500)).toBe(3);
    expect(dropIndex(middles, 3, -500)).toBe(0);
  });
});
