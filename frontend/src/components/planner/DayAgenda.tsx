import { useEffect, useRef } from "react";

import { formatDate, formatDay, isToday, toISODate } from "../../dates";
import { PlanCell } from "./PlanCell";
import { PlanFigure } from "./PlanFigure";
import { MEALS, cellKey, priced, type LayoutProps } from "./plan";

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
  onAdd,
  onRemove,
  onChangeServings,
}: LayoutProps) {
  // Set on today's card when the shown week has one.
  const todayCard = useRef<HTMLElement>(null);
  const weekOf = toISODate(days[0]);
  // A phone's week opens at today, not at Monday: the days before it are
  // done with, and scrolling past them to find what is next is the chore.
  // Another week has no today, so it opens at its top. Keyed on the week
  // rather than on mount, so the Today button brings you back the same way.
  useEffect(() => {
    todayCard.current?.scrollIntoView({ block: "start" });
  }, [weekOf]);

  return (
    <div className="day-agenda">
      {days.map((d) => {
        const iso = toISODate(d);
        const today = isToday(d);
        const cost = costs.days.get(iso);
        return (
          <section
            key={iso}
            ref={today ? todayCard : undefined}
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
                  onAdd={() => onAdd({ date: iso, meal })}
                  onRemove={onRemove}
                  onChangeServings={onChangeServings}
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
