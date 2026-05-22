import { describe, expect, test } from "bun:test";
import { cronMatches, nextRun, parseCron } from "./cron.ts";
import { SchedulerError } from "./errors.ts";

// ---------------------------------------------------------------------------
// parseCron — field count validation
// ---------------------------------------------------------------------------

describe("parseCron — field count", () => {
  test("throws invalid_cron for too few fields", () => {
    expect(() => parseCron("* * * *")).toThrow(SchedulerError);
    try {
      parseCron("* * * *");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("throws invalid_cron for too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow(SchedulerError);
    try {
      parseCron("* * * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("accepts exactly 5 fields", () => {
    expect(() => parseCron("* * * * *")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseCron — wildcard `*`
// ---------------------------------------------------------------------------

describe("parseCron — wildcard", () => {
  test("* in minute produces all 60 values (0-59)", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.values.size).toBe(60);
    expect(p.minute.values.has(0)).toBe(true);
    expect(p.minute.values.has(59)).toBe(true);
  });

  test("* in hour produces all 24 values (0-23)", () => {
    const p = parseCron("* * * * *");
    expect(p.hour.values.size).toBe(24);
    expect(p.hour.values.has(0)).toBe(true);
    expect(p.hour.values.has(23)).toBe(true);
  });

  test("* in day-of-month produces 1-31", () => {
    const p = parseCron("* * * * *");
    expect(p.dayOfMonth.values.size).toBe(31);
    expect(p.dayOfMonth.values.has(1)).toBe(true);
    expect(p.dayOfMonth.values.has(31)).toBe(true);
  });

  test("* in month produces 1-12", () => {
    const p = parseCron("* * * * *");
    expect(p.month.values.size).toBe(12);
  });

  test("* in day-of-week produces 0-6", () => {
    const p = parseCron("* * * * *");
    expect(p.dayOfWeek.values.size).toBe(7);
    expect(p.dayOfWeek.values.has(0)).toBe(true);
    expect(p.dayOfWeek.values.has(6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCron — exact values
// ---------------------------------------------------------------------------

describe("parseCron — exact values", () => {
  test("exact minute", () => {
    const p = parseCron("30 * * * *");
    expect(p.minute.values).toEqual(new Set([30]));
  });

  test("exact hour", () => {
    const p = parseCron("* 14 * * *");
    expect(p.hour.values).toEqual(new Set([14]));
  });

  test("exact day-of-month", () => {
    const p = parseCron("* * 15 * *");
    expect(p.dayOfMonth.values).toEqual(new Set([15]));
  });

  test("exact month", () => {
    const p = parseCron("* * * 6 *");
    expect(p.month.values).toEqual(new Set([6]));
  });

  test("exact day-of-week", () => {
    const p = parseCron("* * * * 3");
    expect(p.dayOfWeek.values).toEqual(new Set([3]));
  });

  test("exact boundary values pass", () => {
    expect(() => parseCron("0 0 1 1 0")).not.toThrow();
    expect(() => parseCron("59 23 31 12 6")).not.toThrow();
  });

  test("value above range throws invalid_cron", () => {
    expect(() => parseCron("60 * * * *")).toThrow(SchedulerError);
    expect(() => parseCron("* 24 * * *")).toThrow(SchedulerError);
    expect(() => parseCron("* * 32 * *")).toThrow(SchedulerError);
    expect(() => parseCron("* * * 13 *")).toThrow(SchedulerError);
    expect(() => parseCron("* * * * 7")).toThrow(SchedulerError);
  });
});

// ---------------------------------------------------------------------------
// parseCron — lists
// ---------------------------------------------------------------------------

describe("parseCron — lists", () => {
  test("list of minutes", () => {
    const p = parseCron("0,15,30,45 * * * *");
    expect(p.minute.values).toEqual(new Set([0, 15, 30, 45]));
  });

  test("list of hours", () => {
    const p = parseCron("* 6,12,18 * * *");
    expect(p.hour.values).toEqual(new Set([6, 12, 18]));
  });

  test("list of days-of-week", () => {
    const p = parseCron("* * * * 1,3,5");
    expect(p.dayOfWeek.values).toEqual(new Set([1, 3, 5]));
  });

  test("single-element list is valid", () => {
    // "5" alone with no comma:
    const p2 = parseCron("5 * * * *");
    expect(p2.minute.values).toEqual(new Set([5]));
  });
});

// ---------------------------------------------------------------------------
// parseCron — ranges
// ---------------------------------------------------------------------------

describe("parseCron — ranges", () => {
  test("range in minute", () => {
    const p = parseCron("10-20 * * * *");
    expect(p.minute.values.size).toBe(11);
    expect(p.minute.values.has(10)).toBe(true);
    expect(p.minute.values.has(20)).toBe(true);
    expect(p.minute.values.has(9)).toBe(false);
    expect(p.minute.values.has(21)).toBe(false);
  });

  test("range in hour", () => {
    const p = parseCron("* 8-17 * * *");
    expect(p.hour.values.size).toBe(10);
    expect(p.hour.values.has(8)).toBe(true);
    expect(p.hour.values.has(17)).toBe(true);
  });

  test("range in month", () => {
    const p = parseCron("* * * 3-5 *");
    expect(p.month.values).toEqual(new Set([3, 4, 5]));
  });

  test("single-value range (a-a) is valid", () => {
    const p = parseCron("5-5 * * * *");
    expect(p.minute.values).toEqual(new Set([5]));
  });

  test("reversed range (lo > hi) throws invalid_cron", () => {
    expect(() => parseCron("30-10 * * * *")).toThrow(SchedulerError);
    try {
      parseCron("30-10 * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });
});

// ---------------------------------------------------------------------------
// parseCron — steps
// ---------------------------------------------------------------------------

describe("parseCron — steps", () => {
  test("*/5 in minute produces 0,5,10,...,55", () => {
    const p = parseCron("*/5 * * * *");
    expect(p.minute.values).toEqual(new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]));
  });

  test("*/2 in hour produces even hours 0-22", () => {
    const p = parseCron("* */2 * * *");
    expect(p.hour.values).toEqual(new Set([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]));
  });

  test("0-30/10 in minute produces 0,10,20,30", () => {
    const p = parseCron("0-30/10 * * * *");
    expect(p.minute.values).toEqual(new Set([0, 10, 20, 30]));
  });

  test("*/1 is equivalent to *", () => {
    const p = parseCron("*/1 * * * *");
    expect(p.minute.values.size).toBe(60);
  });

  test("step of 0 throws invalid_cron", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(SchedulerError);
    try {
      parseCron("*/0 * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("non-numeric step throws invalid_cron", () => {
    expect(() => parseCron("*/x * * * *")).toThrow(SchedulerError);
  });

  test("5/15 in minute (value/step) produces 5,20,35,50", () => {
    const p = parseCron("5/15 * * * *");
    expect(p.minute.values).toEqual(new Set([5, 20, 35, 50]));
  });
});

// ---------------------------------------------------------------------------
// parseCron — combinations
// ---------------------------------------------------------------------------

describe("parseCron — combinations", () => {
  test("list mixed with ranges and steps", () => {
    // "0,15-20,*/30" in minute
    const p = parseCron("0,15-17,*/30 * * * *");
    const expected = new Set([0, 15, 16, 17, 30]); // */30 = 0,30; union with 0,15,16,17
    expect(p.minute.values).toEqual(expected);
  });

  test("@daily equivalent: 0 0 * * *", () => {
    const p = parseCron("0 0 * * *");
    expect(p.minute.values).toEqual(new Set([0]));
    expect(p.hour.values).toEqual(new Set([0]));
    expect(p.dayOfMonth.values.size).toBe(31);
  });

  test("@hourly equivalent: 0 * * * *", () => {
    const p = parseCron("0 * * * *");
    expect(p.minute.values).toEqual(new Set([0]));
    expect(p.hour.values.size).toBe(24);
  });

  test("preserves original expression string", () => {
    const expr = "0 9 * * 1-5";
    const p = parseCron(expr);
    expect(p.expression).toBe(expr);
  });
});

// ---------------------------------------------------------------------------
// cronMatches
// ---------------------------------------------------------------------------

describe("cronMatches", () => {
  // 2025-01-15 is a Wednesday (day-of-week = 3), minute 30, hour 9, dom 15, month 1
  const wed = new Date(2025, 0, 15, 9, 30, 0, 0); // Jan 15 2025 09:30 Wed

  test("* * * * * matches any date", () => {
    const p = parseCron("* * * * *");
    expect(cronMatches(p, wed)).toBe(true);
  });

  test("exact match: 30 9 15 1 3 matches the reference date", () => {
    const p = parseCron("30 9 15 1 3");
    expect(cronMatches(p, wed)).toBe(true);
  });

  test("wrong minute does not match", () => {
    const p = parseCron("31 9 15 1 3");
    expect(cronMatches(p, wed)).toBe(false);
  });

  test("wrong hour does not match", () => {
    const p = parseCron("30 10 15 1 3");
    expect(cronMatches(p, wed)).toBe(false);
  });

  test("wrong day-of-month does not match", () => {
    const p = parseCron("30 9 16 1 3");
    expect(cronMatches(p, wed)).toBe(false);
  });

  test("wrong month does not match", () => {
    const p = parseCron("30 9 15 2 3");
    expect(cronMatches(p, wed)).toBe(false);
  });

  test("wrong day-of-week does not match", () => {
    const p = parseCron("30 9 15 1 4");
    expect(cronMatches(p, wed)).toBe(false);
  });

  test("range match: 25-35 in minute matches 30", () => {
    const p = parseCron("25-35 9 15 1 3");
    expect(cronMatches(p, wed)).toBe(true);
  });

  test("step match: */15 in minute matches 30", () => {
    const p = parseCron("*/15 9 15 1 3");
    expect(cronMatches(p, wed)).toBe(true);
  });

  test("list match: 0,30 in minute matches 30", () => {
    const p = parseCron("0,30 9 15 1 3");
    expect(cronMatches(p, wed)).toBe(true);
  });

  test("seconds and milliseconds are ignored (minute granularity)", () => {
    const p = parseCron("30 9 15 1 3");
    const dateWithSecs = new Date(2025, 0, 15, 9, 30, 45, 999);
    expect(cronMatches(p, dateWithSecs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCron — additional error paths
// ---------------------------------------------------------------------------

describe("parseCron — additional error paths", () => {
  test("empty part in list throws invalid_cron", () => {
    // "0,,30" has an empty middle element
    expect(() => parseCron("0,,30 * * * *")).toThrow(SchedulerError);
    try {
      parseCron("0,,30 * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("invalid range start (non-numeric) throws invalid_cron", () => {
    expect(() => parseCron("x-30 * * * *")).toThrow(SchedulerError);
    try {
      parseCron("x-30 * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("invalid range end (non-numeric) throws invalid_cron", () => {
    expect(() => parseCron("0-z * * * *")).toThrow(SchedulerError);
    try {
      parseCron("0-z * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("non-numeric value throws invalid_cron", () => {
    expect(() => parseCron("abc * * * *")).toThrow(SchedulerError);
    try {
      parseCron("abc * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("range hi out of field range throws invalid_cron", () => {
    // 0-60 in minute: hi=60 is above max 59
    expect(() => parseCron("0-60 * * * *")).toThrow(SchedulerError);
    try {
      parseCron("0-60 * * * *");
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });
});

// ---------------------------------------------------------------------------
// nextRun
// ---------------------------------------------------------------------------

describe("nextRun", () => {
  test("next run of * * * * * from current minute is the same minute (aligned)", () => {
    const p = parseCron("* * * * *");
    const from = new Date(2025, 0, 15, 9, 30, 0, 0);
    const next = nextRun(p, from);
    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });

  test("next run respects step: */5 finds next multiple of 5", () => {
    const p = parseCron("*/5 * * * *");
    // from minute 33 — next should be minute 35
    const from = new Date(2025, 0, 15, 9, 33, 0, 0);
    const next = nextRun(p, from);
    expect(next.getMinutes()).toBe(35);
    expect(next.getHours()).toBe(9);
  });

  test("next run of hourly task from minute 30 is top of next hour", () => {
    const p = parseCron("0 * * * *");
    const from = new Date(2025, 0, 15, 9, 30, 0, 0);
    const next = nextRun(p, from);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(0);
  });

  test("next run of daily task at midnight", () => {
    const p = parseCron("0 0 * * *");
    const from = new Date(2025, 0, 15, 9, 30, 0, 0);
    const next = nextRun(p, from);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  test("nextRun truncates seconds to 0", () => {
    const p = parseCron("* * * * *");
    const from = new Date(2025, 0, 15, 9, 30, 45, 500);
    const next = nextRun(p, from);
    // Current minute still matches when truncated to :30
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
    expect(next.getMinutes()).toBe(30);
  });

  test("nextRun advances past non-matching date", () => {
    // Every Monday (day-of-week = 1) at 09:00
    const p = parseCron("0 9 * * 1");
    // Jan 15 2025 is Wednesday 09:30 — next Monday is Jan 20
    const from = new Date(2025, 0, 15, 9, 30, 0, 0);
    const next = nextRun(p, from);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  test("nextRun throws invalid_cron for impossible schedule (Feb 30)", () => {
    // Feb 30 never exists; the parser won't reject it but nextRun will exhaust the cap.
    const p = parseCron("0 0 30 2 *");
    const from = new Date(2025, 0, 1, 0, 0, 0, 0);
    expect(() => nextRun(p, from)).toThrow(SchedulerError);
    try {
      nextRun(p, from);
    } catch (e: unknown) {
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });
});
