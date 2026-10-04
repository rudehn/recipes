import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest, type RouteHandler } from "../test/backend";
import { page, recipe, recipeSummary, tagCount } from "../test/fixtures";
import { renderApp, type AppRender } from "../test/render";

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

const TAGS = [tagCount("baking"), tagCount("dinner"), tagCount("quick")];

/**
 * The page asks the server for both a page of recipes and the tag list, so
 * every test needs both routes answered.
 */
function recipesBackend(recipes: RouteHandler | object, tags: unknown = TAGS) {
  return mockBackend({
    "GET /api/recipes/tags": tags,
    "GET /api/recipes": recipes,
    "GET /api/recipes/suggestions": NOTHING_TO_SUGGEST,
    "GET /api/recipes/attention": [],
  });
}

const NOTHING_TO_SUGGEST = { on_sale: [], cheap: [], median_per_serving: null, pantry: [] };

const SUGAR_ON_SALE = {
  key: "granulated-sugar",
  name: "sugar",
  price: {
    product_id: "0002",
    description: "Kroger® Granulated Sugar",
    size: "4 lb",
    regular: 3.99,
    promo: 2.99,
    aisle: "AISLE 18",
    in_stock: true,
    estimated: null,
  },
};

function cardTitles(): string[] {
  return screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
}

/** Tag pills by accessible name, which carries the count the pill shows. */
function pillLabels(): string[] {
  return screen
    .getAllByRole("button")
    .filter((b) => b.className.includes("tag-pill"))
    .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
}

function lastListRequest(backend: { requestsTo(p: string): MockRequest[] }): MockRequest {
  const requests = backend.requestsTo("GET /api/recipes");
  return requests[requests.length - 1];
}

function lastTagsRequest(backend: { requestsTo(p: string): MockRequest[] }): MockRequest {
  const requests = backend.requestsTo("GET /api/recipes/tags");
  return requests[requests.length - 1];
}

