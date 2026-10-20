import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IngredientSummary } from "../api";
import { HttpError, mockBackend } from "../test/backend";
import {
  ingredientSummary,
  itemPrice,
  mergeSuggestion,
  recipe,
  recipeSummary,
  staple,
} from "../test/fixtures";
import { renderApp } from "../test/render";

/** The list as the server sends it: already in name order. */
const list = (...ingredients: IngredientSummary[]) => ({ ingredients, suggestions: [] });

/** The row for a staple, whichever way it is stocked. */
function row(name: string): HTMLElement {
  return screen.getByRole("link", { name }).closest<HTMLElement>(".pantry-item")!;
}

describe("IngredientsPage: staples", () => {
  it("puts staples to restock first, then those in stock", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("coffee", false), staple("olive oil"), staple("rice", false)),
    });
    renderApp("/ingredients");

    expect(await screen.findByText("2 to restock")).toBeInTheDocument();
    const restock = screen.getByRole("region", { name: "To restock" });
    const stocked = screen.getByRole("region", { name: "In stock" });
    expect(within(restock).getAllByRole("link").map((l) => l.textContent)).toEqual(["coffee", "rice"]);
    expect(within(stocked).getAllByRole("link").map((l) => l.textContent)).toEqual(["olive oil"]);
  });

  it("says so when everything is stocked", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByText("Fully stocked")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To restock" })).not.toBeInTheDocument();
  });

  it("suggests what to add when there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": list() });
    renderApp("/ingredients");

    expect(await screen.findByText("No staples yet")).toBeInTheDocument();
  });

  it("links each staple to its ingredient's page", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByRole("link", { name: "rice" })).toHaveAttribute("href", "/ingredients/rice");
  });

  it("adds a staple in stock, then clears the box for the next one", async () => {
    const backend = mockBackend({
      "GET /api/ingredients": list(),
      "POST /api/pantry": { id: 9, name: "olive oil", in_stock: true },
    });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    const box = screen.getByLabelText("Add a staple");
    await user.type(box, "  olive oil  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/pantry")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/pantry")[0].body).toEqual({ name: "olive oil", in_stock: true });
    expect(box).toHaveValue("");
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("does nothing when the name is blank", async () => {
    const backend = mockBackend({ "GET /api/ingredients": list() });
    const { user } = renderApp("/ingredients");
    await screen.findByText("No staples yet");

    await user.type(screen.getByLabelText("Add a staple"), "   ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(backend.requestsTo("POST /api/pantry")).toHaveLength(0);
  });

  it("flips the stock switch immediately, then saves it", async () => {
    const rice = staple("rice");
    let confirmSave: () => void = () => {};
    const backend = mockBackend({
      "GET /api/ingredients": list(rice),
      "PUT /api/pantry/:id": () =>
        new Promise((resolve) => {
          confirmSave = () => resolve({ ...rice.staple, in_stock: false });
        }),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(within(row("rice")).getByRole("button", { name: /out of stock/i })).toBeInTheDocument();
    // The row moves to the staples to restock at once, not after the save.
    expect(
      within(screen.getByRole("region", { name: "To restock" })).getByRole("link", { name: "rice" }),
    ).toBeInTheDocument();
    const [request] = backend.requestsTo("PUT /api/pantry/:id");
    expect(request.path).toBe(`/api/pantry/${rice.staple!.id}`);
    expect(request.body).toEqual({ in_stock: false });
    confirmSave();
    await waitFor(() => expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2));
  });

  it("puts the switch back when the server refuses", async () => {
    mockBackend({
      "GET /api/ingredients": list(staple("rice")),
      "PUT /api/pantry/:id": new HttpError(500, "Database is down"),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText("Database is down")).toBeInTheDocument();
    expect(within(row("rice")).getByRole("button", { name: /in stock/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports a failed load instead of claiming there are no staples", async () => {
    mockBackend({ "GET /api/ingredients": new HttpError(500, "Database is down") });
    renderApp("/ingredients");

    expect(await screen.findByText(/Couldn't load your ingredients/)).toBeInTheDocument();
    expect(screen.queryByText("No staples yet")).not.toBeInTheDocument();
  });

  it("explains why a staple could not be added, keeping what was typed", async () => {
    // "Eggs" is the ingredient the "Egg" staple already is, so the server
    // refuses it by name rather than adding a row the list would hide.
    mockBackend({
      "GET /api/ingredients": list(staple("Egg")),
      "POST /api/pantry": new HttpError(409, "Egg is already a staple."),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "Egg" });

    await user.type(screen.getByLabelText("Add a staple"), "Eggs");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Egg is already a staple.")).toBeInTheDocument();
    expect(screen.getByLabelText("Add a staple")).toHaveValue("Eggs");
  });

  it("puts a staple back in stock", async () => {
    const rice = staple("rice", false);
    const backend = mockBackend({
      "GET /api/ingredients": list(rice),
      "PUT /api/pantry/:id": { ...rice.staple, in_stock: true },
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /out of stock/i }));

    await waitFor(() =>
      expect(backend.requestsTo("PUT /api/pantry/:id")[0].body).toEqual({ in_stock: true }),
    );
  });

  it("retries a failed load", async () => {
    let attempt = 0;
    const backend = mockBackend({
      "GET /api/ingredients": () =>
        ++attempt === 1 ? new HttpError(503, "Server is restarting") : list(staple("rice")),
    });
    const { user } = renderApp("/ingredients");
    await screen.findByText(/Couldn't load your ingredients/);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByRole("link", { name: "rice" })).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("keeps the staples on screen when a refresh fails", async () => {
    let attempt = 0;
    mockBackend({
      "GET /api/ingredients": () =>
        ++attempt === 1 ? list(staple("rice")) : new HttpError(503, "Server is restarting"),
      "PUT /api/pantry/:id": undefined,
    });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.click(within(row("rice")).getByRole("button", { name: /in stock/i }));

    expect(await screen.findByText(/Showing the last version that loaded/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "rice" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load your ingredients/)).not.toBeInTheDocument();
  });

  it("is where the old pantry address goes", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    renderApp("/pantry");

    expect(await screen.findByRole("heading", { name: "Ingredients" })).toBeInTheDocument();
  });
});

describe("IngredientsPage: views", () => {
  const cumin = ingredientSummary({
    key: "cumin",
    name: "cumin",
    also_called: ["ground cumin"],
    recipe_count: 2,
    product: { status: "picked", product: itemPrice({ description: "McCormick Ground Cumin", regular: 3.49 }) },
  });
  const fries = ingredientSummary({
    key: "22-ounce-bag-frozen-waffle-fry",
    name: "22-ounce bag frozen waffle fries",
    product: { status: "no_match", product: null },
    food: { status: "none", food: null },
    problems: ["no_match", "no_food", "fix_line"],
  });

  it("opens on Staples and switches to All, remembering the choice", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, staple("rice")) });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });
    expect(screen.getByRole("button", { name: /Staples/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /All/ }));

    expect(screen.getByRole("link", { name: /cumin/ })).toHaveTextContent(
      "2 recipes · McCormick Ground Cumin $3.49 · counted",
    );
    expect(localStorage.getItem("ingredients-view")).toBe("all");
  });

  it("opens on the view remembered on this device", async () => {
    localStorage.setItem("ingredients-view", "all");
    mockBackend({ "GET /api/ingredients": list(cumin) });
    renderApp("/ingredients");

    expect(await screen.findByRole("button", { name: /All/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens on the view a link asks for", async () => {
    localStorage.setItem("ingredients-view", "staples");
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    renderApp("/ingredients?view=look");

    expect(await screen.findByRole("button", { name: /Needs a look/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("counts each view", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries, staple("rice")) });
    renderApp("/ingredients");

    expect(await screen.findByRole("button", { name: "Staples 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs a look 1" })).toBeInTheDocument();
  });

  it("groups what needs a look by the job it needs", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    renderApp("/ingredients?view=look");

    for (const heading of ["No product at your store", "No food for nutrition", "Recipe lines to fix"]) {
      const group = await screen.findByRole("region", { name: heading });
      expect(within(group).getByRole("link", { name: /waffle fries/ })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: /cumin/ })).not.toBeInTheDocument();
  });

  it("says so when nothing needs a look", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin) });
    renderApp("/ingredients?view=look");

    expect(await screen.findByText("Nothing needs a look")).toBeInTheDocument();
  });

  it("searches the view on screen, by any name merged in", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    const { user } = renderApp("/ingredients?view=all");
    await screen.findByRole("link", { name: /cumin/ });

    await user.type(screen.getByLabelText("Search ingredients"), "ground");

    expect(screen.getByRole("link", { name: /cumin/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /waffle fries/ })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search ingredients"));
    await user.type(screen.getByLabelText("Search ingredients"), "saffron");
    expect(screen.getByText("No ingredients match “saffron”.")).toBeInTheDocument();
  });

  it("does not claim nothing needs a look when a search finds nothing", async () => {
    mockBackend({ "GET /api/ingredients": list(cumin, fries) });
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "No product at your store" });

    await user.type(screen.getByLabelText("Search ingredients"), "saffron");

    expect(screen.getByText("No ingredients match “saffron”.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs a look")).not.toBeInTheDocument();
  });

  it("does not say there are no staples when a search finds none", async () => {
    mockBackend({ "GET /api/ingredients": list(staple("rice")) });
    const { user } = renderApp("/ingredients");
    await screen.findByRole("link", { name: "rice" });

    await user.type(screen.getByLabelText("Search ingredients"), "saffron");

    expect(screen.getByText("No ingredients match “saffron”.")).toBeInTheDocument();
    expect(screen.queryByText("No staples yet")).not.toBeInTheDocument();
  });
});

