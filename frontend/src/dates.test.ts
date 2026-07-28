import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addDays,
  formatDate,
  formatDay,
  formatRange,
  fromISODate,
  isToday,
  startOfWeek,
  toISODate,
} from "./dates";

afterEach(() => {
  vi.useRealTimers();
});

describe("toISODate", () => {
  it("pads single-digit months and days", () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("reads the local calendar day, not the UTC one", () => {
    // The API keys plan entries by date. Using toISOString here would shift a
    // late-evening plan onto tomorrow for anyone west of UTC.
    const lateEvening = new Date(2026, 6, 27, 23, 30);
    expect(toISODate(lateEvening)).toBe("2026-07-27");
  });
});

describe("fromISODate", () => {
  it("builds a local midnight, so it round-trips through toISODate", () => {
    expect(toISODate(fromISODate("2026-07-27"))).toBe("2026-07-27");
  });

  it("reads the month as a calendar month", () => {
    const d = fromISODate("2026-12-31");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 31]);
  });
});

describe("startOfWeek", () => {
  it.each([
    ["2026-07-27", "Monday"],
    ["2026-07-29", "Wednesday"],
    ["2026-08-02", "Sunday"],
  ])("moves %s (a %s) back to its Monday", (iso) => {
    expect(toISODate(startOfWeek(fromISODate(iso)))).toBe("2026-07-27");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    // The planner grid runs Monday to Sunday; the default getDay() ordering
    // would put Sunday at the head of the following week.
    expect(toISODate(startOfWeek(fromISODate("2026-08-02")))).toBe("2026-07-27");
    expect(toISODate(startOfWeek(fromISODate("2026-08-03")))).toBe("2026-08-03");
  });

  it("leaves the caller's date untouched", () => {
    const wednesday = fromISODate("2026-07-29");
    startOfWeek(wednesday);
    expect(toISODate(wednesday)).toBe("2026-07-29");
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(toISODate(addDays(fromISODate("2026-07-30"), 5))).toBe("2026-08-04");
  });

  it("goes backwards for the previous week", () => {
    expect(toISODate(addDays(fromISODate("2026-07-27"), -7))).toBe("2026-07-20");
  });

  it("leaves the caller's date untouched", () => {
    const start = fromISODate("2026-07-27");
    addDays(start, 6);
    expect(toISODate(start)).toBe("2026-07-27");
  });
});

describe("isToday", () => {
  it("ignores the time of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 14, 0));
    expect(isToday(new Date(2026, 6, 27, 0, 0))).toBe(true);
    expect(isToday(new Date(2026, 6, 27, 23, 59))).toBe(true);
    expect(isToday(new Date(2026, 6, 28, 0, 0))).toBe(false);
  });
});

describe("week header formatting", () => {
  it("writes the weekday and date the planner column shows", () => {
    const monday = fromISODate("2026-07-27");
    expect(formatDay(monday)).toBe("Mon");
    expect(formatDate(monday)).toBe("Jul 27");
  });

  it("puts the year only on the end of a range", () => {
    const range = formatRange(fromISODate("2026-07-27"), fromISODate("2026-08-02"));
    expect(range).toBe("Jul 27 – Aug 2, 2026");
  });
});
