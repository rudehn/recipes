import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { EntryCost, Label, PlannedMeal } from "../../api";
import { formatWeekday, fromISODate } from "../../dates";
import { errorMessage } from "../../useLoad";
import { Button, Modal } from "../ui";
import { PlanFigure } from "./PlanFigure";
import {
  changeTarget,
  isPast,
  priced,
  repeatName,
  type ChangeTarget,
  type MealChange,
} from "./plan";
import { RepeatMenu } from "./RepeatMenu";
import { ScopePrompt } from "./ScopePrompt";
import { asStored } from "./usePlannedServings";

/**
 * What the sheet shows: the meal, the days it repeats on, or one of the two
 * questions a repeated meal asks - which days lose it, and which days get
 * what was changed here.
 */
type View = "meal" | "repeat" | "remove" | "save";

/**
 * A planned meal's own controls on a phone, in a sheet from the bottom of the
 * screen: its recipe, servings, labels, repeat and Remove. The list keeps only
 * the meal's title, labels and ↻, so a long title has the card's width.
 *
 * Closing the sheet is what saves the labels, so ticking two is one write.
 * A repeated meal's servings wait with them: every change to it asks Just
 * this day or From this day on, once, and the sheet asks it as it closes
 * and sends what changed in one write. A one-off's servings save as they are
 * tapped, as in a cell, since a one-off has nothing to ask.
 */
