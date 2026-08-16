import type { ReactNode } from "react";

/**
 * `error` is "that did not happen"; `notice` is something worth knowing while
 * the page stays perfectly usable. The distinction is the whole reason there
 * are two, so it is a required prop rather than a default.
 */
export type BannerTone = "error" | "notice";

export function Banner({
  tone,
  spaced,
  role,
  children,
}: {
  tone: BannerTone;
  /**
   * Adds the gap below. Omit inside a flex container that already spaces its
   * own children, which is why this is opt-in rather than built into the tone.
   */
  spaced?: boolean;
  role?: "alert" | "status";
  children: ReactNode;
}) {
  const classes = [
    tone === "error" ? "error-banner" : "notice-banner",
    spaced && "spaced",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role={role}>
      {children}
    </div>
  );
}
