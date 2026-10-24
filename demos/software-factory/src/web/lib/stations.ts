import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleSlash,
  CircleX,
  ClipboardList,
  Hammer,
  Hourglass,
  LoaderCircle,
  PackageCheck,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
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

export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly spin: boolean;
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

const WORK_ORDER_STATUS: Readonly<Record<WorkOrderStatus, StatusMeta>> = {
  queued: { label: "Queued", tone: "active", icon: Hourglass, spin: false },
  planning: { label: "Planning", tone: "active", icon: LoaderCircle, spin: true },
  building: { label: "Building", tone: "active", icon: LoaderCircle, spin: true },
  releasing: { label: "Releasing", tone: "active", icon: LoaderCircle, spin: true },
  completed: { label: "Completed", tone: "success", icon: CircleCheck, spin: false },
  failed: { label: "Failed", tone: "danger", icon: CircleX, spin: false },
  cancelled: { label: "Cancelled", tone: "neutral", icon: CircleSlash, spin: false },
};

export function workOrderStatusMeta(status: WorkOrderStatus): StatusMeta {
  return WORK_ORDER_STATUS[status] ?? { label: status, tone: "neutral", icon: CircleDashed, spin: false };
}

export function stationStatusMeta(station: Pick<Station, "status" | "kind" | "placement" | "acceptedWithFindings">): StatusMeta {
  switch (station.status) {
    case "waiting":
      return { label: "Waiting", tone: "neutral", icon: CircleDashed, spin: false };
    case "starting":
      return {
        label: station.placement === "sandbox" ? "Starting sandbox" : "Starting",
        tone: "active",
        icon: LoaderCircle,
        spin: true,
      };
    case "working":
      return { label: "Working", tone: "active", icon: LoaderCircle, spin: true };
    case "collecting":
      return { label: "Collecting results", tone: "active", icon: LoaderCircle, spin: true };
    case "changes_requested":
      return { label: "Changes requested", tone: "warning", icon: RotateCcw, spin: false };
    case "done":
      if (station.kind === "review") {
        return station.acceptedWithFindings
          ? { label: "Accepted with findings", tone: "warning", icon: CircleCheck, spin: false }
          : { label: "Approved", tone: "success", icon: CircleCheck, spin: false };
      }
      if (station.kind === "release") return { label: "Released", tone: "success", icon: CircleCheck, spin: false };
      return { label: "Done", tone: "success", icon: CircleCheck, spin: false };
    case "failed":
      return { label: "Failed", tone: "danger", icon: CircleX, spin: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", icon: CircleSlash, spin: false };
    case "skipped":
      return { label: "Skipped", tone: "neutral", icon: CircleMinus, spin: false };
    default:
      return { label: String(station.status), tone: "neutral", icon: CircleDashed, spin: false };
  }
}

export const KIND_ICONS: Readonly<Record<StationKind, LucideIcon>> = {
  plan: ClipboardList,
  build: Hammer,
  review: ScanSearch,
  release: PackageCheck,
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
