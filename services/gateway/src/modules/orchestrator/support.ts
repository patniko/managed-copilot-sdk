// Orchestrator workers: limits, shared types, and pure helpers for the coordinator tools.
import type { Readable } from "node:stream";
import {
  ManagedCopilotError,
  type EnvironmentConfig,
  type ExecutionStyle,
  type FileEntry,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Logger } from "../../log.js";
import type { WorkerRecord, WorkerStore } from "./store.js";

/** Recorded as the worker sessions' client name. */
export const WORKER_CLIENT_NAME = "managed-copilot-orchestrator";

/** Recorded as the hands sandboxes' client name. */
export const HANDS_CLIENT_NAME = "managed-copilot-orchestrator-hands";

/** A hands sandbox, ready for commands and files. */
export interface HandsSandbox {
  readonly record: WorkerRecord;
  /** The sandbox to pin calls to (`sandboxId` of file and exec calls). */
  readonly sandboxId: string;
}

/** What `copy_worker_files` and `read_worker_file` call the calling agent's own sandbox in mixed mode. */
export const SELF_REF = "self";

/** Remembered tool calls of sub-agents (attribution check). */
export const REMEMBERED_CALLS = 5_000;

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const TASK_LIMIT = 32_000;

export const RESULT_LIMIT = 16_000;

export const REPORT_LIMIT = 8_000;

export const REPORTS_BUDGET = 48_000;

export const READ_BYTES = 256 * 1024;

export const READ_CHARS = 64_000;

export const COPY_FILES = 500;

export const COPY_BYTES = 64 * 1024 * 1024;

export const COPY_PATHS = 50;

export const EVENT_ERROR_LIMIT = 500;

/** How long `wait_for_workers` waits for finished workers' outputs to be published before it reports. */
export const PUBLICATION_WAIT_MS = 30_000;

/** The first retry of a cleanup that failed; later ones back off up to `CLEANUP_RETRY_MAX_MS`. */
export const CLEANUP_RETRY_MS = 60_000;

export const CLEANUP_RETRY_MAX_MS = 30 * 60_000;

/** Attempts at approving one prompt before it is left to a person. */
export const APPROVAL_ATTEMPTS = 3;

export const REMEMBERED_PROMPTS = 1_000;

/** How long after a worker's runtime connection closes its state is checked: core's queued events land first. */
export const STOPPED_SETTLE_MS = 1_000;

export interface RunState {
  /** The run's latest root reply with content. */
  latest?: string;
  /** A root error this run reported, unless it went on after it: the run fails when it ends. */
  error?: string;
}

/** How deleting a stopped worker's session went. */
export type CleanupOutcome = { readonly state: "deleted" } | { readonly state: "deleting" } | { readonly state: "failed"; readonly reason: string };

/** What a tool call a shutdown interrupted resolves to: nothing, so the ledger runs it again after the restart. */
export function unanswered<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export interface Waiter {
  readonly coordinatorId: string;
  /** Re-checks the workers waited for; resolves the wait once none is busy. */
  readonly check: () => void;
  /** Resolves the wait now: the coordinator's turn is over, or a message for it is waiting (`end`). */
  readonly finish: (end?: WaitEnd) => void;
  /** Drops the wait without answering it (shutdown: the ledger runs it again after the restart). */
  readonly abandon: () => void;
}

/**
 * Why a wait ended. A user message for the coordinator ends it early: a steering message reaches the model right after
 * the wait's result (in the same turn), a queued one only once the turn ends.
 */
export type WaitEnd = { readonly reason: "settled" | "timeout" | "ended" } | { readonly reason: "message"; readonly delivery: "steering" | "queued" };

/** `session.queue.pendingItems` (stock runtime 1.0.103, experimental): what is waiting for the coordinator. */
export interface QueueSnapshot {
  readonly items?: readonly { readonly id?: string; readonly kind?: string }[];
  readonly steeringMessages?: readonly string[];
  readonly inFlightSteeringCount?: number;
}

interface ActionChange {
  readonly type: string;
  readonly sessionId: string;
  readonly actionId: string;
}

export type ChangeFeed = { onChange?(listener: (change: ActionChange) => void): () => void };

export interface WorkerManagerOptions {
  readonly app: GatewayApp;
  readonly log: Logger;
  readonly store: WorkerStore;
}

// -----------------------------------------------------------------------------------------------------------------
// Helpers

export function executionOf(config: EnvironmentConfig): ExecutionStyle {
  return config.execution ?? "delegate";
}

