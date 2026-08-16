import type { ReactNode } from "react";

/**
 * What a page shows in place of a list it cannot fill.
 *
 * The glyph is hidden from assistive tech: it is decoration standing in for an
 * illustration, and read aloud it is noise ahead of the heading that carries
 * the actual message.
 */
export function EmptyState({
  glyph,
  title,
  role,
  children,
}: {
  glyph: string;
  title: ReactNode;
  /** `alert` when this is standing in for content that failed to load. */
  role?: "alert";
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" role={role}>
      <div className="glyph" aria-hidden>
        {glyph}
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
