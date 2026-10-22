import { useState, type DragEvent } from "react";
import { Link } from "react-router-dom";

import type { EntryCost, Label, PlannedMeal } from "../../api";
import { LabelPills } from "./LabelPills";
import { MealMenu } from "./MealMenu";
import { PlanFigure } from "./PlanFigure";
import { ScopePrompt } from "./ScopePrompt";
import { ServingsStepper } from "./ServingsStepper";
import { priced, type EntryActions } from "./plan";
import { isPlacingDrag, startDrag, type CellDrop, type CellTarget } from "./placing";

/**
 * A meal's title, after its ↻ if it repeats.
 *
 * The mark is a box of its own (so a link's underline passes it by, and a
 * screen reader hears "Repeats" as a word), and a line may break after a box.
 * In a narrow card that left the ↻ alone on a line above the title, so the
 * title starts with a word joiner, which holds the two together; the title is
 * its own element inside, so it is still found by its words alone.
 */
function MealTitle({ meal }: { meal: PlannedMeal }) {
  if (!meal.repeat) return <span>{meal.recipe.title}</span>;
  return (
    <>
      <span className="repeat-mark" role="img" aria-label="Repeats">
        ↻
      </span>
      <span>
        {"\u2060"}
        <span>{meal.recipe.title}</span>
      </span>
    </>
  );
}

/**
 * One day's one meal: what is planned for it, and the way to plan more.
 *
 * While something is being placed the whole cell is the target: one button
 * laid over all of it, so a press anywhere places, and never lands on a meal's
 * link or menu underneath by accident.
 *
 * Its meals can be dragged to another cell, and the cell takes what is
 * dragged onto it, highlighted while it is over it.
 */
export function PlanCell({
  className,
  narrow = false,
  onOpen,
  target,
  drop,
  entries,
  costs,
  dimmed,
  asking,
  labels,
  actions,
  onAdd,
}: {
  className: string;
  /**
   * A week grid's column, where a title needs the card's whole width: there
   * a meal's menu shares its stepper's line rather than its title's.
   */
  narrow?: boolean;
  entries: PlannedMeal[];
  costs: Map<string, EntryCost>;
  dimmed: Set<string>;
  asking: ReadonlySet<string>;
  labels: Label[];
  actions: EntryActions;
  onAdd: () => void;
  /** What a press on the cell does while something is being placed. */
  target: CellTarget | null;
  /** What a drop on the cell does while something is dragged; null where it cannot go. */
  drop: CellDrop | null;
  /**
   * Where a meal's controls are kept in a sheet of their own rather than on
   * it (a phone): opens that sheet. The meal is then its title, labels and
   * ↻ only, and a press anywhere on it is this.
   */
  onOpen?: (meal: PlannedMeal) => void;
}) {
  const { onChangeServings, onAnswerServings, onDrag } = actions;
  // Whether what is dragged is over this cell. Let go of as soon as there is
  // no drag, so a drag that ended without leaving the cell leaves no mark.
  const [over, setOver] = useState(false);
  if (over && !drop) setOver(false);

  const classes = [className, target && "drop-target", over && "drop-over"]
    .filter(Boolean)
    .join(" ");
  // Taken only where something can be put, and only from the planner's own
  // drags: anywhere else, and for a file or text from elsewhere, the browser
  // shows that a drop does nothing, and does nothing.
  const accept = drop
    ? (event: DragEvent) => {
        if (!isPlacingDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = drop.effect(event.altKey);
        setOver(true);
      }
    : undefined;
  return (
    <div
      className={classes}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(event) => {
        // Not when the pointer only crosses onto one of the cell's own meals.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={
        drop
          ? (event) => {
              if (!isPlacingDrag(event.dataTransfer)) return;
              event.preventDefault();
              setOver(false);
              drop.onDrop(event.altKey);
            }
          : undefined
      }
    >
      {target && (
        <button type="button" className="cell-target" aria-label={target.name} onClick={target.onPlace} />
      )}
      {entries.map((e) => {
        const servings = e.servings ?? e.recipe.servings;
        const cost = costs.get(e.key);
        // A repeated meal is drawn lighter, and marked: the routine, so the
        // meals chosen for this week stand out from it.
        const classes = ["plan-entry", e.repeat && "repeated", dimmed.has(e.key) && "dimmed"]
          .filter(Boolean)
          .join(" ");
        // Out of reach under the cell's target, by Tab as well as by press.
        const inert = target ? { inert: "" } : {};
        const menu = (
          <MealMenu
            meal={e}
            labels={labels}
            onCreateLabel={actions.onCreateLabel}
            onSetLabels={actions.onSetLabels}
            onRemove={actions.onRemove}
            onRepeat={actions.onRepeat}
            onPlacing={actions.onPlacing}
          />
        );
        // Beside the title, unless a narrow card's title needs the width and
        // there is a stepper's line to share. A line of the menu's own would
        // look empty: where there is a pointer the menu shows only on hover.
        const menuOnMeta = narrow && servings != null;
        if (onOpen) {
          // Not dragged: a phone has no drag to place with, and a press on
          // the meal is for its sheet.
          return (
            <div key={e.key} className={`${classes} opens-sheet`} {...inert}>
              <button
                type="button"
                className="plan-entry-open"
                aria-haspopup="dialog"
                onClick={() => onOpen(e)}
              >
                <MealTitle meal={e} />
              </button>
              <LabelPills labels={e.labels} />
            </div>
          );
        }
        return (
          <div
            key={e.key}
            // The whole card is what is picked up, wherever it is pressed,
            // except in its menu: there a press is for the menu, and a field
            // in it inside anything draggable could not have its text
            // selected, since the browser drags the card instead. Decided
            // afresh on each press, before the browser looks for something
            // to drag; React leaves the attribute be, its prop never changing.
            draggable
            onPointerDown={(event) => {
              const inMenu = (event.target as Element).closest(".meal-popover") !== null;
              event.currentTarget.draggable = !inMenu;
            }}
            onDragStart={(event) => {
              // Only the card's own drag: not text selected in a field of its
              // menu, which the browser drags on its own and bubbles here.
              if (event.target !== event.currentTarget) return;
              startDrag(event, { kind: "meal", meal: e, copy: false }, onDrag);
            }}
            className={classes}
            {...inert}
          >
            <div className="plan-entry-title">
              {/* Not a drag of its own: a link dragged is its address, which
                  a drop elsewhere would open. The card is dragged. */}
              <Link to={`/recipes/${e.recipe.id}`} draggable={false}>
                <MealTitle meal={e} />
              </Link>
              {!menuOnMeta && menu}
            </div>
            <LabelPills labels={e.labels} />
            {/* The servings and what they cost, on the line under the title.
                A recipe that says nothing of servings has no stepper here,
                and still has a cost. */}
            {(servings != null || priced(cost)) && (
              <div className="plan-entry-meta">
                {servings != null && (
                  <ServingsStepper
                    count={servings}
                    overridden={e.servings != null}
                    onStep={(delta) => onChangeServings(e, delta)}
                  />
                )}
                {priced(cost) && <PlanFigure cost={cost} />}
                {menuOnMeta && menu}
              </div>
            )}
            {asking.has(e.key) && servings != null && (
              <ScopePrompt
                day={e.plan_date}
                question={`Which days get ×${servings}?`}
                onChoose={(scope) => onAnswerServings(e, scope)}
                onCancel={() => onAnswerServings(e, null)}
              />
            )}
          </div>
        );
      })}
      {/* Hidden while the cell is a target (see .drop-target .plan-add). */}
      <button className="plan-add" onClick={onAdd}>
        + Add
      </button>
    </div>
  );
}
