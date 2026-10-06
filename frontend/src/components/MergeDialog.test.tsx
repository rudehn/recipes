import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MergePreview } from "../api";
import { mockBackend, type MockRequest } from "../test/backend";
import { ingredientDetail, ingredientSummary, itemPrice } from "../test/fixtures";
import { renderApp } from "../test/render";

const cumin = ingredientSummary({ key: "cumin", name: "cumin" });
const ground = ingredientSummary({ key: "ground-cumin", name: "ground cumin", recipe_count: 1 });

function preview(overrides: Partial<MergePreview> = {}): MergePreview {
  return {
    from_key: "ground-cumin",
    from_name: "ground cumin",
    to_key: "cumin",
    to_name: "cumin",
    recipes: [{ id: 4, title: "Chili" }],
    product: null,
    food: null,
    staple: null,
    needs: [],
    ...overrides,
  };
}

/** The page the dialog opens from, with the list it searches. */
function backendFor(previewed: MergePreview) {
  return mockBackend({
    "GET /api/ingredients/:key": ({ params }: MockRequest) =>
      params.key === "cumin"
        ? ingredientDetail({ ...cumin, lines: [] })
        : ingredientDetail({ ...ground, lines: [] }),
    "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [] },
    "POST /api/ingredients/merges/preview": previewed,
    "POST /api/ingredients/merges": undefined,
  });
}

