import {
  CheckCircleFillIcon,
  ClockIcon,
  CodeReviewIcon,
  DotFillIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  PackageIcon,
  SkipIcon,
  StopIcon,
  TasklistIcon,
  ToolsIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import { ACTIVE_WORK_ORDER_STATUSES } from "../../shared/types.js";
import type {
  PlanTask,
  ReviewRecord,
  Station,
  StationKind,
  StationRole,
  StationStatus,
  WorkOrder,
  WorkOrderStatus,
} from "../../shared/types.js";
import { parseTime } from "./format.js";
import type { Tone } from "./tone.js";

/** A status shown the GitHub way: an Octicon (or the Primer spinner when `spin`), its color, and a label. */
export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: Icon;
  readonly spin: boolean;
}

/** Work order lifecycle as a pull request state: open while it runs, merged once released, closed when it failed. */
export type WorkOrderState = "open" | "merged" | "closed" | "draft";

export interface WorkOrderStatusMeta {
  readonly label: string;
  readonly state: WorkOrderState;
  readonly icon: Icon;
  /** Color for the state Octicon in lists. */
  readonly iconClass: string;
}

const ACTIVE_STATION_STATUSES: readonly StationStatus[] = ["starting", "working", "collecting"];

export function isStationActive(status: StationStatus): boolean {
  return ACTIVE_STATION_STATUSES.includes(status);
}

export function isWorkOrderActive(status: WorkOrderStatus): boolean {
  return ACTIVE_WORK_ORDER_STATUSES.includes(status);
}

export function isWorkOrderTerminal(status: WorkOrderStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const OPEN = { state: "open", icon: GitPullRequestIcon, iconClass: "text-fg-open" } as const;

const WORK_ORDER_STATUS: Readonly<Record<WorkOrderStatus, WorkOrderStatusMeta>> = {
  queued: { label: "Queued", state: "draft", icon: GitPullRequestDraftIcon, iconClass: "text-fg-draft" },
  planning: { label: "Planning", ...OPEN },
  building: { label: "Building", ...OPEN },
  releasing: { label: "Releasing", ...OPEN },
  completed: { label: "Completed", state: "merged", icon: GitMergeIcon, iconClass: "text-fg-done" },
  failed: { label: "Failed", state: "closed", icon: GitPullRequestClosedIcon, iconClass: "text-fg-closed" },
  cancelled: { label: "Cancelled", state: "draft", icon: SkipIcon, iconClass: "text-fg-muted" },
};

export function workOrderStatusMeta(status: WorkOrderStatus): WorkOrderStatusMeta {
  return WORK_ORDER_STATUS[status] ?? { label: status, state: "draft", icon: GitPullRequestDraftIcon, iconClass: "text-fg-muted" };
}

/** Primer `State` modifier for a work order state. */
export const STATE_CLASS: Readonly<Record<WorkOrderState, string>> = {
  open: "State--open",
  merged: "State--merged",
  closed: "State--closed",
  draft: "State--draft",
};

const RUNNING = { tone: "active", icon: DotFillIcon, spin: true } as const;

export function stationStatusMeta(station: Pick<Station, "status" | "kind" | "placement" | "acceptedWithFindings">): StatusMeta {
  switch (station.status) {
    case "waiting":
      return { label: "Waiting", tone: "neutral", icon: ClockIcon, spin: false };
    case "starting":
      return { label: station.placement === "sandbox" ? "Starting sandbox" : "Starting", ...RUNNING };
    case "working":
      return { label: "Working", ...RUNNING };
    case "collecting":
      return { label: "Collecting results", ...RUNNING };
    case "changes_requested":
      return { label: "Changes requested", tone: "warning", icon: FileDiffIcon, spin: false };
    case "done":
      if (station.kind === "review") {
        return station.acceptedWithFindings
          ? { label: "Accepted with findings", tone: "warning", icon: CheckCircleFillIcon, spin: false }
          : { label: "Approved", tone: "success", icon: CheckCircleFillIcon, spin: false };
      }
      if (station.kind === "release") return { label: "Released", tone: "success", icon: CheckCircleFillIcon, spin: false };
      return { label: "Done", tone: "success", icon: CheckCircleFillIcon, spin: false };
    case "failed":
      return { label: "Failed", tone: "danger", icon: XCircleFillIcon, spin: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", icon: StopIcon, spin: false };
    case "skipped":
      return { label: "Skipped", tone: "neutral", icon: SkipIcon, spin: false };
    default:
      return { label: String(station.status), tone: "neutral", icon: ClockIcon, spin: false };
  }
}

export const KIND_ICONS: Readonly<Record<StationKind, Icon>> = {
  plan: TasklistIcon,
  build: ToolsIcon,
  review: CodeReviewIcon,
  release: PackageIcon,
};

export const KIND_LABELS: Readonly<Record<StationKind, string>> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  release: "Release",
};

export const ROLE_LABELS: Readonly<Record<StationRole, string>> = {
  planner: "Planner",
  builder: "Builder",
  reviewer: "Reviewer",
  release: "Release",
};

export function stationTaskId(station: Station): string | undefined {
  if (station.taskId) return station.taskId;
  const separator = station.id.indexOf(":");
  return separator >= 0 ? station.id.slice(separator + 1) : undefined;
}

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly task?: PlanTask;
  readonly build?: Station;
  readonly review?: Station;
}

