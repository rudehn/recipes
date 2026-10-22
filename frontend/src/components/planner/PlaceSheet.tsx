import { useId, useState } from "react";

import type { Meal, RecipeSummary } from "../../api";
import { formatDate, formatWeekday, toISODate } from "../../dates";
import { capitalized } from "../../text";
import { Button, Modal } from "../ui";
import { MEALS } from "./plan";
import type { CellRef } from "./placing";

/**
 * Where a pick goes, on a phone: a day of the week and a meal, as chips, then
 * Place. Two taps where the desktop drags, and no cells to aim at on a list a
 * week long.
 *
 * Today starts chosen when it is in the week, and dinner always does, which
 * is where most picks go. Another week has no day that is more likely than
 * the rest, so its day waits to be chosen.
 */
export function PlaceSheet({
  recipe,
  days,
  error,
  onPlace,
  onClose,
}: {
  recipe: RecipeSummary;
  /** The week's seven days, Monday first. */
  days: Date[];
  /** Why the last write failed, shown once a Place here has failed. */
  error: string | null;
  /** Plans the recipe there; answers whether it went through. */
  onPlace: (cell: CellRef) => Promise<boolean>;
  onClose: () => void;
}) {
  const [date, setDate] = useState<string | null>(
    () => days.map(toISODate).find((iso) => iso === toISODate(new Date())) ?? null,
  );
  const [meal, setMeal] = useState<Meal>("dinner");
  const [placing, setPlacing] = useState(false);
  const [failed, setFailed] = useState(false);
  const dayId = useId();
  const mealId = useId();

  async function place() {
    if (!date || placing) return;
    setPlacing(true);
    setFailed(false);
    // The page puts the sheet away once the meal is planned.
    if (!(await onPlace({ date, meal }))) {
      setPlacing(false);
      setFailed(true);
    }
  }

  return (
    <Modal title={`Place ${recipe.title}`} onClose={onClose}>
      <div className="modal-body place-sheet">
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
                onClick={() => setDate(iso)}
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
              onClick={() => setMeal(m)}
            >
              {capitalized(m)}
            </button>
          ))}
        </div>

        {failed && error && (
          <p className="place-sheet-error" role="alert">
            {error}
          </p>
        )}

        <div className="place-sheet-actions">
          <Button variant="primary" disabled={!date || placing} onClick={place}>
            Place
          </Button>
        </div>
      </div>
    </Modal>
  );
}
