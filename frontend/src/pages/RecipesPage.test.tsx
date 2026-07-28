import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend, type MockRequest, type RouteHandler } from "../test/backend";
import { page, recipeSummary, tagCount } from "../test/fixtures";
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

const TAGS = [tagCount("baking"), tagCount("dinner"), tagCount("quick")];

/**
 * The page asks the server for both a page of recipes and the tag list, so
 * every test needs both routes answered.
 */
function recipesBackend(recipes: RouteHandler | object, tags: unknown = TAGS) {
  return mockBackend({
    "GET /api/recipes/tags": tags,
    "GET /api/recipes": recipes,
  });
}

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
});
