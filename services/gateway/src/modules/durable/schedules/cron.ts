/**
 * Cron schedules evaluated in IANA time zones (spec: "Record cron expression, time zone, and resolved scheduled
 * instant. Repeated daylight-saving wall-clock slots run at most once; nonexistent slots are skipped.").
 *
 * Standard 5-field expressions (minute hour day-of-month month day-of-week) with Vixie-cron day matching and the usual
 * macros. Matching local wall-clock times are resolved to instants with `Intl` only:
 *
 * - A wall time inside a spring-forward gap does not exist and is skipped (never shifted past the gap).
 * - A wall time inside a fall-back overlap occurs twice and runs once, at its earliest instant.
 */
import { ManagedCopilotError } from "@managed-copilot/protocol";

export interface CronSchedule {
  /** The original expression (trimmed). */
  readonly source: string;
  /** Sorted unique values, 0-59. */
  readonly minutes: readonly number[];
  /** Sorted unique values, 0-23. */
  readonly hours: readonly number[];
  /** Sorted unique values, 1-31. */
  readonly daysOfMonth: readonly number[];
  /** Sorted unique values, 1-12. */
  readonly months: readonly number[];
  /** Sorted unique values, 0-6 with Sunday = 0 (7 is accepted on input as Sunday). */
  readonly daysOfWeek: readonly number[];
  /** The day-of-month field did not start with "*". */
  readonly domRestricted: boolean;
  /** The day-of-week field did not start with "*". */
  readonly dowRestricted: boolean;
}

/** Local wall-clock components of an instant in a zone (seconds dropped). `weekday` is 0-6 with Sunday = 0. */
export interface WallClockTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** UTC offsets are sampled this far either side of a wall time; real offsets stay within ±14 hours. */
const PROBE_MS = 26 * HOUR_MS;
/** Iteration gives up after this many days without an occurrence (~8 years: every leap day is reachable, even across 2100). */
const HORIZON_DAYS = 8 * 366;
const DEFAULT_LIMIT = 1000;
const DEFAULT_SAMPLE = 50;

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  /** Largest accepted value. */
  readonly max: number;
  /** Largest value covered by "*" and "a/n" (day-of-week stops at Saturday; 7 is only an alias for Sunday). */
  readonly last: number;
  readonly names?: ReadonlyMap<string, number>;
  /** Accepted names, for messages. */
  readonly nameRange?: string;
}

function nameMap(names: readonly string[], first: number): ReadonlyMap<string, number> {
  return new Map(names.map((name, index) => [name, first + index]));
}

const MINUTE: FieldSpec = { name: "minute", min: 0, max: 59, last: 59 };
const HOUR: FieldSpec = { name: "hour", min: 0, max: 23, last: 23 };
const DAY_OF_MONTH: FieldSpec = { name: "day-of-month", min: 1, max: 31, last: 31 };
const MONTH: FieldSpec = {
  name: "month",
  min: 1,
  max: 12,
  last: 12,
  names: nameMap(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1),
  nameRange: "JAN-DEC",
};
const DAY_OF_WEEK: FieldSpec = {
  name: "day-of-week",
  min: 0,
  max: 7,
  last: 6,
  names: nameMap(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], 0),
  nameRange: "SUN-SAT",
};

const FIELD_LIST = "minute hour day-of-month month day-of-week";

const MACROS: ReadonlyMap<string, string> = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

/** Parses a 5-field cron expression or macro. Throws invalid_request with a user-facing message when it is invalid. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") throw new ManagedCopilotError("invalid_request", "Cron expression must be a string");
  const source = expression.trim();
  if (source === "") throw new ManagedCopilotError("invalid_request", `Cron expression is empty; expected 5 fields (${FIELD_LIST})`);
  const fields = expandMacro(source).split(/\s+/);
  if (fields.length !== 5) {
    const hint = fields.length === 6 || fields.length === 7 ? "; seconds and year fields are not supported" : "";
    throw invalidCron(source, `expected 5 fields (${FIELD_LIST}) but found ${fields.length}${hint}`);
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  return Object.freeze({
    source,
    minutes: parseField(minute, MINUTE, source),
    hours: parseField(hour, HOUR, source),
    daysOfMonth: parseField(dayOfMonth, DAY_OF_MONTH, source),
    months: parseField(month, MONTH, source),
    daysOfWeek: parseField(dayOfWeek, DAY_OF_WEEK, source),
    // Vixie cron: a day field starting with "*" never restricts, even with a step ("*/2").
    domRestricted: !dayOfMonth.startsWith("*"),
    dowRestricted: !dayOfWeek.startsWith("*"),
  });
}

