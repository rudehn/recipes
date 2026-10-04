import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RecipeInput, RecipePart } from "../api";
import { HttpError, mockBackend, type MockBackend, type Routes } from "../test/backend";
import { pastedRecipeDraft, recipe, recipeDraft, tagCount } from "../test/fixtures";
import { renderApp, type AppRender } from "../test/render";

/**
 * The backend the form talks to. The form asks for the box's tags to suggest,
 * so every test answers that, with none unless it says otherwise; left out,
 * "GET /api/recipes/:id" would answer it with a recipe.
 */
function formBackend(routes: Routes): MockBackend {
  return mockBackend({ "GET /api/recipes/tags": [], ...routes });
}

/** The recipe body the form posted, as the backend would receive it. */
function savedPayload(backend: MockBackend, pattern: string): RecipeInput {
  const [request] = backend.requestsTo(pattern);
  expect(request, `no request to ${pattern}`).toBeDefined();
  return request.body as RecipeInput;
}

function ingredientRows(): HTMLElement[] {
  return screen.getAllByLabelText("Ingredient name");
}

/** The tags on the form, read off their chips' remove buttons. */
function tagChips(): string[] {
  const field = screen.getByRole("combobox", { name: "Tags" }).closest<HTMLElement>(".tag-input")!;
  return within(field)
    .queryAllByRole("button", { name: /^Remove / })
    .map((b) => b.getAttribute("aria-label")!.replace(/^Remove /, ""));
}

/** The photo picker, which has a plain label with nothing to query it by. */
function photoInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!;
}