describe("IngredientsPage: suggested merges", () => {
  const cumin = ingredientSummary({ key: "cumin", name: "cumin", problems: ["merge"] });
  const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", problems: ["merge"] });
  const suggestion = mergeSuggestion();

  it("lists them first in Needs a look, and counts them", async () => {
    mockBackend({ "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] } });
    renderApp("/ingredients?view=look");

    const group = await screen.findByRole("region", { name: "Might be the same" });
    expect(within(group).getByText("Ground cumin and cumin look like the same thing to buy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs a look 1" })).toBeInTheDocument();
  });

  it("turns one down, and asks the server never to offer it again", async () => {
    const backend = mockBackend({
      "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] },
      "POST /api/ingredients/suggestions/dismiss": undefined,
    });
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "Might be the same" });

    await user.click(screen.getByRole("button", { name: "Not the same" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/suggestions/dismiss")[0].body).toEqual({
        key_a: "ground-cumin",
        key_b: "cumin",
      }),
    );
    expect(backend.requestsTo("GET /api/ingredients")).toHaveLength(2);
  });

  it("merges one through the ingredient's page", async () => {
    mockBackend({ "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [suggestion] } });
    renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "Might be the same" });

    expect(screen.getByRole("link", { name: "Merge" })).toHaveAttribute(
      "href",
      "/ingredients/ground-cumin?merge=cumin",
    );
  });
});

