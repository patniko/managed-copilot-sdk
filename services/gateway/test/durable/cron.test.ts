import { ManagedCopilotError } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  minimumIntervalMinutes,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  wallClock,
} from "../../src/modules/durable/schedules/cron.js";

const LA = "America/Los_Angeles";
const SYDNEY = "Australia/Sydney";
const KOLKATA = "Asia/Kolkata";

const at = (iso: string): Date => new Date(iso);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

function next(cron: string, timeZone: string, after: string): string | undefined {
  return nextOccurrence(parseCron(cron), timeZone, at(after))?.toISOString();
}

function between(cron: string, timeZone: string, after: string, until: string, limit?: number): string[] {
  return occurrencesBetween(parseCron(cron), timeZone, at(after), at(until), limit).map((date) => date.toISOString());
}

function expectInvalid(action: () => unknown, message: string | RegExp): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ManagedCopilotError);
  const error = caught as ManagedCopilotError;
  expect(error.code).toBe("invalid_request");
  if (typeof message === "string") expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
}

describe("parseCron", () => {
  it("parses wildcards and single values", () => {
    expect(parseCron("5 4 * * *")).toEqual({
      source: "5 4 * * *",
      minutes: [5],
      hours: [4],
      daysOfMonth: range(1, 31),
      months: range(1, 12),
      daysOfWeek: range(0, 6),
      domRestricted: false,
      dowRestricted: false,
    });
  });

  it("trims the source and accepts any whitespace between fields", () => {
    const schedule = parseCron("  0\t9  * *   1-5 \n");
    expect(schedule.source).toBe("0\t9  * *   1-5");
    expect(schedule).toMatchObject({ minutes: [0], hours: [9], daysOfWeek: [1, 2, 3, 4, 5] });
  });

  it("parses lists, ranges, and steps", () => {
    expect(parseCron("0,15,30-33 */6 1-10/3 */4 1-5/2")).toMatchObject({
      minutes: [0, 15, 30, 31, 32, 33],
      hours: [0, 6, 12, 18],
      daysOfMonth: [1, 4, 7, 10],
      months: [1, 5, 9],
      daysOfWeek: [1, 3, 5],
    });
  });

  it("runs a/n from a through the end of the field", () => {
    expect(parseCron("50/3 20/2 28/2 11/1 4/1")).toMatchObject({
      minutes: [50, 53, 56, 59],
      hours: [20, 22],
      daysOfMonth: [28, 30],
      months: [11, 12],
      daysOfWeek: [4, 5, 6],
    });
  });

  it("sorts and deduplicates values and accepts leading zeros", () => {
    expect(parseCron("30,5,5,0-10/5 23,1,1 * * *")).toMatchObject({ minutes: [0, 5, 10, 30], hours: [1, 23] });
    expect(parseCron("05 09 01 02 03")).toMatchObject({ minutes: [5], hours: [9], daysOfMonth: [1], months: [2], daysOfWeek: [3] });
  });

  it("accepts month and weekday names case-insensitively, including in ranges and steps", () => {
    expect(parseCron("0 0 * jan-MAR,Dec mon-FRI")).toMatchObject({ months: [1, 2, 3, 12], daysOfWeek: [1, 2, 3, 4, 5] });
    expect(parseCron("0 0 * * sun,SAT").daysOfWeek).toEqual([0, 6]);
    expect(parseCron("0 0 * JAN/3 *").months).toEqual([1, 4, 7, 10]);
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 0,7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 5-7").daysOfWeek).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * FRI-7").daysOfWeek).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * */2").daysOfWeek).toEqual([0, 2, 4, 6]);
    expect(next("0 12 * * 7", "UTC", "2026-04-01T00:00:00Z")).toBe("2026-04-05T12:00:00.000Z");
  });

  it("expands macros", () => {
    const macros: Record<string, string> = {
      "@yearly": "0 0 1 1 *",
      "@annually": "0 0 1 1 *",
      "@monthly": "0 0 1 * *",
      "@weekly": "0 0 * * 0",
      "@daily": "0 0 * * *",
      "@midnight": "0 0 * * *",
      "@hourly": "0 * * * *",
    };
    for (const [macro, fields] of Object.entries(macros)) {
      expect(parseCron(macro)).toEqual({ ...parseCron(fields), source: macro });
    }
    expect(parseCron(" @DAILY ")).toEqual({ ...parseCron("0 0 * * *"), source: "@DAILY" });
    expect(parseCron("@weekly")).toMatchObject({ daysOfWeek: [0], domRestricted: false, dowRestricted: true });
    expect(parseCron("@hourly")).toMatchObject({ minutes: [0], hours: range(0, 23) });
  });

  it("marks day fields as restricted unless they start with *", () => {
    expect(parseCron("0 0 13 * 5")).toMatchObject({ domRestricted: true, dowRestricted: true });
    expect(parseCron("0 0 1-31 * *")).toMatchObject({ domRestricted: true, dowRestricted: false });
    expect(parseCron("0 0 */2 * MON")).toMatchObject({ domRestricted: false, dowRestricted: true });
    expect(parseCron("0 0 * * */1")).toMatchObject({ domRestricted: false, dowRestricted: false });
  });

  it("returns an immutable schedule", () => {
    const schedule = parseCron("0 9 * * 1-5");
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule.daysOfWeek)).toBe(true);
  });
});

