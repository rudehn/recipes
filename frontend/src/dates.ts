export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Monday of the week containing d. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - day);
  return out;
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export function isToday(d: Date): boolean {
  return toISODate(d) === toISODate(new Date());
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const RANGE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatDay(d: Date): string {
  return DAY_FMT.format(d);
}

export function formatDate(d: Date): string {
  return DATE_FMT.format(d);
}

export function formatRange(start: Date, end: Date): string {
  return `${DATE_FMT.format(start)} – ${RANGE_FMT.format(end)}`;
}

const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * A moment that has passed, said the way someone would say it.
 *
 * The day is dropped when it is today's. These read as answers to "have I
 * already done this?", and "3:42 PM" answers it where "Aug 17 at 3:42 PM"
 * makes the reader work out whether Aug 17 is today.
 */
export function formatWhen(d: Date): string {
  const time = TIME_FMT.format(d);
  return isToday(d) ? `today at ${time}` : `${DATE_FMT.format(d)} at ${time}`;
}
