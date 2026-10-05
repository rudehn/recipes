import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MergePreview } from "../api";
import { mockBackend, type MockRequest } from "../test/backend";
import { ingredientDetail, ingredientSummary } from "../test/fixtures";
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
});