describe("parseCron rejections", () => {
  it.each([
    ["0 25 * * *", 'Invalid cron expression "0 25 * * *": hour 25 is out of range (0-23)'],
    ["0 0-24 * * *", 'Invalid cron expression "0 0-24 * * *": hour 24 is out of range (0-23)'],
    ["60 * * * *", 'Invalid cron expression "60 * * * *": minute 60 is out of range (0-59)'],
    ["0 0 0 * *", 'Invalid cron expression "0 0 0 * *": day-of-month 0 is out of range (1-31)'],
    ["0 0 32 * *", 'Invalid cron expression "0 0 32 * *": day-of-month 32 is out of range (1-31)'],
    ["0 0 * 0 *", 'Invalid cron expression "0 0 * 0 *": month 0 is out of range (1-12)'],
    ["0 0 * 13 *", 'Invalid cron expression "0 0 * 13 *": month 13 is out of range (1-12)'],
    ["0 0 * * 8", 'Invalid cron expression "0 0 * * 8": day-of-week 8 is out of range (0-7)'],
  ])("rejects out-of-range values in %s", (cron, message) => {
    expectInvalid(() => parseCron(cron), message);
  });

  it("rejects the wrong number of fields, including seconds fields", () => {
    const expected = "expected 5 fields (minute hour day-of-month month day-of-week)";
    expectInvalid(() => parseCron("* * * *"), `Invalid cron expression "* * * *": ${expected} but found 4`);
    expectInvalid(() => parseCron("0"), `Invalid cron expression "0": ${expected} but found 1`);
    expectInvalid(
      () => parseCron("0 0 9 * * *"),
      `Invalid cron expression "0 0 9 * * *": ${expected} but found 6; seconds and year fields are not supported`,
    );
    expectInvalid(() => parseCron("0 0 9 * * * 2026"), /but found 7; seconds and year fields are not supported$/);
  });

  it("rejects empty expressions and non-strings", () => {
    expectInvalid(() => parseCron(""), "Cron expression is empty; expected 5 fields (minute hour day-of-month month day-of-week)");
    expectInvalid(() => parseCron(" \t "), /^Cron expression is empty/);
    expectInvalid(() => parseCron(undefined as unknown as string), "Cron expression must be a string");
  });

  it("rejects empty list items, range ends, and steps", () => {
    expectInvalid(() => parseCron("0 0 1,,2 * *"), 'Invalid cron expression "0 0 1,,2 * *": day-of-month field "1,,2" has an empty list item');
    expectInvalid(() => parseCron("0 0 1, * *"), /day-of-month field "1," has an empty list item$/);
    expectInvalid(() => parseCron(",5 * * * *"), /minute field ",5" has an empty list item$/);
    expectInvalid(() => parseCron("0 9- * * *"), /hour range "9-" is missing its end$/);
    expectInvalid(() => parseCron("0 -9 * * *"), /hour range "-9" is missing its start$/);
    expectInvalid(() => parseCron("*/ * * * *"), /minute value "\*\/" is missing a step after "\/"$/);
    expectInvalid(() => parseCron("/5 * * * *"), /minute value "\/5" is missing a value before "\/"$/);
  });

  it("rejects reversed ranges with a wrap-around hint", () => {
    expectInvalid(() => parseCron("0 17-9 * * *"), 'Invalid cron expression "0 17-9 * * *": hour range "17-9" is reversed; to wrap around use "17-23,0-9"');
    expectInvalid(() => parseCron("0 0 * * FRI-SUN"), /day-of-week range "FRI-SUN" is reversed; to wrap around use "5-7"$/);
    expectInvalid(() => parseCron("0 0 * NOV-FEB *"), /month range "NOV-FEB" is reversed; to wrap around use "11-12,1-2"$/);
  });

  it("rejects zero, oversized, and malformed steps", () => {
    expectInvalid(() => parseCron("*/0 * * * *"), 'Invalid cron expression "*/0 * * * *": minute step 0 is out of range (1-60)');
    expectInvalid(() => parseCron("0 1-5/0 * * *"), /hour step 0 is out of range \(1-24\)$/);
    expectInvalid(() => parseCron("*/90 * * * *"), /minute step 90 is out of range \(1-60\)$/);
    expectInvalid(() => parseCron("0 0 * * */8"), /day-of-week step 8 is out of range \(1-7\)$/);
    expectInvalid(() => parseCron("*/x * * * *"), /minute step "x" is not a number$/);
    expectInvalid(() => parseCron("*/5/2 * * * *"), /minute value "\*\/5\/2" has more than one "\/"$/);
  });

  it("rejects malformed values", () => {
    expectInvalid(() => parseCron("x * * * *"), 'Invalid cron expression "x * * * *": minute value "x" is not valid (expected 0-59)');
    expectInvalid(() => parseCron("0 MON * * *"), /hour value "MON" is not valid \(expected 0-23\)$/);
    expectInvalid(() => parseCron("0 0 * FOO *"), /month value "FOO" is not valid \(expected 1-12 or JAN-DEC\)$/);
    expectInvalid(() => parseCron("0 0 * * MONDAY"), /day-of-week value "MONDAY" is not valid \(expected 0-7 or SUN-SAT\)$/);
    expectInvalid(() => parseCron("0 0 * * MON-XYZ"), /day-of-week value "XYZ" in "MON-XYZ" is not valid/);
    expectInvalid(() => parseCron("*-5 * * * *"), /minute value "\*" in "\*-5" is not valid/);
    expectInvalid(() => parseCron("1.5 * * * *"), /minute value "1.5" is not valid/);
    expectInvalid(() => parseCron("1-2-3 * * * *"), /minute range "1-2-3" has more than one "-"$/);
    expectInvalid(() => parseCron("0 0 ? * *"), /day-of-month value "\?" is not supported; use "\*"$/);
  });

  it("rejects @reboot, unknown macros, and macros with extra fields", () => {
    expectInvalid(
      () => parseCron("@reboot"),
      'Invalid cron expression "@reboot": @reboot is not supported; use a time-based schedule such as "@daily" or "0 9 * * 1-5"',
    );
    expectInvalid(() => parseCron("@fortnightly"), /unknown macro "@fortnightly"; use one of @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly/);
    expectInvalid(() => parseCron("@daily 5"), /@daily cannot be combined with other fields$/);
  });
});

