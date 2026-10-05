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
