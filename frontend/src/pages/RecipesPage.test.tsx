import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest, type RouteHandler, type Routes } from "../test/backend";
import { page, recipe, recipeSummary, tagCount } from "../test/fixtures";
import { renderApp } from "../test/render";

const curry = recipeSummary({
  id: 1,
  title: "Weeknight chicken curry",
  description: "Fast and warming.",
  tags: ["quick", "dinner"],
});
const bread = recipeSummary({
  id: 2,
  title: "Banana bread",
  description: "A classic loaf.",
  tags: ["baking"],
});

/** What the quick row is built from, with pricing off unless a test says otherwise. */
const FACETS = {
  tags: [tagCount("dinner"), tagCount("quick"), tagCount("baking")],
  on_sale: null,
  ingredients: [],
};

const NO_SUGGESTIONS = { ingredients: [], tags: [], recipes: [] };

/**
 * The page asks for a page of recipes and for the quick row's facets, and
 * the search box asks for recent searches and suggestions, so every test
 * needs those answered.
 */
function recipesBackend(
  recipes: RouteHandler | object,
  facets: unknown = FACETS,
  routes: Routes = {},
) {
  return mockBackend({
    "GET /api/recipes/facets": facets,
    "GET /api/recipes": recipes,
    "GET /api/recipes/suggest": NO_SUGGESTIONS,
    "GET /api/recipes/searches": [],
    "POST /api/recipes/searches": undefined,
    ...routes,
  });
}

function cardTitles(): string[] {
  return screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
}

/**
 * The page's own requests for the grid, leaving out the one-recipe asks
 * that count the box and the removals the empty state offers.
 */
function listRequests(backend: { requestsTo(p: string): MockRequest[] }): MockRequest[] {
  return backend
    .requestsTo("GET /api/recipes")
    .filter((r) => r.searchParams.get("per_page") !== "1");
}

function lastListRequest(backend: { requestsTo(p: string): MockRequest[] }): MockRequest {
  const requests = listRequests(backend);
  return requests[requests.length - 1];
}

/**
 * Requests for one recipe. The ":id" pattern also matches the literal paths
 * beside it (facets, suggest, searches), so they are told apart by path.
 */
function recipeRequests(backend: { requestsTo(p: string): MockRequest[] }, id: number) {
  return backend.requestsTo("GET /api/recipes/:id").filter((r) => r.path === `/api/recipes/${id}`);
}

function searchBox(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search recipes" });
}

function sortMenu(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Sort" });
}

/** The line between the controls and the grid that says what is listed. */
function resultLine(): string {
  return document.querySelector(".recipes-result")?.textContent ?? "";
}

/** The tag chips a card shows, in order; spares wait out of sight to be measured. */
function cardChips(title: string): string[] {
  const card = screen.getByRole("heading", { name: title }).closest("a")!;
  return [...card.querySelectorAll(".card-tags .chip:not(.spare)")].map(
    (c) => c.textContent ?? "",
  );
}

