import type { Label } from "../../api";
import { EVERYTHING, type LabelFilter } from "./plan";

/**
 * The row of chips above the week: Everything, then each label, one selected
 * at a time. With a label selected, a checkbox keeps the unlabelled meals in
 * view (dimmed) or hides them. It scrolls sideways within itself when the
 * labels do not fit, so the page never does.
 */
export function LabelFilterBar({
  labels,
  filter,
  onChange,
}: {
  labels: Label[];
  filter: LabelFilter;
  onChange: (f: LabelFilter) => void;
}) {
  return (
    <div className="label-filter">
      <div className="label-filter-chips" role="group" aria-label="Show meals for">
        <button
          type="button"
          className={`tag-pill${filter.label === null ? " active" : ""}`}
          aria-pressed={filter.label === null}
          onClick={() => onChange(EVERYTHING)}
        >
          Everything
        </button>
        {labels.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`tag-pill${filter.label === l.id ? " active" : ""}`}
            aria-pressed={filter.label === l.id}
            onClick={() => onChange({ label: l.id, unlabelled: filter.unlabelled })}
          >
            {l.name}
          </button>
        ))}
      </div>
      {filter.label !== null && (
        <label className="label-filter-unlabelled">
          <input
            type="checkbox"
            checked={filter.unlabelled}
            onChange={(e) => onChange({ ...filter, unlabelled: e.target.checked })}
          />
          Include unlabelled meals
        </label>
      )}
    </div>
  );
}
