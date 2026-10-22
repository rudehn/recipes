import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { Label, PlannedMeal } from "../../api";
import { LabelChecklist } from "./LabelChecklist";

const POPOVER_WIDTH = 240;
const GAP = 4;
const EDGE = 8;

/**
 * The "⋯" on a planned meal: the things to do to it that are not a tap on its
 * servings. Opens a menu, and Labels… swaps that for the label checklist in
 * the same place.
 *
 * The popover is fixed to the window rather than hung from the meal. The
 * week grid scrolls sideways, which makes it clip downward as well, and a
 * menu on the bottom row would have been cut off by the grid's edge.
 *
 * A repeated meal has no Labels… yet: its labels change through the repeat,
 * not through a row of its own.
 */
export function MealMenu({
  meal,
  labels,
  onCreateLabel,
  onSetLabels,
  onRemove,
}: {
  meal: PlannedMeal;
  labels: Label[];
  onCreateLabel: (name: string) => Promise<Label>;
  onSetLabels: (meal: PlannedMeal, ids: number[]) => void;
  onRemove: (entryId: number) => void;
}) {
  const [view, setView] = useState<"menu" | "labels" | null>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Whichever popover is showing, for measuring.
  const popover = useRef<HTMLDivElement | null>(null);

  function close(returnFocus: boolean) {
    setView(null);
    if (returnFocus) button.current?.focus();
  }

  /**
   * Opens down when the space below fits the popover, up when the space above
   * does, and otherwise on the side with more room. It is capped to the space
   * it was given and scrolls inside it, so Done is always reachable.
   */
  function position() {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      EDGE,
      Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - EDGE),
    );
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const needed = popover.current?.scrollHeight ?? 0;
    const down = needed <= below || (needed > above && below >= above);
    setPlace(
      down
        ? { left, top: rect.bottom + GAP, maxHeight: Math.max(below, 0) }
        : { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: Math.max(above, 0) },
    );
  }

  useLayoutEffect(() => {
    if (view !== null) position();
  }, [view]);

  useEffect(() => {
    if (view === null) return;
    const follow = () => position();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [view]);

  // The menu itself closes on a press outside; the checklist does its own,
  // since closing it is also what saves.
  useEffect(() => {
    if (view !== "menu") return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setView(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [view]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setView(null);
    }
  }

  const title = meal.recipe.title;

  return (
    <span className="meal-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="menu-btn"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={view !== null}
        onClick={() => (view === null ? setView("menu") : close(false))}
      >
        ⋯
      </button>
      {view === "menu" && (
        <div
          className="meal-popover"
          role="menu"
          aria-label={title}
          ref={(el) => {
            menu.current = el;
            popover.current = el;
          }}
          style={place}
          onKeyDown={onMenuKeyDown}
        >
          {meal.repeat === null && (
            <button type="button" role="menuitem" onClick={() => setView("labels")}>
              Labels…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              close(false);
              if (meal.entry_id !== null) onRemove(meal.entry_id);
            }}
          >
            Remove
          </button>
        </div>
      )}
      {view === "labels" && (
        <div className="meal-popover" style={place} ref={popover}>
          <LabelChecklist
            labels={labels}
            chosen={meal.labels.map((l) => l.id)}
            onCreate={onCreateLabel}
            onDone={(ids) => onSetLabels(meal, ids)}
            onClose={() => close(true)}
          />
        </div>
      )}
    </span>
  );
}
