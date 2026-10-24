/** Human-readable cron cadences for the schedules panel and timeline ("Every weekday at 8:00 AM"). */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function expandDays(field: string): number[] | undefined {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part.trim());
    if (!range) return undefined;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 7 || to > 7 || to < from) return undefined;
    for (let day = from; day <= to; day++) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** Describes common 5-field cron expressions; anything else falls back to the expression itself. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `Custom schedule (${cron})`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];

  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = Number(everyMinutes[1]);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return minute === "0" ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && everyHours && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${everyHours[1]} hours`;
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return `Custom schedule (${cron})`;
  const at = clock(Number(hour), Number(minute));
  if (month !== "*") return `Custom schedule (${cron})`;
  if (dayOfMonth !== "*" && dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) return `Monthly on day ${dayOfMonth} at ${at}`;
  if (dayOfMonth !== "*") return `Custom schedule (${cron})`;
  if (dayOfWeek === "*") return `Every day at ${at}`;
  const days = expandDays(dayOfWeek);
  if (!days) return `Custom schedule (${cron})`;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return `Every weekday at ${at}`;
  if (key === "0,6") return `Every weekend day at ${at}`;
  if (days.length === 7) return `Every day at ${at}`;
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]!]} at ${at}`;
  return `Every ${days.map((d) => SHORT_DAYS[d]).join(", ")} at ${at}`;
}
