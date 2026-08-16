import type { ReactNode } from "react";

/**
 * The title line every page opens with: heading, an optional quiet count
 * beside it, and actions pushed to the far end.
 */
export function PageHead({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  /** The quiet line beside the heading - "8 saved", "7 days of meals". */
  sub?: ReactNode;
  /** Actions, pushed to the trailing edge. */
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {sub !== undefined && <span className="sub">{sub}</span>}
      {children !== undefined && (
        <>
          <span className="spacer" />
          {children}
        </>
      )}
    </div>
  );
}

/** A row of controls that wraps rather than overflowing. */
export function Toolbar({
  center,
  children,
}: {
  /** Centre the row, for a toolbar standing alone inside an empty state. */
  center?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={["toolbar", center && "center"].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
