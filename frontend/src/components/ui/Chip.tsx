import type { ReactNode } from "react";

export type ChipTone = "accent" | "green";

/** A small standing label: a time, a serving count, a tag. */
export function Chip({ tone, children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={["chip", tone].filter(Boolean).join(" ")}>{children}</span>;
}

/** The row they sit in, which wraps and pins itself to the bottom of a card. */
export function Chips({ children }: { children: ReactNode }) {
  return <div className="chips">{children}</div>;
}
