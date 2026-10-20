/**
 * The Recipes page's search as data: tags, ingredients, an on-sale flag and at
 * most one piece of text. The page shows these as tokens in the search box and
 * keeps them in the URL, so a search can be bookmarked and survives a reload.
 */

import type { IngredientName, RecipeFilters, RecipeSort, SearchInput } from "./api";

export interface Search {
  text: string;
  tags: string[];
  ingredients: IngredientName[];
  onSale: boolean;
}

export const EMPTY_SEARCH: Search = { text: "", tags: [], ingredients: [], onSale: false };

export type Token =
  | { kind: "tag"; name: string }
  | { kind: "ingredient"; key: string; name: string }
  | { kind: "sale" }
  | { kind: "text"; text: string };

const DEFAULT_SORT: RecipeSort = "title";
const SORTS: readonly RecipeSort[] = ["title", "newest", "cooked", "sale"];

/** The search's parts in the order the box shows them: tags, ingredients, on sale, text. */
export function tokensOf(s: Search): Token[] {
  const tokens: Token[] = [
    ...s.tags.map((name): Token => ({ kind: "tag", name })),
    ...s.ingredients.map((i): Token => ({ kind: "ingredient", key: i.key, name: i.name })),
  ];
  if (s.onSale) tokens.push({ kind: "sale" });
  if (s.text) tokens.push({ kind: "text", text: s.text });
  return tokens;
}

export function without(s: Search, t: Token): Search {
  switch (t.kind) {
    case "tag":
      return { ...s, tags: s.tags.filter((name) => name !== t.name) };
    case "ingredient":
      return { ...s, ingredients: s.ingredients.filter((i) => i.key !== t.key) };
    case "sale":
      return { ...s, onSale: false };
    case "text":
      return { ...s, text: "" };
  }
}

export function isEmpty(s: Search): boolean {
  return tokensOf(s).length === 0;
}

/** A search in one line, the way recent searches list it. */
export function describe(s: Search): string {
  return tokensOf(s)
    .map((t) => {
      switch (t.kind) {
        case "tag":
          return t.name;
        case "ingredient":
          return `🥕 ${t.name}`;
        case "sale":
          return "on sale";
        case "text":
          return `“${t.text}”`;
      }
    })
    .join(" · ");
}

/**
 * Reads a search from the URL. An old bookmark's `q` and `tag` land as a text
 * token and tags. The URL carries only an ingredient's key, so its name is the
 * key spelled with spaces until the facets supply the real one.
 */
export function searchFromParams(p: URLSearchParams): Search {
  return {
    text: p.get("q") ?? "",
    tags: p.getAll("tag"),
    ingredients: p.getAll("ing").map((key) => ({ key, name: key.replaceAll("-", " ") })),
    onSale: p.get("sale") === "1",
  };
}

export function sortFromParams(p: URLSearchParams): RecipeSort {
  const sort = p.get("sort");
  return SORTS.find((each) => each === sort) ?? DEFAULT_SORT;
}

/** Writes the search and sort into `p`, leaving out whatever is at its default. */
export function writeParams(s: Search, sort: RecipeSort, p: URLSearchParams): URLSearchParams {
  for (const key of ["q", "tag", "ing", "sale", "sort"]) p.delete(key);
  if (s.text) p.set("q", s.text);
  for (const name of s.tags) p.append("tag", name);
  for (const { key } of s.ingredients) p.append("ing", key);
  if (s.onSale) p.set("sale", "1");
  if (sort !== DEFAULT_SORT) p.set("sort", sort);
  return p;
}

/**
 * The filters to ask the server for. The text token wins; without one, the
 * draft still being typed filters the list live.
 */
export function toFilters(s: Search, draft = ""): RecipeFilters {
  return {
    q: s.text || draft.trim(),
    tags: s.tags,
    ingredients: s.ingredients.map((i) => i.key),
    onSale: s.onSale,
  };
}

export function toInput(s: Search): SearchInput {
  return {
    text: s.text,
    tags: s.tags,
    ingredients: s.ingredients.map((i) => i.key),
    on_sale: s.onSale,
  };
}
