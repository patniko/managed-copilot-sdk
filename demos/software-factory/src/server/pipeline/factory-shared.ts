import type { WorkerInfo } from "@managed-copilot/sdk";
import {
  isGitHubWorkOrder,
  workOrderMode,
  type ChangeRevision,
  type MediaItem,
  type NetworkView,
  type OutputManifest,
  type Plan,
  type Station,
  type StationKind,
  type StationRole,
  type TestReport,
  type TestSummary,
  type WorkOrder,
  type WorkOrderMode,
  type WorkOrderSummary,
} from "../../shared/types.js";
import type { FactoryConfig } from "../config.js";
import type { GitHubApi } from "../github.js";
import type { EventHub } from "../hub.js";
import type { FactoryPlatform, StationSession } from "../platform.js";
import type { FactoryStore } from "../store.js";
import { StationActivityMapper } from "./activity.js";
import type { ToolStart } from "./coordinator.js";
import { StationError } from "./errors.js";
import type { LoadedInputs } from "./inputs.js";
import type { ValidReview } from "./plan.js";
import { Semaphore } from "./semaphore.js";
import type { SubmittedChange } from "./repo.js";

// Types, limits, and pure helpers shared by the factory's layers (factory-state → factory-coordination →
// factory-github → factory-stages → factory).

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type MStation = Mutable<Station>;
export type MWorkOrder = Mutable<Omit<WorkOrder, "stations">> & { stations: MStation[] };
export type ReadinessKind = WorkOrderMode | "github";

/** The single change lane of a GitHub work order. */
export const CHANGE_TASK = "change";
export const CHANGE_BUILD = `build:${CHANGE_TASK}`;
export const CHANGE_REVIEW = `review:${CHANGE_TASK}`;
/** Repository archives the factory moves into a sandbox (GitHub's own limit for archives is far larger). */
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
/** Checkout and diff commands in the sandbox. */
export const SANDBOX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const MAX_PATCH_BYTES = 1024 * 1024;

/** Nudges per round when the factory check fails before the station gives up. */
export const MAX_NUDGES = 2;
/** Artifacts the factory keeps in its own store for viewing, diffing, and the release (bytes). */
export const MAX_TEXT_BYTES = 1024 * 1024;
export const TEXT_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "json", "md", "markdown", "txt", "patch", "diff", "csv", "tsv", "yml", "yaml",
  "toml", "ini", "sh", "bash", "py", "rb", "go", "rs", "java", "cs", "html", "htm", "css", "scss", "xml", "svg", "sql", "env", "gitignore", "npmignore", "editorconfig", "lock", "log",
]);

export const ROLE_FOR_KIND: Readonly<Record<StationKind, StationRole>> = { plan: "planner", coordinate: "coordinator", build: "builder", review: "reviewer", release: "release" };

export function isTextPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) return ["README", "LICENSE", "Makefile", "Dockerfile"].some((known) => name.startsWith(known));
  return TEXT_EXTENSIONS.has(name.split(".").pop()!.toLowerCase());
}

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "json") return "application/json";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "patch" || ext === "diff") return "text/x-diff";
  if (["js", "mjs", "cjs"].includes(ext)) return "text/javascript";
  return isTextPath(path) ? "text/plain" : "application/octet-stream";
}

export function now(): string {
  return new Date().toISOString();
}

/** "3 minutes", "30 seconds": for activity notes. */
export function spokenDuration(ms: number): string {
  const [amount, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.max(1, Math.round(ms / 1000)), "second"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

export function networkView(policy: { access: NetworkView["access"]; allowedDomains: readonly string[] } | undefined): NetworkView {
  return { access: policy?.access ?? "enabled", allowedDomains: [...(policy?.allowedDomains ?? [])] };
}

export function describeNetwork(network: NetworkView): string {
  if (network.access === "disabled") return "network off";
  if (network.access === "enabled") return "open network";
  return `network limited to ${network.allowedDomains.join(", ")}`;
}

export function summaryOf(report: TestReport, at = now()): TestSummary {
  return { ...report.summary, durationMs: report.durationMs, at };
}

export function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** What a work order needs from the platform: GitHub work orders need `factory-repo` and sandbox commands. */
export function readinessKind(wo: WorkOrder): ReadinessKind {
  return isGitHubWorkOrder(wo) ? "github" : workOrderMode(wo);
}

/** Key of an uploaded media file in `GitHubWork.uploads`. */
export function mediaKey(item: Pick<MediaItem, "stationId" | "path" | "version">): string {
  return `${item.stationId}:${item.path}@${item.version}`;
}

/** "3 files changed · tests pass · 2 media" for the change station. */
export function describeChange(revision: ChangeRevision): string {
  const files = revision.files?.length ?? 0;
  if (files === 0) return revision.answer ? "Answered · no changes" : "No changes";
  const parts = [`${files} file${files === 1 ? "" : "s"} changed`];
  if (revision.check) parts.push(revision.check.passed ? "tests pass" : "tests failing");
  const media = revision.media?.length ?? 0;
  if (media > 0) parts.push(`${media} media`);
  return parts.join(" · ");
}

/**
 * A `factory-repo` sandbox whose session-time npm install failed: most often a registry that hands out downloads from
 * other hosts than its own, which the environment's network rules don't list yet.
 */
export function explainSetupFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/npm install -g .* failed/i.test(message)) return error;
  return new StationError(
    "setup_failed",
    `${message.replace(/\s*\[\w+\]\s*$/, "").replace(/[.\s]+$/, "")}. If your npm registry serves package downloads from other hosts (an Azure Artifacts upstream uses *.pkgs.visualstudio.com and *.vsblob.vsassets.io), list them in FACTORY_REPO_EXTRA_HOSTS and restart the AppHost.`,
  );
}

