import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { EntryCost, Label, Meal, PlannedMeal } from "../../api";
import { formatWeekday, fromISODate } from "../../dates";
import { Button, Modal } from "../ui";
import { CellChooser } from "./CellChooser";
import { PlanFigure } from "./PlanFigure";
import {
  changeTarget,
  isPast,
  priced,
  repeatName,
  type ChangeTarget,
  type MealChange,
} from "./plan";
import type { CellRef } from "./placing";
import { RepeatMenu } from "./RepeatMenu";
import { ScopePrompt } from "./ScopePrompt";
import { useLabelChoice, type LabelChoice } from "./useLabelChoice";
import { asStored } from "./usePlannedServings";

/**
 * What the sheet shows: the meal, the days it repeats on, where it is moved
 * or copied to, or one of the two questions a repeated meal asks - which days
 * lose it, and which days get what was changed here.
 */
type View = "meal" | "repeat" | "move" | "copy" | "remove" | "save";

/**
 * A planned meal's own controls on a phone, in a sheet from the bottom of the
 * screen: its recipe, servings, labels, repeat, Move to…, Copy to… and
 * Remove. The list keeps only the meal's title, labels and ↻, so a long title
 * has the card's width. Move to… and Copy to… are a phone's drag: a day and
 * a meal chosen as chips, the way a pick is placed.
 *
 * Closing the sheet is what saves the labels, so ticking two is one write.
 * A repeated meal's servings wait with them: every change to it asks Just
 * this day or From this day on, once, and the sheet asks it as it closes
 * and sends what changed in one write. A one-off's servings save as they are
 * tapped, as in a cell, since a one-off has nothing to ask.
 */
