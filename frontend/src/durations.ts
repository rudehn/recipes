/**
 * The lengths of time a recipe step mentions, so cook mode can offer each one
 * as a timer where it is written.
 *
 * Recipes are imported from anywhere, so the phrasing is whatever the author
 * wrote: "about 60 minutes", "(4-5 minutes)", "45-50 minutes", "3 to 4 hours",
 * "two minutes", "1 ½ hours", "1 hour 15 minutes", "a 10-minute rest". Days
 * and weeks are left alone - "keeps for 3 to 4 days" is storage advice, not
 * something to count down.
 *
 * A range times its shorter end. "Bake 45-50 minutes, until golden" means
 * check at 45; a timer that waited for 50 would ring after the crust burned.
 */

import { parseQuantity } from "./quantity";

export interface Duration {
  /** The words as written, "45-50 minutes". */
  text: string;
  /** Where they start and end in the step, for splitting it around them. */
  start: number;
  end: number;
  /** How long the timer runs: the shorter end of a range. */
  seconds: number;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  sixty: 60,
  ninety: 90,
};

// Longest first, so "forty-five" is not read as "forty" and a stray "-five".
const WORDS = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const AMOUNT = String.raw`(?:\d+(?:\.\d+)?(?:\s*[½¼¾⅓⅔]|\s+\d\/\d)?|\d\/\d|[½¼¾⅓⅔]|half\s+an?|${WORDS})`;

const HOURS = String.raw`hours?|hrs?`;
const MINUTES = String.raw`minutes?|mins?`;
const SECONDS = String.raw`seconds?|secs?`;

/**
 * An amount, an optional second amount making it a range, and a unit - or an
 * hour followed by its minutes, "1 hour 15 minutes". The lookbehind keeps the
 * "5" of "1.5" or "3/5" from starting a match of its own; "-minute" covers
 * the adjective, "a 10-minute rest".
 */
const DURATION = new RegExp(
  String.raw`(?<![\w.\/])(${AMOUNT})(?:\s*(?:-|–|to)\s*(${AMOUNT}))?\s*-?\s*` +
    String.raw`(?:(${HOURS})\b(?:\s+(?:and\s+)?(${AMOUNT})\s*(?:${MINUTES})\b)?|(${MINUTES}|${SECONDS})\b)`,
  "gi",
);

function amount(text: string): number {
  const words = text.toLowerCase().replace(/\s+/g, " ");
  if (words.startsWith("half")) return 0.5;
  if (words in NUMBER_WORDS) return NUMBER_WORDS[words];
  return parseQuantity(text) ?? NaN;
}

function unitSeconds(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return 3600;
  if (u.startsWith("m")) return 60;
  return 1;
}

/** Every duration in a step, in the order they appear. */
export function findDurations(step: string): Duration[] {
  const found: Duration[] = [];
  for (const match of step.matchAll(DURATION)) {
    const [text, low, , hourUnit, extraMinutes, shortUnit] = match;
    const unit = hourUnit ?? shortUnit;
    let seconds = amount(low) * unitSeconds(unit);
    if (extraMinutes) seconds += amount(extraMinutes) * 60;
    seconds = Math.round(seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const start = match.index;
    found.push({ text: text.trimEnd(), start, end: start + text.trimEnd().length, seconds });
  }
  return found;
}

/** A step cut into its plain text and the durations inside it. */
export function splitStep(step: string): (string | Duration)[] {
  const parts: (string | Duration)[] = [];
  let at = 0;
  for (const duration of findDurations(step)) {
    if (duration.start > at) parts.push(step.slice(at, duration.start));
    parts.push(duration);
    at = duration.end;
  }
  if (at < step.length) parts.push(step.slice(at));
  return parts;
}

/** A countdown as a kitchen timer reads it: "4:05", "1:02:30". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${minutes}:${seconds}`;
}
