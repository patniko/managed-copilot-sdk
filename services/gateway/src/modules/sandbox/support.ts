// The `sandboxes` service: timings, limits, options, and pure helpers.
import { promises as fs, type Stats } from "node:fs";
import { join } from "node:path";
import {
  ManagedCopilotError,
  type ErrorCode,
  type OperatorSandbox,
  type SandboxSetupRecord,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Logger } from "../../log.js";
import { OUTPUT_TAIL_MARKER, redactText } from "../../redaction.js";
import type { SandboxRuntime } from "./contract.js";
import type { SandboxProvider } from "./providers/types.js";
import type { SandboxStore } from "./store.js";

export const ACTION_REQUESTED = new Set(["external_tool.requested", "permission.requested", "elicitation.requested"]);

export const ACTION_COMPLETED = new Set(["external_tool.completed", "permission.completed", "elicitation.completed"]);

export const IDLE_SWEEP_MS = Number(process.env.MANAGED_COPILOT_SANDBOX_IDLE_SWEEP_MS ?? 30_000) || 30_000;

export const RECONCILE_MS = 5 * 60_000;

/** How often other instances' abandoned resources are swept (`MANAGED_COPILOT_ABANDONED_SWEEP_HOURS`, 0 disables). */
const ABANDONED_SWEEP_HOURS = Number(process.env.MANAGED_COPILOT_ABANDONED_SWEEP_HOURS ?? 6);

export const ABANDONED_SWEEP_MS = Number.isFinite(ABANDONED_SWEEP_HOURS) && ABANDONED_SWEEP_HOURS > 0 ? Math.min(ABANDONED_SWEEP_HOURS * 3_600_000, 2 ** 31 - 1) : 0;

/** How long a failed publication waits for sandbox operations already queued for its session before classifying. */
export const SETTLE_MS = 5_000;

/** How long gateway shutdown lets publications under way finish before it stops sandboxes. */
export const SHUTDOWN_DRAIN_MS = 10_000;

/** How often the backend's readiness is re-checked for `available`. */
export const PROBE_MS = 30_000;

/** How long a sandbox found running at startup stays protected while the ledger says its last turn was running. */
export const RECOVERY_GRACE_MS = 2 * 60 * 60_000;

/** Why a turn's outputs were not published when the runtime process running the turn was replaced. */
export const TURN_INTERRUPTED =
  "The sandbox runtime was restarted while this turn was running, so the turn ended and its outputs were not published. Send the prompt again to continue.";

export interface LiveState {
  readonly runtimes: Set<SandboxRuntime>;
  readonly pending: Set<string>;
  busy: number;
  turnRunning: boolean;
  turnFailed: boolean;
  lastActivity: number;
  /** Set when reconciliation found the sandbox running after a gateway restart; cleared once its events flow again. */
  recoveredAt?: number;
  /** The runtime process (sandboxd's `runtime.instance`) the session's runtime connections last reached. */
  runtimeInstance?: string;
}

export interface SandboxServiceOptions {
  readonly app: GatewayApp;
  readonly store: SandboxStore;
  readonly provider: SandboxProvider;
  readonly log: Logger;
  readonly defaultIdleSeconds: number;
  /** Build the base image and reconcile on start even before any sandbox exists. */
  readonly prepareOnStart: boolean;
}

export function optional<T>(app: GatewayApp, key: string): T | undefined {
  return (app.services as Record<string, unknown>)[key] as T | undefined;
}

export function toManaged(error: unknown, fallback: ErrorCode = "internal"): ManagedCopilotError {
  if (error instanceof ManagedCopilotError) return error;
  return new ManagedCopilotError(fallback, (error as Error)?.message ?? String(error));
}

/** Appends the last lines of a failed step's (already redacted) output; clients may see only the error message. */
export function withOutputTail(message: string, output: string | undefined): string {
  const lines = (output ?? "").trim().split("\n").slice(-8).join("\n").slice(-800).trim();
  // The marker lets operator views leave the output out: it is the session owner's to see.
  return lines ? `${message}${OUTPUT_TAIL_MARKER}${lines}` : message;
}

/** How long a sandbox must have been quiet before an operator may stop it. */
export const OPERATOR_STOP_QUIET_MS = 5_000;

/** A setup record as operators see it: what ran and how it ended, never what it printed. */
export function operatorSetup(setup: SandboxSetupRecord): SandboxSetupRecord {
  return {
    ...setup,
    steps: setup.steps.map(({ output: _output, ...step }) => ({ ...step, name: redactText(step.name) })),
    ...(setup.error ? { error: redactText(setup.error) } : {}),
  };
}

export const SETUP_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f\\]+$/;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Exact decoded size of strict base64, or undefined when the text is not strict base64. */
export function base64Size(value: string): number | undefined {
  const compact = value.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

const IMPORT_LIMITS = { files: 10_000, bytes: 1024 * 1024 * 1024 } as const;

/** A sandbox as the operator console shows it, with its owner's account ID (the operator module adds the account). */
export type SandboxOperatorRecord = Omit<OperatorSandbox, "owner"> & { readonly ownerId: number };

/** Regular files of a runtime-state export (relative POSIX paths), skipping lock files; anything else is refused. */
export async function collectRuntimeState(directory: string): Promise<{ relative: string; absolute: string; size: number }[]> {
  let root: Stats;
  try {
    root = await fs.lstat(directory);
  } catch {
    throw new ManagedCopilotError("invalid_request", `The runtime state directory ${directory} does not exist.`);
  }
  if (!root.isDirectory()) throw new ManagedCopilotError("invalid_request", `The runtime state path ${directory} is not a directory.`);
  const files: { relative: string; absolute: string; size: number }[] = [];
  let total = 0;
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      // Lock files are never imported, whatever they are.
      if (entry.name.endsWith(".lock")) continue;
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(childAbsolute);
      if (stat.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (!stat.isFile()) throw new ManagedCopilotError("invalid_request", `"${childRelative}" in the runtime state is a symbolic link or special file; only regular files can be imported.`);
      total += stat.size;
      if (files.length >= IMPORT_LIMITS.files) throw new ManagedCopilotError("invalid_request", `The runtime state has more than ${IMPORT_LIMITS.files} files.`);
      if (total > IMPORT_LIMITS.bytes) throw new ManagedCopilotError("invalid_request", "The runtime state is larger than 1 GiB.");
      files.push({ relative: childRelative, absolute: childAbsolute, size: stat.size });
    }
  };
  await walk(directory, "");
  return files;
}