function pill(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name: typeof name === "string" ? new RegExp(`^${name}`) : name });
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
  });

  it("counts every match, not the recipes on screen", async () => {
    // The whole point of `total`: 87 saved, 24 fetched.
    recipesBackend(page([curry, bread], { total: 87 }));
    renderApp("/recipes");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(screen.getByText("87 saved")).toBeInTheDocument();
  });

  it("links each card to its recipe", async () => {
    recipesBackend(page([curry, bread]));
    renderApp("/recipes");

    const card = (await screen.findByText("Banana bread")).closest("a");
    expect(card).toHaveAttribute("href", "/recipes/2");
  });

  it("offers both ways in when the recipe box is empty", async () => {
    recipesBackend(page([]), []);
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
  });

  it("hands the search to the server and shows what comes back", async () => {
    // Searching in the browser would only ever see the page it had loaded, so
    // the query goes to the server and the results are whatever it returns.
    const backend = recipesBackend((req) =>
      req.searchParams.get("q") === "coconut" ? page([curry]) : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Banana bread");

    await user.type(screen.getByPlaceholderText(/search recipes/i), "coconut");

    await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
    expect(lastListRequest(backend).searchParams.get("q")).toBe("coconut");
    expect(screen.getByText("1 match")).toBeInTheDocument();
  });

  it("debounces typing instead of asking on every keystroke", async () => {
    const backend = recipesBackend(page([curry]));
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.type(screen.getByPlaceholderText(/search recipes/i), "curry");

    await waitFor(() =>
      expect(lastListRequest(backend).searchParams.get("q")).toBe("curry"),
    );
    // One request for the initial load and one for the settled query; a
    // request per letter would be six.
    expect(backend.requestsTo("GET /api/recipes").length).toBeLessThan(6);
  });

  it("filters by tag, and clears the filter when the tag is clicked again", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("tag") === "baking" ? page([bread]) : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await waitFor(() => expect(cardTitles()).toEqual(["Banana bread"]));

    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await waitFor(() =>
      expect(cardTitles()).toEqual(["Weeknight chicken curry", "Banana bread"]),
    );
    expect(lastListRequest(backend).searchParams.get("tag")).toBe(null);
  });

  it("sends the search and the tag filter together", async () => {
    const backend = recipesBackend((req) =>
      req.searchParams.get("q") || req.searchParams.get("tag")
        ? page([])
        : page([curry, bread]),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("Weeknight chicken curry");

    await user.click(screen.getByRole("button", { name: /^baking/ }));
    await user.type(screen.getByPlaceholderText(/search recipes/i), "chicken");

    await waitFor(() => {
      const request = lastListRequest(backend);
      expect(request.searchParams.get("q")).toBe("chicken");
      expect(request.searchParams.get("tag")).toBe("baking");
    });
    expect(
      screen.getByText(/No recipes match “chicken” with tag “baking”/),
    ).toBeInTheDocument();
  });

  it("keeps the count with the results it counts while a search is in flight", async () => {
    // Otherwise the header pairs the query the user just typed with the total
    // from before it and announces "31 matches" for a search nothing has
    // counted yet.
    let answer: (value: unknown) => void = () => {};
    const backend = recipesBackend((req) =>
      req.searchParams.get("q")
        ? new Promise((resolve) => (answer = resolve))
        : page([curry, bread], { total: 31 }),
    );
    const { user } = renderApp("/recipes");
    await screen.findByText("31 saved");

    await user.type(screen.getByPlaceholderText(/search recipes/i), "zuppa");
    await waitFor(() => expect(backend.requestsTo("GET /api/recipes")).toHaveLength(2));

    expect(screen.getByText("31 saved")).toBeInTheDocument();
    expect(screen.queryByText("31 matches")).not.toBeInTheDocument();

    answer(page([curry], { total: 1 }));
    expect(await screen.findByText("1 match")).toBeInTheDocument();
  });

  it("builds the tag bar from every tag, not just the loaded page", async () => {
    // Page one here carries no tags at all. The bar is still the whole set,
    // because it comes from its own endpoint.
    recipesBackend(page([recipeSummary({ id: 9, title: "Plain toast", tags: [] })]));
    renderApp("/recipes");
    await screen.findByText("Plain toast");

    expect(pillLabels()).toEqual([
      "All",
      "baking, 1 recipe",
      "dinner, 1 recipe",
      "quick, 1 recipe",
    ]);
  });

  describe("filtering by several tags", () => {
    it("narrows to the recipes carrying every tag selected", async () => {
      const backend = recipesBackend((req) => {
        const tags = req.searchParams.getAll("tag");
        if (tags.includes("dinner") && tags.includes("quick")) return page([curry]);
        if (tags.includes("dinner")) return page([curry, bread]);
        return page([curry, bread]);
      });
      const { user } = renderApp("/recipes");
      await screen.findByText("Weeknight chicken curry");

      await user.click(pill("dinner"));
      await user.click(pill("quick"));

      await waitFor(() => expect(cardTitles()).toEqual(["Weeknight chicken curry"]));
      expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual(["dinner", "quick"]);
      expect(pill("dinner")).toHaveAttribute("aria-pressed", "true");
      expect(pill("quick")).toHaveAttribute("aria-pressed", "true");
      expect(pill("baking")).toHaveAttribute("aria-pressed", "false");
    });

    it("drops one tag of several when it is tapped again", async () => {
      const backend = recipesBackend(page([curry]));
      const { user } = renderApp("/recipes?tag=dinner&tag=quick");
      await screen.findByText("Weeknight chicken curry");

      await user.click(pill("dinner"));

      await waitFor(() =>
        expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual(["quick"]),
      );
      expect(pill("dinner")).toHaveAttribute("aria-pressed", "false");
    });

    it("clears every selected tag with All", async () => {
      const backend = recipesBackend(page([curry]));
      const { user } = renderApp("/recipes?tag=dinner&tag=quick");
      await screen.findByText("Weeknight chicken curry");
      expect(pill("All")).toHaveAttribute("aria-pressed", "false");

      await user.click(pill("All"));

      await waitFor(() =>
        expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual([]),
      );
      expect(pill("All")).toHaveAttribute("aria-pressed", "true");
      expect(pill("dinner")).toHaveAttribute("aria-pressed", "false");
    });

    it("opens with every tag the URL names applied", async () => {
      const backend = recipesBackend(page([curry]));
      renderApp("/recipes?tag=dinner&tag=quick");

      expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
      expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual(["dinner", "quick"]);
      expect(pill("dinner")).toHaveClass("active");
      expect(pill("quick")).toHaveClass("active");
    });

    it("counts each tag within the search and the tags already selected", async () => {
      // A count is what tapping the pill would leave, so it has to be asked
      // of the same filters the list is showing.
      const backend = recipesBackend(page([curry]));
      const { user } = renderApp("/recipes");
      await screen.findByText("Weeknight chicken curry");

      await user.click(pill("dinner"));
      await user.type(screen.getByPlaceholderText(/search recipes/i), "curry");

      await waitFor(() => {
        const request = lastTagsRequest(backend);
        expect(request.searchParams.get("q")).toBe("curry");
        expect(request.searchParams.getAll("tag")).toEqual(["dinner"]);
      });
    });

    it("dims a tag that would leave nothing, but never a selected one", async () => {
      recipesBackend(page([]), (req: MockRequest) =>
        req.searchParams.getAll("tag").includes("dinner")
          ? [tagCount("baking", 0), tagCount("dinner", 0), tagCount("quick", 0)]
          : [tagCount("baking", 1), tagCount("dinner", 1), tagCount("quick", 1)],
      );
      const { user } = renderApp("/recipes?q=zuppa");
      await screen.findByText("No matches");

      await user.click(pill("dinner"));

      await waitFor(() => expect(pill("baking")).toBeDisabled());
      expect(pill("quick")).toBeDisabled();
      // Selected and leading nowhere, it still has to be tappable: it is the
      // way back out.
      expect(pill("dinner")).toBeEnabled();
      expect(pill("dinner")).toHaveAccessibleName("dinner, 0 recipes");
    });

    it("keeps a selected tag the box no longer has, so it can be taken off", async () => {
      // A link from before the tag was renamed would otherwise filter by
      // something the bar has no pill for.
      const backend = recipesBackend(page([]));
      const { user } = renderApp("/recipes?tag=gone");
      await screen.findByText("No matches");

      expect(pill("gone")).toHaveAttribute("aria-pressed", "true");
      await user.click(pill("gone"));

      await waitFor(() =>
        expect(lastListRequest(backend).searchParams.getAll("tag")).toEqual([]),
      );
      expect(screen.queryByRole("button", { name: /^gone/ })).not.toBeInTheDocument();
    });

    it("names every selected tag when nothing matches them all", async () => {
      recipesBackend(page([]));
      renderApp("/recipes?tag=dinner&tag=quick&tag=baking");

      expect(
        await screen.findByText("No recipes match with tags “dinner”, “quick” and “baking”."),
      ).toBeInTheDocument();
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

    await user.type(screen.getByPlaceholderText(/search recipes/i), "bread");

    await waitFor(() => expect(cardTitles()).toEqual(["Banana bread"]));
    expect(lastListRequest(backend).searchParams.get("page")).toBe("1");
  });

  it("opens with the filters named in the URL applied", async () => {
    const backend = recipesBackend(page([curry]));
    renderApp("/recipes?q=curry&tag=quick");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    const request = lastListRequest(backend);
    expect(request.searchParams.get("q")).toBe("curry");
    expect(request.searchParams.get("tag")).toBe("quick");
    expect(screen.getByPlaceholderText(/search recipes/i)).toHaveValue("curry");
    expect(screen.getByRole("button", { name: /^quick/ })).toHaveClass("active");
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

  it("still lists recipes when the tag bar fails to load", async () => {
    recipesBackend(page([curry]), new HttpError(500, "No tags for you"));
    renderApp("/recipes");

    expect(await screen.findByText("Weeknight chicken curry")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  describe("suggestions", () => {
    it("lists the recipes with an ingredient on offer, most on offer first", async () => {
      mockBackend({
        "GET /api/recipes/tags": TAGS,
        "GET /api/recipes": page([curry, bread]),
        "GET /api/recipes/suggestions": {
          ...NOTHING_TO_SUGGEST,
          on_sale: [{ recipe: bread, on_sale: [SUGAR_ON_SALE], ingredient_count: 3 }],
        },
      });
      const { user } = renderApp("/recipes");

      await user.click(await screen.findByText(/on sale this week/i));

      const offer = screen.getByText("1 of 3 ingredients on offer").closest(".offer")!;
      expect(within(offer as HTMLElement).getByRole("link", { name: "Banana bread" })).toHaveAttribute(
        "href",
        "/recipes/2",
      );
      expect(within(offer as HTMLElement).getByText("sugar")).toBeInTheDocument();
      expect(within(offer as HTMLElement).getByText("$3.99").tagName).toBe("S");
      expect(within(offer as HTMLElement).getByText(/\$2\.99/)).toBeInTheDocument();
    });

    it("names the recipes under the median cost per serving, with the number", async () => {
      // "Cheap" with a figure attached: below the median across the box,
      // never against a price history.
      mockBackend({
        "GET /api/recipes/tags": TAGS,
        "GET /api/recipes": page([curry, bread]),
        "GET /api/recipes/suggestions": {
          ...NOTHING_TO_SUGGEST,
          cheap: [{ recipe: bread, per_serving: 0.42, priced: 5, total_lines: 6 }],
          median_per_serving: 2.1,
        },
      });
      const { user } = renderApp("/recipes");

      await user.click(await screen.findByText(/under \$2\.10 a serving/i));

      const offer = screen.getByText("$0.42 a serving").closest(".offer")!;
      expect(within(offer as HTMLElement).getByRole("link", { name: "Banana bread" })).toBeInTheDocument();
      expect(within(offer as HTMLElement).getByText("5 of 6 ingredients priced")).toBeInTheDocument();
    });

    it("names the recipes the pantry mostly covers", async () => {
      mockBackend({
        "GET /api/recipes/tags": TAGS,
        "GET /api/recipes": page([curry, bread]),
        "GET /api/recipes/suggestions": {
          ...NOTHING_TO_SUGGEST,
          pantry: [{ recipe: curry, in_pantry: 3, total_lines: 4 }],
        },
      });
      const { user } = renderApp("/recipes");

      await user.click(await screen.findByText(/mostly in your pantry/i));

      expect(screen.getByText("3 of 4 ingredients in stock")).toBeInTheDocument();
    });

    it("stays out of the way when there is nothing to suggest", async () => {
      recipesBackend(page([curry]));
      renderApp("/recipes");

      await screen.findByText("Weeknight chicken curry");
      expect(screen.queryByText(/on sale this week/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/a serving/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/in your pantry/i)).not.toBeInTheDocument();
    });
  });

  describe("needs a look", () => {
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

    function needingALook(attention: unknown) {
      return mockBackend({
        "GET /api/recipes/tags": TAGS,
        "GET /api/recipes": page([curry, bread]),
        "GET /api/recipes/suggestions": NOTHING_TO_SUGGEST,
        "GET /api/recipes/attention": attention,
      });
    }

    /** The fold's entry for one recipe, opened. */
    async function openEntry(user: AppRender["user"], title: string): Promise<HTMLElement> {
      await user.click(await screen.findByText(/needs a look/i));
      return screen.getByRole("link", { name: title }).closest<HTMLElement>(".offer")!;
    }

    /**
     * An entry as it reads: each list of lines under what they hold up, and
     * each line's row and reason, in order.
     */
    function groups(entry: HTMLElement): [string, string[][]][] {
      return within(entry)
        .getAllByRole("list")
        .map((list) => [
          // The heading that names the list, for a screen reader as for the eye.
          document.getElementById(list.getAttribute("aria-labelledby")!)?.textContent ?? "",
          within(list)
            .getAllByRole("listitem")
            .map((li) => [
              within(li).getByRole("link").textContent ?? "",
              li.querySelector(".issue-tag")?.textContent ?? "",
            ]),
        ]);
    }

    it("says what each row holds up, and sums it up for the recipe", async () => {
      needingALook([{ recipe: bread, issues: [AVOCADO, PAPRICA_UNMATCHED, BEANS], no_servings: false }]);
      const { user } = renderApp("/recipes");

      const entry = await openEntry(user, "Banana bread");

      expect(within(entry).getByRole("link", { name: "Banana bread" })).toHaveAttribute(
        "href",
        "/recipes/2",
      );
      expect(within(entry).getByText("2 for nutrition · 2 for price")).toBeInTheDocument();
      expect(groups(entry)).toEqual([
        ["Price and nutrition", [["Optional: 1 diced ripe avocado", "amount is in the name"]]],
        ["Nutrition", [["can black beans", "can't weigh the amount"]]],
        ["Price", [["paprica", "no match"]]],
      ]);
    });

    it("lists a row under each when price and nutrition are held up for their own reasons", async () => {
      needingALook([
        { recipe: bread, issues: [PAPRICA_UNMATCHED, PAPRICA_NO_FOOD], no_servings: false },
      ]);
      const { user } = renderApp("/recipes");

      const entry = await openEntry(user, "Banana bread");

      expect(within(entry).getByText("1 for nutrition · 1 for price")).toBeInTheDocument();
      expect(groups(entry)).toEqual([
        ["Nutrition", [["paprica", "no food chosen"]]],
        ["Price", [["paprica", "no match"]]],
      ]);
    });

    it("links a price line to its row and a nutrition line to its place in the breakdown", async () => {
      needingALook([
        { recipe: bread, issues: [AVOCADO, PAPRICA_UNMATCHED, PAPRICA_NO_FOOD], no_servings: false },
      ]);
      const { user } = renderApp("/recipes");

      const entry = await openEntry(user, "Banana bread");
      const link = (list: string, name: string) =>
        within(within(entry).getByRole("list", { name: list })).getByRole("link", { name });

      // A reason the recipe line has wrong is fixed on the line, whatever it
      // also holds up.
      expect(link("Price and nutrition", "Optional: 1 diced ripe avocado")).toHaveAttribute(
        "href",
        "/recipes/2?ingredient=9",
      );
      expect(link("Price", "paprica")).toHaveAttribute("href", "/recipes/2?ingredient=10");
      expect(link("Nutrition", "paprica")).toHaveAttribute("href", "/recipes/2?nutrition=10");
    });

    it("sends a recipe with no serving count to its edit form", async () => {
      needingALook([{ recipe: bread, issues: [BEANS], no_servings: true }]);
      const { user } = renderApp("/recipes");

      const entry = await openEntry(user, "Banana bread");

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
        "/recipes/2/edit",
      );
    });

    it("lands a nutrition line on the breakdown, open at that ingredient", async () => {
      const cake = recipe({
        id: 2,
        title: "Banana bread",
        servings: 12,
        ingredients: [{ id: 10, name: "paprica", quantity: 1, unit: "tbsp" }],
      });
      mockBackend({
        "GET /api/recipes/tags": TAGS,
        "GET /api/recipes": page([curry, bread]),
        "GET /api/recipes/suggestions": NOTHING_TO_SUGGEST,
        "GET /api/recipes/attention": [
          { recipe: bread, issues: [PAPRICA_NO_FOOD], no_servings: false },
        ],
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
      const { user } = renderApp("/recipes");

      const entry = await openEntry(user, "Banana bread");
      await user.click(within(entry).getByRole("link", { name: "paprica" }));

      const row = await screen.findByText("paprica", { selector: ".nutrition-lines .name" });
      expect(document.querySelector("#nutrition")).toHaveAttribute("open");
      expect(row.closest("li")).toHaveClass("highlighted");
    });

    it("is absent when every recipe is in order", async () => {
      recipesBackend(page([curry]));
      renderApp("/recipes");

      await screen.findByText("Weeknight chicken curry");
      expect(screen.queryByText(/needs a look/i)).not.toBeInTheDocument();
    });
  });
});