export interface Capture {
  plan?: Plan;
  review?: ValidReview;
  /** GitHub work orders: the developer called `submit_change` in the current turn. */
  change?: SubmittedChange;
}

export interface ActiveSession {
  readonly session: StationSession;
  readonly mapper: StationActivityMapper;
  readonly capture: Capture;
}

export interface Run {
  readonly wo: MWorkOrder;
  readonly abort: AbortController;
  readonly sessions: Map<string, ActiveSession>;
  /** Set once the run has finished; late asynchronous results must not touch the work order anymore. */
  closed: boolean;
  done: Promise<void>;
  /** A station lost its platform connection (see `interrupts`); no failure was recorded for it. */
  interrupted: boolean;
  /** A station recorded a real failure, so the work order fails rather than pausing. */
  failed: boolean;
  /** The run ended paused at its checkpoint; the work order resumes when the platform is ready. */
  paused: boolean;
  readonly gates: Semaphore;
  readonly decisions: Map<string, { readonly start: ToolStart; readonly firstMessage: boolean }>;
  workerSync?: Promise<WorkerInfo[]>;
  workerRevision: number;
  workerSnapshotRevision: number;
  stopCoordinator?: (error: unknown) => void;
  /** A routed work order's files, loaded on first use. */
  inputs?: LoadedInputs;
}

export interface CheckOutcome {
  readonly passed: boolean;
  readonly code: string;
  readonly problem: string;
  readonly report?: TestReport;
  readonly manifest?: OutputManifest;
}

export interface FactoryOptions {
  readonly store: FactoryStore;
  readonly hub: EventHub;
  readonly platform: FactoryPlatform;
  /** Whether the platform can run work orders right now, with a user-facing reason when it can't. */
  readonly readiness: (mode?: ReadinessKind) => { readonly ready: boolean; readonly reason?: string };
  readonly account: () => { readonly login: string; readonly avatarUrl?: string } | undefined;
  readonly config: Pick<FactoryConfig, "maxSandboxes" | "turnTimeoutMs" | "publicationTimeoutMs"> & Partial<Pick<FactoryConfig, "checkTimeoutMs">>;
  /** GitHub work orders: the factory's own GitHub access (repositories, archives, branches, pull requests). */
  readonly github?: GitHubApi;
  readonly skillsRoot?: string;
  /** Poll interval while waiting for a resumed turn (tests shorten it). */
  readonly pollMs?: number;
  /**
   * Confirms the platform answers before a paused work order resumes on its own; resolves false (and starts
   * reconnecting) when it doesn't. Without it, readiness alone decides.
   */
  readonly checkPlatform?: () => Promise<boolean>;
  /** First delay before a paused work order resumes on its own; doubles per pause (tests shorten it). */
  readonly resumeBackoffMs?: number;
  /** How long a resumed in-flight turn may show no activity at all before it is stopped and continued (tests shorten it). */
  readonly stallMs?: number;
  /** How long a resumed turn whose sandbox restarted under it may stay silent before the agent is asked to continue. */
  readonly restartGraceMs?: number;
}

/** Pauses a work order may take for lost platform connections before the next one fails it instead. */
export const MAX_AUTO_RESUMES = 5;
/** Detaching a session whose transport dropped can go unanswered; the run moves on after this long. */
export const DETACH_TIMEOUT_MS = 5_000;
/** A resumed in-flight turn with no session events for this long is stuck (for example on a connection that died with a gateway). */
export const STALL_MS = 3 * 60_000;
/** Silence allowed after reattaching before a turn whose sandbox restarted under it is taken as gone. */
export const RESTART_GRACE_MS = 30_000;
/** Clock skew allowed between the factory (turn sent) and the gateway (sandbox started). */
export const RESTART_MARGIN_MS = 5_000;
/** Stopping a stuck turn can go unanswered too. */
export const ABORT_TIMEOUT_MS = 10_000;
/** Failed reads of an in-flight turn's status in a row (with the platform otherwise up) before the work order pauses. */
export const MAX_READ_FAILURES = 5;


export function toSummary(wo: WorkOrder): WorkOrderSummary {
  return {
    id: wo.id,
    number: wo.number,
    title: wo.title,
    mode: workOrderMode(wo),
    status: wo.status,
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    ...(wo.startedAt ? { startedAt: wo.startedAt } : {}),
    ...(wo.completedAt ? { completedAt: wo.completedAt } : {}),
    taskCount: wo.taskCount,
    ...(wo.tests ? { tests: wo.tests } : {}),
    ...(wo.error ? { error: wo.error } : {}),
    ...(wo.origin ? { origin: wo.origin } : {}),
    ...(wo.gates?.length ? { gates: wo.gates.map(({ id, kind, target, label, state }) => ({ id, kind, target, label, state })) } : {}),
    ...(wo.github
      ? {
          github: {
            repository: wo.github.repository.fullName,
            ...(wo.github.issue ? { issue: wo.github.issue.number } : {}),
            ...(wo.github.pullRequest ? { pullRequest: wo.github.pullRequest.number, pullRequestState: wo.github.pullRequest.state } : {}),
          },
        }
      : {}),
  };
}
