import { Fragment } from "react";

import { formatDate, formatDay, isToday, toISODate } from "../../dates";
import { PlanCell } from "./PlanCell";
import { PlanFigure } from "./PlanFigure";
import { MEALS, cellKey, priced, type LayoutProps } from "./plan";

/**
 * The week as a grid: a row per meal, a column per day.
 *
 * Row-major, because that is the order a CSS grid fills itself in - the meal
 * label, then its seven days, then the next meal.
 */
export function WeekGrid({
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
}: LayoutProps) {
  return (
    <div className="week-grid">
      <div className="corner" />
      {days.map((d) => {
        const cost = costs.days.get(toISODate(d));
        return (
          <div
            key={d.toISOString()}
            className={`day-head${isToday(d) ? " today" : ""}`}
          >
            <div className="dow">{formatDay(d)}</div>
            <div className="date">{formatDate(d)}</div>
            {priced(cost) && <PlanFigure cost={cost} />}
          </div>
        );
      })}

      {/* A fragment, not a wrapper: the cells are the grid's own children, and
          anything between them would be the thing placed in a track instead. */}
      {MEALS.map((meal) => (
        <Fragment key={meal}>
          <div className="meal-label">{meal}</div>
          {days.map((d) => {
            const iso = toISODate(d);
            return (
              <PlanCell
                key={iso}
                className={`plan-cell${isToday(d) ? " today" : ""}`}
                entries={byCell.get(cellKey(iso, meal)) ?? []}
                costs={costs.entries}
                dimmed={dimmed}
                asking={asking}
                labels={labels}
                onAdd={() => onAdd({ date: iso, meal })}
                onRemove={onRemove}
                onChangeServings={onChangeServings}
                onAnswerServings={onAnswerServings}
                onSetLabels={onSetLabels}
                onRepeat={onRepeat}
                onCreateLabel={onCreateLabel}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