/** One row per plan task (plus any task stations the plan doesn't list), in plan order. */
export function taskRows(workOrder: WorkOrder): TaskRow[] {
  const stationFor = (kind: StationKind, taskId: string): Station | undefined =>
    workOrder.stations.find((station) => station.kind === kind && stationTaskId(station) === taskId);
  const rows: TaskRow[] = [];
  for (const task of workOrder.plan?.tasks ?? []) {
    rows.push({
      id: task.id,
      title: task.title,
      dependsOn: task.dependsOn,
      task,
      build: stationFor("build", task.id),
      review: stationFor("review", task.id),
    });
  }
  for (const station of workOrder.stations) {
    if (station.kind !== "build" && station.kind !== "review") continue;
    const taskId = stationTaskId(station);
    if (!taskId || rows.some((row) => row.id === taskId)) continue;
    rows.push({
      id: taskId,
      title: taskId,
      dependsOn: [],
      build: stationFor("build", taskId),
      review: stationFor("review", taskId),
    });
  }
  return rows;
}

export function taskTitle(workOrder: WorkOrder, taskId: string): string {
  return workOrder.plan?.tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

export function findStation(workOrder: WorkOrder, stationId: string | undefined): Station | undefined {
  return stationId ? workOrder.stations.find((station) => station.id === stationId) : undefined;
}

/** Stations in pipeline order: plan, then build/review per task, then release. */
export function pipelineStations(workOrder: WorkOrder): Station[] {
  const ordered: Station[] = [];
  const plan = workOrder.stations.find((station) => station.kind === "plan");
  if (plan) ordered.push(plan);
  for (const row of taskRows(workOrder)) {
    if (row.build) ordered.push(row.build);
    if (row.review) ordered.push(row.review);
  }
  for (const station of workOrder.stations) {
    if (!ordered.includes(station)) ordered.push(station);
  }
  return ordered;
}

/** The station worth looking at first: something running, then something that needs attention. */
export function defaultStationId(workOrder: WorkOrder): string {
  const stations = pipelineStations(workOrder);
  const pick =
    stations.find((station) => isStationActive(station.status)) ??
    stations.find((station) => station.status === "failed") ??
    stations.find((station) => station.kind === "release" && station.status !== "waiting" && station.status !== "skipped") ??
    stations.find((station) => station.status === "changes_requested") ??
    [...stations].reverse().find((station) => station.status !== "waiting" && station.status !== "skipped");
  return pick?.id ?? "intake";
}

/** Live (when running) or final duration of a station. */
export function stationElapsed(station: Station, now: number): number | undefined {
  const start = parseTime(station.startedAt);
  if (start === undefined) return undefined;
  const end = parseTime(station.finishedAt) ?? (isStationActive(station.status) ? now : undefined);
  return end === undefined ? undefined : Math.max(0, end - start);
}

export function latestReview(station: Station | undefined): ReviewRecord | undefined {
  const reviews = station?.reviews;
  if (!reviews || reviews.length === 0) return undefined;
  return [...reviews].sort((a, b) => a.round - b.round)[reviews.length - 1];
}

export type EdgeState = "idle" | "ready" | "active" | "done" | "warning" | "failed";

/** Connector state, driven by the downstream station. */
export function edgeState(upstreamDone: boolean, downstream: StationStatus | undefined): EdgeState {
  if (downstream === undefined) return upstreamDone ? "ready" : "idle";
  if (isStationActive(downstream)) return "active";
  switch (downstream) {
    case "done":
      return "done";
    case "changes_requested":
      return "warning";
    case "failed":
      return "failed";
    case "waiting":
      return upstreamDone ? "ready" : "idle";
    default:
      return "idle";
  }
}
