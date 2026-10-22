import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Placing } from "./placing";

/**
 * Where the Picks panel sits beside the week on a desktop. Where the panel
 * and the grid do not both fit, it folds to a strip whose toggle opens it over
 * the plan's left edge, and it is put away again by Escape, a press outside
 * it, a pick chosen to place, or a drag under way, so every cell can be
 * reached.
 */
export function PicksDock({
  folded,
  placing,
  dragging,
  children,
}: {
  /** Whether the panel is folded to a strip. */
  folded: boolean;
  /** What is being placed by a press, which takes the panel away when it starts. */
  placing: Placing | null;
  /** What is being dragged, which takes the panel away once it is under way. */
  dragging: Placing | null;
  /** The panel. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const overlaid = folded && open;

  // Something chosen to place puts the opened panel away, so every cell can
  // be chosen. Only as it is chosen: the panel opened again while it is
  // waits for its own Escape.
  const [placed, setPlaced] = useState(placing);
  if (placing !== placed) {
    setPlaced(placing);
    if (placing) setOpen(false);
  }

  // Escape puts the opened panel away. Not an Escape something else has
  // already answered (a meal's menu, the search's suggestions), nor one that
  // lets go of what is being placed, which the page answers.
  useEffect(() => {
    if (!overlaid) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || placing) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlaid, placing]);

  // A drag puts an opened panel away, so every cell can be reached. Only once
  // the drag is under way: the browser takes its picture of the row as the
  // drag starts, and would have nothing to draw were the row already hidden.
  useEffect(() => {
    if (!dragging || !overlaid) return;
    const timer = setTimeout(() => setOpen(false));
    return () => clearTimeout(timer);
  }, [dragging, overlaid]);

  // A press anywhere outside the opened panel puts it away, as a menu would.
  useEffect(() => {
    if (!overlaid) return;
    function onPointerDown(event: MouseEvent) {
      if (!dock.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [overlaid]);

  return (
    <div className="picks-dock" ref={dock}>
      {folded && (
        <button
          type="button"
          className="picks-toggle"
          aria-expanded={open}
          aria-controls={sheetId}
          onClick={() => setOpen((o) => !o)}
        >
          Picks
        </button>
      )}
      {/* Kept while folded away, so a search there is still there when it
          opens again. */}
      <div className="picks-sheet" id={sheetId} hidden={folded && !open}>
        {children}
      </div>
    </div>
  );
}
