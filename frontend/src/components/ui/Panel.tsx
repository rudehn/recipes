import type { ReactNode } from "react";

/** A titled card. `action` sits on the title's baseline, opposite it. */
export function Panel({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      {action === undefined ? (
        <h2>{title}</h2>
      ) : (
        <div className="panel-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
