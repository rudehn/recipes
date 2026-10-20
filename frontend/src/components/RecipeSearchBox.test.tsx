import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RecentSearch, SearchSuggestions } from "../api";
import { EMPTY_SEARCH, type Search } from "../recipeSearch";
import { mockBackend } from "../test/backend";
import { RecipeSearchBox } from "./RecipeSearchBox";

const RECENT: RecentSearch[] = [
  { signature: "sig-dinner-sale", text: "", tags: ["dinner"], ingredients: [], on_sale: true },
  {
    signature: "sig-ground-beef",
    text: "",
    tags: ["blackstone"],
    ingredients: [{ key: "ground-beef", name: "ground beef" }],
    on_sale: false,
  },
];

const CHI: SearchSuggestions = {
  ingredients: [
    { key: "chicken-thighs", name: "chicken thighs", count: 5 },
    { key: "chives", name: "chives", count: 1 },
  ],
  tags: [{ name: "chinese", count: 2 }],
  recipes: [{ id: 42, title: "Chicken Fried Rice" }],
};

/** The box as a page holds it: it owns the search and the draft, the box reports. */
function setup({
  initial = EMPTY_SEARCH,
  recent = RECENT,
  suggestions = CHI,
}: { initial?: Search; recent?: RecentSearch[]; suggestions?: SearchSuggestions } = {}) {
  const backend = mockBackend({
    "GET /api/recipes/searches": () => recent,
    "DELETE /api/recipes/searches": () => undefined,
    "GET /api/recipes/suggest": () => suggestions,
  });
  const onOpenRecipe = vi.fn();
  const seen: Search[] = [];
  function Harness() {
    const [search, setSearch] = useState(initial);
    const [draft, setDraft] = useState("");
    seen.push(search);
    return (
      <RecipeSearchBox
        search={search}
        onChange={setSearch}
        draft={draft}
        onDraft={setDraft}
        onOpenRecipe={onOpenRecipe}
      />
    );
  }
  const user = userEvent.setup({ delay: null });
  render(<Harness />);
  return {
    user,
    backend,
    onOpenRecipe,
    box: screen.getByRole("combobox", { name: "Search recipes" }),
    search: () => seen[seen.length - 1],
  };
}

function options(): string[] {
  const list = screen.queryByRole("listbox");
  return list ? within(list).getAllByRole("option").map((o) => o.textContent ?? "") : [];
}

