import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui";
import {
  EVERY_DAY,
  WEEKDAY_NAMES,
  dayName,
  repeatName,
  repeatPatterns,
  sameWeekdays,
  shortWeekday,
  weekdayOf,
} from "./plan";

/**
 * The days a meal repeats on. `current` is the repeat's weekdays (0 is
 * Monday), or null for a one-off; the choice answers the same, null being
 * Just this day.
 *
 * Every choice here takes effect from the meal's own day on, so nothing asks
 * Just this day or From this day on: a repeated meal's choices say so
 * instead, and Just this day on one ends the repeat after its day. For the
 * same reason a day that has passed offers nothing. Days that leave out the
 * meal's own weekday leave its meal on its own day, as a one-off.
 */
export function RepeatMenu({
  day,
  current,
  past,
  onChoose,
}: {
  /** The meal's day, ISO. */
  day: string;
  current: number[] | null;
  past: boolean;
  onChoose: (weekdays: number[] | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ids = useId();
  const own = weekdayOf(day);
  // The weekdays ticked in Custom…, or null while the patterns show.
  const [custom, setCustom] = useState<Set<number> | null>(null);
  const since = current === null ? "" : ` from ${dayName(day)} on`;

  const patterns = repeatPatterns(own);
  const isCustom = !patterns.some((p) => sameWeekdays(p.weekdays, current));
  const view = custom === null ? "patterns" : "custom";

  // Whichever view is showing starts with its first choice focused.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [view]);

  if (custom !== null) {
    const chosen = [...custom].sort((a, b) => a - b);
    const toggle = (weekday: number) => {
      const next = new Set(custom);
      if (next.has(weekday)) next.delete(weekday);
      else next.add(weekday);
      setCustom(next);
    };
    return (
      <div className="repeat-menu" role="group" aria-label="Repeat on" ref={root}>
        <div className="repeat-weekdays">
          {EVERY_DAY.map((weekday) => (
            <button
              key={weekday}
              type="button"
              aria-label={WEEKDAY_NAMES[weekday]}
              aria-pressed={custom.has(weekday)}
              onClick={() => toggle(weekday)}
            >
              {shortWeekday(weekday)}
            </button>
          ))}
        </div>
        <p className="repeat-summary">
          {chosen.length === 0
            ? "Choose at least one day"
            : // A custom set that is one of the patterns reads as that pattern.
              `${repeatName(day, chosen)}${since}`}
          {/* The meal the days are chosen from keeps its own day either
              way, as a one-off where the days leave it out. */}
          {chosen.length > 0 && !custom.has(own) && (
            <span className="repeat-summary-note">This {WEEKDAY_NAMES[own]} stays as it is</span>
          )}
        </p>
        <Button size="small" disabled={chosen.length === 0} onClick={() => onChoose(chosen)}>
          Save
        </Button>
      </div>
    );
  }

  return (
    <div className="repeat-menu" role="group" aria-label="Repeat" ref={root}>
      {past && <p className="repeat-summary">That day has passed</p>}
      {patterns.map((p) =>
        p.weekdays === null && current !== null ? (
          // On a repeated meal this one ends the repeat, which its name alone
          // does not say; the line under it does, as its description.
          <button
            key={p.name}
            type="button"
            className="repeat-choice"
            aria-pressed={false}
            aria-labelledby={`${ids}-name`}
            aria-describedby={`${ids}-note`}
            disabled={past}
            onClick={() => onChoose(null)}
          >
            <span className="repeat-choice-text">
              <span id={`${ids}-name`}>{p.name}</span>
              <span id={`${ids}-note`} className="repeat-choice-note">
                Stops repeating after {dayName(day)}
              </span>
            </span>
          </button>
        ) : (
          <button
            key={p.name}
            type="button"
            className="repeat-choice"
            aria-pressed={sameWeekdays(p.weekdays, current)}
            disabled={past}
            onClick={() => onChoose(p.weekdays)}
          >
            {p.weekdays === null ? p.name : `${p.name}${since}`}
          </button>
        ),
      )}
      <button
        type="button"
        className="repeat-choice"
        aria-pressed={isCustom}
        disabled={past}
        onClick={() => setCustom(new Set(current ?? [own]))}
      >
        Custom…
      </button>
    </div>
  );
}
