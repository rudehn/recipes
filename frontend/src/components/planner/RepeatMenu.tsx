import { useEffect, useRef, useState } from "react";

import { Button } from "../ui";
import { dayName, weekdayOf } from "./plan";

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const short = (weekday: number) => WEEKDAY_NAMES[weekday].slice(0, 3);

const WEEKDAYS = [0, 1, 2, 3, 4];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const same = (a: number[] | null, b: number[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((d, i) => d === b[i]));

/**
 * The days a meal repeats on. `current` is the repeat's weekdays (0 is
 * Monday), or null for a one-off; the choice answers the same, null being
 * Just this day.
 *
 * Every choice here takes effect from the meal's own day on, so nothing asks
 * Just this day or From this day on: a repeated meal's choices say so
 * instead, and Just this day on one ends the repeat after its day. For the
 * same reason a day that has passed offers nothing.
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
  const own = weekdayOf(day);
  // The weekdays ticked in Custom…, or null while the patterns show.
  const [custom, setCustom] = useState<Set<number> | null>(null);
  const since = current === null ? "" : ` from ${dayName(day)} on`;

  const patterns: { name: string; weekdays: number[] | null }[] = [
    { name: "Just this day", weekdays: null },
    { name: `Every ${WEEKDAY_NAMES[own]}`, weekdays: [own] },
    { name: "Weekdays", weekdays: WEEKDAYS },
    { name: "Every day", weekdays: EVERY_DAY },
  ];
  const isCustom = !patterns.some((p) => same(p.weekdays, current));
  // A custom set that is one of the patterns reads as that pattern.
  const named = (weekdays: number[]) =>
    patterns.find((p) => same(p.weekdays, weekdays))?.name ?? weekdays.map(short).join(", ");
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
              {short(weekday)}
            </button>
          ))}
        </div>
        <p className="repeat-summary">
          {chosen.length === 0
            ? "Choose at least one day"
            : `${named(chosen)}${since}`}
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
      {patterns.map((p) => (
        <button
          key={p.name}
          type="button"
          className="repeat-choice"
          aria-pressed={same(p.weekdays, current)}
          disabled={past}
          onClick={() => onChoose(p.weekdays)}
        >
          {p.weekdays === null ? p.name : `${p.name}${since}`}
        </button>
      ))}
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