describe("assertTimeZone", () => {
  it("returns the canonical name reported by Intl", () => {
    expect(assertTimeZone("UTC")).toBe("UTC");
    expect(assertTimeZone("utc")).toBe("UTC");
    expect(assertTimeZone("america/los_angeles")).toBe(LA);
    expect(assertTimeZone(SYDNEY)).toBe(SYDNEY);
    // Links canonicalize differently across ICU/V8 versions; whatever Intl reports is returned.
    expect(assertTimeZone("Etc/UTC")).toBe(new Intl.DateTimeFormat("en-US", { timeZone: "Etc/UTC" }).resolvedOptions().timeZone);
    expect(["Asia/Kolkata", "Asia/Calcutta"]).toContain(assertTimeZone(KOLKATA));
  });

  it("rejects unknown zones and UTC offsets", () => {
    expectInvalid(() => assertTimeZone("Mars/Olympus"), 'Unknown time zone "Mars/Olympus". Use an IANA name such as "America/Los_Angeles" or "UTC".');
    expectInvalid(() => assertTimeZone(""), 'Unknown time zone "". Use an IANA name such as "America/Los_Angeles" or "UTC".');
    expectInvalid(
      () => assertTimeZone("+05:30"),
      'Time zone "+05:30" is a UTC offset, not an IANA time zone. Use an IANA name such as "America/Los_Angeles" or "UTC".',
    );
    expectInvalid(() => assertTimeZone(undefined as unknown as string), /^Unknown time zone undefined\./);
  });

  it("validates zones and dates passed to the other functions", () => {
    const schedule = parseCron("0 9 * * *");
    const from = at("2026-01-01T00:00:00Z");
    expectInvalid(() => nextOccurrence(schedule, "Mars/Olympus", from), /^Unknown time zone "Mars\/Olympus"/);
    expectInvalid(() => occurrencesBetween(schedule, "Nowhere/Land", from, at("2026-01-02T00:00:00Z")), /^Unknown time zone "Nowhere\/Land"/);
    expectInvalid(() => minimumIntervalMinutes(schedule, "Nowhere/Land", from), /^Unknown time zone "Nowhere\/Land"/);
    expectInvalid(() => wallClock(from, "Nowhere/Land"), /^Unknown time zone "Nowhere\/Land"/);
    expectInvalid(() => nextOccurrence(schedule, "UTC", new Date("not a date")), "after must be a valid date");
    expectInvalid(() => wallClock(new Date(Number.NaN), "UTC"), "instant must be a valid date");
  });
});

