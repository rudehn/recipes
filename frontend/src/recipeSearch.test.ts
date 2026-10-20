import { describe as suite, expect, it } from "vitest";

import {
  EMPTY_SEARCH,
  describe,
  isEmpty,
  searchFromParams,
  sortFromParams,
  toFilters,
  toInput,
  tokensOf,
  without,
  writeParams,
  type Search,
} from "./recipeSearch";

const full: Search = {
  text: "egg roll",
  tags: ["blackstone", "dinner"],
  ingredients: [{ key: "ground-beef", name: "ground beef" }],
  onSale: true,
};

suite("recipeSearch", () => {
  it("reads an old bookmark's q and tag as a text token and a tag", () => {
    const s = searchFromParams(new URLSearchParams("q=curry&tag=dinner"));
    expect(tokensOf(s)).toEqual([
      { kind: "tag", name: "dinner" },
      { kind: "text", text: "curry" },
    ]);
  });

  it("orders tokens tags, ingredients, on sale, text", () => {
    expect(tokensOf(full)).toEqual([
      { kind: "tag", name: "blackstone" },
      { kind: "tag", name: "dinner" },
      { kind: "ingredient", key: "ground-beef", name: "ground beef" },
      { kind: "sale" },
      { kind: "text", text: "egg roll" },
    ]);
  });

  it("round-trips every token through the URL", () => {
    const p = writeParams(full, "sale", new URLSearchParams());
    expect(p.toString()).toBe(
      "q=egg+roll&tag=blackstone&tag=dinner&ing=ground-beef&sale=1&sort=sale",
    );
    const back = new URLSearchParams(p.toString());
    expect(searchFromParams(back)).toEqual(full);
    expect(sortFromParams(back)).toBe("sale");
  });

  it("names an ingredient from its key until facets supply the name", () => {
    expect(searchFromParams(new URLSearchParams("ing=ground-beef")).ingredients).toEqual([
      { key: "ground-beef", name: "ground beef" },
    ]);
  });

  it("leaves defaults out of the URL", () => {
    expect(writeParams(EMPTY_SEARCH, "title", new URLSearchParams()).toString()).toBe("");
  });

  it("replaces its own params and keeps others", () => {
    const p = writeParams(EMPTY_SEARCH, "title", new URLSearchParams("q=old&tag=x&other=1"));
    expect(p.toString()).toBe("other=1");
  });

  it("falls back to A-Z for an unknown sort", () => {
    expect(sortFromParams(new URLSearchParams("sort=bogus"))).toBe("title");
    expect(sortFromParams(new URLSearchParams())).toBe("title");
    expect(sortFromParams(new URLSearchParams("sort=cooked"))).toBe("cooked");
  });

  it("describes a search the way recent searches show it", () => {
    expect(
      describe({
        text: "egg roll",
        tags: ["blackstone"],
        ingredients: [{ key: "ground-beef", name: "ground beef" }],
        onSale: true,
      }),
    ).toBe("blackstone · 🥕 ground beef · on sale · “egg roll”");
  });

  it("removes one token and leaves the rest", () => {
    expect(without(full, { kind: "tag", name: "dinner" }).tags).toEqual(["blackstone"]);
    expect(without(full, { kind: "ingredient", key: "ground-beef", name: "x" }).ingredients).toEqual([]);
    expect(without(full, { kind: "sale" }).onSale).toBe(false);
    expect(without(full, { kind: "text", text: "egg roll" }).text).toBe("");
    expect(without(full, { kind: "sale" }).text).toBe("egg roll");
  });

  it("is empty only with no tokens", () => {
    expect(isEmpty(EMPTY_SEARCH)).toBe(true);
    expect(isEmpty({ ...EMPTY_SEARCH, onSale: true })).toBe(false);
  });

  it("filters on the draft only while there is no text token", () => {
    expect(toFilters(EMPTY_SEARCH, "  soup ").q).toBe("soup");
    expect(toFilters({ ...EMPTY_SEARCH, text: "curry" }, "soup").q).toBe("curry");
  });

  it("turns a search into filters and a recordable input by key", () => {
    expect(toFilters(full)).toEqual({
      q: "egg roll",
      tags: ["blackstone", "dinner"],
      ingredients: ["ground-beef"],
      onSale: true,
    });
    expect(toInput(full)).toEqual({
      text: "egg roll",
      tags: ["blackstone", "dinner"],
      ingredients: ["ground-beef"],
      on_sale: true,
    });
  });

  it("keeps text with wildcards and quotes exactly", () => {
    const s: Search = { ...EMPTY_SEARCH, text: '100% "x"' };
    const p = writeParams(s, "title", new URLSearchParams());
    expect(searchFromParams(new URLSearchParams(p.toString())).text).toBe('100% "x"');
    expect(toFilters(s).q).toBe('100% "x"');
    expect(toInput(s).text).toBe('100% "x"');
  });
});