describe("IngredientsPage: Needs a look, by recipe", () => {
  const fries = ingredientSummary({
    key: "waffle-fries",
    name: "waffle fries",
    product: { status: "no_match", product: null },
    problems: ["no_match"],
  });
  const curry = recipeSummary({ id: 7, title: "Weeknight chicken curry" });
  const bread = recipeSummary({ id: 8, title: "Banana bread" });
  const attention = [
    {
      recipe: curry,
      issues: [
        { ingredient_id: 21, name: "paprica", issue: "no_match", affects: ["price"] },
        { ingredient_id: 22, name: "can black beans", issue: "unweighable", affects: ["nutrition"] },
      ],
      no_servings: false,
    },
    {
      recipe: bread,
      issues: [{ ingredient_id: 31, name: "ripe bananas", issue: "no_food", affects: ["nutrition"] }],
      no_servings: false,
    },
  ];

  function lookBackend(entries: unknown = attention) {
    return mockBackend({
      "GET /api/ingredients": list(fries),
      "GET /api/recipes/attention": entries,
    });
  }

  it("lists what needs a look by recipe, each line linking to its fix", async () => {
    lookBackend();
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "No product at your store" });

    await user.click(within(screen.getByRole("group", { name: "Group" })).getByRole("button", { name: "By recipe" }));

    const title = await screen.findByRole("link", { name: "Weeknight chicken curry" });
    expect(title).toHaveAttribute("href", "/recipes/7");
    const entry = title.closest<HTMLElement>(".attention-recipe")!;
    expect(within(entry).getByText("1 for nutrition · 1 for price")).toBeInTheDocument();
    expect(within(entry).getByRole("link", { name: "paprica" })).toHaveAttribute(
      "href",
      "/recipes/7?ingredient=21",
    );
    expect(within(entry).getByRole("link", { name: "can black beans" })).toHaveAttribute(
      "href",
      "/recipes/7?nutrition=22",
    );
    expect(screen.queryByRole("region", { name: "No product at your store" })).not.toBeInTheDocument();
  });

  it("remembers By recipe on this device", async () => {
    lookBackend();
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("region", { name: "No product at your store" });
    expect(localStorage.getItem("ingredients-look-by")).toBe("ingredient");

    await user.click(screen.getByRole("button", { name: "By recipe" }));
    expect(localStorage.getItem("ingredients-look-by")).toBe("recipe");
  });

  it("opens on By recipe when this device left it there", async () => {
    localStorage.setItem("ingredients-look-by", "recipe");
    lookBackend();
    renderApp("/ingredients?view=look");

    expect(await screen.findByRole("link", { name: "Banana bread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "By recipe" })).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows the by-recipe list with the search box", async () => {
    localStorage.setItem("ingredients-look-by", "recipe");
    lookBackend();
    const { user } = renderApp("/ingredients?view=look");
    await screen.findByRole("link", { name: "Banana bread" });

    // By a line's name.
    await user.type(screen.getByLabelText("Search ingredients"), "paprica");
    expect(screen.getByRole("link", { name: "Weeknight chicken curry" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Banana bread" })).not.toBeInTheDocument();

    // By the recipe's title.
    await user.clear(screen.getByLabelText("Search ingredients"));
    await user.type(screen.getByLabelText("Search ingredients"), "banana bread");
    expect(screen.getByRole("link", { name: "Banana bread" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Weeknight chicken curry" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search ingredients"));
    await user.type(screen.getByLabelText("Search ingredients"), "saffron");
    expect(screen.getByText("No recipes match “saffron”.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs a look")).not.toBeInTheDocument();
  });

  it("says nothing needs a look when no recipe has a problem", async () => {
    localStorage.setItem("ingredients-look-by", "recipe");
    lookBackend([]);
    renderApp("/ingredients?view=look");

    expect(await screen.findByText("Nothing needs a look")).toBeInTheDocument();
    expect(screen.getByText("Every recipe's lines read right.")).toBeInTheDocument();
  });

  /*
   * What each entry says, moved here with the list from the Recipes page's
   * Needs a look fold.
   */
  describe("an entry", () => {
    const AVOCADO = {
      ingredient_id: 9,
      name: "Optional: 1 diced ripe avocado",
      issue: "amount_in_name",
      affects: ["price", "nutrition"],
    };
    const PAPRICA_UNMATCHED = {
      ingredient_id: 10,
      name: "paprica",
      issue: "no_match",
      affects: ["price"],
    };
    const PAPRICA_NO_FOOD = {
      ingredient_id: 10,
      name: "paprica",
      issue: "no_food",
      affects: ["nutrition"],
    };
    const BEANS = {
      ingredient_id: 11,
      name: "can black beans",
      issue: "unweighable",
      affects: ["nutrition"],
    };

    /** The by-recipe list's entry for one recipe. */
    async function entryFor(title: string): Promise<HTMLElement> {
      return (await screen.findByRole("link", { name: title })).closest<HTMLElement>(
        ".attention-recipe",
      )!;
    }

    function openOn(entries: unknown, routes: Record<string, unknown> = {}) {
      localStorage.setItem("ingredients-look-by", "recipe");
      mockBackend({
        "GET /api/ingredients": list(fries),
        "GET /api/recipes/attention": entries,
        ...routes,
      });
      return renderApp("/ingredients?view=look");
    }

    /**
     * An entry as it reads: each list of lines under what they hold up, and
     * each line's row and reason, in order.
     */
    function groups(entry: HTMLElement): [string, string[][]][] {
      return within(entry)
        .getAllByRole("list")
        .map((ul) => [
          // The heading that names the list, for a screen reader as for the eye.
          document.getElementById(ul.getAttribute("aria-labelledby")!)?.textContent ?? "",
          within(ul)
            .getAllByRole("listitem")
            .map((li) => [
              within(li).getByRole("link").textContent ?? "",
              li.querySelector(".issue-tag")?.textContent ?? "",
            ]),
        ]);
    }

    it("says what each row holds up, and sums it up for the recipe", async () => {
      openOn([{ recipe: bread, issues: [AVOCADO, PAPRICA_UNMATCHED, BEANS], no_servings: false }]);

      const entry = await entryFor("Banana bread");

      expect(within(entry).getByRole("link", { name: "Banana bread" })).toHaveAttribute(
        "href",
        "/recipes/8",
      );
      expect(within(entry).getByText("2 for nutrition · 2 for price")).toBeInTheDocument();
      expect(groups(entry)).toEqual([
        ["Price and nutrition", [["Optional: 1 diced ripe avocado", "amount is in the name"]]],
        ["Nutrition", [["can black beans", "can't weigh the amount"]]],
        ["Price", [["paprica", "no match"]]],
      ]);
    });

    it("lists a row under each when price and nutrition are held up for their own reasons", async () => {
      openOn([{ recipe: bread, issues: [PAPRICA_UNMATCHED, PAPRICA_NO_FOOD], no_servings: false }]);

      const entry = await entryFor("Banana bread");

      expect(within(entry).getByText("1 for nutrition · 1 for price")).toBeInTheDocument();
      expect(groups(entry)).toEqual([
        ["Nutrition", [["paprica", "no food chosen"]]],
        ["Price", [["paprica", "no match"]]],
      ]);
    });

    it("links a price line to its row and a nutrition line to its place in the breakdown", async () => {
      openOn([
        { recipe: bread, issues: [AVOCADO, PAPRICA_UNMATCHED, PAPRICA_NO_FOOD], no_servings: false },
      ]);

      const entry = await entryFor("Banana bread");
      const link = (heading: string, name: string) =>
        within(within(entry).getByRole("list", { name: heading })).getByRole("link", { name });

      // A reason the recipe line has wrong is fixed on the line, whatever it
      // also holds up.
      expect(link("Price and nutrition", "Optional: 1 diced ripe avocado")).toHaveAttribute(
        "href",
        "/recipes/8?ingredient=9",
      );
      expect(link("Price", "paprica")).toHaveAttribute("href", "/recipes/8?ingredient=10");
      expect(link("Nutrition", "paprica")).toHaveAttribute("href", "/recipes/8?nutrition=10");
    });

    it("sends a recipe with no serving count to its edit form", async () => {
      openOn([{ recipe: bread, issues: [BEANS], no_servings: true }]);

      const entry = await entryFor("Banana bread");

      expect(within(entry).getByText("2 for nutrition")).toBeInTheDocument();
      expect(groups(entry)).toEqual([
        [
          "Nutrition",
          [
            ["Whole recipe", "no serving count"],
            ["can black beans", "can't weigh the amount"],
          ],
        ],
      ]);
      expect(within(entry).getByRole("link", { name: "Whole recipe" })).toHaveAttribute(
        "href",
        "/recipes/8/edit",
      );
    });

    it("lands a nutrition line on the breakdown, open at that ingredient", async () => {
      const cake = recipe({
        id: 8,
        title: "Banana bread",
        servings: 12,
        ingredients: [{ id: 10, name: "paprica", quantity: 1, unit: "tbsp" }],
      });
      const { user } = openOn([{ recipe: bread, issues: [PAPRICA_NO_FOOD], no_servings: false }], {
        "GET /api/recipes/:id/nutrition": {
          servings: 12,
          per_serving: null,
          counted: 0,
          total_lines: 1,
          lines: [
            {
              ingredient_id: 10,
              name: "paprica",
              key: "paprica",
              measured: true,
              skipped: false,
              food: null,
              hand_picked: false,
              grams: null,
              nutrients: null,
              issue: "no_food",
            },
          ],
        },
        "GET /api/recipes/:id": cake,
      });

      const entry = await entryFor("Banana bread");
      await user.click(within(entry).getByRole("link", { name: "paprica" }));

      const row = await screen.findByText("paprica", { selector: ".nutrition-lines .name" });
      expect(document.querySelector("#nutrition")).toHaveAttribute("open");
      expect(row.closest("li")).toHaveClass("highlighted");
    });
  });
});
