/** Date and time formatting in the person's configured time zone. */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(undefined, { timeZone, ...options });
    cache.set(key, value);
  }
  return value;
}

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of the local calendar day (Latin digits whatever the locale, so keys can be compared and shifted). */
export function dayKey(iso: string | Date, timeZone: string): string {
  let keyFormatter = keyFormatters.get(timeZone);
  if (!keyFormatter) {
    keyFormatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    keyFormatters.set(timeZone, keyFormatter);
  }
  const parts = keyFormatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A day key shifted by whole calendar days (no clock arithmetic, so DST days of 23 or 25 hours don't matter). */
function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function timeOf(iso: string | Date, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function dayLabel(iso: string | Date, timeZone: string, now = new Date()): string {
  const key = dayKey(iso, timeZone);
  const today = dayKey(now, timeZone);
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  if (key === shiftDay(today, 1)) return "Tomorrow";
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return formatter(timeZone, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(iso));
}

/** "Today 4:00 PM", "Tomorrow 9:30 AM", "Mon, Oct 26 9:30 AM". */
export function whenLabel(iso: string | Date, timeZone: string): string {
  return `${dayLabel(iso, timeZone)} ${timeOf(iso, timeZone)}`;
}

export function fullDate(iso: string | Date, timeZone: string): string {
  return formatter(timeZone, { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
}

export function timeRange(start: string, end: string, timeZone: string): string {
  return `${timeOf(start, timeZone)} – ${timeOf(end, timeZone)}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 1) return diff >= 0 ? "in a moment" : "just now";
  if (minutes < 60) return rtf.format(Math.sign(diff) * minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(Math.sign(diff) * hours, "hour");
  return rtf.format(Math.sign(diff) * Math.round(hours / 24), "day");
}

export function greeting(timeZone: string): string {
  const hour = Number(formatter(timeZone, { hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function firstName(name: string | undefined, login: string | undefined): string {
  return name?.trim().split(/\s+/)[0] || login || "there";
}