describe("RecipeSearchBox", () => {
  it("shows recent searches when the empty box is focused", async () => {
    const { user, backend, box } = setup();
    expect(backend.requestsTo("GET /api/recipes/searches")).toHaveLength(0);

    await user.click(box);

    expect(await screen.findByText("Recent searches")).toBeInTheDocument();
    expect(options()).toEqual(["↺dinner · on sale✕", "↺blackstone · 🥕 ground beef✕"]);
    expect(screen.getByText("Start typing for ingredients, tags and recipes")).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/recipes/searches")[0].searchParams.get("limit")).toBe("5");
  });

  it("says where searches come from when there is no history", async () => {
    const { user, box } = setup({ recent: [] });
    await user.click(box);
    expect(await screen.findByText(/Searches you open a recipe from show up here/)).toBeInTheDocument();
  });

  it("replaces the box's contents with a chosen recent search", async () => {
    const { user, box, search } = setup({
      initial: { ...EMPTY_SEARCH, text: "soup" },
    });
    await user.click(box);
    await user.click(await screen.findByRole("option", { name: /blackstone/ }));

    expect(search()).toEqual({
      text: "",
      tags: ["blackstone"],
      ingredients: [{ key: "ground-beef", name: "ground beef" }],
      onSale: false,
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("forgets a recent search with its ✕", async () => {
    const { user, backend, box, search } = setup();
    await user.click(box);
    await screen.findByText("Recent searches");

    await user.click(screen.getByRole("button", { name: "Forget dinner · on sale" }));

    await waitFor(() => expect(backend.requestsTo("DELETE /api/recipes/searches")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/recipes/searches")[0].searchParams.get("signature")).toBe(
      "sig-dinner-sale",
    );
    expect(options()).toEqual(["↺blackstone · 🥕 ground beef✕"]);
    expect(search()).toEqual(EMPTY_SEARCH);
  });

  it("switches to grouped suggestions as you type", async () => {
    const { user, backend, box } = setup();
    await user.type(box, "chi");

    await screen.findByText("Ingredient");
    const headings = screen.getAllByRole("presentation").map((h) => h.textContent);
    expect(headings).toEqual(["Ingredient", "Tag", "Recipe"]);
    expect(options()).toEqual([
      "🥕chicken thighs5 recipes",
      "🥕chives1 recipe",
      "#chinese2 recipes",
      "Chicken Fried Rice",
      "Search for “chi”",
    ]);
    const marks = Array.from(document.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["chi", "chi", "chi", "Chi"]);
    expect(backend.requestsTo("GET /api/recipes/suggest")).toHaveLength(1);
    expect(backend.requestsTo("GET /api/recipes/suggest")[0].searchParams.get("text")).toBe("chi");
  });

  it("asks for suggestions given the tokens already in the box", async () => {
    const { user, backend, box } = setup({ initial: { ...EMPTY_SEARCH, tags: ["dinner"] } });
    await user.type(box, "chi");
    await screen.findByText("Ingredient");
    expect(backend.requestsTo("GET /api/recipes/suggest")[0].searchParams.getAll("tag")).toEqual([
      "dinner",
    ]);
  });

  it("adds a picked ingredient as a token and clears the typing", async () => {
    const { user, box, search } = setup();
    await user.type(box, "chi");
    await user.click(await screen.findByRole("option", { name: /chicken thighs/ }));

    expect(search().ingredients).toEqual([{ key: "chicken-thighs", name: "chicken thighs" }]);
    expect(box).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove chicken thighs" })).toBeInTheDocument();
  });

  it("adds a picked tag as a token", async () => {
    const { user, box, search } = setup();
    await user.type(box, "chi");
    await user.click(await screen.findByRole("option", { name: /chinese/ }));

    expect(search().tags).toEqual(["chinese"]);
    expect(box).toHaveValue("");
  });

  it("turns typed text into one text token on Enter, replacing an earlier one", async () => {
    const { user, box, search } = setup({ initial: { ...EMPTY_SEARCH, text: "soup" } });
    expect(screen.getByRole("button", { name: "Remove “soup”" })).toBeInTheDocument();

    await user.type(box, "egg roll{Enter}");

    expect(search().text).toBe("egg roll");
    expect(box).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove “soup”" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove “egg roll”" })).toBeInTheDocument();
  });

  it("turns the typing into a text token from the Search for row", async () => {
    const { user, box, search } = setup();
    await user.type(box, "chi");
    await user.click(await screen.findByRole("option", { name: "Search for “chi”" }));
    expect(search().text).toBe("chi");
    expect(box).toHaveValue("");
  });

  it("opens a recipe picked from the suggestions", async () => {
    const { user, box, onOpenRecipe, search } = setup();
    await user.type(box, "chi");
    await user.click(await screen.findByRole("option", { name: "Chicken Fried Rice" }));

    expect(onOpenRecipe).toHaveBeenCalledWith(42);
    expect(search()).toEqual(EMPTY_SEARCH);
  });

  it("moves through suggestions with the arrow keys", async () => {
    const { user, box, search } = setup();
    await user.type(box, "chi");
    await screen.findByText("Ingredient");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const second = screen.getByRole("option", { name: /chives/ });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", second.id);

    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Up from the first row wraps to the last: the Search for row.
    expect(screen.getByRole("option", { name: "Search for “chi”" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(search().ingredients).toEqual([{ key: "chives", name: "chives" }]);
  });

  it("removes the last token with Backspace on an empty box", async () => {
    const { user, box, search } = setup({
      initial: { text: "", tags: ["dinner"], ingredients: [], onSale: true },
    });
    await user.click(box);
    await user.keyboard("{Backspace}");
    expect(search().onSale).toBe(false);
    expect(search().tags).toEqual(["dinner"]);
    await user.keyboard("{Backspace}");
    expect(search().tags).toEqual([]);
  });

  it("does not take Backspace for a token while there is typing", async () => {
    const { user, box, search } = setup({ initial: { ...EMPTY_SEARCH, tags: ["dinner"] } });
    await user.type(box, "a{Backspace}");
    expect(search().tags).toEqual(["dinner"]);
  });

  it("removes a token with its ✕ and clears everything with Clear", async () => {
    const { user, box, search } = setup({
      initial: { text: "soup", tags: ["dinner", "quick"], ingredients: [], onSale: false },
    });
    await user.click(screen.getByRole("button", { name: "Remove dinner" }));
    expect(search().tags).toEqual(["quick"]);

    await user.type(box, "ab");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(search()).toEqual(EMPTY_SEARCH);
    expect(box).toHaveValue("");
  });

  it("closes the dropdown on Escape", async () => {
    const { user, box } = setup();
    await user.click(box);
    await screen.findByRole("listbox");
    expect(box).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).toHaveAttribute("aria-expanded", "false");
  });
});
