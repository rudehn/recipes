import { useId } from "react";

import type { Meal } from "../../api";
import { formatDate, formatWeekday, toISODate } from "../../dates";
import { capitalized } from "../../text";
import { MEALS } from "./plan";

/**
 * A cell of the week chosen on a phone: a day of the week and a meal, as
 * chips, one of each pressed. Two taps where the desktop aims at a cell, and
 * no cells to aim at on a list a week long.
 */
export function CellChooser({
  days,
  date,
  meal,
  onDate,
  onMeal,
}: {
  /** The week's seven days, Monday first. */
  days: Date[];
  /** The chosen day (ISO), or null while none is. */
  date: string | null;
  meal: Meal;
  onDate: (date: string) => void;
  onMeal: (meal: Meal) => void;
}) {
  const dayId = useId();
  const mealId = useId();
  return (
    <>
      <h4 className="place-sheet-key" id={dayId}>
        Day
      </h4>
      <div className="place-days" role="group" aria-labelledby={dayId}>
        {days.map((d) => {
          const iso = toISODate(d);
          const weekday = formatWeekday(d);
          return (
            <button
              key={iso}
              type="button"
              className="place-chip place-day"
              aria-label={`${weekday}, ${formatDate(d)}`}
              aria-pressed={date === iso}
              onClick={() => onDate(iso)}
            >
              <span className="place-day-letter">{weekday[0]}</span>
              <span className="place-day-date">{d.getDate()}</span>
            </button>
          );
        })}
      </div>

      <h4 className="place-sheet-key" id={mealId}>
        Meal
      </h4>
      <div className="place-meals" role="group" aria-labelledby={mealId}>
        {MEALS.map((m) => (
          <button
            key={m}
            type="button"
            className="place-chip"
            aria-pressed={meal === m}
            onClick={() => onMeal(m)}
          >
            {capitalized(m)}
          </button>
        ))}
      </div>
    </>
  );
}
