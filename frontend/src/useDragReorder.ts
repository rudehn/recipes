import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { dropIndex } from "./reorder";

/** How near the window's top or bottom a drag scrolls it, and how far a frame at the very edge. */
const SCROLL_EDGE = 64;
const SCROLL_STEP = 16;

/** A drag in the air, as the rows are drawn from it. */
interface Drag {
  from: number;
  /** Where it would land if let go now. */
  to: number;
  /** How far the dragged row is drawn from its place. */
  offset: number;
  /** How far the rows it passes step aside: its own height and the gap after it. */
  slot: number;
}

/** What only the pointer handlers read, measured once when the drag begins. */
interface Gesture {
  pointerId: number;
  from: number;
  to: number;
  clientY: number;
  /** The pointer's distance down the page when the drag began. */
  startY: number;
  /** Every row's top and bottom, down the page, before the drag moved anything. */
  tops: number[];
  bottoms: number[];
  frame: number;
}

/**
 * Rows of a list put in a new order by dragging a handle on each, or by the
 * arrow keys on the handle.
 *
 * Built on pointer events rather than the browser's drag and drop, which a
 * phone does not have: a finger on the handle drags exactly as a mouse does,
 * since the handle takes no touch gestures of its own (`touch-action: none`
 * in its stylesheet). While a row is dragged the rows it passes step aside to
 * show where it would land, and nothing is reordered until it is let go -
 * so a drag let go where it began, or taken back with Escape, changes nothing.
 * Near the window's top or bottom the page scrolls, so a long list can be
 * dragged end to end on a small screen.
 *
 * `list` holds the rows as its children, in order, and nothing else.
 */
export function useDragReorder(
  list: RefObject<HTMLElement>,
  count: number,
  onMove: (from: number, to: number) => void,
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const gesture = useRef<Gesture | null>(null);

  function follow() {
    const g = gesture.current;
    if (!g) return;
    const { from, tops, bottoms } = g;
    const last = tops.length - 1;
    const moved = g.clientY + window.scrollY - g.startY;
    // Where it lands is worked out from where the pointer is. Only the row as
    // drawn is kept within the list, where past either end it would overlap
    // what is there: worked out from that, its middle would stop level with
    // the end row's and never pass it, and the end place could not be had.
    const middles = tops.map((top, i) => (top + bottoms[i]) / 2);
    const to = dropIndex(middles, from, middles[from] + moved);
    const offset = Math.min(
      Math.max(moved, tops[0] - tops[from]),
      bottoms[last] - bottoms[from],
    );
    g.to = to;
    setDrag((d) => d && { ...d, to, offset });
  }

  function scroll() {
    const g = gesture.current;
    if (!g) return;
    const below = g.clientY - (window.innerHeight - SCROLL_EDGE);
    const above = SCROLL_EDGE - g.clientY;
    const step =
      below > 0
        ? SCROLL_STEP * Math.min(1, below / SCROLL_EDGE)
        : above > 0
          ? -SCROLL_STEP * Math.min(1, above / SCROLL_EDGE)
          : 0;
    if (step === 0) {
      g.frame = 0;
      return;
    }
    window.scrollBy(0, step);
    follow();
    g.frame = requestAnimationFrame(scroll);
  }

  function end(commit: boolean) {
    const g = gesture.current;
    if (!g) return;
    cancelAnimationFrame(g.frame);
    gesture.current = null;
    setDrag(null);
    if (commit && g.to !== g.from) onMove(g.from, g.to);
  }

  // Escape puts the row back where it was.
  useEffect(() => {
    if (!drag) return;
    function cancel(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") end(false);
    }
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  });

  useEffect(() => () => cancelAnimationFrame(gesture.current?.frame ?? 0), []);

  function handleProps(index: number) {
    return {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || count < 2 || gesture.current) return;
        const rows = Array.from(list.current?.children ?? []);
        if (rows.length !== count) return;
        // Neither text selected nor the page scrolled by the gesture.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const rects = rows.map((row) => row.getBoundingClientRect());
        const tops = rects.map((r) => r.top + window.scrollY);
        const bottoms = rects.map((r) => r.bottom + window.scrollY);
        const gap = index < count - 1 ? tops[index + 1] - bottoms[index] : tops[index] - bottoms[index - 1];
        gesture.current = {
          pointerId: event.pointerId,
          from: index,
          to: index,
          clientY: event.clientY,
          startY: event.clientY + window.scrollY,
          tops,
          bottoms,
          frame: 0,
        };
        setDrag({ from: index, to: index, offset: 0, slot: bottoms[index] - tops[index] + gap });
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const g = gesture.current;
        if (!g || event.pointerId !== g.pointerId) return;
        g.clientY = event.clientY;
        follow();
        if (!g.frame) g.frame = requestAnimationFrame(scroll);
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        if (event.pointerId === gesture.current?.pointerId) end(true);
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        if (event.pointerId === gesture.current?.pointerId) end(false);
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        const to =
          event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
        if (to === null) return;
        // The arrows are the handle's while it has focus, not the page's.
        event.preventDefault();
        if (to >= 0 && to < count) onMove(index, to);
      },
    };
  }

  /** How a row is drawn while another, or itself, is dragged. */
  function rowStyle(index: number): CSSProperties | undefined {
    if (!drag) return undefined;
    const { from, to, offset, slot } = drag;
    if (index === from) return { transform: `translateY(${offset}px)` };
    const shift =
      from < to && index > from && index <= to
        ? -slot
        : to < from && index >= to && index < from
          ? slot
          : 0;
    return { transform: `translateY(${shift}px)` };
  }

  return { dragging: drag?.from ?? null, handleProps, rowStyle };
}
