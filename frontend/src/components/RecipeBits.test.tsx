import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RecipePhoto, RecipePickerModal, TimeChips } from "./RecipeBits";
import { HttpError, mockBackend, type MockRequest } from "../test/backend";
import { page, recipeSummary } from "../test/fixtures";
import { renderInRouter } from "../test/render";

describe("TimeChips", () => {
  it("adds prep and cook into one total", async () => {
    render(<TimeChips recipe={{ prep_minutes: 10, cook_minutes: 20, servings: 4 }} />);

    expect(screen.getByText("⏱ 30 min")).toBeInTheDocument();
    expect(screen.getByText("Serves 4")).toBeInTheDocument();
  });

  it("counts the half of the time that was stated", async () => {
    render(<TimeChips recipe={{ prep_minutes: null, cook_minutes: 20, servings: null }} />);

    expect(screen.getByText("⏱ 20 min")).toBeInTheDocument();
    expect(screen.queryByText(/Serves/)).not.toBeInTheDocument();
  });

  it("shows no chip at all when neither time is known", async () => {
    // "⏱ 0 min" would be a claim the recipe never made.
    render(<TimeChips recipe={{ prep_minutes: null, cook_minutes: null, servings: null }} />);

    expect(screen.queryByText(/min/)).not.toBeInTheDocument();
  });
});

describe("RecipePhoto", () => {
  it("shows the photo, labelled with the recipe title", async () => {
    render(<RecipePhoto recipe={{ image_filename: "abc.jpg", title: "Banana bread" }} />);

    const img = screen.getByAltText("Banana bread");
    expect(img).toHaveAttribute("src", "/api/images/abc.jpg");
  });

  it("falls back to a placeholder that screen readers skip", async () => {
    const { container } = render(
      <RecipePhoto recipe={{ image_filename: null, title: "Banana bread" }} />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".photo-placeholder")).toHaveAttribute("aria-hidden");
  });
});

describe("RecipePickerModal", () => {
  const curry = recipeSummary({ id: 1, title: "Weeknight chicken curry" });
  const bread = recipeSummary({ id: 2, title: "Banana bread" });

  function renderPicker(overrides: { onPick?: () => void; onClose?: () => void } = {}) {
    const onPick = overrides.onPick ?? vi.fn();
    const onClose = overrides.onClose ?? vi.fn();
    const rendered = renderInRouter(
      <RecipePickerModal title="Add to dinner" onPick={onPick} onClose={onClose} />,
    );
    return { ...rendered, onPick, onClose };
  }

  it("lists the recipes to choose from", async () => {
    mockBackend({ "GET /api/recipes": page([curry, bread]) });
    renderPicker();

    expect(await screen.findByRole("button", { name: /Weeknight chicken curry/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Banana bread/ })).toBeVisible();
  });

  it("narrows the list through the server as the cook types", async () => {
    const backend = mockBackend({
      "GET /api/recipes": (req: MockRequest) =>
        page(req.searchParams.get("q") === "banana" ? [bread] : [curry, bread]),
    });
    const { user } = renderPicker();
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    await user.type(screen.getByPlaceholderText("Search recipes…"), "banana");

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Weeknight chicken curry/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Banana bread/ })).toBeVisible();
    expect(backend.requestsTo("GET /api/recipes").at(-1)!.searchParams.get("q")).toBe("banana");
  });

  it("asks for a screenful at a time rather than every recipe", async () => {
    const backend = mockBackend({ "GET /api/recipes": page([curry]) });
    renderPicker();
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    const perPage = backend.requestsTo("GET /api/recipes")[0].searchParams.get("per_page");
    expect(Number(perPage)).toBeGreaterThan(0);
  });

  it("asks for a narrower search rather than paging through the rest", async () => {
    // A modal with page numbers would be a worse way to find a recipe than
    // typing two more letters.
    mockBackend({ "GET /api/recipes": page([curry], { total: 4 }) });
    renderPicker();

    expect(await screen.findByText(/3 more matches - keep typing to narrow/)).toBeInTheDocument();
  });

  it("counts a single hidden match in the singular", async () => {
    mockBackend({ "GET /api/recipes": page([curry], { total: 2 }) });
    renderPicker();

    expect(await screen.findByText(/1 more match - keep typing to narrow/)).toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    mockBackend({
      "GET /api/recipes": (req: MockRequest) => (req.searchParams.get("q") ? page([]) : page([curry])),
    });
    const { user } = renderPicker();
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    await user.type(screen.getByPlaceholderText("Search recipes…"), "kohlrabi");

    expect(await screen.findByText("No recipes found.")).toBeInTheDocument();
  });

  it("hands back the recipe that was picked", async () => {
    mockBackend({ "GET /api/recipes": page([curry, bread]) });
    const onPick = vi.fn();
    const { user } = renderPicker({ onPick });
    await screen.findByRole("button", { name: /Banana bread/ });

    await user.click(screen.getByRole("button", { name: /Banana bread/ }));

    expect(onPick).toHaveBeenCalledWith(bread);
  });

  it("closes on the close button, the backdrop, and Escape", async () => {
    mockBackend({ "GET /api/recipes": page([curry]) });
    const onClose = vi.fn();
    const { user, container } = renderPicker({ onClose });
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("stays open when the modal itself is clicked", async () => {
    // The backdrop closes on click; the dialog on top of it must not.
    mockBackend({ "GET /api/recipes": page([curry]) });
    const onClose = vi.fn();
    const { user, container } = renderPicker({ onClose });
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    await user.click(container.querySelector(".modal")!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening for Escape once it is gone", async () => {
    // The listener is on window, so a leaked one would close the next modal.
    mockBackend({ "GET /api/recipes": page([curry]) });
    const onClose = vi.fn();
    const { user, unmount } = renderPicker({ onClose });
    await screen.findByRole("button", { name: /Weeknight chicken curry/ });

    unmount();
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("is a dialog assistive tech can name", async () => {
    mockBackend({ "GET /api/recipes": page([curry]) });
    renderPicker();

    const dialog = await screen.findByRole("dialog", { name: "Add to dinner" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus to the box the cook came here to type in", async () => {
    mockBackend({ "GET /api/recipes": page([curry]) });
    renderPicker();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Search recipes…")).toHaveFocus(),
    );
  });

  it("puts focus back where it was when it closes", async () => {
    // Without the restore, dismissing the picker drops focus onto <body> and a
    // keyboard user starts again from the top of the page.
    mockBackend({ "GET /api/recipes": page([curry]) });

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open picker</button>
          {open && (
            <RecipePickerModal
              title="Add to dinner"
              onPick={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    const { user } = renderInRouter(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open picker" });

    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps Tab inside the dialog", async () => {
    // Tabbing out of a modal leaves the user driving a page they cannot see.
    mockBackend({ "GET /api/recipes": page([curry, bread]) });
    const { user } = renderPicker();
    const last = await screen.findByRole("button", { name: /Banana bread/ });
    const close = screen.getByRole("button", { name: "Close" });

    last.focus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("says why the list is empty when the recipes could not be loaded", async () => {
    mockBackend({ "GET /api/recipes": new HttpError(500, "Database is down") });
    renderPicker();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your recipes/)).toHaveTextContent(
        "Database is down",
      ),
    );
  });
});
