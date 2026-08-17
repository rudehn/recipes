import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallHint } from "./InstallHint";
import { USER_AGENTS as UA, pretendToBe, restoreRealAgent } from "../test/agents";

/*
 * Which environments count as installable is installability.test.ts's subject.
 * What is left for the component is what it says, and that it says it once.
 */

const HEADLINE = "Add Mise to your Home Screen";

afterEach(restoreRealAgent);

describe("InstallHint", () => {
  it("tells an iPhone visitor how to install the app", () => {
    pretendToBe(UA.iphoneSafari);

    render(<InstallHint />);

    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    // The share glyph is the instruction's subject rather than decoration, so
    // it carries a name instead of being hidden from screen readers.
    expect(screen.getByRole("img", { name: "Share" })).toBeInTheDocument();
  });

  it("says nothing where the instructions would not work", () => {
    pretendToBe(UA.androidChrome);

    render(<InstallHint />);

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it("asks the page for room only while it is up", async () => {
    // The card floats, so the page owes it clearance - and takes it straight
    // back, rather than leaving a dead band at the bottom of every later page.
    pretendToBe(UA.iphoneSafari);
    const user = userEvent.setup({ delay: null });

    render(<InstallHint />);
    expect(document.body).toHaveClass("has-install-hint");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(document.body).not.toHaveClass("has-install-hint");
  });

  it("leaves the page alone where it never appears", () => {
    pretendToBe(UA.androidChrome);

    render(<InstallHint />);

    expect(document.body).not.toHaveClass("has-install-hint");
  });

  it("stays gone after it has been dismissed once", async () => {
    pretendToBe(UA.iphoneSafari);
    const user = userEvent.setup({ delay: null });

    const first = render(<InstallHint />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();

    // The point of the banner is that it is one-time, so a fresh mount - which
    // is what the next launch is - has to come up quiet.
    first.unmount();
    render(<InstallHint />);

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it("still dismisses when storage cannot remember it", async () => {
    // The hint may be back next launch; what it must not do is fail to close.
    pretendToBe(UA.iphoneSafari);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const user = userEvent.setup({ delay: null });

    render(<InstallHint />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });
});
