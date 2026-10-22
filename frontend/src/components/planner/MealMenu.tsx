import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { Label, PlannedMeal, Scope } from "../../api";
import { LabelChecklist } from "./LabelChecklist";
import { changeTarget, isPast, type ChangeTarget } from "./plan";
import type { Placing } from "./placing";
import { RepeatMenu } from "./RepeatMenu";
import { ScopePrompt } from "./ScopePrompt";

const POPOVER_WIDTH = 240;
const GAP = 4;
const EDGE = 8;

/** A change to a repeated meal that waits on Just this day or From this day on. */
type Pending = { kind: "remove" } | { kind: "labels"; ids: number[] };

/**
 * The "⋯" on a planned meal: the things to do to it that are not a tap on its
 * servings. Opens a menu, and Labels… or Repeat… swaps that for its own
 * choices in the same place. Move to… and Copy to… are a drag's equivalent,
 * for a press or the keyboard: they start placing the meal, and the cells
 * are then the targets, as for a pick.
 *
 * The popover is fixed to the window rather than hung from the meal. The
 * week grid scrolls sideways, which makes it clip downward as well, and a
 * menu on the bottom row would have been cut off by the grid's edge.
 *
 * A repeated meal's Remove and Labels… ask, in the same place, whether they
 * are for this day or from it on, once: after Remove, or once the checklist
 * closes. Repeat… never asks, since its choices all say from when they apply.
 */
export function MealMenu({
  meal,
  labels,
  onCreateLabel,
  onSetLabels,
  onRemove,
  onRepeat,
  onPlacing,
}: {
  meal: PlannedMeal;
  labels: Label[];
  onCreateLabel: (name: string) => Promise<Label>;
  onSetLabels: (target: ChangeTarget, ids: number[]) => void;
  onRemove: (target: ChangeTarget) => void;
  onRepeat: (meal: PlannedMeal, weekdays: number[] | null) => void;
  /** Starts moving the meal, or copying it, to a cell chosen next. */
  onPlacing: (placing: Placing) => void;
}) {
  const [view, setView] = useState<"menu" | "labels" | "repeat" | "scope" | null>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Whichever popover is showing, for measuring.
  const popover = useRef<HTMLDivElement | null>(null);
  // The change waiting on the scope question, while it is asked.
  const [pending, setPending] = useState<Pending | null>(null);
  // The checklist's new labels: its onDone runs just before its onClose.
  const ticked = useRef<number[] | null>(null);
  const repeated = meal.repeat !== null;
  const past = isPast(meal.plan_date);

  function close(returnFocus: boolean) {
    setView(null);
    setPending(null);
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

  // The menu and what it opens close on a press outside or Escape, which
  // drops a change still waiting on its question. The checklist does its
  // own, since closing it is also what saves.
  useEffect(() => {
    if (view === null || view === "labels") return;
    if (view === "menu") menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    if (view === "scope") popover.current?.querySelector<HTMLElement>("button")?.focus();
    function dismiss(returnFocus: boolean) {
      setView(null);
      setPending(null);
      if (returnFocus) button.current?.focus();
    }
    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) dismiss(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss(true);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [view]);

  /** Asks a repeated meal's question about `change`, or makes a one-off's at once. */
  function change(next: Pending) {
    if (repeated) {
      setPending(next);
      setView("scope");
      return;
    }
    close(next.kind === "labels");
    commit(next);
  }

  /** Makes the change; a repeated meal's only ever with the owner's answer. */
  function commit(next: Pending, scope?: Scope) {
    const target = changeTarget(meal, scope);
    if (next.kind === "remove") onRemove(target);
    else onSetLabels(target, next.ids);
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
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
          <button type="button" role="menuitem" onClick={() => setView("labels")}>
            Labels…
          </button>
          <button
            type="button"
            role="menuitem"
            // Every choice in it applies from this day on, which a past day
            // cannot take; still focusable, so the reason can be found.
            aria-disabled={past}
            title={past ? "That day has passed" : undefined}
            onClick={() => !past && setView("repeat")}
          >
            Repeat…
          </button>
          {([false, true] as const).map((copy) => (
            <button
              key={String(copy)}
              type="button"
              role="menuitem"
              onClick={() => {
                close(true);
                onPlacing({ kind: "meal", meal, copy });
              }}
            >
              {copy ? "Copy to…" : "Move to…"}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => change({ kind: "remove" })}
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
            onDone={(ids) => {
              ticked.current = ids;
            }}
            onClose={() => {
              const ids = ticked.current;
              ticked.current = null;
              if (ids) change({ kind: "labels", ids });
              else close(true);
            }}
          />
        </div>
      )}
      {view === "repeat" && (
        <div className="meal-popover" style={place} ref={popover}>
          <RepeatMenu
            day={meal.plan_date}
            current={meal.repeat?.weekdays ?? null}
            past={past}
            onChoose={(weekdays) => {
              close(true);
              onRepeat(meal, weekdays);
            }}
          />
        </div>
      )}
      {view === "scope" && pending && (
        <div className="meal-popover" style={place} ref={popover}>
          <ScopePrompt
            day={meal.plan_date}
            question={
              pending.kind === "remove"
                ? `Remove ${title} from which days?`
                : "Which days get these labels?"
            }
            onChoose={(scope) => {
              close(true);
              commit(pending, scope);
            }}
            onCancel={() => close(true)}
          />
        </div>
      )}
    </span>
  );
}
