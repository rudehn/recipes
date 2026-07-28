import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HttpError, mockBackend } from "../test/backend";
import { recipeDraft } from "../test/fixtures";
import { renderApp } from "../test/render";

const budgetBytes = recipeDraft({
  title: "One bowl banana bread",
  description: "Cheap and easy.",
  source_url: "https://www.budgetbytes.com/banana-bread/",
  prep_minutes: 15,
  cook_minutes: 60,
  servings: 8,
  instructions: "Mash the bananas\nBake for an hour",
  ingredients: [
    { name: "bananas", quantity: 3, unit: null },
    { name: "flour", quantity: 1.5, unit: "cups" },
  ],
});
const nyt = recipeDraft({
  title: "Brown butter banana bread",
  description: "Worth the extra pan.",
  source_url: "https://cooking.nytimes.com/recipes/1234",
  source_label: "cooking.nytimes.com",
  prep_minutes: 20,
  cook_minutes: null,
  servings: null,
  instructions: "Brown the butter",
  ingredients: [{ name: "butter", quantity: 0.5, unit: "cup" }],
});

async function search(user: ReturnType<typeof renderApp>["user"], query: string) {
  await user.type(screen.getByPlaceholderText(/what do you want to cook/i), query);
  await user.click(screen.getByRole("button", { name: "Search" }));
}

/** The compare stat shown under a heading, e.g. "steps" -> "2". */
function stat(label: string): string {
  const tile = screen.getByText(label).closest(".compare-stat")!;
  return tile.querySelector(".value")!.textContent ?? "";
}

describe("RecipeSearchPage", () => {
  it("will not search on a query too short to mean anything", async () => {
    mockBackend({});
    const { user } = renderApp("/recipes/search");

    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/what do you want to cook/i), "b");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/what do you want to cook/i), "read");
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });

  it("searches the trimmed query", async () => {
    const backend = mockBackend({ "POST /api/import/search": [] });
    const { user } = renderApp("/recipes/search");

    await search(user, "  banana bread  ");

    await waitFor(() => expect(backend.requestsTo("POST /api/import/search")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/import/search")[0].body).toEqual({
      query: "banana bread",
    });
  });

  it("searches when Enter is pressed in the box", async () => {
    const backend = mockBackend({ "POST /api/import/search": [] });
    const { user } = renderApp("/recipes/search");

    await user.type(
      screen.getByPlaceholderText(/what do you want to cook/i),
      "banana bread{Enter}",
    );

    await waitFor(() => expect(backend.requestsTo("POST /api/import/search")).toHaveLength(1));
  });

  it("says it is working while the sites are being read", async () => {
    // Reading several cooking sites takes seconds; an unexplained blank page
    // reads as a broken search.
    let release: (drafts: unknown) => void = () => {};
    mockBackend({
      "POST /api/import/search": () => new Promise((resolve) => (release = resolve)),
    });
    const { user } = renderApp("/recipes/search");

    await search(user, "banana bread");

    expect(screen.getByText("Gathering recipes…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled();

    release([budgetBytes]);
    expect(await screen.findByRole("heading", { name: budgetBytes.title })).toBeVisible();
    expect(screen.queryByText("Gathering recipes…")).not.toBeInTheDocument();
  });

  it("offers one tab per result, labelled by site, with the first one open", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes, nyt] });
    const { user } = renderApp("/recipes/search");

    await search(user, "banana bread");

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.querySelector(".site")!.textContent)).toEqual([
      "Budget Bytes",
      "cooking.nytimes.com",
    ]);
    expect(tabs.map((t) => t.querySelector(".name")!.textContent)).toEqual([
      budgetBytes.title,
      nyt.title,
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2 recipes found - pick one to compare")).toBeInTheDocument();
  });

  it("shows the picked result when another tab is opened", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes, nyt] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    await user.click(screen.getAllByRole("tab")[1]);

    expect(screen.getByRole("heading", { name: nyt.title })).toBeVisible();
    expect(screen.getByText("Worth the extra pan.")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("compares the results on ingredients, steps, time, and servings", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes, nyt] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    expect(stat("ingredients")).toBe("2");
    expect(stat("steps")).toBe("2");
    expect(stat("total time")).toBe("75 min");
    expect(stat("serves")).toBe("8");
  });

  it("dashes out stats the source page never stated", async () => {
    mockBackend({ "POST /api/import/search": [nyt] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    // A missing cook time still leaves the stated prep time worth showing.
    expect(stat("total time")).toBe("20 min");
    expect(stat("serves")).toBe("-");
  });

  it("shows the ingredients as fractions and numbers the steps", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    const flour = screen.getByText("flour").closest("li")!;
    expect(flour.querySelector(".qty")!.textContent).toBe("1½ cups");
    const steps = screen.getAllByRole("listitem").filter((li) => li.closest("ol"));
    expect(steps.map((li) => li.textContent)).toEqual(["Mash the bananas", "Bake for an hour"]);
  });

  it("says the preview is not saved and credits the source", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    const banner = screen.getByText("Preview").closest<HTMLElement>(".preview-banner")!;
    expect(banner).toHaveTextContent("Not saved yet.");
    expect(within(banner).getByRole("link", { name: "Budget Bytes" })).toHaveAttribute(
      "href",
      budgetBytes.source_url,
    );
  });

  it("saves nothing while the results are being compared", async () => {
    const backend = mockBackend({ "POST /api/import/search": [budgetBytes, nyt] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");

    await user.click(screen.getAllByRole("tab")[1]);

    expect(backend.requests.map((r) => r.path)).toEqual(["/api/import/search"]);
  });

  it("hands the picked recipe to the form for review", async () => {
    mockBackend({ "POST /api/import/search": [budgetBytes, nyt] });
    const { user } = renderApp("/recipes/search");
    await search(user, "banana bread");
    await screen.findAllByRole("tab");
    await user.click(screen.getAllByRole("tab")[1]);

    await user.click(screen.getAllByRole("button", { name: "Use this recipe" })[0]);

    expect(await screen.findByRole("heading", { name: "New recipe" })).toBeVisible();
    expect(screen.getByLabelText("Title")).toHaveValue(nyt.title);
    expect(screen.getByText(/Prefilled from/)).toBeInTheDocument();
  });

  it("names the query it found nothing for, even after the box is retyped", async () => {
    mockBackend({ "POST /api/import/search": [] });
    const { user } = renderApp("/recipes/search");

    await search(user, "kohlrabi gratin");
    expect(await screen.findByText(/No recipes for “kohlrabi gratin”/)).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/what do you want to cook/i));
    await user.type(screen.getByPlaceholderText(/what do you want to cook/i), "something else");
    expect(screen.getByText(/No recipes for “kohlrabi gratin”/)).toBeInTheDocument();
  });

  it("offers writing the recipe by hand when the search comes back empty", async () => {
    mockBackend({ "POST /api/import/search": [] });
    const { user } = renderApp("/recipes/search");

    await search(user, "kohlrabi gratin");

    expect(await screen.findByRole("link", { name: /write the recipe yourself/i })).toHaveAttribute(
      "href",
      "/recipes/new",
    );
  });

  it("shows why a search failed, and lets it be retried", async () => {
    mockBackend({ "POST /api/import/search": new HttpError(503, "Search is unavailable.") });
    const { user } = renderApp("/recipes/search");

    await search(user, "banana bread");

    expect(await screen.findByText("Search is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });
});