export function MealSheet({
  meal,
  days,
  cost,
  labels,
  onCreateLabel,
  onStepServings,
  onChange,
  onRemove,
  onRepeat,
  onPlace,
  onClose,
}: {
  /** The meal as shown, with a one-off's stepped count in it. */
  meal: PlannedMeal;
  /** The week's seven days, Monday first, for Move to… and Copy to…. */
  days: Date[];
  cost: EntryCost | undefined;
  labels: Label[];
  onCreateLabel: (name: string) => Promise<Label>;
  /** Steps a one-off meal's servings, saved as they are tapped. */
  onStepServings: (meal: PlannedMeal, delta: number) => void;
  /** Saves a change to the meal's servings or labels; answers whether it went through. */
  onChange: (target: ChangeTarget, change: MealChange) => Promise<boolean>;
  onRemove: (target: ChangeTarget) => void;
  onRepeat: (meal: PlannedMeal, weekdays: number[] | null) => void;
  /** Moves the meal to a cell, or copies it there. */
  onPlace: (meal: PlannedMeal, cell: CellRef, copy: boolean) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("meal");
  const body = useRef<HTMLDivElement>(null);
  const forId = useId();
  const pastId = useId();
  const waitingId = useId();
  const repeated = meal.repeat !== null;
  const past = isPast(meal.plan_date);
  const weekday = formatWeekday(fromISODate(meal.plan_date));
  const title = meal.recipe.title;

  // A repeated meal's count as stepped here, until the sheet closes; null
  // until it is stepped.
  const [count, setCount] = useState<number | null>(null);
  const choice = useLabelChoice({
    labels,
    chosen: meal.labels.map((l) => l.id),
    onCreate: onCreateLabel,
  });

  const servings = count ?? meal.servings ?? meal.recipe.servings;
  const stored = count === null ? meal.servings : asStored(meal, count);
  const servingsChanged = stored !== meal.servings;
  const changed = choice.changed || servingsChanged;
  const change: MealChange = {
    ...(servingsChanged && { servings: stored }),
    ...(choice.changed && { labelIds: choice.ids }),
  };

  // A question takes focus as it is asked, and the control that asked it
  // gets it back when the sheet returns to the meal.
  const from = useRef<View>("meal");
  useEffect(() => {
    if (view === "remove" || view === "save") {
      body.current?.querySelector<HTMLElement>(".scope-choice")?.focus();
    } else if (view === "move" || view === "copy") {
      body.current?.querySelector<HTMLElement>(".place-chip[aria-pressed=true]")?.focus();
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

  /**
   * Moved or copied as it now is: a one-off's waiting labels go first, so the
   * meal moved has them, and a copy gets them too. A repeated meal has none
   * waiting (see `waiting`).
   */
  async function place(cell: CellRef, copy: boolean) {
    onClose();
    if (changed && !repeated && !(await onChange(changeTarget(meal), change))) return;
    const labelled = choice.all.filter((l) => choice.ticked.has(l.id));
    onPlace({ ...meal, servings: stored, labels: labelled }, cell, copy);
  }

  // A repeated meal's changes wait on their question until the sheet closes.
  // Changing its days, or moving or copying it, is a write of its own, and
  // one made beside them would leave them unasked, or answer for them.
  const waiting = repeated && changed;
  // Its days change from this day on, which a passed day cannot take either.
  const repeatBlocked = past || waiting;

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
                {choice.all.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`tag-pill${choice.ticked.has(l.id) ? " active" : ""}`}
                    aria-pressed={choice.ticked.has(l.id)}
                    onClick={() => choice.toggle(l.id)}
                  >
                    {l.name}
                  </button>
                ))}
                <NewLabel choice={choice} />
              </div>
            </div>

            <button
              type="button"
              className="meal-sheet-row meal-sheet-repeat"
              data-opens="repeat"
              aria-disabled={repeatBlocked}
              aria-describedby={past ? pastId : waiting ? waitingId : undefined}
              onClick={() => !repeatBlocked && setView("repeat")}
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
            {past && (
              <p className="meal-sheet-note" id={pastId}>
                That day has passed
              </p>
            )}

            <div className="meal-sheet-row meal-sheet-place">
              {(["move", "copy"] as const).map((verb) => (
                <Button
                  key={verb}
                  data-opens={verb}
                  aria-disabled={waiting}
                  aria-describedby={waiting ? waitingId : undefined}
                  onClick={() => !waiting && setView(verb)}
                >
                  {verb === "move" ? "Move to…" : "Copy to…"}
                </Button>
              ))}
            </div>
            {waiting && (
              <p className="meal-sheet-note" id={waitingId}>
                Close to save the changes above, then change its days, move or copy it.
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

        {(view === "move" || view === "copy") && (
          <PlaceMeal
            meal={meal}
            days={days}
            copy={view === "copy"}
            onPlace={(cell) => void place(cell, view === "copy")}
            onBack={() => setView("meal")}
          />
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
 * Where a meal is moved or copied to. It starts at the meal's own day and
 * meal, which is no place to put it, as a drag back onto its own cell is not:
 * one tap away from wherever it goes.
 */
function PlaceMeal({
  meal,
  days,
  copy,
  onPlace,
  onBack,
}: {
  meal: PlannedMeal;
  days: Date[];
  copy: boolean;
  onPlace: (cell: CellRef) => void;
  onBack: () => void;
}) {
  const [date, setDate] = useState(meal.plan_date);
  const [slot, setSlot] = useState<Meal>(meal.meal);
  const own = date === meal.plan_date && slot === meal.meal;
  return (
    <div className="place-sheet">
      <CellChooser days={days} date={date} meal={slot} onDate={setDate} onMeal={setSlot} />
      <div className="place-sheet-actions">
        <Button variant="primary" disabled={own} onClick={() => onPlace({ date, meal: slot })}>
          {copy ? "Copy" : "Move"}
        </Button>
      </div>
      <div className="meal-sheet-back">
        <Button size="small" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

/**
 * The "+ New" chip, which turns into a field for a label's name. Enter makes
 * the label; Escape, or leaving the field empty, puts the chip back without
 * closing the sheet around it.
 */
function NewLabel({ choice }: { choice: LabelChoice }) {
  const [naming, setNaming] = useState(false);
  const { draft, error, creating } = choice;
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
    choice.stopNaming();
  }

  async function create() {
    await choice.create();
    field.current?.focus();
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
        onChange={(e) => choice.setDraft(e.target.value)}
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
