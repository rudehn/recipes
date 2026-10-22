import { useState } from "react";

import type { Meal, RecipeSummary } from "../../api";
import { toISODate } from "../../dates";
import { Button, Modal } from "../ui";
import { CellChooser } from "./CellChooser";
import type { CellRef } from "./placing";

/**
 * Where a pick goes, on a phone: a day of the week and a meal, then Place.
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
        <CellChooser days={days} date={date} meal={meal} onDate={setDate} onMeal={setMeal} />

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