describe("RecipesPage", () => {
  it("lists a page of recipes with the total count", async () => {
    recipesBackend(page([curry, bread]));
    renderApp("/recipes");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(cardTitles()).toEqual(["Weeknight chicken curry", "Banana bread"]);
    expect(screen.getByText("2 saved")).toBeInTheDocument();
    expect(resultLine()).toBe("2 recipes");
  });

  it("counts every match, not the recipes on screen", async () => {
    // The whole point of `total`: 87 saved, 24 fetched.
    recipesBackend(page([curry, bread], { total: 87 }));
    renderApp("/recipes");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(screen.getByText("87 saved")).toBeInTheDocument();
    expect(resultLine()).toBe("87 recipes");
  });

  it("starts the recipes right under the search controls", async () => {
    // The folds that used to stand between the search and the recipes are
    // gone, and nothing asks for what they showed.
    const backend = recipesBackend(page([curry, bread]), FACETS, {
      "GET /api/recipes/attention": [],
    });
    renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    expect(screen.queryByText(/on sale this week/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs a look/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Under /)).not.toBeInTheDocument();
    expect(screen.queryByText(/in your pantry/i)).not.toBeInTheDocument();
    expect(backend.requestsTo("GET /api/recipes/attention")).toHaveLength(0);
    expect(document.querySelector(".recipes-controls")!.nextElementSibling).toHaveClass(
      "recipe-grid",
    );
  });

  it("counts the whole box in the header while a search is applied", async () => {
    // The result line counts the matches; the header keeps saying how many
    // recipes there are, even when the page opens filtered.
    recipesBackend((req) =>
      req.searchParams.get("tag") ? page([curry]) : page([curry], { total: 33 }),
    );
    renderApp("/recipes?tag=dinner");

    expect(await screen.findByText("33 saved")).toBeInTheDocument();
    expect(resultLine()).toBe("1 recipe · dinner");
  });

  it("shows only a description's first paragraph on its card", async () => {
    // The card cuts its description to a line or two; the paragraphs after
    // the first would only run on into it.
    recipesBackend(
      page([{ ...curry, description: "Fast and warming.\n\nNotes: Freezes for a month." }]),
    );
    renderApp("/recipes");

    const card = (await screen.findByRole("heading", { name: curry.title })).closest("a")!;
    expect(within(card).getByText("Fast and warming.")).toHaveClass("desc");
    expect(card).not.toHaveTextContent("Freezes for a month");
  });

  it("links each card to its recipe", async () => {
    recipesBackend(page([curry, bread]));
    renderApp("/recipes");

    const card = (await screen.findByText("Banana bread")).closest("a");
    expect(card).toHaveAttribute("href", "/recipes/2");
  });

  it("offers both ways in when the recipe box is empty", async () => {
    recipesBackend(page([]), { ...FACETS, tags: [] });
    renderApp("/recipes");

    expect(await screen.findByText("Your recipe box is empty")).toBeInTheDocument();
    const empty = screen
      .getByText("Your recipe box is empty")
      .closest<HTMLElement>(".empty-state")!;
    expect(within(empty).getByRole("link", { name: /find a recipe online/i })).toHaveAttribute(
      "href",
      "/recipes/search",
    );
    expect(within(empty).getByRole("link", { name: /new recipe/i })).toHaveAttribute(
      "href",
      "/recipes/new",
    );
    // Nothing to search or sort: the box and the menu would only be in the way.
    expect(screen.queryByRole("combobox", { name: "Search recipes" })).toBeNull();
    expect(screen.queryByLabelText("Sort")).toBeNull();
  });

  it("holds the quick row's line while its tags load", async () => {
    // The facets answer after the recipes; until then an invisible chip keeps
    // the row's height, so the grid does not jump down when they arrive.
    recipesBackend(page([curry]), () => new Promise(() => {}));
    const { container } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    const held = container.querySelector(".quick-row-wrap");
    expect(held).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /All tags/ })).toBeNull();
  });

  it("hands the search to the server and shows what comes back", async () => {
    // Searching in the browser would only ever see the page it had loaded, so
    // the query goes to the server and the results are whatever it returns.
    const backend = recipesBackend((req) =>
      req.searchParams.get("q") === "coconut" ? page([curry]) : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Banana bread");

    await user.type(searchBox(), "coconut");

    await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
    expect(lastListRequest(backend).searchParams.get("q")).toBe("coconut");
    expect(resultLine()).toBe("1 recipe · “coconut”");
    expect(screen.getByText("2 saved")).toBeInTheDocument();
  });

  it("debounces typing instead of asking on every keystroke", async () => {
    const backend = recipesBackend(page([curry]));
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.type(searchBox(), "curry");

    await waitFor(() => expect(lastListRequest(backend).searchParams.get("q")).toBe("curry"));
    // One request for the initial load and one for the settled query; a
    // request per letter would be six.
    expect(backend.requestsTo("GET /api/recipes").length).toBeLessThan(6);
  });

  it("filters by a tag picked from the quick row", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("tag") === "dinner" ? page([curry]) : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Banana bread");

    await user.click(screen.getByRole("button", { name: /^dinner/ }));

    await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
    expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual(["dinner"]);
    // Picked, it lives in the box, and the row asks what would narrow it further.
    expect(screen.getByRole("button", { name: "Remove dinner" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dinner/ })).not.toBeInTheDocument();
    const facets = backend.requestsTo("GET /api/recipes/facets");
    expect(facets[facets.length - 1].searchParams.getAll("tag")).toEqual(["dinner"]);
    expect(resultLine()).toBe("1 recipe · dinner");
  });

  it("sends the typing and a picked tag together", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("q") || req.searchParams.get("tag")
        ? page([])
        : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await user.type(searchBox(), "chicken");

    await waitFor(() => {
      const request = lastListRequest(backend);
      expect(request.searchParams.get("q")).toBe("chicken");
      expect(request.searchParams.get("tag")).toBe("baking");
    });
    expect(await screen.findByText("No recipes match baking · “chicken”.")).toBeInTheDocument();
  });

  it("keeps the count with the results it counts while a search is in flight", async () => {
    // Otherwise the line pairs the query the user just typed with the total
    // from before it and announces "31 recipes · zuppa" for a search nothing
    // has counted yet.
    let answer: (value: unknown) => void = () => {};
    const backend = recipesBackend((req) =>
      req.searchParams.get("q")
        ? new Promise((resolve) => (answer = resolve))
        : page([curry, bread], { total: 31 }),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("31 saved");

    await user.type(searchBox(), "zuppa");
    await waitFor(() => expect(backend.requestsTo("GET /api/recipes")).toHaveLength(2));

    expect(resultLine()).toBe("31 recipes");

    answer(page([curry], { total: 1 }));
    await waitFor(() => expect(resultLine()).toBe("1 recipe · “zuppa”"));
    expect(screen.getByText("31 saved")).toBeInTheDocument();
  });

  it("adds On sale from the quick row and sorts by biggest sale", async () => {
    const backend = recipesBackend(
      (req) => (req.searchParams.get("on_sale") === "true" ? page([curry]) : page([curry, bread])),
      { ...FACETS, on_sale: 1 },
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Banana bread");

    await user.click(screen.getByRole("button", { name: /^On sale/ }));

    await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
    expect(lastListRequest(backend).searchParams.get("on_sale")).toBe("true");
    expect(screen.getByRole("button", { name: "Remove on sale" })).toBeInTheDocument();
    expect(resultLine()).toBe("1 recipe · on sale");
    // Picking On sale filters; it leaves the order alone.
    expect(sortMenu()).toHaveValue("title");
    expect(lastListRequest(backend).searchParams.get("sort")).toBe("title");

    await user.selectOptions(sortMenu(), "Biggest sale");

    await waitFor(() => expect(lastListRequest(backend).searchParams.get("sort")).toBe("sale"));
    expect(lastListRequest(backend).searchParams.get("on_sale")).toBe("true");
    expect(lastListRequest(backend).searchParams.get("page")).toBe("1");
  });

  it("offers the four sorts, in order", async () => {
    const backend = recipesBackend(page([curry]), { ...FACETS, on_sale: 0 });
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    expect(within(sortMenu()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "A-Z",
      "Recently added",
      "Recently cooked",
      "Biggest sale",
    ]);

    await user.selectOptions(sortMenu(), "Recently cooked");
    await waitFor(() => expect(lastListRequest(backend).searchParams.get("sort")).toBe("cooked"));
  });

  it("hides Biggest sale when pricing is off", async () => {
    recipesBackend(page([curry]), { ...FACETS, on_sale: null });
    renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    expect(within(sortMenu()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "A-Z",
      "Recently added",
      "Recently cooked",
    ]);
    expect(screen.queryByRole("button", { name: /^On sale/ })).not.toBeInTheDocument();
  });

  it("opens with the sort the URL names", async () => {
    const backend = recipesBackend(page([curry]));
    renderApp("/recipes?sort=newest");
    await screen.findByText("Weeknight chicken curry");

    expect(sortMenu()).toHaveValue("newest");
    expect(lastListRequest(backend).searchParams.get("sort")).toBe("newest");
  });

  it("shows a sale ribbon on a recipe on sale and nothing on the rest", async () => {
    recipesBackend(page([{ ...curry, sale_percent: 24 }, bread]), { ...FACETS, on_sale: 1 });
    renderApp("/recipes");

    const onSale = (await screen.findByRole("heading", { name: curry.title })).closest("a")!;
    const ribbon = within(onSale).getByText("24% off");
    expect(ribbon).toHaveClass("sale-ribbon");
    expect(ribbon.closest(".photo-wrap")).not.toBeNull();

    const notOnSale = screen.getByRole("heading", { name: bread.title }).closest("a")!;
    expect(notOnSale.querySelector(".sale-ribbon")).toBeNull();
    // A card never carries a price.
    expect(onSale).not.toHaveTextContent("$");
  });

  it("opens an old bookmark with its search in the box", async () => {
    const backend = recipesBackend(page([curry]));
    renderApp("/recipes?q=curry&tag=dinner");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    const request = lastListRequest(backend);
    expect(request.searchParams.get("q")).toBe("curry");
    expect(request.searchParams.getAll("tag")).toEqual(["dinner"]);
    expect(screen.getByRole("button", { name: "Remove dinner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove “curry”" })).toBeInTheDocument();
    expect(searchBox()).toHaveValue("");
    expect(resultLine()).toBe("1 recipe · dinner · “curry”");
  });

  it("names ingredient tokens from the facets", async () => {
    // The URL carries only the key; the server knows what the owner calls it.
    const backend = recipesBackend(page([curry]), {
      ...FACETS,
      ingredients: [{ key: "chicken-thigh", name: "chicken thighs" }],
    });
    renderApp("/recipes?ing=chicken-thigh");

    expect(await screen.findByRole("button", { name: "Remove chicken thighs" })).toBeInTheDocument();
    expect(lastListRequest(backend).searchParams.getAll("ingredient")).toEqual(["chicken-thigh"]);
    await waitFor(() => expect(resultLine()).toBe("1 recipe · 🥕 chicken thighs"));
  });

  describe("search history", () => {
    it("records the search when a recipe is opened from it", async () => {
      const backend = recipesBackend(page([curry]), FACETS, { "GET /api/recipes/:id": recipe({ id: 1 }) });
      const { user } = renderApp("/recipes?tag=dinner&sale=1");
      await screen.findByText("Weeknight chicken curry");

      await user.click(screen.getByRole("heading", { name: curry.title }));

      await waitFor(() => expect(backend.requestsTo("POST /api/recipes/searches")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/recipes/searches")[0].body).toEqual({
        text: "",
        tags: ["dinner"],
        ingredients: [],
        on_sale: true,
      });
      await waitFor(() => expect(recipeRequests(backend, 1)).toHaveLength(1));
    });

    it("records the typing the results answer, as the search's text", async () => {
      const backend = recipesBackend(
        (req) => (req.searchParams.get("q") ? page([curry]) : page([curry, bread])),
        FACETS,
        { "GET /api/recipes/:id": recipe({ id: 1 }) },
      );
      const { user } = renderApp("/recipes");
      await screen.findByText("Banana bread");
      await user.type(searchBox(), "curry");
      await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));

      await user.click(screen.getByRole("heading", { name: curry.title }));

      await waitFor(() => expect(backend.requestsTo("POST /api/recipes/searches")).toHaveLength(1));
      expect(backend.requestsTo("POST /api/recipes/searches")[0].body).toEqual({
        text: "curry",
        tags: [],
        ingredients: [],
        on_sale: false,
      });
    });

    it("records the box's tokens when a recipe is opened from its suggestions", async () => {
      const backend = recipesBackend(page([curry, bread]), FACETS, {
        "GET /api/recipes/suggest": { ...NO_SUGGESTIONS, recipes: [{ id: 2, title: "Banana bread" }] },
        "GET /api/recipes/:id": recipe({ id: 2, title: "Banana bread" }),
      });
      const { user } = renderApp("/recipes?tag=baking");
      await screen.findByText("Banana bread");

      await user.type(searchBox(), "bana");
      await user.click(await screen.findByRole("option", { name: /Banana bread/ }));

      await waitFor(() => expect(recipeRequests(backend, 2)).toHaveLength(1));
      // The typing was finding the recipe, not searching: only the tokens count.
      expect(backend.requestsTo("POST /api/recipes/searches").map((r) => r.body)).toEqual([
        { text: "", tags: ["baking"], ingredients: [], on_sale: false },
      ]);
    });

    it("does not record anything when no search is applied", async () => {
      const backend = recipesBackend(page([curry]), FACETS, { "GET /api/recipes/:id": recipe({ id: 1 }) });
      const { user } = renderApp("/recipes");
      await screen.findByText("Weeknight chicken curry");

      await user.click(screen.getByRole("heading", { name: curry.title }));

      await waitFor(() => expect(recipeRequests(backend, 1)).toHaveLength(1));
      expect(backend.requestsTo("POST /api/recipes/searches")).toHaveLength(0);
    });

    it("still opens the recipe when the search could not be recorded", async () => {
      const backend = recipesBackend(page([curry]), FACETS, {
        "POST /api/recipes/searches": new HttpError(500, "History is down"),
        "GET /api/recipes/:id": recipe({ id: 1, title: "Weeknight chicken curry" }),
      });
      const { user } = renderApp("/recipes?tag=dinner");
      await screen.findByText("Weeknight chicken curry");

      await user.click(screen.getByRole("heading", { name: curry.title }));

      expect(await screen.findByRole("heading", { level: 1, name: curry.title })).toBeInTheDocument();
      expect(backend.requestsTo("POST /api/recipes/searches")).toHaveLength(1);
      expect(screen.queryByText("History is down")).not.toBeInTheDocument();
    });
  });

  describe("when nothing matches", () => {
    it("offers the removal that brings results back", async () => {
      // Dinner and on sale together match nothing; on sale alone matches
      // nothing either, but dinner alone matches one.
      const backend = recipesBackend((req) => {
        const dinner = req.searchParams.get("tag") === "dinner";
        const sale = req.searchParams.get("on_sale") === "true";
        if (dinner && sale) return page([]);
        if (sale) return page([], { total: 0 });
        if (dinner) return page([curry]);
        return page([curry, bread]);
      });
      const { user } = renderApp("/recipes?tag=dinner&sale=1");

      expect(await screen.findByText("No recipes match dinner · on sale.")).toBeInTheDocument();
      const remove = await screen.findByRole("button", { name: "Remove “on sale” to see 1" });

      await user.click(remove);

      await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
      expect(lastListRequest(backend).searchParams.get("on_sale")).toBe(null);
      expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual(["dinner"]);
      expect(screen.queryByRole("button", { name: "Remove on sale" })).not.toBeInTheDocument();
    });

    it("offers to drop a tag no recipe carries any more", async () => {
      // An old search, opened from history or a bookmark, naming a tag that
      // has since been renamed away.
      recipesBackend((req) => {
        const tags = req.searchParams.getAll("tag");
        if (tags.includes("gone")) return page([]);
        return tags.includes("dinner") ? page([curry]) : page([curry, bread]);
      });
      renderApp("/recipes?tag=dinner&tag=gone");

      expect(await screen.findByText("No recipes match dinner · gone.")).toBeInTheDocument();
      expect(
        await screen.findByRole("button", { name: "Remove “gone” to see 1" }),
      ).toBeInTheDocument();
    });

    it("offers the first removal that helps, in the box's order", async () => {
      // Dropping dinner leaves two on sale, dropping on sale leaves one
      // dinner: both help, and the box's first token is the one offered.
      recipesBackend((req) => {
        const dinner = req.searchParams.get("tag") === "dinner";
        const sale = req.searchParams.get("on_sale") === "true";
        if (dinner && sale) return page([]);
        if (sale) return page([curry, bread]);
        return page([curry]);
      });
      renderApp("/recipes?tag=dinner&sale=1");

      expect(
        await screen.findByRole("button", { name: "Remove “dinner” to see 2" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Remove “on sale”/ })).not.toBeInTheDocument();
    });

    it("offers Clear when no single removal brings anything back", async () => {
      const backend = recipesBackend((req) =>
        req.searchParams.get("q") || req.searchParams.get("tag")
          ? page([])
          : page([curry, bread]),
      );
      const { user } = renderApp("/recipes?q=zuppa&tag=dinner");
      expect(await screen.findByText("No recipes match dinner · “zuppa”.")).toBeInTheDocument();

      const clear = await screen.findByRole("button", { name: "Clear the search" });
      expect(screen.queryByRole("button", { name: /to see/ })).not.toBeInTheDocument();
      await user.click(clear);

      await waitFor(() =>
        expect(cardTitles()).toEqual(["Weeknight chicken curry", "Banana bread"]),
      );
      const request = lastListRequest(backend);
      expect(request.searchParams.get("q")).toBe(null);
      expect(request.searchParams.getAll("tag")).toEqual([]);
    });
  });

  describe("tags on cards", () => {
    it("shows a recipe's tags under its title", async () => {
      recipesBackend(page([curry]));
      renderApp("/recipes");
      await screen.findByText("Weeknight chicken curry");

      expect(cardChips("Weeknight chicken curry")).toEqual(["quick", "dinner"]);
    });

    it("shows three and counts the rest, naming them on hover", async () => {
      const busy = recipeSummary({
        id: 5,
        title: "Dan dan noodles",
        tags: ["chinese", "dinner", "noodles", "spicy", "weeknight"],
      });
      recipesBackend(page([busy]));
      renderApp("/recipes");
      await screen.findByText("Dan dan noodles");

      expect(cardChips("Dan dan noodles")).toEqual(["chinese", "dinner", "noodles", "+2"]);
      expect(screen.getByText("+2")).toHaveAttribute("title", "spicy, weeknight");
    });

    it("leaves the row off a recipe with no tags", async () => {
      recipesBackend(page([recipeSummary({ id: 9, title: "Plain toast", tags: [] })]));
      renderApp("/recipes");
      await screen.findByText("Plain toast");

      const card = screen.getByRole("heading", { name: "Plain toast" }).closest("a")!;
      expect(card.querySelector(".card-tags")).toBeNull();
    });
  });

  it("loads the next page and appends it to what is already shown", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("page") === "2"
        ? page([bread], { total: 2, page: 2 })
        : page([curry], { total: 2, page: 1 }),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");
    expect(screen.getByText("Showing 1 of 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("Banana bread")).toBeInTheDocument();
    expect(cardTitles()).toEqual(["Weeknight chicken curry", "Banana bread"]);
    expect(lastListRequest(backend).searchParams.get("page")).toBe("2");
  });

  it("asks for the next page in the same order and with the same search", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("page") === "2"
        ? page([bread], { total: 2, page: 2 })
        : page([curry], { total: 2, page: 1 }),
    );
    const { user } = renderApp("/recipes?tag=dinner&sort=newest");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /load more/i }));

    await screen.findByText("Banana bread");
    const request = lastListRequest(backend);
    expect(request.searchParams.get("page")).toBe("2");
    expect(request.searchParams.get("sort")).toBe("newest");
    expect(request.searchParams.getAll("tag")).toEqual(["dinner"]);
  });

  it("drops the load-more button once everything is on screen", async () => {
    recipesBackend(page([curry, bread]));
    renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("starts over at page one when the filter changes", async () => {
    // Otherwise a search run after loading three pages would ask the server
    // for page four of a collection it has not seen the start of.
    const backend = recipesBackend((req) => {
      if (req.searchParams.get("q")) return page([bread]);
      return req.searchParams.get("page") === "2"
        ? page([bread], { total: 2, page: 2 })
        : page([curry], { total: 2, page: 1 });
    });
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Banana bread");

    await user.type(searchBox(), "bread");

    await waitFor(() => expect(cardTitles()).toEqual(["Banana bread"]));
    expect(lastListRequest(backend).searchParams.get("page")).toBe("1");
  });

  it("does not append a page fetched for a search that has since changed", async () => {
    // "Load more" answering after the search moved on belongs to the old
    // results, and must not be stacked under the new ones.
    let answer: (value: unknown) => void = () => {};
    recipesBackend((req) => {
      if (req.searchParams.get("page") === "2") return new Promise((resolve) => (answer = resolve));
      if (req.searchParams.get("tag")) return page([bread], { total: 3 });
      return page([curry], { total: 2 });
    });
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /load more/i }));
    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await waitFor(() => expect(cardTitles()).toEqual(["Banana bread"]));
    answer(page([recipeSummary({ id: 7, title: "Old page two" })], { total: 2, page: 2 }));

    // The button is back once the stalled page has been dealt with.
    expect(await screen.findByRole("button", { name: "Load more" })).toBeEnabled();
    expect(cardTitles()).toEqual(["Banana bread"]);
    expect(screen.getByText("Showing 1 of 3")).toBeInTheDocument();
  });

  it("offers no next page while a new search is loading", async () => {
    // The page it would fetch continues the results about to be replaced.
    let answer: (value: unknown) => void = () => {};
    const backend = recipesBackend((req) => {
      if (req.searchParams.get("tag")) return new Promise((resolve) => (answer = resolve));
      return page([curry], { total: 2 });
    });
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await waitFor(() => expect(listRequests(backend)).toHaveLength(2));

    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    answer(page([bread], { total: 3 }));

    await waitFor(() => expect(cardTitles()).toEqual(["Banana bread"]));
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    expect(listRequests(backend).filter((r) => r.searchParams.get("page") === "2")).toHaveLength(0);
  });

  it("puts a Biggest sale bookmark back to A-Z when pricing is off", async () => {
    const backend = recipesBackend(page([curry]), { ...FACETS, on_sale: null });
    renderApp("/recipes?sort=sale");
    await screen.findByText("Weeknight chicken curry");

    await waitFor(() => expect(lastListRequest(backend).searchParams.get("sort")).toBe("title"));
    expect(sortMenu()).toHaveValue("title");
  });

  it("reports a failed load instead of claiming the recipe box is empty", async () => {
    // Telling someone their recipes are gone when the server is merely
    // unreachable is the one thing this screen must never do.
    recipesBackend(new HttpError(500, "Database is down"));
    renderApp("/recipes");

    expect(await screen.findByText(/Couldn't load your recipes/)).toBeInTheDocument();
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    expect(screen.queryByText("Your recipe box is empty")).not.toBeInTheDocument();
  });

  it("retries the load when the error state's button is pressed", async () => {
    let attempt = 0;
    const backend = recipesBackend(() =>
      ++attempt === 1 ? new HttpError(503, "Server is restarting") : page([curry]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText(/Couldn't load your recipes/);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    expect(backend.requestsTo("GET /api/recipes")).toHaveLength(2);
  });

  it("still lists recipes when the quick row fails to load", async () => {
    recipesBackend(page([curry]), new HttpError(500, "No facets for you"));
    renderApp("/recipes");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    expect(screen.queryByText("No facets for you")).not.toBeInTheDocument();
  });
});
