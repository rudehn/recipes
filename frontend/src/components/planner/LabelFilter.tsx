import { useLayoutEffect, useRef } from "react";

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
  const row = useRef<HTMLDivElement>(null);
  // The selected chip is kept in sight within the row: a reload with a label
  // far along it would otherwise have the choice scrolled off the side of a
  // phone. The row scrolls, never the page, which the agenda may just have
  // put at today.
  useLayoutEffect(() => {
    const chips = row.current;
    const chip = chips?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!chips || !chip) return;
    const edge = parseFloat(getComputedStyle(chips).paddingLeft) || 0;
    const outer = chips.getBoundingClientRect();
    const inner = chip.getBoundingClientRect();
    if (inner.left < outer.left + edge) chips.scrollLeft -= outer.left + edge - inner.left;
    else if (inner.right > outer.right - edge) chips.scrollLeft += inner.right - (outer.right - edge);
  }, [filter.label, labels]);

  return (
    <div className="label-filter">
      <div className="label-filter-chips" role="group" aria-label="Show meals for" ref={row}>
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
