import { useEffect, type Dispatch, type SetStateAction } from "react";

import { DRAG_QUIET_MS, isPlacingDrag, type Placing } from "./placing";

/**
 * Watches over one of the planner's drags while it is in the air.
 *
 * Only a cell takes what is dragged. Anywhere else is told the drop does
 * nothing, or a field there would take the title the drag carries as text.
 *
 * And the drag is over, whatever was missed, once the pointer moves after
 * the drag's own events have stopped: a browser sends no pointer events
 * while it drags, and its drag events keep coming while it does (`drag` at
 * the row even while the pointer is outside the window). A row that went
 * while it was dragged may never hear its drag end (Firefox does not tell a
 * row no longer in the page), and a drag left in the air would keep the
 * cells taking drops and the meals' menus hidden. A pointer event while the
 * drag's events still come is a stray one, and is not its end.
 *
 * `setDragging` is the state the drag is kept in, which a lost drag sets to
 * null.
 */
export function useDragGuard(
  dragging: Placing | null,
  setDragging: Dispatch<SetStateAction<Placing | null>>,
) {
  useEffect(() => {
    if (!dragging) return;
    let heard = Date.now();
    const hear = () => (heard = Date.now());
    function refuse(event: DragEvent) {
      const data = event.dataTransfer;
      if (event.defaultPrevented || !data || !isPlacingDrag(data)) return;
      event.preventDefault();
      data.dropEffect = "none";
    }
    function over() {
      if (Date.now() - heard > DRAG_QUIET_MS) setDragging(null);
    }
    const dragEvents = ["drag", "dragenter", "dragover"] as const;
    for (const type of dragEvents) window.addEventListener(type, hear, true);
    window.addEventListener("dragenter", refuse);
    window.addEventListener("dragover", refuse);
    window.addEventListener("pointermove", over);
    return () => {
      for (const type of dragEvents) window.removeEventListener(type, hear, true);
      window.removeEventListener("dragenter", refuse);
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("pointermove", over);
    };
  }, [dragging, setDragging]);
}