describe("MergeDialog", () => {
  it("finds the other name, proposes a direction, previews, and merges", async () => {
    const backend = backendFor(preview());
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });

    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.type(screen.getByLabelText("Find the ingredient"), "cum");
    await user.click(screen.getByRole("button", { name: "cumin" }));

    expect(await screen.findByText("Merge ground cumin into cumin")).toBeInTheDocument();
    expect(screen.getByText(/Chili keeps saying “ground cumin”, and shops as cumin/)).toBeInTheDocument();
    // In the dialog's padded body, not against its edges.
    expect(screen.getByText("Merge ground cumin into cumin").closest(".modal-body")).not.toBeNull();
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[0].body).toEqual({
      from_key: "ground-cumin",
      to_key: "cumin",
    });

    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/ingredients/merges")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toEqual({
      from_key: "ground-cumin",
      to_key: "cumin",
      choices: {},
    });
    expect(await screen.findByText(/Merged ground cumin into cumin/)).toBeInTheDocument();
  });

  it("swaps the direction and previews again", async () => {
    const backend = backendFor(preview());
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Merge ground cumin into cumin");

    await user.click(screen.getByRole("button", { name: "Swap" }));

    await waitFor(() => expect(backend.requestsTo("POST /api/ingredients/merges/preview")).toHaveLength(2));
    expect(backend.requestsTo("POST /api/ingredients/merges/preview")[1].body).toEqual({
      from_key: "cumin",
      to_key: "ground-cumin",
    });
  });

  it("asks which staple to keep, and will not merge until it is chosen", async () => {
    const backend = backendFor(
      preview({
        staple: {
          from_side: { name: "Ground Cumin", in_stock: false },
          to_side: { name: "Cumin", in_stock: true },
          keeps: null,
        },
        needs: ["staple"],
      }),
    );
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Which staple to keep?");

    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Cumin, in stock/ }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toEqual({
        from_key: "ground-cumin",
        to_key: "cumin",
        choices: { staple: "to" },
      }),
    );
  });

  it("asks whose product to keep when it cannot say which products they are", async () => {
    // Both names hold a hand pick at a store the app is not pricing: the
    // merge needs the choice, and the preview cannot name either product.
    const unknown = { product: null, hand_picked: true, not_priced: false };
    const backend = backendFor(
      preview({ product: { from_side: unknown, to_side: unknown, keeps: null }, needs: ["product"] }),
    );
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    const question = await screen.findByText("Which product to keep?");
    // The question opens its item in the list of changes, so the item's
    // bullet sits beside it; as a fieldset's legend it sat outside the
    // item's first line, and the bullet landed beside the first answer.
    expect(question.closest("li")?.firstElementChild).toBe(question);
    expect(screen.getByRole("radiogroup", { name: "Which product to keep?" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "ground cumin’s" }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toEqual({
        from_key: "ground-cumin",
        to_key: "cumin",
        choices: { product: "from" },
      }),
    );
  });

  it("never leaves a needed choice with nothing to choose from", async () => {
    const backend = backendFor(preview({ food: null, needs: ["food"] }));
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Which food to keep?");

    await user.click(screen.getByRole("radio", { name: "cumin’s" }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toMatchObject({ choices: { food: "to" } }),
    );
  });

  it("cannot merge against the old direction's preview while a swap is loading", async () => {
    let release: (p: MergePreview) => void = () => {};
    let calls = 0;
    const backend = mockBackend({
      "GET /api/ingredients/:key": ({ params }: MockRequest) =>
        ingredientDetail({ ...(params.key === "cumin" ? cumin : ground), lines: [] }),
      "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [] },
      "POST /api/ingredients/merges/preview": () =>
        ++calls === 1
          ? preview()
          : new Promise<MergePreview>((r) => (release = r)),
      "POST /api/ingredients/merges": undefined,
    });
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await screen.findByText("Merge ground cumin into cumin");

    await user.click(screen.getByRole("button", { name: "Swap" }));
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.queryByText("Merge ground cumin into cumin")).not.toBeInTheDocument();

    release(preview({ from_key: "cumin", from_name: "cumin", to_key: "ground-cumin", to_name: "ground cumin" }));
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await waitFor(() => expect(backend.requestsTo("POST /api/ingredients/merges")).toHaveLength(1));
    expect(backend.requestsTo("POST /api/ingredients/merges")[0].body).toMatchObject({
      from_key: "cumin",
      to_key: "ground-cumin",
    });
    expect(await screen.findByText(/Merged cumin into ground cumin/)).toBeInTheDocument();
  });

  it("shows what each side has when the merge decides which is kept", async () => {
    const side = (description: string, regular: number, hand_picked: boolean) => ({
      product: itemPrice({ description, regular }),
      hand_picked,
      not_priced: false,
    });
    backendFor(
      preview({
        product: {
          from_side: side("Simple Truth Cumin", 2.99, false),
          to_side: side("McCormick Ground Cumin", 3.49, true),
          keeps: "to",
        },
      }),
    );
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));

    expect(
      await screen.findByText("Product: McCormick Ground Cumin $3.49 (your pick), kept over Simple Truth Cumin $2.99"),
    ).toBeInTheDocument();
  });

  it("does not say a product is kept over itself", async () => {
    // Both names matched the same product on their own, which happens to a
    // name that was merged, unmerged and is now being merged again.
    const same = { product: itemPrice({ description: "McCormick Ground Cumin", regular: 3.49 }), hand_picked: false, not_priced: false };
    backendFor(preview({ product: { from_side: same, to_side: same, keeps: "to" } }));
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));

    expect(await screen.findByText("Product: McCormick Ground Cumin $3.49")).toBeInTheDocument();
    expect(screen.queryByText(/kept over/)).not.toBeInTheDocument();
  });

  it("refreshes the target's own page after merging into it", async () => {
    const backend = backendFor(preview());
    const { user } = renderApp("/ingredients/cumin");
    await screen.findByRole("heading", { name: "cumin" });
    const before = backend.requestsTo("GET /api/ingredients/:key").length;

    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "ground cumin" }));
    await user.click(await screen.findByRole("button", { name: "Merge" }));

    expect(await screen.findByText(/Merged ground cumin into cumin/)).toBeInTheDocument();
    expect(backend.requestsTo("GET /api/ingredients/:key").length).toBeGreaterThan(before);
  });

  it("asks before the banner's Unmerge takes the merge back", async () => {
    const backend = mockBackend({
      "GET /api/ingredients/:key": ({ params }: MockRequest) =>
        params.key === "cumin"
          ? ingredientDetail({ ...cumin, lines: [] })
          : ingredientDetail({ ...ground, lines: [] }),
      "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [] },
      "POST /api/ingredients/merges/preview": preview(),
      "POST /api/ingredients/merges": undefined,
      "DELETE /api/ingredients/merges/:key": undefined,
    });
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await screen.findByText(/Merged ground cumin into cumin/);

    // The old name starts fresh rather than getting its picks back, which
    // the owner is told before it happens, from either Unmerge.
    await user.click(screen.getByRole("button", { name: "Unmerge" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/starts fresh/)).toBeInTheDocument();
    expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Unmerge" }));
    await waitFor(() => expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")).toHaveLength(1));
    expect(backend.requestsTo("DELETE /api/ingredients/merges/:key")[0].path).toBe(
      "/api/ingredients/merges/ground-cumin",
    );
    await waitFor(() => expect(screen.queryByText(/Merged ground cumin into cumin/)).not.toBeInTheDocument());
  });

  it("drops the banner when a name is unmerged from the list", async () => {
    mockBackend({
      "GET /api/ingredients/:key": ({ params }: MockRequest) =>
        params.key === "cumin"
          ? ingredientDetail({ ...cumin, lines: [], merged: [{ key: "ground-cumin", name: "ground cumin" }] })
          : ingredientDetail({ ...ground, lines: [] }),
      "GET /api/ingredients": { ingredients: [cumin, ground], suggestions: [] },
      "POST /api/ingredients/merges/preview": preview(),
      "POST /api/ingredients/merges": undefined,
      "DELETE /api/ingredients/merges/:key": undefined,
    });
    const { user } = renderApp("/ingredients/ground-cumin");
    await screen.findByRole("heading", { name: "ground cumin" });
    await user.click(screen.getByRole("button", { name: "Same as another ingredient…" }));
    await user.click(screen.getByRole("button", { name: "cumin" }));
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await screen.findByText(/Merged ground cumin into cumin/);

    await user.click(screen.getByRole("button", { name: "Unmerge ground cumin" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unmerge" }));

    await waitFor(() => expect(screen.queryByText(/Merged ground cumin into cumin/)).not.toBeInTheDocument());
  });
});