/** Refuses a hands sandbox where only an agent makes sense (messages, waits, stops). */
export function agentWorker(worker: WorkerRecord): WorkerRecord {
  if (worker.role === "hands") {
    throw new ManagedCopilotError(
      "invalid_request",
      `"${worker.name}" is your own sandbox, not a worker: no agent runs in it. Use your shell and file tools on it, or "${SELF_REF}" in read_worker_file and copy_worker_files.`,
    );
  }
  return worker;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManagedCopilotError("invalid_request", "Expected a string");
  return value.trim() || undefined;
}

export function requiredText(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ManagedCopilotError("invalid_request", `${field} is required`);
  if (value.length > limit) throw new ManagedCopilotError("invalid_request", `${field} is too long (at most ${limit} characters)`);
  return value;
}

export function workerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "-") : "";
  if (!NAME.test(name)) throw new ManagedCopilotError("invalid_request", 'name must be 1 to 40 letters, digits, "-" or "_", starting with a letter or digit');
  return name;
}

/** A worker takes a message between runs: idle or failed, with a session. */
export function assertMessageable(worker: WorkerRecord): void {
  agentWorker(worker);
  if (worker.state === "stopped") throw new ManagedCopilotError("conflict", `Worker "${worker.name}" was stopped. Start a new worker instead.`);
  if (worker.state === "starting") throw new ManagedCopilotError("session_busy", `Worker "${worker.name}" is still starting. Call wait_for_workers, then message it.`);
  if (worker.state === "working") {
    throw new ManagedCopilotError(
      "session_busy",
      `Worker "${worker.name}" is still working. Call wait_for_workers for its report, then message it. To change its task now, stop it with stop_worker and start a new worker.`,
    );
  }
  if (!worker.incarnation) throw new ManagedCopilotError("conflict", `Worker "${worker.name}" never started (${worker.error ?? "its sandbox could not be prepared"}). Start a new worker instead.`);
}

/** Whether a root `user.message` starts a run: steering, autopilot continuations, and skill prompts are inside one (as core reads them). */
export function startsRun(data: Record<string, unknown>): boolean {
  return data["delivery"] !== "steering" && data["isAutopilotContinuation"] !== true && !String(data["source"] ?? "").startsWith("skill-");
}

/** A path relative to /workspace with no `..` segments ("." for the top level). */
export function workspacePath(value: string): string {
  const segments = value
    .replace(/\\/g, "/")
    .replace(/^\/?workspace(?:\/|$)/, "")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new ManagedCopilotError("invalid_request", "Paths must stay inside the worker's /workspace");
  return segments.length === 0 ? "." : segments.join("/");
}

export function describeError(error: unknown): string {
  if (error instanceof ManagedCopilotError) return error.message;
  return "the platform could not complete it";
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function statusLine(worker: WorkerRecord): string {
  return `"${worker.name}" (${worker.environment}${worker.agent ? `, agent ${worker.agent}` : ""}, ID ${worker.id}): ${worker.state}${worker.messages > 1 ? `, ${worker.messages} messages` : ""}`;
}

export function startedText(worker: WorkerRecord, created: boolean): string {
  if (!created) return `This call already started worker "${worker.name}" (ID ${worker.id}); it is ${worker.state}.`;
  return `Started worker "${worker.name}" (ID ${worker.id}) in environment "${worker.environment}"${worker.agent ? ` as agent ${worker.agent}` : ""}. Its sandbox is starting; then it works on the task. Call wait_for_workers to get its report.`;
}

export function listing(worker: WorkerRecord, path: string, entries: readonly FileEntry[]): string {
  if (entries.length === 0) return `${path === "." ? "/workspace" : path} in worker "${worker.name}" is empty.`;
  const shown = entries.slice(0, 200).map((entry) => `- ${entry.path}${entry.type === "directory" ? "/" : ` (${entry.size} bytes)`}`);
  return [`${path === "." ? "/workspace" : path} in worker "${worker.name}":`, ...shown, ...(entries.length > 200 ? [`… and ${entries.length - 200} more`] : [])].join("\n");
}

export async function readPrefix(body: Readable, limit: number): Promise<{ readonly bytes: Buffer; readonly complete: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= limit) return { bytes: Buffer.concat(chunks).subarray(0, limit), complete: size === limit && body.readableEnded };
    }
    return { bytes: Buffer.concat(chunks), complete: true };
  } finally {
    if (!body.destroyed) body.destroy();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
