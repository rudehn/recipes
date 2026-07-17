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
