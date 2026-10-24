/** Free-time search over busy calendar intervals, in the person's time zone and working hours. */
import { addDays, atTime, offsetMinutes, startOfDay, zonedParts } from "../time.js";

export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

export interface FreeTimeOptions {
  readonly busy: readonly Interval[];
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly durationMinutes: number;
  readonly timeZone: string;
  /** Local hour the working day starts (default 9). */
  readonly workdayStartHour?: number;
  /** Local hour the working day ends (default 17). */
  readonly workdayEndHour?: number;
  readonly includeWeekends?: boolean;
  /** Suggested start times align to this many minutes (default 30). */
  readonly stepMinutes?: number;
  /** Earliest proposal (default: now). */
  readonly notBefore?: Date;
  readonly maxSuggestions?: number;
}

export interface FreeTimeResult {
  /** Contiguous free windows long enough for the meeting. */
  readonly windows: Interval[];
  /** Concrete proposals: the first aligned slot in each window, at most two per day. */
  readonly suggestions: Interval[];
}

export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end > last.end) merged[merged.length - 1] = { start: last.start, end: interval.end };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/** The next local day's start, always strictly later so day loops terminate whatever the zone's rules. */
function nextDay(day: Date, timeZone: string): Date {
  const next = addDays(day, 1, timeZone);
  return next.getTime() > day.getTime() ? next : new Date(day.getTime() + 86_400_000);
}

/** Rounds up to the next step boundary on the local clock, so slots start at :00 and :30 even in UTC+5:45. */
function alignUp(date: Date, stepMinutes: number, timeZone: string): Date {
  const step = stepMinutes * 60_000;
  const offset = offsetMinutes(date, timeZone) * 60_000;
  return new Date(Math.ceil((date.getTime() + offset) / step) * step - offset);
}

export function findFreeTime(options: FreeTimeOptions): FreeTimeResult {
  const { timeZone } = options;
  const duration = options.durationMinutes * 60_000;
  const startHour = options.workdayStartHour ?? 9;
  const endHour = options.workdayEndHour ?? 17;
  const step = options.stepMinutes ?? 30;
  const maxSuggestions = options.maxSuggestions ?? 6;
  const notBefore = options.notBefore ?? new Date();
  const busy = mergeIntervals(options.busy);
  const windows: Interval[] = [];
  const suggestions: Interval[] = [];
  const perDay = new Map<string, number>();

  for (let day = startOfDay(options.rangeStart, timeZone); day < options.rangeEnd; day = nextDay(day, timeZone)) {
    const weekday = zonedParts(day, timeZone).weekday;
    if (!options.includeWeekends && (weekday === 0 || weekday === 6)) continue;
    const windowStart = new Date(Math.max(atTime(day, startHour, 0, timeZone).getTime(), options.rangeStart.getTime(), notBefore.getTime()));
    const windowEnd = new Date(Math.min(atTime(day, endHour, 0, timeZone).getTime(), options.rangeEnd.getTime()));
    if (windowEnd.getTime() - windowStart.getTime() < duration) continue;

    let cursor = windowStart;
    const gaps: Interval[] = [];
    for (const interval of busy) {
      if (interval.end <= cursor) continue;
      if (interval.start >= windowEnd) break;
      if (interval.start > cursor) gaps.push({ start: cursor, end: new Date(Math.min(interval.start.getTime(), windowEnd.getTime())) });
      if (interval.end > cursor) cursor = interval.end;
      if (cursor >= windowEnd) break;
    }
    if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });

    for (const gap of gaps) {
      if (gap.end.getTime() - gap.start.getTime() < duration) continue;
      windows.push(gap);
      const slotStart = alignUp(gap.start, step, timeZone);
      const slotEnd = new Date(slotStart.getTime() + duration);
      const dayKey = day.toISOString();
      const count = perDay.get(dayKey) ?? 0;
      if (slotEnd <= gap.end && count < 2 && suggestions.length < maxSuggestions) {
        suggestions.push({ start: slotStart, end: slotEnd });
        perDay.set(dayKey, count + 1);
      }
    }
  }
  return { windows, suggestions };
}
