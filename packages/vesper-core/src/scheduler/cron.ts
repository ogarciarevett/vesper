/**
 * Hand-rolled standard 5-field cron parser.
 *
 * Field order: minute hour day-of-month month day-of-week
 * Ranges     : 0-59   0-23  1-31          1-12   0-6 (0=Sunday)
 *
 * Supported syntax per field:
 *   `*`         — every value in the field's range
 *   `a`         — exact value
 *   `a,b,c`     — list of values
 *   `a-b`       — inclusive range
 *   `*\/n`       — every n-th value starting from the range minimum
 *   `a-b/n`     — every n-th value within a range
 */

import { SchedulerError } from "./errors.ts";

/** Parsed representation of a single cron field. */
export interface CronField {
  /** The set of all matching values for this field. */
  readonly values: ReadonlySet<number>;
}

/** A fully parsed 5-field cron expression. */
export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
  /** The original expression string, preserved for display. */
  readonly expression: string;
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

const FIELD_RANGES: readonly [FieldRange, FieldRange, FieldRange, FieldRange, FieldRange] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week
];

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;

/** Parse a single cron field token into a set of matching integers. */
function parseField(token: string, range: FieldRange, fieldName: string): CronField {
  const values = new Set<number>();

  for (const part of token.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new SchedulerError("invalid_cron", `empty part in field "${fieldName}"`);
    }

    // Determine if there is a step.
    const slashIdx = trimmed.indexOf("/");
    let base = trimmed;
    let step: number | undefined;

    if (slashIdx !== -1) {
      const stepStr = trimmed.slice(slashIdx + 1);
      base = trimmed.slice(0, slashIdx);
      const parsedStep = parseInt(stepStr, 10);
      if (Number.isNaN(parsedStep) || parsedStep < 1 || String(parsedStep) !== stepStr) {
        throw new SchedulerError(
          "invalid_cron",
          `invalid step "${stepStr}" in field "${fieldName}"`,
        );
      }
      step = parsedStep;
    }

    let lo: number;
    let hi: number;

    if (base === "*") {
      lo = range.min;
      hi = range.max;
    } else {
      const dashIdx = base.indexOf("-");
      if (dashIdx !== -1) {
        const loStr = base.slice(0, dashIdx);
        const hiStr = base.slice(dashIdx + 1);
        lo = parseInt(loStr, 10);
        hi = parseInt(hiStr, 10);
        if (Number.isNaN(lo) || String(lo) !== loStr) {
          throw new SchedulerError(
            "invalid_cron",
            `invalid range start "${loStr}" in field "${fieldName}"`,
          );
        }
        if (Number.isNaN(hi) || String(hi) !== hiStr) {
          throw new SchedulerError(
            "invalid_cron",
            `invalid range end "${hiStr}" in field "${fieldName}"`,
          );
        }
        if (lo > hi) {
          throw new SchedulerError(
            "invalid_cron",
            `range start ${lo} > end ${hi} in field "${fieldName}"`,
          );
        }
      } else {
        // Exact value (or base of a step without range, treat as lo=value hi=max).
        const val = parseInt(base, 10);
        if (Number.isNaN(val) || String(val) !== base) {
          throw new SchedulerError(
            "invalid_cron",
            `invalid value "${base}" in field "${fieldName}"`,
          );
        }
        lo = val;
        hi = step !== undefined ? range.max : val;
      }
    }

    // Validate bounds.
    if (lo < range.min || lo > range.max) {
      throw new SchedulerError(
        "invalid_cron",
        `value ${lo} out of range [${range.min}..${range.max}] in field "${fieldName}"`,
      );
    }
    if (hi < range.min || hi > range.max) {
      throw new SchedulerError(
        "invalid_cron",
        `value ${hi} out of range [${range.min}..${range.max}] in field "${fieldName}"`,
      );
    }

    // Fill values.
    const inc = step ?? 1;
    for (let v = lo; v <= hi; v += inc) {
      values.add(v);
    }
  }

  if (values.size === 0) {
    throw new SchedulerError(
      "invalid_cron",
      `field "${fieldName}" resolved to zero matching values`,
    );
  }

  return { values };
}

/**
 * Parse a standard 5-field cron expression.
 *
 * Throws {@link SchedulerError} with reason `"invalid_cron"` on any parse error.
 */
export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);

  if (parts.length !== 5) {
    throw new SchedulerError("invalid_cron", `expected 5 fields, got ${parts.length}: "${expr}"`);
  }

  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const [minuteRange, hourRange, domRange, monthRange, dowRange] = FIELD_RANGES;

  return {
    minute: parseField(minuteToken, minuteRange, FIELD_NAMES[0]),
    hour: parseField(hourToken, hourRange, FIELD_NAMES[1]),
    dayOfMonth: parseField(domToken, domRange, FIELD_NAMES[2]),
    month: parseField(monthToken, monthRange, FIELD_NAMES[3]),
    dayOfWeek: parseField(dowToken, dowRange, FIELD_NAMES[4]),
    expression: expr,
  };
}

/**
 * Returns true if `date` satisfies the parsed cron expression (to minute granularity).
 *
 * Uses local time components of `date`.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // getMonth() is 0-based
  const dow = date.getDay(); // 0=Sunday

  return (
    parsed.minute.values.has(minute) &&
    parsed.hour.values.has(hour) &&
    parsed.dayOfMonth.values.has(dom) &&
    parsed.month.values.has(month) &&
    parsed.dayOfWeek.values.has(dow)
  );
}

/**
 * Returns the next Date at or after `from` that matches the parsed cron expression.
 *
 * Searches forward minute-by-minute up to 4 years. Throws {@link SchedulerError}
 * with reason `"invalid_cron"` if no matching date is found within the cap.
 */
export function nextRun(parsed: ParsedCron, from: Date): Date {
  // Align to the start of the current minute (truncate seconds/ms).
  const start = new Date(from);
  start.setSeconds(0, 0);

  const MAX_MINUTES = 4 * 366 * 24 * 60; // ~4 years of minutes

  for (let i = 0; i < MAX_MINUTES; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronMatches(parsed, candidate)) {
      return candidate;
    }
  }

  throw new SchedulerError(
    "invalid_cron",
    `no matching date found within 4 years for expression "${parsed.expression}"`,
  );
}