function expandMacro(source: string): string {
  if (!source.startsWith("@")) return source;
  const [macro = "", ...rest] = source.split(/\s+/);
  const name = macro.toLowerCase();
  if (name === "@reboot") throw invalidCron(source, `@reboot is not supported; use a time-based schedule such as "@daily" or "0 9 * * 1-5"`);
  const fields = MACROS.get(name);
  if (fields === undefined) throw invalidCron(source, `unknown macro ${quote(macro)}; use one of ${[...MACROS.keys()].join(", ")} or 5 fields (${FIELD_LIST})`);
  if (rest.length > 0) throw invalidCron(source, `${macro} cannot be combined with other fields`);
  return fields;
}

function parseField(text: string, spec: FieldSpec, source: string): readonly number[] {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw invalidCron(source, `${spec.name} field ${quote(text)} has an empty list item`);
    const [rangeText = "", stepText, ...extraSteps] = item.split("/");
    if (extraSteps.length > 0) throw invalidCron(source, `${spec.name} value ${quote(item)} has more than one "/"`);
    if (rangeText === "") throw invalidCron(source, `${spec.name} value ${quote(item)} is missing a value before "/"`);
    const step = stepText === undefined ? 1 : parseStep(stepText, item, spec, source);
    const [start, end] = rangeText === "*" ? [spec.min, spec.last] : parseRange(rangeText, stepText !== undefined, item, spec, source);
    for (let value = start; value <= end; value += step) values.add(spec === DAY_OF_WEEK && value === 7 ? 0 : value);
  }
  return Object.freeze([...values].sort((a, b) => a - b));
}

function parseRange(text: string, stepped: boolean, item: string, spec: FieldSpec, source: string): [number, number] {
  const [startText = "", endText, ...extra] = text.split("-");
  if (extra.length > 0) throw invalidCron(source, `${spec.name} range ${quote(text)} has more than one "-"`);
  if (startText === "" || endText === "") throw invalidCron(source, `${spec.name} range ${quote(text)} is missing its ${startText === "" ? "start" : "end"}`);
  const start = parseValue(startText, item, spec, source);
  // A single value with a step ("a/n") runs from a through the end of the field.
  if (endText === undefined) return [start, stepped ? Math.max(start, spec.last) : start];
  const end = parseValue(endText, item, spec, source);
  if (start > end) throw invalidCron(source, `${spec.name} range ${quote(text)} is reversed; to wrap around use ${quote(wrapAround(spec, start, end))}`);
  return [start, end];
}

function wrapAround(spec: FieldSpec, start: number, end: number): string {
  const span = (from: number, to: number): string => (from === to ? `${from}` : `${from}-${to}`);
  if (spec === DAY_OF_WEEK && start === 7) return span(0, end);
  if (spec === DAY_OF_WEEK && end === 0) return span(start, 7);
  return `${span(start, spec.last)},${span(spec.min, end)}`;
}

function parseValue(text: string, item: string, spec: FieldSpec, source: string): number {
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (value < spec.min || value > spec.max) throw invalidCron(source, `${spec.name} ${text} is out of range (${spec.min}-${spec.max})`);
    return value;
  }
  const named = /^[a-z]{3}$/i.test(text) ? spec.names?.get(text.toUpperCase()) : undefined;
  if (named !== undefined) return named;
  if (text === "?") throw invalidCron(source, `${spec.name} value "?" is not supported; use "*"`);
  const context = text === item ? "" : ` in ${quote(item)}`;
  const expected = spec.nameRange === undefined ? `${spec.min}-${spec.max}` : `${spec.min}-${spec.max} or ${spec.nameRange}`;
  throw invalidCron(source, `${spec.name} value ${quote(text)}${context} is not valid (expected ${expected})`);
}

