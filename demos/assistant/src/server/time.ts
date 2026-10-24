/**
 * Time zone helpers built on `Intl` (no dependencies). The assistant always reasons in the person's IANA time zone;
 * tools accept ISO 8601 date-times with an offset, or local date-times interpreted in that zone.
 */

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday … 6 = Saturday */
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAYS[values.weekday ?? "Sun"] ?? 0,
  };
}

/** Minutes east of UTC for `timeZone` at `date` (e.g. -420 for PDT). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/** The instant at which the wall clock in `timeZone` reads the given local time. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = offsetMinutes(new Date(guess), timeZone);
  let result = guess - first * 60_000;
  const second_ = offsetMinutes(new Date(result), timeZone);
  if (second_ !== first) result = guess - second_ * 60_000;
  return new Date(result);
}

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

export class TimeInputError extends Error {}

/**
 * Parses an ISO 8601 date-time. Values with `Z` or an offset are absolute; values without one (`2026-10-23T16:00`)
 * are wall-clock times in `timeZone`; a bare date is that day's local midnight.
 */
export function parseDateTime(input: string, timeZone: string): Date {
  const value = input.trim();
  if (WITH_OFFSET.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const local = LOCAL.exec(value);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    const month = Number(mo);
    const day = Number(d);
    const hour = h === undefined ? 0 : Number(h);
    const minute = mi === undefined ? 0 : Number(mi);
    const second = s === undefined ? 0 : Number(s);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59) {
      return zonedToUtc(Number(y), month, day, hour, minute, second, timeZone);
    }
  }
  throw new TimeInputError(`"${input}" is not a valid date-time. Use ISO 8601, for example 2026-10-23T16:00:00-07:00.`);
}

function pad(value: number, length = 2): string {
  return String(Math.abs(value)).padStart(length, "0");
}

/** ISO 8601 with the zone's offset, e.g. `2026-10-23T16:00:00-07:00`. */
export function isoInZone(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  const offset = offsetMinutes(date, timeZone);
  const sign = offset < 0 ? "-" : "+";
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** `YYYY-MM-DD` for the local calendar day containing `date`. */
export function dayKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function startOfDay(date: Date, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  return zonedToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

/** Local midnight `days` calendar days after the day containing `date` (DST-safe). */
export function addDays(date: Date, days: number, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), 0, 0, 0, timeZone);
}

/** The instant of local `hour:minute` on the day containing `date`. */
export function atTime(date: Date, hour: number, minute: number, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  return zonedToUtc(parts.year, parts.month, parts.day, hour, minute, 0, timeZone);
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

export function formatDay(date: Date, timeZone: string, now: Date = new Date()): string {
  const key = dayKey(date, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(addDays(now, 1, timeZone), timeZone)) return "Tomorrow";
  if (key === dayKey(addDays(now, -1, timeZone), timeZone)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
}

/** "Today at 4:00 PM", "Tomorrow at 9:30 AM", "Mon, Oct 26 at 9:30 AM". */
export function formatWhen(date: Date, timeZone: string, now: Date = new Date()): string {
  return `${formatDay(date, timeZone, now)} at ${formatTime(date, timeZone)}`;
}

/** "Fri, Oct 23, 2026, 10:01 PM PDT": unambiguous, for model-facing results. */
export function formatLong(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
