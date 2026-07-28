import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RecipeInput } from "../api";
import { HttpError, mockBackend, type MockBackend } from "../test/backend";
import { recipe, recipeDraft } from "../test/fixtures";
import { renderApp } from "../test/render";

/** The recipe body the form posted, as the backend would receive it. */
function savedPayload(backend: MockBackend, pattern: string): RecipeInput {
  const [request] = backend.requestsTo(pattern);
  expect(request, `no request to ${pattern}`).toBeDefined();
  return request.body as RecipeInput;
}

function ingredientRows(): HTMLElement[] {
  return screen.getAllByLabelText("Ingredient name");
}

/** The photo picker, which has a plain label with nothing to query it by. */
function photoInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!;
}

describe("RecipeFormPage: writing a recipe", () => {
  it("saves what was typed, then opens the saved recipe", async () => {
    const created = recipe({ id: 42, title: "Sheet pan salmon" });
    const backend = mockBackend({
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
    const backend = mockBackend({
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
    const backend = mockBackend({
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
    const backend = mockBackend({ "POST /api/recipes": recipe() });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(screen.getByText("Give your recipe a title.")).toBeInTheDocument();
    expect(backend.requests).toHaveLength(0);
  });

  it("explains an unreadable quantity instead of sending NaN", async () => {
    const backend = mockBackend({ "POST /api/recipes": recipe() });
    const { user } = renderApp("/recipes/new");

    await user.type(screen.getByLabelText("Title"), "Toast");
    await user.type(screen.getByLabelText("Quantity"), "a handful");
    await user.type(screen.getByLabelText("Ingredient name"), "bread");
    await user.click(screen.getByRole("button", { name: "Create recipe" }));

    expect(
      screen.getByText("Ingredient quantities must be numbers or fractions like 1 1/2."),
    ).toBeInTheDocument();
    expect(backend.requests).toHaveLength(0);
  });

  it("keeps the form filled in and re-enables saving when the server rejects it", async () => {
    const backend = mockBackend({
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
    mockBackend({});
    const { user } = renderApp("/recipes/new");

    expect(ingredientRows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "+ Add ingredient" }));
    expect(ingredientRows()).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Remove ingredient" })[0]);
    expect(ingredientRows()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Remove ingredient" }));
    expect(ingredientRows()).toHaveLength(1);
  });

  it("removes the row that was clicked, not the last one", async () => {
    mockBackend({});
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
    mockBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));
    expect(screen.getByLabelText("Description")).toHaveValue("Fast and warming.");
    expect(screen.getByLabelText("Prep (min)")).toHaveValue(10);
    expect(screen.getByLabelText("Servings")).toHaveValue(4);
    expect(screen.getByLabelText("Tags")).toHaveValue("quick, dinner");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Season the chicken");
  });

  it("shows stored amounts as the fractions the rest of the app shows", async () => {
    // Editing a recipe should not turn "¾" into "0.75" in front of the cook.
    mockBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    await waitFor(() => expect(screen.getAllByLabelText("Quantity")[0]).toHaveValue("¾"));
    expect(screen.getAllByLabelText("Quantity")[1]).toHaveValue("⅓");
    expect(screen.getAllByLabelText("Quantity")[2]).toHaveValue("");
  });

  it("saves an untouched recipe back unchanged", async () => {
    // The fraction shown must parse back to the number that produced it, or
    // every edit would nudge the amounts.
    const backend = mockBackend({
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

  it("updates the recipe named in the URL rather than creating a new one", async () => {
    const backend = mockBackend({
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
    mockBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");

    expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/recipes/7",
    );
  });

  it("hides the URL importer, which only makes sense for a new recipe", async () => {
    mockBackend({ "GET /api/recipes/:id": stored });
    renderApp("/recipes/7/edit");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(stored.title));

    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  });
});

describe("RecipeFormPage: importing from a URL", () => {
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
  });

  it("fills the form from the imported page", async () => {
    const backend = mockBackend({ "POST /api/import/recipe": draft });
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

  it("shows why an import failed and leaves the form alone", async () => {
    mockBackend({
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
    mockBackend({});
    renderApp("/recipes/new");

    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("fetches the imported photo server-side after saving", async () => {
    // The photo lives on the source site; the backend downloads it once the
    // recipe exists and has an id to attach it to.
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = mockBackend({
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
    mockBackend({
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

  it("does not fetch the photo that was removed before saving", async () => {
    const created = recipe({ id: 42, title: "Banana bread" });
    const backend = mockBackend({
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

describe("RecipeFormPage: a draft picked out of search", () => {
  const draft = recipeDraft({
    title: "Banana bread",
    source_url: "https://www.budgetbytes.com/banana-bread/",
  });

  it("prefills the form and credits the source", async () => {
    mockBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft } });

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.getByRole("link", { name: "Budget Bytes" })).toHaveAttribute(
      "href",
      draft.source_url,
    );
  });

  it("hides the URL importer, since the form is already filled", async () => {
    mockBackend({});
    renderApp({ pathname: "/recipes/new", state: { draft } });

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Banana bread"));
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  });
});

describe("RecipeFormPage: photos", () => {
  it("previews a chosen file and offers to remove it", async () => {
    mockBackend({});
    const { user } = renderApp("/recipes/new");
    const file = new File(["x"], "curry.jpg", { type: "image/jpeg" });

    await user.upload(photoInput(), file);

    expect(screen.getByAltText("Recipe preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeInTheDocument();
  });

  it("uploads the chosen file after the recipe is created", async () => {
    const created = recipe({ id: 42, title: "Toast" });
    const backend = mockBackend({
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
    const backend = mockBackend({
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
