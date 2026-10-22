import { useEffect, useRef } from "react";

import type { PlannedMeal } from "../../api";
import { formatDate, formatDay, isToday, toISODate } from "../../dates";
import { PlanCell } from "./PlanCell";
import { PlanFigure } from "./PlanFigure";
import { MEALS, cellKey, priced, type LayoutProps } from "./plan";
import { cellDrop, cellTarget, type CellRef } from "./placing";

/**
 * The same week as a stack of days, each listing its four meals.
 *
 * Day-major, which is how a week is read on a phone: you scroll to Thursday
 * and see all of Thursday, rather than scrolling sideways to Thursday four
 * separate times to collect its meals one row at a time.
 */
export function DayAgenda({
  days,
  byCell,
  costs,
  dimmed,
  asking,
  labels,
  onAdd,
  onRemove,
  onChangeServings,
  onAnswerServings,
  onSetLabels,
  onRepeat,
  onCreateLabel,
  placing,
  onPlace,
  dragging,
  onDrag,
  onDrop,
  loadedWeek,
  onOpen,
  reveal = null,
}: LayoutProps & {
  /** The Monday (ISO) of the week whose meals were last loaded, if any. */
  loadedWeek: string | null;
  /** Opens a meal's sheet, where its controls are kept off the list (a phone). */
  onOpen?: (meal: PlannedMeal) => void;
  /**
   * Where something was just put from a sheet, whose day is scrolled to.
   * Each placing is a new one, so placing on the same day twice scrolls twice.
   */
  reveal?: CellRef | null;
}) {
  // Each shown day's card, by its ISO date.
  const cards = useRef(new Map<string, HTMLElement>());
  const weekOf = toISODate(days[0]);
  const scrolledFor = useRef<string | null>(null);
  // A phone's week opens at today, not at Monday: the days before it are
  // done with, and scrolling past them to find what is next is the chore.
  // Another week has no today, so it opens at its top.
  //
  // Once per week, and only after that week's meals are in: the days above
  // today grow as they fill, and a scroll made while they were empty would be
  // pushed off today. Keyed on the week rather than on mount, so the Today
  // button brings you back the same way; a reload of the same week, or a
  // servings step, does not scroll again.
  useEffect(() => {
    if (loadedWeek !== weekOf || scrolledFor.current === weekOf) return;
    scrolledFor.current = weekOf;
    cards.current.get(toISODate(new Date()))?.scrollIntoView({ block: "start" });
  }, [weekOf, loadedWeek]);

  // A pick placed from the Picks sheet often lands days below the button
  // that opened it, out of sight, where it would look as if nothing happened.
  useEffect(() => {
    if (reveal) cards.current.get(reveal.date)?.scrollIntoView({ block: "start" });
  }, [reveal]);

  return (
    <div className="day-agenda">
      {days.map((d) => {
        const iso = toISODate(d);
        const today = isToday(d);
        const cost = costs.days.get(iso);
        return (
          <section
            key={iso}
            ref={(card) => {
              if (card) cards.current.set(iso, card);
              else cards.current.delete(iso);
            }}
            className={`agenda-day${today ? " today" : ""}`}
          >
            <h2 className="day-head">
              <span className="dow">{formatDay(d)}</span>
              <span className="date">{formatDate(d)}</span>
              {today && <span className="today-tag">Today</span>}
              {priced(cost) && <PlanFigure cost={cost} />}
            </h2>
            {MEALS.map((meal) => (
              <div key={meal} className="agenda-meal">
                <div className="meal-label">{meal}</div>
                <PlanCell
                  className="plan-cell"
                  entries={byCell.get(cellKey(iso, meal)) ?? []}
                  costs={costs.entries}
                  dimmed={dimmed}
                  asking={asking}
                  labels={labels}
                  onAdd={() => onAdd({ date: iso, meal })}
                  target={cellTarget(placing, { date: iso, meal }, onPlace)}
                  drop={cellDrop(dragging, { date: iso, meal }, onDrop)}
                  onDrag={onDrag}
                  onOpen={onOpen}
                  onRemove={onRemove}
                  onChangeServings={onChangeServings}
                  onAnswerServings={onAnswerServings}
                  onSetLabels={onSetLabels}
                  onRepeat={onRepeat}
                  onCreateLabel={onCreateLabel}
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