describe("wallClock", () => {
  it("returns local components with the local weekday", () => {
    expect(wallClock(at("2026-06-15T12:34:56.789Z"), "UTC")).toEqual({ year: 2026, month: 6, day: 15, hour: 12, minute: 34, weekday: 1 });
    expect(wallClock(at("2026-01-01T07:59:00Z"), LA)).toEqual({ year: 2025, month: 12, day: 31, hour: 23, minute: 59, weekday: 3 });
    expect(wallClock(at("2026-01-01T00:00:00Z"), KOLKATA)).toEqual({ year: 2026, month: 1, day: 1, hour: 5, minute: 30, weekday: 4 });
    expect(wallClock(at("2026-12-31T23:59:59.999Z"), SYDNEY)).toEqual({ year: 2027, month: 1, day: 1, hour: 10, minute: 59, weekday: 5 });
  });

  it("reports midnight as hour 0", () => {
    expect(wallClock(at("2026-03-08T08:00:00Z"), LA)).toEqual({ year: 2026, month: 3, day: 8, hour: 0, minute: 0, weekday: 0 });
    expect(wallClock(at("2026-06-01T00:00:00Z"), "UTC")).toMatchObject({ hour: 0, minute: 0 });
  });

  it("maps both instants of a repeated hour to the same wall time and skips the spring-forward gap", () => {
    const repeated = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 0 };
    expect(wallClock(at("2026-11-01T08:30:00Z"), LA)).toEqual(repeated);
    expect(wallClock(at("2026-11-01T09:30:00Z"), LA)).toEqual(repeated);
    expect(wallClock(at("2026-03-08T09:59:00Z"), LA)).toMatchObject({ hour: 1, minute: 59 });
    expect(wallClock(at("2026-03-08T10:00:00Z"), LA)).toMatchObject({ hour: 3, minute: 0 });
  });
});

