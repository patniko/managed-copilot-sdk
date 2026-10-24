import { describe, expect, it } from "vitest";
import { describeCron } from "../src/server/cron.js";
import { mergeIntervals, findFreeTime } from "../src/server/tools/freeTime.js";
import { addDays, atTime, dayKey, isoInZone, offsetMinutes, parseDateTime, TimeInputError, zonedParts, zonedToUtc } from "../src/server/time.js";

const LA = "America/Los_Angeles";

describe("time zones", () => {
  it("parses absolute and local ISO date-times", () => {
    expect(parseDateTime("2026-10-23T16:00:00-07:00", LA).toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(parseDateTime("2026-10-23T16:00:00Z", LA).toISOString()).toBe("2026-10-23T16:00:00.000Z");
    expect(parseDateTime("2026-10-23T16:00", LA).toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(parseDateTime("2026-12-23T16:00", LA).toISOString()).toBe("2026-12-24T00:00:00.000Z");
    expect(parseDateTime("2026-10-23", "Europe/Berlin").toISOString()).toBe("2026-10-22T22:00:00.000Z");
  });

  it("rejects malformed input with a helpful message", () => {
    expect(() => parseDateTime("tomorrow at 4", LA)).toThrow(TimeInputError);
    expect(() => parseDateTime("2026-13-01T10:00", LA)).toThrow(/ISO 8601/);
  });

  it("handles daylight saving transitions", () => {
    // Fall back: 2026-11-01 01:30 happens twice in Los Angeles; either instant reads 01:30 locally.
    const fold = zonedToUtc(2026, 11, 1, 1, 30, 0, LA);
    expect(zonedParts(fold, LA).hour).toBe(1);
    expect(zonedParts(fold, LA).minute).toBe(30);
    // Spring forward: 2026-03-08 10:00 is after the jump (PDT, -07:00).
    expect(isoInZone(zonedToUtc(2026, 3, 8, 10, 0, 0, LA), LA)).toBe("2026-03-08T10:00:00-07:00");
    expect(offsetMinutes(new Date("2026-01-15T12:00:00Z"), LA)).toBe(-480);
    expect(offsetMinutes(new Date("2026-07-15T12:00:00Z"), LA)).toBe(-420);
  });

  it("adds calendar days across DST without drifting off midnight", () => {
    const start = new Date("2026-10-31T19:00:00Z"); // Oct 31, noon PDT
    const next = addDays(start, 2, LA); // Nov 2 local midnight, now PST
    expect(isoInZone(next, LA)).toBe("2026-11-02T00:00:00-08:00");
    expect(dayKey(next, LA)).toBe("2026-11-02");
  });

  it("formats with the zone's offset", () => {
    expect(isoInZone(new Date("2026-10-23T23:00:00Z"), LA)).toBe("2026-10-23T16:00:00-07:00");
    expect(isoInZone(new Date("2026-10-23T23:00:00Z"), "Asia/Kolkata")).toBe("2026-10-24T04:30:00+05:30");
  });
});

describe("describeCron", () => {
  it.each([
    ["0 8 * * 1-5", "Every weekday at 8:00 AM"],
    ["30 17 * * *", "Every day at 5:30 PM"],
    ["0 9 * * 1", "Every Monday at 9:00 AM"],
    ["0 9 * * 1,3,5", "Every Mon, Wed, Fri at 9:00 AM"],
    ["0 10 * * 0,6", "Every weekend day at 10:00 AM"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Every hour"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 12 1 * *", "Monthly on day 1 at 12:00 PM"],
    ["0 0 * * 7", "Every Sunday at 12:00 AM"],
  ])("%s → %s", (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });

  it("falls back for unusual expressions", () => {
    expect(describeCron("0 9 1 1 *")).toBe("Custom schedule (0 9 1 1 *)");
    expect(describeCron("nonsense")).toBe("Custom schedule (nonsense)");
  });
});

describe("findFreeTime", () => {
  const day = new Date("2026-10-26T16:00:00Z"); // Monday 9:00 AM PDT
  const at = (hour: number, minute = 0) => atTime(day, hour, minute, LA);

  it("merges overlapping busy intervals", () => {
    const merged = mergeIntervals([
      { start: at(10), end: at(11) },
      { start: at(10, 30), end: at(12) },
      { start: at(13), end: at(14) },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.end.getTime()).toBe(at(12).getTime());
  });

  it("finds gaps within working hours and aligns suggestions", () => {
    const result = findFreeTime({
      busy: [
        { start: at(9, 30), end: at(9, 45) },
        { start: at(10), end: at(11) },
        { start: at(14), end: at(14, 45) },
      ],
      rangeStart: at(0),
      rangeEnd: addDays(day, 1, LA),
      durationMinutes: 30,
      timeZone: LA,
      notBefore: new Date("2026-10-20T00:00:00Z"),
    });
    const windows = result.windows.map((w) => `${isoInZone(w.start, LA).slice(11, 16)}-${isoInZone(w.end, LA).slice(11, 16)}`);
    // 9:00-9:30 is exactly 30 minutes, so it fits; 9:45-10:00 is too short.
    expect(windows).toEqual(["09:00-09:30", "11:00-14:00", "14:45-17:00"]);
    // At most two suggestions per day, spread across the day's windows.
    expect(result.suggestions.map((s) => isoInZone(s.start, LA).slice(11, 16))).toEqual(["09:00", "11:00"]);
  });

  it("skips weekends unless asked and never proposes the past", () => {
    const saturday = new Date("2026-10-24T17:00:00Z");
    const weekend = findFreeTime({ busy: [], rangeStart: saturday, rangeEnd: addDays(saturday, 2, LA), durationMinutes: 30, timeZone: LA, notBefore: saturday });
    expect(weekend.windows).toHaveLength(0);
    const included = findFreeTime({ busy: [], rangeStart: saturday, rangeEnd: addDays(saturday, 1, LA), durationMinutes: 30, timeZone: LA, includeWeekends: true, notBefore: saturday });
    expect(isoInZone(included.windows[0]!.start, LA)).toBe("2026-10-24T10:00:00-07:00");
  });
});
