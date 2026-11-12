// Launch day, relative to the server's first start (kept in the data directory, so restarts keep the same story):
// Downhill launched three hours before it, and the shop's launch-week banner went live 45 minutes before it. Launch day
// lasts a day: after that it starts over, so the story stays "launched three hours ago" and the sales stay a day's worth.
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./files.js";

export const MINUTE = 60_000;
export const LAUNCH_BEFORE_START = 3 * 60 * MINUTE;
export const BANNER_BEFORE_START = 45 * MINUTE;
export const LAUNCH_DAY = 24 * 60 * MINUTE;

export interface Timeline {
  /** The server's first start. */
  readonly startedAt: number;
  /** Downhill 1.0.0 launched, with checkout on the storefront as it shipped. */
  readonly launchAt: number;
  /** Downhill shop 1.1.0 put the launch-week banner live. */
  readonly bannerAt: number;
}

export function timelineFrom(startedAt: number): Timeline {
  return { startedAt, launchAt: startedAt - LAUNCH_BEFORE_START, bannerAt: startedAt - BANNER_BEFORE_START };
}

const FILE = "timeline.json";

/** The persisted timeline, or a new one starting now (saved). */
export function loadTimeline(dataDir: string, now: number): Timeline {
  const saved = readJsonFile<{ startedAt?: unknown }>(join(dataDir, FILE));
  const startedAt = typeof saved?.startedAt === "string" ? Date.parse(saved.startedAt) : Number.NaN;
  if (Number.isFinite(startedAt)) return timelineFrom(startedAt);
  return restartTimeline(dataDir, now);
}

/** Starts launch day over: launch three hours before `now`. */
export function restartTimeline(dataDir: string, now: number): Timeline {
  writeJsonFile(join(dataDir, FILE), { startedAt: new Date(now).toISOString() });
  return timelineFrom(now);
}