describe("nextOccurrence", () => {
  it("returns the first whole-minute occurrence strictly after the given instant", () => {
    expect(next("*/15 * * * *", "UTC", "2026-01-01T00:07:30Z")).toBe("2026-01-01T00:15:00.000Z");
    expect(next("*/15 * * * *", "UTC", "2026-01-01T00:14:59.999Z")).toBe("2026-01-01T00:15:00.000Z");
    expect(next("*/15 * * * *", "UTC", "2026-01-01T00:15:00Z")).toBe("2026-01-01T00:30:00.000Z");
    expect(next("0 9 * * *", "UTC", "2026-01-01T09:00:00.001Z")).toBe("2026-01-02T09:00:00.000Z");
    expect(next("59 23 31 12 *", "UTC", "2026-01-01T00:00:00Z")).toBe("2026-12-31T23:59:00.000Z");
    expect(nextOccurrence(parseCron("@hourly"), "UTC", at("2026-01-01T00:00:00Z"))).toBeInstanceOf(Date);
  });

  it("supports UTC aliases", () => {
    expect(next("30 6 * * *", "Etc/UTC", "2026-05-05T07:00:00Z")).toBe("2026-05-06T06:30:00.000Z");
    expect(next("30 6 * * *", "utc", "2026-05-05T07:00:00Z")).toBe("2026-05-06T06:30:00.000Z");
  });

  it("finds leap days within the eight-year horizon", () => {
    expect(next("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 29 2 *", "UTC", "2028-02-29T00:00:00Z")).toBe("2032-02-29T00:00:00.000Z");
    // 2100 is not a leap year, so the leap day after 2096 is eight years away.
    expect(next("0 0 29 2 *", "UTC", "2096-03-01T00:00:00Z")).toBe("2104-02-29T00:00:00.000Z");
  });

  it("returns undefined for schedules that never fire", () => {
    expect(next("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeUndefined();
    expect(next("0 0 31 4,6,9,11 *", LA, "2026-01-01T00:00:00Z")).toBeUndefined();
  });

  it("skips months without the requested day", () => {
    expect(next("0 0 31 * *", "UTC", "2026-01-31T00:00:00Z")).toBe("2026-03-31T00:00:00.000Z");
    expect(between("0 0 31 * *", "UTC", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual(
      ["01", "03", "05", "07", "08", "10", "12"].map((month) => `2026-${month}-31T00:00:00.000Z`),
    );
  });
});

describe("day matching", () => {
  it("fires when either day field matches if both are restricted", () => {
    // April 2026: Fridays are the 3rd, 10th, 17th, and 24th; the 13th is a Monday.
    expect(between("0 9 13 * 5", "UTC", "2026-04-01T00:00:00Z", "2026-04-30T23:59:00Z")).toEqual(
      ["03", "10", "13", "17", "24"].map((day) => `2026-04-${day}T09:00:00.000Z`),
    );
  });

  it("requires both day fields when one starts with *", () => {
    // Days 1, 11, 21, 31 that are also Fridays between April and June 2026: only May 1.
    expect(between("0 9 */10 * 5", "UTC", "2026-04-01T00:00:00Z", "2026-07-01T00:00:00Z")).toEqual(["2026-05-01T09:00:00.000Z"]);
    expect(between("0 9 * * MON", "UTC", "2026-04-01T00:00:00Z", "2026-04-30T23:59:00Z")).toEqual(
      ["06", "13", "20", "27"].map((day) => `2026-04-${day}T09:00:00.000Z`),
    );
    expect(between("0 9 1 * *", "UTC", "2026-04-01T00:00:00Z", "2026-07-01T00:00:00Z")).toEqual(
      ["04", "05", "06"].map((month) => `2026-${month}-01T09:00:00.000Z`),
    );
  });
});

describe("America/Los_Angeles", () => {
  it("runs weekday schedules at 09:00 local across the PST to PDT switch", () => {
    expect(between("0 9 * * 1-5", LA, "2026-03-02T00:00:00Z", "2026-03-14T00:00:00Z")).toEqual([
      ...["02", "03", "04", "05", "06"].map((day) => `2026-03-${day}T17:00:00.000Z`),
      ...["09", "10", "11", "12", "13"].map((day) => `2026-03-${day}T16:00:00.000Z`),
    ]);
  });

  it("runs weekday schedules at 09:00 local across the PDT to PST switch", () => {
    expect(between("0 9 * * MON-FRI", LA, "2026-10-26T00:00:00Z", "2026-11-07T00:00:00Z")).toEqual([
      ...["26", "27", "28", "29", "30"].map((day) => `2026-10-${day}T16:00:00.000Z`),
      ...["02", "03", "04", "05", "06"].map((day) => `2026-11-${day}T17:00:00.000Z`),
    ]);
  });

  describe("spring forward (2026-03-08 02:00 PST -> 03:00 PDT)", () => {
    it("skips a daily slot that falls in the gap", () => {
      expect(next("30 2 * * *", LA, "2026-03-07T10:30:00Z")).toBe("2026-03-09T09:30:00.000Z");
      expect(between("30 2 * * *", LA, "2026-03-06T00:00:00Z", "2026-03-10T00:00:00Z")).toEqual([
        "2026-03-06T10:30:00.000Z",
        "2026-03-07T10:30:00.000Z",
        "2026-03-09T09:30:00.000Z",
      ]);
    });

    it("does not shift skipped slots past the gap", () => {
      expect(next("30 2 * * *", LA, "2026-03-08T09:59:00Z")).toBe("2026-03-09T09:30:00.000Z");
      expect(next("30 1 * * *", LA, "2026-03-08T09:00:00Z")).toBe("2026-03-08T09:30:00.000Z");
      expect(next("0 3 * * *", LA, "2026-03-08T09:59:00Z")).toBe("2026-03-08T10:00:00.000Z");
    });

    it("jumps hourly schedules from 01:00 PST to 03:00 PDT", () => {
      const occurrences = between("0 * * * *", LA, "2026-03-08T07:30:00Z", "2026-03-08T11:30:00Z");
      expect(occurrences).toEqual(["2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z", "2026-03-08T10:00:00.000Z", "2026-03-08T11:00:00.000Z"]);
      expect(occurrences.map((iso) => wallClock(at(iso), LA).hour)).toEqual([0, 1, 3, 4]);
      expect(next("0 * * * *", LA, "2026-03-08T09:00:00Z")).toBe("2026-03-08T10:00:00.000Z");
    });
  });

  describe("fall back (2026-11-01 02:00 PDT -> 01:00 PST)", () => {
    it("runs a repeated daily slot once, at its first instant", () => {
      expect(between("30 1 * * *", LA, "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z")).toEqual([
        "2026-10-31T08:30:00.000Z",
        "2026-11-01T08:30:00.000Z",
        "2026-11-02T09:30:00.000Z",
      ]);
      expect(next("30 1 * * *", LA, "2026-11-01T08:00:00Z")).toBe("2026-11-01T08:30:00.000Z");
      expect(next("30 1 * * *", LA, "2026-11-01T08:30:00Z")).toBe("2026-11-02T09:30:00.000Z");
    });

    it("does not rerun a slot that already ran when asked during the repeated hour", () => {
      // 09:10Z is 01:10 PST (second pass); 01:30 already ran at 08:30Z (01:30 PDT).
      expect(next("30 1 * * *", LA, "2026-11-01T09:10:00Z")).toBe("2026-11-02T09:30:00.000Z");
      // 08:45Z is 01:45 PDT, just after the first 01:30.
      expect(next("30 1 * * *", LA, "2026-11-01T08:45:00Z")).toBe("2026-11-02T09:30:00.000Z");
      // 01:00 and 01:30 both ran during the first pass.
      expect(next("0,30 1 * * *", LA, "2026-11-01T09:05:00Z")).toBe("2026-11-02T09:00:00.000Z");
      expect(next("30 * * * *", LA, "2026-11-01T09:10:00Z")).toBe("2026-11-01T10:30:00.000Z");
    });

    it("runs the repeated hour of an hourly schedule once", () => {
      const occurrences = between("0 * * * *", LA, "2026-11-01T06:30:00Z", "2026-11-01T11:30:00Z");
      expect(occurrences).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z"]);
      expect(occurrences.map((iso) => wallClock(at(iso), LA).hour)).toEqual([0, 1, 2, 3]);
      expect(next("0 * * * *", LA, "2026-11-01T08:00:00Z")).toBe("2026-11-01T10:00:00.000Z");
      expect(next("0 * * * *", LA, "2026-11-01T09:00:00Z")).toBe("2026-11-01T10:00:00.000Z");
      expect(next("0 * * * *", LA, "2026-11-01T09:30:00Z")).toBe("2026-11-01T10:00:00.000Z");
    });

    it("runs every-minute schedules through the repeated hour once", () => {
      const occurrences = between("* * * * *", LA, "2026-11-01T07:58:00Z", "2026-11-01T10:02:00Z");
      // 00:59 PDT, 01:00-01:59 PDT, then 02:00-02:02 PST: the second pass through 01:xx (09:00Z-09:59Z) is skipped.
      expect(occurrences).toHaveLength(1 + 60 + 3);
      expect(occurrences[0]).toBe("2026-11-01T07:59:00.000Z");
      expect(occurrences[60]).toBe("2026-11-01T08:59:00.000Z");
      expect(occurrences[61]).toBe("2026-11-01T10:00:00.000Z");
      expect(occurrences.at(-1)).toBe("2026-11-01T10:02:00.000Z");
    });
  });
});

describe("Asia/Kolkata (UTC+05:30, no DST)", () => {
  it("resolves half-hour offsets", () => {
    expect(next("0 9 * * *", KOLKATA, "2026-06-01T00:00:00Z")).toBe("2026-06-01T03:30:00.000Z");
    expect(next("0 0 * * *", KOLKATA, "2026-06-01T00:00:00Z")).toBe("2026-06-01T18:30:00.000Z");
    expect(between("0 * * * *", KOLKATA, "2026-06-01T00:00:00Z", "2026-06-01T03:00:00Z")).toEqual([
      "2026-06-01T00:30:00.000Z",
      "2026-06-01T01:30:00.000Z",
      "2026-06-01T02:30:00.000Z",
    ]);
  });

  it("matches local days rather than UTC days", () => {
    // 2026-06-01T00:00Z is Monday 05:30 IST, so the next Monday 00:15 IST is 2026-06-07T18:45Z (a Sunday in UTC).
    expect(next("15 0 * * MON", KOLKATA, "2026-06-01T00:00:00Z")).toBe("2026-06-07T18:45:00.000Z");
  });
});

describe("Australia/Sydney (southern hemisphere)", () => {
  it("runs the repeated slot once when DST ends (2026-04-05 03:00 AEDT -> 02:00 AEST)", () => {
    expect(between("30 2 * * *", SYDNEY, "2026-04-03T00:00:00Z", "2026-04-06T00:00:00Z")).toEqual([
      "2026-04-03T15:30:00.000Z",
      "2026-04-04T15:30:00.000Z",
      "2026-04-05T16:30:00.000Z",
    ]);
    // 16:10Z is 02:10 AEST (second pass); 02:30 already ran at 15:30Z (02:30 AEDT).
    expect(next("30 2 * * *", SYDNEY, "2026-04-04T16:10:00Z")).toBe("2026-04-05T16:30:00.000Z");
    expect(next("0 9 * * *", SYDNEY, "2026-04-04T00:00:00Z")).toBe("2026-04-04T23:00:00.000Z");
  });

  it("skips the missing slot when DST starts (2026-10-04 02:00 AEST -> 03:00 AEDT)", () => {
    expect(between("30 2 * * *", SYDNEY, "2026-10-02T00:00:00Z", "2026-10-05T00:00:00Z")).toEqual([
      "2026-10-02T16:30:00.000Z",
      "2026-10-04T15:30:00.000Z",
    ]);
    const hourly = between("0 * * * *", SYDNEY, "2026-10-03T13:30:00Z", "2026-10-03T17:30:00Z");
    expect(hourly).toEqual(["2026-10-03T14:00:00.000Z", "2026-10-03T15:00:00.000Z", "2026-10-03T16:00:00.000Z", "2026-10-03T17:00:00.000Z"]);
    expect(hourly.map((iso) => wallClock(at(iso), SYDNEY).hour)).toEqual([0, 1, 3, 4]);
  });
});

describe("occurrencesBetween", () => {
  it("excludes the start, includes the end, and returns ascending instants", () => {
    expect(between("0 * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z")).toEqual([
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z",
    ]);
  });

  it("returns nothing for empty or inverted windows", () => {
    expect(between("* * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toEqual([]);
    expect(between("* * * * *", "UTC", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toEqual([]);
    expect(between("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual([]);
  });

  it("caps results at the limit, 1000 by default", () => {
    const all = occurrencesBetween(parseCron("* * * * *"), "UTC", at("2026-01-01T00:00:00Z"), at("2026-01-02T00:00:00Z"));
    expect(all).toHaveLength(1000);
    expect(all[0]?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(all[999]?.toISOString()).toBe("2026-01-01T16:40:00.000Z");
    expect(all.every((date, index) => index === 0 || date.getTime() - (all[index - 1]?.getTime() ?? 0) === 60_000)).toBe(true);
    expect(between("*/5 * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 3)).toEqual([
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:15:00.000Z",
    ]);
    expect(between("*/5 * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 0)).toEqual([]);
  });

  it("covers windows longer than the search horizon", () => {
    expect(between("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z", "2045-01-01T00:00:00Z")).toEqual(
      [2028, 2032, 2036, 2040, 2044].map((year) => `${year}-02-29T00:00:00.000Z`),
    );
  });

  it("returns whole-minute instants in every zone", () => {
    for (const timeZone of ["UTC", LA, KOLKATA, SYDNEY]) {
      const occurrences = occurrencesBetween(parseCron("*/7 */5 * * *"), timeZone, at("2026-03-01T00:00:13.5Z"), at("2026-04-30T00:00:00Z"));
      expect(occurrences.length).toBeGreaterThan(100);
      expect(occurrences.every((date) => date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0)).toBe(true);
      expect(occurrences.every((date, index) => index === 0 || date > (occurrences[index - 1] ?? date))).toBe(true);
    }
  });
});

describe("minimumIntervalMinutes", () => {
  const from = at("2026-03-01T00:00:00Z");

  it("measures the smallest gap between upcoming occurrences", () => {
    expect(minimumIntervalMinutes(parseCron("*/5 * * * *"), "UTC", from)).toBe(5);
    expect(minimumIntervalMinutes(parseCron("0 9 * * 1-5"), LA, from)).toBe(1440);
    expect(minimumIntervalMinutes(parseCron("0 9,17 * * *"), "UTC", from)).toBe(480);
    expect(minimumIntervalMinutes(parseCron("@hourly"), LA, at("2026-03-08T06:00:00Z"), 10)).toBe(60);
    expect(minimumIntervalMinutes(parseCron("@hourly"), LA, at("2026-11-01T05:00:00Z"), 10)).toBe(60);
    expect(minimumIntervalMinutes(parseCron("0 0 29 2 *"), "UTC", at("2026-01-01T00:00:00Z"), 2)).toBe(1461 * 1440);
  });

  it("sees intervals compressed by a spring-forward gap when the sample covers it", () => {
    // 2026-03-08: 01:59 PST (09:59Z) is followed by 03:00 PDT (10:00Z).
    expect(minimumIntervalMinutes(parseCron("0,59 1,3 * * *"), LA, at("2026-03-07T12:00:00Z"), 10)).toBe(1);
    expect(minimumIntervalMinutes(parseCron("0,59 1,3 * * *"), LA, at("2026-03-10T12:00:00Z"), 10)).toBe(59);
  });

  it("returns Infinity with fewer than two occurrences", () => {
    expect(minimumIntervalMinutes(parseCron("0 0 30 2 *"), "UTC", from)).toBe(Number.POSITIVE_INFINITY);
    expect(minimumIntervalMinutes(parseCron("*/5 * * * *"), "UTC", from, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});
