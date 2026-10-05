import { useState } from "react";

import { api, type EditedLine, type IngredientLine } from "../api";
import { formatAmount, parseQuantity } from "../quantity";
import { errorMessage } from "../useLoad";
import { Banner, Button } from "./ui";

/**
 * One recipe line, edited where it is shown.
 *
 * The same three fields as the recipe form, saved by id so the line keeps
 * its place and the links to it. "Read it again" asks the importer what it
 * makes of the line now and fills the fields with the answer, unsaved, so
 * the cook decides.
 */
export function LineFixer({
  line,
  onSaved,
  onCancel,
}: {
  line: IngredientLine;
  onSaved: (edited: EditedLine) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(line.quantity === null ? "" : formatAmount(line.quantity));
  const [unit, setUnit] = useState(line.unit ?? "");
  const [name, setName] = useState(line.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const typed = quantity.trim();
    const amount = typed === "" ? null : parseQuantity(typed);
    if (typed !== "" && amount === null) {
      setError("Quantities are numbers or fractions like 1 1/2.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [edited] = await api.editLines([
        { id: line.ingredient_id, name: name.trim(), quantity: amount, unit: unit.trim() || null },
      ]);
      onSaved(edited);
    } catch (cause) {
      setError(errorMessage(cause, "That did not save."));
      setBusy(false);
    }
  }

  async function readAgain() {
    setError(null);
    try {
      const [answer] = await api.rereadLines([line.ingredient_id]);
      setQuantity(answer.after.quantity === null ? "" : formatAmount(answer.after.quantity));
      setUnit(answer.after.unit ?? "");
      setName(answer.after.name);
    } catch (cause) {
      setError(errorMessage(cause, "Could not read the line again."));
    }
  }

  return (
    <form className="line-fixer" onSubmit={save} aria-label={`Fix ${line.name}`}>
      <div className="line-fixer-fields">
        <input aria-label="Quantity" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input aria-label="Unit" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {line.source_line && <p className="source-line">The website wrote: {line.source_line}</p>}
      {error && <Banner tone="error">{error}</Banner>}
      <div className="fact-actions">
        <Button type="submit" variant="primary" size="small" disabled={busy || !name.trim()}>
          Save
        </Button>
        <Button size="small" onClick={readAgain}>
          Read it again
        </Button>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
