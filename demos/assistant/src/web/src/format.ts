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

export function dayKey(iso: string | Date, timeZone: string): string {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function timeOf(iso: string | Date, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function dayLabel(iso: string | Date, timeZone: string, now = new Date()): string {
  const key = dayKey(iso, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return "Yesterday";
  if (key === dayKey(new Date(now.getTime() + 86_400_000), timeZone)) return "Tomorrow";
  const sameYear = key.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
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