function parseStep(text: string, item: string, spec: FieldSpec, source: string): number {
  if (text === "") throw invalidCron(source, `${spec.name} value ${quote(item)} is missing a step after "/"`);
  if (!/^\d+$/.test(text)) throw invalidCron(source, `${spec.name} step ${quote(text)} is not a number`);
  const step = Number(text);
  const largest = spec.last - spec.min + 1;
  if (step < 1 || step > largest) throw invalidCron(source, `${spec.name} step ${text} is out of range (1-${largest})`);
  return step;
}

/** JSON-quotes user input for messages, shortened so pathological input cannot flood responses and logs. */
function quote(text: string): string {
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}…` : text);
}

function invalidCron(source: string, detail: string): ManagedCopilotError {
  return new ManagedCopilotError("invalid_request", `Invalid cron expression ${quote(source)}: ${detail}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------------------------

const MAX_CACHED_ZONES = 256;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  if (typeof timeZone !== "string") throw unknownTimeZone(timeZone);
  if (/^[+-]\d/.test(timeZone)) {
    throw new ManagedCopilotError("invalid_request", `Time zone ${quote(timeZone)} is a UTC offset, not an IANA time zone. Use an IANA name such as "America/Los_Angeles" or "UTC".`);
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch (error) {
    if (error instanceof RangeError) throw unknownTimeZone(timeZone);
    throw error;
  }
  if (formatters.size >= MAX_CACHED_ZONES) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

function unknownTimeZone(timeZone: unknown): ManagedCopilotError {
  const name = typeof timeZone === "string" ? quote(timeZone) : String(timeZone);
  return new ManagedCopilotError("invalid_request", `Unknown time zone ${name}. Use an IANA name such as "America/Los_Angeles" or "UTC".`);
}

/**
 * Validates an IANA zone name (e.g. "America/Los_Angeles", "UTC"); returns the canonical name from Intl
 * (`resolvedOptions().timeZone`). Throws invalid_request for unknown zones and for bare UTC offsets such as "+05:30".
 */
export function assertTimeZone(timeZone: string): string {
  return formatterFor(timeZone).resolvedOptions().timeZone;
}

interface ZonedTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedTime(epochMs: number, timeZone: string): ZonedTime {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of formatterFor(timeZone).formatToParts(epochMs)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        // Some Intl implementations render midnight as "24" despite hourCycle h23.
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

/** The zone's UTC offset at an instant: local wall-clock time (as if it were UTC) minus the instant. */
function offsetAt(epochMs: number, timeZone: string): number {
  const t = zonedTime(epochMs, timeZone);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Every instant at which the zone's clocks show the given wall time, ascending: none inside a spring-forward gap,
 * two inside a fall-back overlap, otherwise one. Candidates use the offsets 26 hours either side of the wall time,
 * which bracket the (at most one) transition that can affect it.
 */
function instantsAt(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number[] {
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const instants: number[] = [];
  for (const probe of [local - PROBE_MS, local + PROBE_MS]) {
    const candidate = local - offsetAt(probe, timeZone);
    if (instants.includes(candidate)) continue;
    const t = zonedTime(candidate, timeZone);
    if (t.year === year && t.month === month && t.day === day && t.hour === hour && t.minute === minute) instants.push(candidate);
  }
  return instants.sort((a, b) => a - b);
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function epochOf(value: Date, name: string): number {
  const epochMs = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(epochMs)) throw new ManagedCopilotError("invalid_request", `${name} must be a valid date`);
  return epochMs;
}

/** Local wall-clock components of an instant in a zone (seconds dropped). */
export function wallClock(instant: Date, timeZone: string): WallClockTime {
  const { year, month, day, hour, minute } = zonedTime(epochOf(instant, "instant"), timeZone);
  return { year, month, day, hour, minute, weekday: weekdayOf(year, month, day) };
}

// ---------------------------------------------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------------------------------------------

/**
 * Occurrence instants strictly after `after`, ascending. Walks local calendar days from the wall-clock minute containing
 * `after`, and matching hours/minutes within matching days, so the cost follows the number of candidates rather than
 * elapsed minutes. Stops once a local day starts after `until`, or after `HORIZON_DAYS` days without an occurrence.
 */
function* occurrencesAfter(schedule: CronSchedule, timeZone: string, after: number, until = Number.POSITIVE_INFINITY): Generator<number> {
  const months = new Set(schedule.months);
  const daysOfMonth = new Set(schedule.daysOfMonth);
  const daysOfWeek = new Set(schedule.daysOfWeek);
  const eitherDay = schedule.domRestricted && schedule.dowRestricted;
  const start = zonedTime(after, timeZone);
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let index = 0, idleDays = 0; idleDays <= HORIZON_DAYS; index++, idleDays++) {
    const dayStart = firstDay + index * DAY_MS;
    // Even the earliest instant of this local day (no zone is 26 hours ahead of UTC) is after `until`.
    if (dayStart - PROBE_MS > until) return;
    const date = new Date(dayStart);
    const month = date.getUTCMonth() + 1;
    if (!months.has(month)) continue;
    const day = date.getUTCDate();
    const domMatch = daysOfMonth.has(day);
    const dowMatch = daysOfWeek.has(date.getUTCDay());
    if (eitherDay ? !domMatch && !dowMatch : !domMatch || !dowMatch) continue;
    const year = date.getUTCFullYear();
    for (const hour of schedule.hours) {
      if (index === 0 && hour < start.hour) continue;
      for (const minute of schedule.minutes) {
        if (index === 0 && hour === start.hour && minute < start.minute) continue;
        // A nonexistent wall time (spring-forward gap) has no instant and is skipped. A repeated wall time (fall-back
        // overlap) runs once, at its earliest instant; if that is not after `after`, the slot already ran and its
        // second instant is not a new occurrence.
        const earliest = instantsAt(timeZone, year, month, day, hour, minute)[0];
        if (earliest === undefined || earliest <= after) continue;
        idleDays = 0;
        yield earliest;
      }
    }
  }
}

/** The first occurrence strictly after `after`, or undefined if none within ~8 years. */
export function nextOccurrence(schedule: CronSchedule, timeZone: string, after: Date): Date | undefined {
  for (const instant of occurrencesAfter(schedule, timeZone, epochOf(after, "after"))) return new Date(instant);
  return undefined;
}

/** Occurrences in (afterExclusive, untilInclusive], at most `limit` (default 1000), ascending. */
export function occurrencesBetween(schedule: CronSchedule, timeZone: string, afterExclusive: Date, untilInclusive: Date, limit = DEFAULT_LIMIT): Date[] {
  const after = epochOf(afterExclusive, "afterExclusive");
  const until = epochOf(untilInclusive, "untilInclusive");
  formatterFor(timeZone);
  const max = Math.floor(limit);
  const results: Date[] = [];
  if (!(max >= 1) || until <= after) return results;
  for (const instant of occurrencesAfter(schedule, timeZone, after, until)) {
    if (instant > until) break;
    results.push(new Date(instant));
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Smallest gap in minutes between consecutive occurrences among the next `sample` (default 50) occurrences after
 * `from` (used to enforce frequency limits). Infinity if fewer than 2 occurrences.
 */
export function minimumIntervalMinutes(schedule: CronSchedule, timeZone: string, from: Date, sample = DEFAULT_SAMPLE): number {
  const after = epochOf(from, "from");
  formatterFor(timeZone);
  const max = Math.floor(sample);
  let smallest = Number.POSITIVE_INFINITY;
  if (!(max >= 2)) return smallest;
  let previous: number | undefined;
  let count = 0;
  for (const instant of occurrencesAfter(schedule, timeZone, after)) {
    if (previous !== undefined) smallest = Math.min(smallest, (instant - previous) / 60_000);
    previous = instant;
    if (++count >= max) break;
  }
  return smallest;
}
