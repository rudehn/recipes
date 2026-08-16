import type { ReactNode } from "react";

/**
 * A labelled control, with the hint between the label and the input so it is
 * read before the thing it qualifies rather than after.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  /** Omit only when the control cannot take an id, e.g. a file input group. */
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {hint !== undefined && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}

/** Fields sitting side by side until the screen is too narrow for it. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="field-row">{children}</div>;
}