describe("RecipeFormPage: writing a recipe", () => {
  it("saves what was typed, then opens the saved recipe", async () => {
    const created = recipe({ id: 42, title: "Sheet pan salmon" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Sheet pan salmon");
    await user.type(screen.getByLabelText("Description"), "Dinner in one pan.");
    await user.type(screen.getByLabelText("Prep (min)"), "5");
    await user.type(screen.getByLabelText("Cook (min)"), "18");
    await user.type(screen.getByLabelText("Servings"), "2");
    await user.type(screen.getByLabelText("Tags"), "quick, fish");
    await user.type(screen.getByLabelText("Instructions"), "Heat the oven\nRoast 18 minutes");
    await user.type(screen.getByLabelText("Quantity"), "1 1/2");
    await user.type(screen.getByLabelText("Unit"), "lb");
    await user.type(screen.getByLabelText("Ingredient name"), "salmon fillet");

    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes")).toEqual({
      title: "Sheet pan salmon",
      description: "Dinner in one pan.",
      instructions: "Heat the oven\nRoast 18 minutes",
      prep_minutes: 5,
      cook_minutes: 18,
      servings: 2,
      ingredients: [{ name: "salmon fillet", quantity: 1.5, unit: "lb" }],
      tags: ["quick", "fish"],
    });
    expect(await screen.findByRole("heading", { name: "Sheet pan salmon" })).toBeVisible();
  });

  it("leaves blank optional fields null rather than zero", async () => {
    // A recipe with no stated prep time is not a zero-minute recipe.
    const created = recipe({ id: 42, title: "Toast" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    const payload = savedPayload(backend, "POST /api/recipes");
    expect(payload.prep_minutes).toBeNull();
    expect(payload.cook_minutes).toBeNull();
    expect(payload.servings).toBeNull();
    expect(payload.tags).toEqual([]);
    expect(payload.ingredients).toEqual([{ name: "bread", quantity: null, unit: null }]);
  });

  it("drops ingredient rows left empty", async () => {
    // Rows are added optimistically; unfilled ones are not ingredients.
    const created = recipe({ id: 42 });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "+ Add ingredient" }));
    await user.click(screen.getByRole("button", { name: "+ Add ingredient" }));
    await user.type(screen.getAllByLabelText("Quantity")[2], "2");

    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").ingredients).toEqual([
      { name: "bread", quantity: null, unit: null },
    ]);
  });

  it("refuses to save without a title", async () => {
    const backend = formBackend({ "POST /api/recipes": recipe() });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(screen.getByText("Give your recipe a title.")).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(0);
  });

  it("brings the reason into view when it will not save", async () => {
    // The button is at the foot of a long form and the reason at its head, so
    // a refusal nobody scrolls up to read looks like a button that does nothing.
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    formBackend({});
    const { user } = renderApp("/recipes/new");

    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    const reason = screen.getByRole("alert");
    expect(reason).toHaveTextContent("Give your recipe a title.");
    const toReason = () =>
      scrolled.mock.contexts.filter((el) => (el as Element).contains(reason)).length;
    expect(toReason()).toBe(1);

    // Scrolled away and pressed again, the same reason is brought back.
    await user.click(screen.getByRole("button", { name: "Create recipe" }));
    expect(toReason()).toBe(2);
  });

  it("explains an unreadable quantity instead of sending NaN", async () => {
    const backend = formBackend({ "POST /api/recipes": recipe() });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Quantity"), "a handful");
    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(
      screen.getByText("Ingredient quantities must be numbers or fractions like 1 1/2."),
    ).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(0);
  });

  it("saves a link to where the recipe came from", async () => {
    const created = recipe({ id: 42, title: "Toast" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Source link"), " https://www.budgetbytes.com/toast/ ");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").source_url).toBe(
      "https://www.budgetbytes.com/toast/",
    );
  });

  it("saves no link when the source field is left blank", async () => {
    const created = recipe({ id: 42, title: "Toast" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Source link"), "   ");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").source_url ?? null).toBeNull();
  });

  it("refuses a source link the recipe page could not open", async () => {
    // The link is rendered on the recipe page; only a web address belongs there.
    const backend = formBackend({ "POST /api/recipes": recipe() });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Source link"), "ftp://example.com/toast");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(
      screen.getByText("Source links must start with http:// or https://."),
    ).toBeInTheDocument();
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(0);
  });

  it("keeps the form filled in and re-enables saving when the server rejects it", async () => {
    const backend = formBackend({
      "POST /api/recipes": new HttpError(409, "A recipe with that title already exists."),
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(
      await screen.findByText("A recipe with that title already exists."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Toast");
    expect(screen.getByRole("button", { name: "Create recipe" })).toBeEnabled();
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(1);
  });

  it("adds and removes ingredient rows, keeping one row to type in", async () => {
    formBackend({});
    const { user } = renderApp("/recipes/new");

    expect(ingredientRows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "+ Add ingredient" }));
    expect(ingredientRows()).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Remove ingredient" })[0]);
    expect(ingredientRows()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Remove ingredient" }));
    expect(ingredientRows()).toHaveLength(1);
  });

  it("offers the tags already in the box as the tags are typed", async () => {
    // Picking "weeknight" from the box beats typing "week night" beside it.
    const backend = formBackend({
      "GET /api/recipes/tags": [tagCount("dinner", 4), tagCount("weeknight", 2)],
      "POST /api/recipes": recipe({ id: 42 }),
      "GET /api/recipes/:id": recipe({ id: 42 }),
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Sheet pan salmon");
    await user.type(screen.getByLabelText("Tags"), "wee");
    await user.click(await screen.findByRole("option", { name: "weeknight" }));
    expect(tagChips()).toEqual(["weeknight"]);

    await user.click(screen.getByRole("button", { name: "Create recipe" }));
    expect(savedPayload(backend, "POST /api/recipes").tags).toEqual(["weeknight"]);
    // Every tag in the box, not the counts within some filter.
    expect(backend.requestsTo("GET /api/recipes/tags")[0].searchParams.toString()).toBe("");
  });

  it("removes the row that was clicked, not the last one", async () => {
    formBackend({});
    const { user } = renderApp("/recipes/new");

    await user.click(screen.getByRole("button", { name: "+ Add ingredient" }));
    await user.type(ingredientRows()[0], "flour");
    await user.type(ingredientRows()[1], "sugar");

    await user.click(screen.getAllByRole("button", { name: "Remove ingredient" })[0]);

    expect(ingredientRows()[0]).toHaveValue("sugar");
  });
});

describe("RecipeFormPage: editing a recipe", () => {
  const stored = recipe({
    id: 7,
    title: "Weeknight chicken curry",
    description: "Fast and warming.",
    prep_minutes: 10,
    cook_minutes: 20,
    servings: 4,
    tags: ["quick", "dinner"],
    instructions: "Season the chicken",
    ingredients: [
      { id: 1, name: "coconut milk", quantity: 0.75, unit: "cup" },
      { id: 2, name: "curry powder", quantity: 1 / 3, unit: "tbsp" },
      { id: 3, name: "salt", quantity: null, unit: null },
    ],
  });

  it("fills the form from the stored recipe", async () => {
    formBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));
    expect(screen.getByLabelText("Description")).toHaveValue("Fast and warming.");
    expect(screen.getByLabelText("Prep (min)")).toHaveValue(10);
    expect(screen.getByLabelText("Servings")).toHaveValue(4);
    expect(tagChips()).toEqual(["quick", "dinner"]);
    expect(screen.getByLabelText("Instructions")).toHaveValue("Season the chicken");
  });

  it("saves the tags as edited", async () => {
    const backend = formBackend({
      "GET /api/recipes/:id": stored,
      "PUT /api/recipes/:id": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(tagChips()).toEqual(["quick", "dinner"]));

    await user.click(screen.getByRole("button", { name: "Remove quick" }));
    await user.type(screen.getByLabelText("Tags"), "Curry{Enter}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(savedPayload(backend, "PUT /api/recipes/:id").tags).toEqual(["dinner", "curry"]);
  });

  it("shows stored amounts as the fractions the rest of the app shows", async () => {
    // Editing a recipe should not turn "¾" into "0.75" in front of the cook.
    formBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    await waitFor(() => expect(screen.getAllByLabelText("Quantity")[0]).toHaveValue("¾"));
    expect(screen.getAllByLabelText("Quantity")[1]).toHaveValue("⅓");
    expect(screen.getAllByLabelText("Quantity")[2]).toHaveValue("");
  });

  it("saves an untouched recipe back unchanged", async () => {
    // The fraction shown must parse back to the number that produced it, or
    // every edit would nudge the amounts.
    const backend = formBackend({
      "GET /api/recipes/:id": stored,
      "PUT /api/recipes/:id": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = savedPayload(backend, "PUT /api/recipes/:id");
    expect(payload.ingredients).toEqual([
      { name: "coconut milk", quantity: 0.75, unit: "cup" },
      { name: "curry powder", quantity: 1 / 3, unit: "tbsp" },
      { name: "salt", quantity: null, unit: null },
    ]);
    expect(payload.tags).toEqual(["quick", "dinner"]);
  });

  it("keeps the line a row was imported from, so it can be parsed again later", async () => {
    const backend = formBackend({
      "GET /api/recipes/:id": recipe({
        id: 7,
        ingredients: [
          {
            id: 1,
            name: "diced ripe avocado (optional)",
            quantity: 1,
            unit: null,
            source_line: "Optional: 1 diced ripe avocado",
          },
        ],
      }),
      "PUT /api/recipes/:id": recipe({ id: 7 }),
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Weeknight chicken curry"));

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(savedPayload(backend, "PUT /api/recipes/:id").ingredients).toEqual([
      {
        name: "diced ripe avocado (optional)",
        quantity: 1,
        unit: null,
        source_line: "Optional: 1 diced ripe avocado",
      },
    ]);
  });

  it("updates the recipe named in the URL rather than creating a new one", async () => {
    const backend = formBackend({
      "GET /api/recipes/:id": stored,
      "PUT /api/recipes/:id": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(backend.requestsTo("PUT /api/recipes/:id")[0].path).toBe("/api/recipes/7");
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(0);
  });

  it("cancels back to the recipe being edited", async () => {
    formBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/recipes/7",
    );
  });

  it("hides the URL importer, which only makes sense for a new recipe", async () => {
    formBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));

    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  });

  it("adds a link to a recipe saved before links were kept", async () => {
    const backend = formBackend({
      "GET /api/recipes/:id": stored,
      "PUT /api/recipes/:id": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));
    expect(screen.getByLabelText("Source link")).toHaveValue("");

    await user.type(screen.getByLabelText("Source link"), "https://pinchofyum.com/curry");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(savedPayload(backend, "PUT /api/recipes/:id").source_url).toBe(
      "https://pinchofyum.com/curry",
    );
  });

  it("keeps a stored link through an edit that does not touch it", async () => {
    const linked = { ...stored, source_url: "https://pinchofyum.com/curry", source_label: "Pinch of Yum" };
    const backend = formBackend({
      "GET /api/recipes/:id": linked,
      "PUT /api/recipes/:id": linked,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() =>
      expect(screen.getByLabelText("Source link")).toHaveValue("https://pinchofyum.com/curry"),
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(savedPayload(backend, "PUT /api/recipes/:id").source_url).toBe(
      "https://pinchofyum.com/curry",
    );
  });

  it("takes a wrong link off when the field is emptied", async () => {
    const linked = { ...stored, source_url: "https://pinchofyum.com/wrong", source_label: "Pinch of Yum" };
    const backend = formBackend({
      "GET /api/recipes/:id": linked,
      "PUT /api/recipes/:id": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() =>
      expect(screen.getByLabelText("Source link")).toHaveValue("https://pinchofyum.com/wrong"),
    );

    await user.clear(screen.getByLabelText("Source link"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(savedPayload(backend, "PUT /api/recipes/:id").source_url ?? null).toBeNull();
  });
});

describe("RecipeFormPage: importing from a URL", () => {
  const page = "https://www.budgetbytes.com/banana-bread/";
  const draft = recipeDraft({
    title: "Banana bread",
    prep_minutes: 15,
    cook_minutes: 60,
    servings: 8,
    ingredients: [
      { name: "bananas", quantity: 3, unit: null },
      { name: "flour", quantity: 1.5, unit: "cups" },
    ],
    image_url: "https://example.com/bread.jpg",
    source_url: page,
  });

  it("fills the form from the imported page", async () => {
    const backend = formBackend({ "POST /api/import/recipe": draft });
    const { user } = renderApp("/recipes/new");

    await user.type(
      screen.getByPlaceholderText(/paste a recipe url/i),
      "https://www.budgetbytes.com/banana-bread/",
    );
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.getByLabelText("Cook (min)")).toHaveValue(60);
    expect(screen.getAllByLabelText("Ingredient name")[1]).toHaveValue("flour");
    expect(screen.getAllByLabelText("Quantity")[1]).toHaveValue("1½");
    expect(backend.requestsTo("POST /api/import/recipe")[0].body).toEqual({
      url: "https://www.budgetbytes.com/banana-bread/",
    });
  });

  it("puts the page's suggested tags in the form, to keep or drop before saving", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/import/recipe": { ...draft, image_url: null, tags: ["bread", "american"] },
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(tagChips()).toEqual(["bread", "american"]));
    // Suggested is not saved: nothing has been sent but the import itself.
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Remove american" }));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").tags).toEqual(["bread"]);
  });

  it("shows why an import failed and leaves the form alone", async () => {
    formBackend({
      "POST /api/import/recipe": new HttpError(422, "No recipe found on that page."),
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("No recipe found on that page.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("cannot be triggered with an empty URL", async () => {
    formBackend({});
    renderApp("/recipes/new");

    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("fetches the imported photo server-side after saving", async () => {
    // The photo lives on the source site; the backend downloads it once the
    // recipe exists and has an id to attach it to.
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/import/recipe": draft,
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image-from-url": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/recipes/:id/image-from-url")).toHaveLength(1),
    );
    const [request] = backend.requestsTo("POST /api/recipes/:id/image-from-url");
    expect(request.path).toBe("/api/recipes/42/image-from-url");
    expect(request.body).toEqual({ url: "https://example.com/bread.jpg" });
  });

  it("still saves the recipe when its photo cannot be fetched", async () => {
    // A recipe without its photo is worth having; the save must not fail.
    const created = recipe({ id: 42, title: "Banana bread" });
    formBackend({
      "POST /api/import/recipe": draft,
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image-from-url": new HttpError(502, "Image host unreachable."),
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(await screen.findByRole("heading", { name: "Banana bread" })).toBeVisible();
  });

  it("saves the imported page as the recipe's source link", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/import/recipe": draft,
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image-from-url": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), page);
    await user.click(screen.getByRole("button", { name: "Import" }));
    // Shown in the form, so what will be saved can be seen and changed.
    await waitFor(() => expect(screen.getByLabelText("Source link")).toHaveValue(page));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").source_url).toBe(page);
  });

  it("says when the imported recipe is already in the box, and still lets it be saved", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/import/recipe": { ...draft, saved_recipe_id: 12 },
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image-from-url": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), page);
    await user.click(screen.getByRole("button", { name: "Import" }));

    const notice = await screen.findByText(/Already in your box/);
    expect(within(notice).getByRole("link", { name: "Open the saved recipe" })).toHaveAttribute(
      "href",
      "/recipes/12",
    );
    // A second copy is a choice, not a mistake: the form is filled in as usual.
    expect(screen.getByLabelText("Title")).toHaveValue("Banana bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));
    expect(backend.requestsTo("POST /api/recipes")).toHaveLength(1);
  });

  it("says nothing about the box for a recipe not saved before", async () => {
    formBackend({ "POST /api/import/recipe": draft });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), page);
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.queryByText(/Already in your box/)).not.toBeInTheDocument();
  });

  it("does not fetch the photo that was removed before saving", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/import/recipe": draft,
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(await screen.findByRole("heading", { name: "Banana bread" })).toBeVisible();
    expect(backend.requestsTo("POST /api/recipes/:id/image-from-url")).toHaveLength(0);
  });
});

describe("RecipeFormPage: reading a pasted recipe", () => {
  const draft = pastedRecipeDraft({
    title: "Black bean soup",
    servings: 6,
    ingredients: [
      { name: "olive oil", quantity: 2, unit: "tbsp", source_line: "2 tbsp olive oil" },
      { name: "smoked paprika", quantity: 0.5, unit: "tsp", source_line: "½ tsp smoked paprika" },
    ],
    instructions: "Soften the onion\nSimmer 20 minutes",
  });
  const pasted = "Black bean soup\nServes 6\n\nIngredients:\n2 tbsp olive oil";

  /** Switch the import box to text and paste `text` into it. */
  async function pasteText(user: AppRender["user"], text: string) {
    await user.click(screen.getByRole("button", { name: "From text" }));
    await user.click(screen.getByLabelText("Recipe text"));
    await user.paste(text);
  }

  it("imports from a link until text is asked for", async () => {
    formBackend({});
    const { user } = renderApp("/recipes/new");

    expect(screen.getByRole("button", { name: "From a link" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("Recipe text")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "From text" }));

    expect(screen.getByRole("button", { name: "From text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Recipe text")).toHaveAttribute(
      "placeholder",
      "Paste a recipe: a note, a text file, an AI chat",
    );
    expect(screen.queryByPlaceholderText(/paste a recipe url/i)).not.toBeInTheDocument();
  });

  it("fills the form from the pasted text", async () => {
    const backend = formBackend({ "POST /api/import/text": draft });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));
    expect(screen.getByLabelText("Servings")).toHaveValue(6);
    expect(screen.getAllByLabelText("Quantity")[1]).toHaveValue("½");
    expect(screen.getAllByLabelText("Ingredient name")[1]).toHaveValue("smoked paprika");
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "Soften the onion\nSimmer 20 minutes",
    );
    expect(backend.requestsTo("POST /api/import/text")[0].body).toEqual({ text: pasted });
  });

  it("keeps the pasted text, to change and read again", async () => {
    const backend = formBackend({ "POST /api/import/text": draft });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));

    expect(screen.getByLabelText("Recipe text")).toHaveValue(pasted);
    await user.type(screen.getByLabelText("Recipe text"), "\n1 can beans");
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/import/text")).toHaveLength(2));
    expect(backend.requestsTo("POST /api/import/text")[1].body).toEqual({
      text: `${pasted}\n1 can beans`,
    });
  });

  it("brings the form it filled into view, as little as it takes", async () => {
    // On a phone a pasted recipe fills the screen, and the form it was read
    // into is below it: without this, reading looks like it did nothing.
    // "nearest" leaves a form already on screen where it is.
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    formBackend({ "POST /api/import/text": draft });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));

    const title = screen.getByLabelText("Title");
    const call = scrolled.mock.calls.findIndex((_, i) =>
      (scrolled.mock.contexts[i] as Element).contains(title),
    );
    expect(call).toBeGreaterThan(-1);
    expect(scrolled.mock.calls[call][0]).toMatchObject({ block: "nearest" });
  });

  it("cannot be read with nothing pasted", async () => {
    formBackend({});
    const { user } = renderApp("/recipes/new");

    await pasteText(user, "  \n ");

    expect(screen.getByRole("button", { name: "Read recipe" })).toBeDisabled();
  });

  it.each<[RecipePart[], string]>([
    [["ingredients"], "Couldn't find an ingredients list - add them below."],
    [["title"], "Couldn't find a title - add one below."],
    [["instructions"], "Couldn't find any steps - add them below."],
    [["title", "ingredients"], "Couldn't find a title or an ingredients list - add them below."],
    [
      ["title", "ingredients", "instructions"],
      "Couldn't find a title, an ingredients list or any steps - add them below.",
    ],
  ])("says what the text did not seem to have: %j", async (missing, notice) => {
    formBackend({
      "POST /api/import/text": pastedRecipeDraft({
        ...(missing.includes("title") ? { title: "" } : {}),
        ...(missing.includes("ingredients") ? { ingredients: [] } : {}),
        ...(missing.includes("instructions") ? { instructions: "" } : {}),
        missing,
      }),
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, "Mix and bake.");
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    // Announced, since it arrives after the button was pressed.
    expect(await screen.findByText(notice)).toHaveAttribute("role", "status");
  });

  it("stops pointing at what was missing once it is filled in", async () => {
    formBackend({
      "POST /api/import/text": pastedRecipeDraft({ title: "", missing: ["title"] }),
    });
    const { user } = renderApp("/recipes/new");
    await pasteText(user, "1 egg\nFry it.");
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    expect(await screen.findByText(/Couldn't find a title/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Fried egg");

    expect(screen.queryByText(/Couldn't find/)).not.toBeInTheDocument();
  });

  it("says nothing is missing when everything was found", async () => {
    formBackend({ "POST /api/import/text": draft });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));
    expect(screen.queryByText(/Couldn't find/)).not.toBeInTheDocument();
  });

  it("shows why the text could not be read and leaves the form alone", async () => {
    formBackend({
      "POST /api/import/text": new HttpError(422, "That text is too long to be one recipe."),
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    expect(await screen.findByText("That text is too long to be one recipe.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Read recipe" })).toBeEnabled();
  });

  it("does not carry a link import's error over to the text", async () => {
    formBackend({ "POST /api/import/recipe": new HttpError(422, "No recipe found on that page.") });
    const { user } = renderApp("/recipes/new");
    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("No recipe found on that page.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "From text" }));

    expect(screen.queryByText("No recipe found on that page.")).not.toBeInTheDocument();
  });

  it("saves the link the text named as the recipe's source", async () => {
    const created = recipe({ id: 42, title: "Black bean soup" });
    const backend = formBackend({
      "POST /api/import/text": {
        ...draft,
        source_url: "https://www.budgetbytes.com/black-bean-soup/",
        source_label: "Budget Bytes",
      },
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Source link")).toHaveValue(
        "https://www.budgetbytes.com/black-bean-soup/",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").source_url).toBe(
      "https://www.budgetbytes.com/black-bean-soup/",
    );
  });

  it("saves no link for text that named none", async () => {
    const created = recipe({ id: 42, title: "Black bean soup" });
    const backend = formBackend({
      "POST /api/import/text": draft,
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));
    expect(screen.getByLabelText("Source link")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes")).not.toHaveProperty("source_url");
    // The lines the rows were read from are kept, as for a link import.
    expect(savedPayload(backend, "POST /api/recipes").ingredients[0]).toEqual({
      name: "olive oil",
      quantity: 2,
      unit: "tbsp",
      source_line: "2 tbsp olive oil",
    });
  });

  it("says when the recipe the text came from is already in the box", async () => {
    formBackend({
      "POST /api/import/text": {
        ...draft,
        source_url: "https://www.budgetbytes.com/black-bean-soup/",
        saved_recipe_id: 12,
      },
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));

    const notice = await screen.findByText(/Already in your box/);
    expect(within(notice).getByRole("link", { name: "Open the saved recipe" })).toHaveAttribute(
      "href",
      "/recipes/12",
    );
  });

  it("keeps a photo chosen by hand when the text is read again", async () => {
    // Text carries no photo, so reading it again after choosing one must not
    // take the person's own choice away.
    const created = recipe({ id: 42, title: "Black bean soup" });
    const backend = formBackend({
      "POST /api/import/text": draft,
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));
    await user.upload(photoInput(), new File(["x"], "soup.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(backend.requestsTo("POST /api/import/text")).toHaveLength(2));

    expect(screen.getByAltText("Recipe preview")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create recipe" }));
    await waitFor(() => expect(backend.requestsTo("POST /api/recipes/:id/image")).toHaveLength(1));
  });

  it("drops a linked page's photo when text is read in its place", async () => {
    const created = recipe({ id: 42, title: "Black bean soup" });
    const backend = formBackend({
      "POST /api/import/recipe": recipeDraft({ image_url: "https://example.com/bread.jpg" }),
      "POST /api/import/text": draft,
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");
    await user.type(screen.getByPlaceholderText(/paste a recipe url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByAltText("Recipe preview")).toBeInTheDocument());

    await pasteText(user, pasted);
    await user.click(screen.getByRole("button", { name: "Read recipe" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Black bean soup"));

    expect(screen.queryByAltText("Recipe preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create recipe" }));
    await screen.findByRole("heading", { name: "Black bean soup" });
    expect(backend.requestsTo("POST /api/recipes/:id/image-from-url")).toHaveLength(0);
  });

  it("is not offered while editing", async () => {
    const stored = recipe({ id: 7, title: "Toast" });
    formBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Toast"));

    expect(screen.queryByRole("button", { name: "From text" })).not.toBeInTheDocument();
  });
});

describe("RecipeFormPage: a draft picked out of search", () => {
  const draft = recipeDraft({
    title: "Banana bread",
    source_url: "https://www.budgetbytes.com/banana-bread/",
  });

  it("prefills the form and credits the source", async () => {
    formBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft } });

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.getByRole("link", { name: "Budget Bytes" })).toHaveAttribute(
      "href",
      draft.source_url,
    );
  });

  it("puts the draft's suggested tags in the form", async () => {
    formBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft: { ...draft, tags: ["breakfast"] } } });

    await waitFor(() => expect(tagChips()).toEqual(["breakfast"]));
  });

  it("hides the URL importer, since the form is already filled", async () => {
    formBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft } });

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  });

  it("saves the page it was picked from as its source link", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp({ pathname: "/recipes/new", state: { draft } });
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));

    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(savedPayload(backend, "POST /api/recipes").source_url).toBe(draft.source_url);
  });

  it("says when the picked recipe is already in the box", async () => {
    formBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft: { ...draft, saved_recipe_id: 12 } } });

    const notice = await screen.findByText(/Already in your box/);
    expect(within(notice).getByRole("link", { name: "Open the saved recipe" })).toHaveAttribute(
      "href",
      "/recipes/12",
    );
  });
});

