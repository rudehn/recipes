import type { ReactNode } from "react";

/**
 * A two-state toggle reported as a pressed button rather than a checkbox,
 * because it acts immediately: there is no form to submit it with.
 */
export function Switch({
  on,
  onToggle,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  /** The visible label, which should say the current state. */
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="stock-toggle"
      onClick={onToggle}
      aria-pressed={on}
    >
      <span className={on ? "switch on" : "switch"} />
      {children}
    </button>
  );
}
