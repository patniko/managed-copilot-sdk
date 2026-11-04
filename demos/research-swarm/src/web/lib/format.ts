import type { ResearcherState, Run, RunStatus } from "../../shared/types.js";

/** "0:42", "3:07", "1:02:15". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "just now", "5 min ago", "3 h ago", "Nov 3". */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** How long a run took, or has taken so far. */
export function runTime(run: Run, now: number): string {
  return duration((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.createdAt));
}

export const RUN_STATUS: Readonly<Record<RunStatus, string>> = {
  planning: "Planning",
  researching: "Researching",
  writing: "Writing",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const RESEARCHER_STATE: Readonly<Record<ResearcherState, string>> = {
  queued: "Queued",
  starting: "Starting",
  reading: "Reading",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const isActive = (status: RunStatus): boolean => status === "planning" || status === "researching" || status === "writing";

/** Pages every researcher read, once each. */
export function pagesRead(run: Run): number {
  return new Set(run.researchers.flatMap((researcher) => researcher.pages.map((page) => page.url))).size;
}
