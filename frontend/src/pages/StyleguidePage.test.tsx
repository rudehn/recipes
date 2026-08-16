import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import StyleguidePage from "./StyleguidePage";
import { renderInRouter } from "../test/render";

describe("StyleguidePage", () => {
  it("lists the tokens it read out of the stylesheet", () => {
    // The point of parsing the stylesheet is that this page cannot fall behind
    // it. If the token block is ever restructured, this is what notices.
    renderInRouter(<StyleguidePage />);

    expect(screen.getByText("--accent")).toBeInTheDocument();
    expect(screen.getByText("--space-16")).toBeInTheDocument();
    expect(screen.getByText("--danger-soft")).toBeInTheDocument();
  });

  it("groups them under the headings the stylesheet gives them", () => {
    renderInRouter(<StyleguidePage />);

    expect(screen.getByRole("heading", { name: "Space" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Danger" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Radius" })).toBeInTheDocument();
  });

  it("shows every button variant", () => {
    renderInRouter(<StyleguidePage />);

    expect(screen.getAllByRole("button", { name: "Primary" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Danger" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "An icon button" })).toBeInTheDocument();
  });

  it("opens the dialog it documents", async () => {
    const { user } = renderInRouter(<StyleguidePage />);

    await user.click(screen.getByRole("button", { name: "Open a dialog" }));

    expect(await screen.findByRole("dialog", { name: "A dialog" })).toBeInTheDocument();
  });
});
