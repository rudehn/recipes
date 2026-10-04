import type { ReactNode } from "react";

export type ChipTone = "accent" | "green";

/**
 * A small standing label: a time, a serving count, a tag. `title` is for a
 * chip that stands for more than it says, such as "+2" for the tags a card
 * had no room for.
 */
export function Chip({
  tone,
  title,
  className,
  children,
}: {
  tone?: ChipTone;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={["chip", tone, className].filter(Boolean).join(" ")} title={title}>
      {children}
    </span>
  );
}

/** The row they sit in, which wraps and pins itself to the bottom of a card. */
export function Chips({ children }: { children: ReactNode }) {
  return <div className="chips">{children}</div>;
}