describe("RecipeFormPage: photos", () => {
  it("offers a photo to choose, then one to replace once there is one", async () => {
    // The platform's own file control drew a grey "Choose File" box and "No
    // file chosen" in the middle of the form; the picker is reached through a
    // button like the rest of the app's, named for what it does.
    formBackend({});
    const { user } = renderApp("/recipes/new");

    const choose = screen.getByLabelText("Choose photo");
    expect(choose).toBe(photoInput());

    await user.upload(choose, new File(["x"], "curry.jpg", { type: "image/jpeg" }));

    expect(screen.getByLabelText("Replace photo")).toBe(photoInput());
    expect(screen.queryByText(/no file chosen/i)).not.toBeInTheDocument();
  });

  it("previews a chosen file and offers to remove it", async () => {
    formBackend({});
    const { user } = renderApp("/recipes/new");
    const file = new File(["x"], "curry.jpg", { type: "image/jpeg" });

    await user.upload(photoInput(), file);

    expect(screen.getByAltText("Recipe preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeInTheDocument();
  });

  it("uploads the chosen file after the recipe is created", async () => {
    const created = recipe({ id: 42, title: "Toast" });
    const backend = formBackend({
      "POST /api/recipes": created,
      "POST /api/recipes/:id/image": created,
      "GET /api/recipes/:id": created,
    });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.upload(photoInput(), new File(["x"], "toast.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/recipes/:id/image")).toHaveLength(1));
    const [upload] = backend.requestsTo("POST /api/recipes/:id/image");
    expect(upload.path).toBe("/api/recipes/42/image");
    expect((upload.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("deletes the existing photo when it is removed while editing", async () => {
    const stored = recipe({ id: 7, title: "Toast", image_filename: "abc.jpg" });
    const backend = formBackend({
      "GET /api/recipes/:id": stored,
      "PUT /api/recipes/:id": stored,
      "DELETE /api/recipes/:id/image": stored,
    });
    const { user } = renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByAltText("Recipe preview")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByAltText("Recipe preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(backend.requestsTo("DELETE /api/recipes/:id/image")).toHaveLength(1),
    );
  });
});
