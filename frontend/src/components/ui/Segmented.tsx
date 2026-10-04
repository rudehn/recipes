import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * A few ways of doing one thing, side by side in a pill track, with the one
 * in use filled in.
 *
 * Reported as a group of pressed buttons, as the grocery list's sort order
 * is, rather than as tabs: choosing acts at once and there are only ever a
 * couple of options, so arrow-key tab handling would add nothing a tap or
 * Tab does not already do. Full width on a phone, where each option needs a
 * thumb's room.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the group for assistive tech; each option names itself. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