export function MealSheet({
  meal,
  cost,
  labels,
  onCreateLabel,
  onStepServings,
  onChange,
  onRemove,
  onRepeat,
  onClose,
}: {
  /** The meal as shown, with a one-off's stepped count in it. */
  meal: PlannedMeal;
  cost: EntryCost | undefined;
  labels: Label[];
  onCreateLabel: (name: string) => Promise<Label>;
  /** Steps a one-off meal's servings, saved as they are tapped. */
  onStepServings: (meal: PlannedMeal, delta: number) => void;
  /** Saves a change to the meal's servings or labels; answers whether it went through. */
  onChange: (target: ChangeTarget, change: MealChange) => Promise<boolean>;
  onRemove: (target: ChangeTarget) => void;
  onRepeat: (meal: PlannedMeal, weekdays: number[] | null) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("meal");
  const body = useRef<HTMLDivElement>(null);
  const forId = useId();
  const noteId = useId();
  const repeated = meal.repeat !== null;
  const past = isPast(meal.plan_date);
  const weekday = formatWeekday(fromISODate(meal.plan_date));
  const title = meal.recipe.title;

  // A repeated meal's count as stepped here, until the sheet closes; null
  // until it is stepped.
  const [count, setCount] = useState<number | null>(null);
  const [ticked, setTicked] = useState(() => new Set(meal.labels.map((l) => l.id)));
  // Labels made here, kept beside the ones given until the page's list
  // catches up with them.
  const [made, setMade] = useState<Label[]>([]);
  const all = [...labels, ...made.filter((m) => !labels.some((l) => l.id === m.id))];

  const servings = count ?? meal.servings ?? meal.recipe.servings;
  const stored = count === null ? meal.servings : asStored(meal, count);
  const chosen = [...ticked].sort((a, b) => a - b);
  const labelsChanged =
    ticked.size !== meal.labels.length || meal.labels.some((l) => !ticked.has(l.id));
  const servingsChanged = stored !== meal.servings;
  const changed = labelsChanged || servingsChanged;
  const change: MealChange = {
    ...(servingsChanged && { servings: stored }),
    ...(labelsChanged && { labelIds: chosen }),
  };

  // A question takes focus as it is asked, and the control that asked it
  // gets it back when the sheet returns to the meal.
  const from = useRef<View>("meal");
  useEffect(() => {
    if (view === "remove" || view === "save") {
      body.current?.querySelector<HTMLElement>(".scope-choice")?.focus();
    } else if (view === "meal" && from.current !== "meal") {
      body.current?.querySelector<HTMLElement>(`[data-opens="${from.current}"]`)?.focus();
    }
    from.current = view;
  }, [view]);

  /**
   * However the sheet is closed. A repeated meal with changes asks which days
   * get them first; closing while that is asked is its Cancel, which drops
   * them. A one-off's go at once.
   */
  function close() {
    if (view === "save" || !changed) return onClose();
    if (repeated) return setView("save");
    onClose();
    void onChange(changeTarget(meal), change);
  }

  function step(delta: number) {
    if (!repeated) return onStepServings(meal, delta);
    if (servings != null) setCount(Math.max(1, servings + delta));
  }

  function toggle(id: number) {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  }

  function remove() {
    if (repeated) return setView("remove");
    onClose();
    onRemove(changeTarget(meal));
  }

  /**
   * A one-off's labels go first, so the repeat it becomes starts with them.
   * A repeated meal has none waiting: its days only change once its other
   * changes are saved (see the Repeat row).
   */
  async function repeat(weekdays: number[] | null) {
    onClose();
    if (changed && !repeated && !(await onChange(changeTarget(meal), change))) return;
    onRepeat(meal, weekdays);
  }

  // Its days change from this day on, which a passed day cannot take, and
  // which is a write of its own: one made beside a repeated meal's waiting
  // changes would answer their question for them.
  const repeatBlocked = past ? "That day has passed" : repeated && changed ? "waiting" : null;

  return (
    <Modal title={`${weekday} ${meal.meal}`} onClose={close}>
      <div className="modal-body meal-sheet" ref={body}>
        {view === "meal" && (
          <>
            <Link className="meal-sheet-title" to={`/recipes/${meal.recipe.id}`}>
              {title}
            </Link>

            {(servings != null || priced(cost)) && (
              <div className="meal-sheet-row">
                <span className="meal-sheet-key">Servings</span>
                {servings != null && (
                  <div className="serv">
                    <button type="button" aria-label="Fewer servings" onClick={() => step(-1)}>
                      −
                    </button>
                    <span
                      className={stored != null ? "overridden" : ""}
                      title={`${servings} serving${servings === 1 ? "" : "s"}`}
                    >
                      ×{servings}
                    </span>
                    <button type="button" aria-label="More servings" onClick={() => step(1)}>
                      +
                    </button>
                  </div>
                )}
                {priced(cost) && <PlanFigure cost={cost} />}
              </div>
            )}

            <div className="meal-sheet-row meal-sheet-for">
              <span className="meal-sheet-key" id={forId}>
                For
              </span>
              <div className="meal-sheet-labels" role="group" aria-labelledby={forId}>
                {all.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`tag-pill${ticked.has(l.id) ? " active" : ""}`}
                    aria-pressed={ticked.has(l.id)}
                    onClick={() => toggle(l.id)}
                  >
                    {l.name}
                  </button>
                ))}
                <NewLabel
                  onCreate={async (name) => {
                    const label = await onCreateLabel(name);
                    setMade((m) => [...m, label]);
                    setTicked((t) => new Set(t).add(label.id));
                  }}
                />
              </div>
            </div>

            <button
              type="button"
              className="meal-sheet-row meal-sheet-repeat"
              data-opens="repeat"
              aria-disabled={repeatBlocked !== null}
              aria-describedby={repeatBlocked ? noteId : undefined}
              onClick={() => repeatBlocked === null && setView("repeat")}
            >
              <span className="meal-sheet-key">Repeat</span>
              <span className="meal-sheet-value">
                {meal.repeat && (
                  <span className="repeat-mark" aria-hidden="true">
                    ↻
                  </span>
                )}
                {repeatName(meal.plan_date, meal.repeat?.weekdays ?? null)}
              </span>
              <span className="meal-sheet-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            {repeatBlocked && (
              <p className="meal-sheet-note" id={noteId}>
                {repeatBlocked === "waiting"
                  ? "Close to save the changes above, then change its days."
                  : repeatBlocked}
              </p>
            )}

            <div className="meal-sheet-remove">
              <Button variant="danger" onClick={remove} data-opens="remove">
                Remove from {weekday}
              </Button>
            </div>
          </>
        )}

        {view === "repeat" && (
          <>
            <RepeatMenu
              day={meal.plan_date}
              current={meal.repeat?.weekdays ?? null}
              past={past}
              onChoose={(weekdays) => void repeat(weekdays)}
            />
            <div className="meal-sheet-back">
              <Button size="small" onClick={() => setView("meal")}>
                Back
              </Button>
            </div>
          </>
        )}

        {view === "remove" && (
          <ScopePrompt
            day={meal.plan_date}
            question={`Remove ${title} from which days?`}
            onChoose={(scope) => {
              onClose();
              onRemove(changeTarget(meal, scope));
            }}
            onCancel={() => setView("meal")}
          />
        )}

        {view === "save" && (
          <ScopePrompt
            day={meal.plan_date}
            question="Which days get these changes?"
            onChoose={(scope) => {
              onClose();
              void onChange(changeTarget(meal, scope), change);
            }}
            onCancel={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * The "+ New" chip, which turns into a field for a label's name. Enter makes
 * the label; Escape, or leaving the field empty, puts the chip back without
 * closing the sheet around it.
 */
function NewLabel({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  // Whether the chip takes focus back once it is in place again: after
  // Escape, not after a press somewhere else, which has a focus of its own.
  const refocus = useRef(false);

  useEffect(() => {
    if (naming || !refocus.current) return;
    refocus.current = false;
    chip.current?.focus();
  }, [naming]);

  function stop(focusChip: boolean) {
    refocus.current = focusChip;
    setNaming(false);
    setDraft("");
    setError(null);
  }

  async function create() {
    const name = draft.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(name);
      setDraft("");
    } catch (cause) {
      setError(errorMessage(cause, "Could not make that label."));
    } finally {
      setCreating(false);
      field.current?.focus();
    }
  }

  if (!naming) {
    return (
      <button
        ref={chip}
        type="button"
        className="tag-pill meal-sheet-new"
        onClick={() => setNaming(true)}
      >
        + New
      </button>
    );
  }
  return (
    <span className="meal-sheet-naming">
      <label className="visually-hidden" htmlFor={fieldId}>
        New label
      </label>
      <input
        id={fieldId}
        ref={field}
        autoFocus
        placeholder="New label…"
        maxLength={40}
        enterKeyHint="done"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!draft.trim() && !creating) stop(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          } else if (e.key === "Escape") {
            // Spent here, so the sheet does not close on it too.
            e.preventDefault();
            stop(true);
          }
        }}
      />
      {error && (
        <span className="meal-sheet-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
