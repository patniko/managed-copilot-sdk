/**
 * REST data transfer objects shared by the gateway, SDK, CLI, and demos.
 * All timestamps are ISO-8601 strings. All routes are owner-scoped by the authenticated GitHub account.
 */
import type { EnvironmentType, SandboxSize, ToolDeclaration } from "./config.js";
import type { NetworkPolicy } from "./network.js";

export interface AccountInfo {
  /** Stable GitHub account ID; ownership binds to this, never to the mutable login. */
  readonly id: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface EnvironmentInfo {
  readonly name: string;
  readonly type: EnvironmentType;
  readonly description?: string;
  readonly models?: readonly string[];
  readonly network: NetworkPolicy;
  readonly size?: SandboxSize;
  readonly promoteTo?: string;
  readonly scheduling: boolean;
  readonly agents: readonly string[];
}

export interface DeploymentInfo {
  readonly name: string;
  readonly version: string;
  readonly mode: "local" | "azure";
  readonly environments: readonly EnvironmentInfo[];
  readonly inline?: { readonly types: readonly EnvironmentType[]; readonly sizes?: readonly SandboxSize[] };
  /** Capabilities that passed qualification on this deployment, e.g. "isolated", "promotion", "attach.cli". */
  readonly capabilities: readonly string[];
  readonly sdk: { readonly copilotSdk: string; readonly copilotRuntime: string };
}

export type Placement = "shared" | "sandbox";

export type SessionState =
  | "creating"
  | "ready"
  | "running"
  | "waiting"
  | "idle"
  | "stopped"
  | "promoting"
  | "deleting"
  | "deleted"
  | "failed";

export type SandboxState = "provisioning" | "setting_up" | "running" | "stopping" | "stopped" | "deleting" | "deleted" | "failed";

export interface SandboxInfo {
  readonly id: string;
  readonly size: SandboxSize;
  readonly state: SandboxState;
  readonly image?: string;
  readonly network: NetworkPolicy;
  readonly startedAt?: string;
}

export type ActionKind = "tool" | "permission" | "user_input" | "elicitation" | "hook";
export type ActionState = "pending" | "claimed" | "executing" | "completed" | "failed" | "needs_reconciliation" | "expired" | "cancelled";

export interface PendingAction {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ActionKind;
  readonly state: ActionState;
  /** The runtime request ID the answer RPC is keyed on (`handlePendingToolCall`, `handlePendingPermissionRequest`, ...). */
  readonly requestId: string;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly arguments?: unknown;
  /** The runtime's request data a handler needs, e.g. the permission request or elicitation schema. */
  readonly payload?: unknown;
  /** Stable identity to pass to side-effecting downstream services. */
  readonly idempotencyKey: string;
  readonly turnId?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly claimedBy?: string;
  readonly result?: unknown;
  /** Error text a responder reported (state `failed`). */
  readonly error?: string;
  /** Why the action is in its current state, e.g. why it needs reconciliation or expired. */
  readonly reason?: string;
  /** Permission request details (`kind: "permission"`), as the stock SDK passes them to `onPermissionRequest`. */
  readonly permissionRequest?: unknown;
}

export interface SessionInfo {
  readonly id: string;
  readonly environment: string;
  readonly type: EnvironmentType;
  readonly placement: Placement;
  readonly state: SessionState;
  readonly owner: AccountInfo;
  readonly title?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sandbox?: SandboxInfo;
  readonly pendingActions: readonly PendingAction[];
  readonly lastTurn?: { readonly turnId: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly completedAt?: string };
  /** Present when created by a schedule run. */
  readonly scheduleId?: string;
}

export interface SessionListQuery {
  readonly environment?: string;
  readonly state?: SessionState;
  readonly limit?: number;
}

export interface FileEntry {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: string;
}

export type ArtifactState = "pending" | "published" | "failed";

export interface ArtifactInfo {
  readonly id: string;
  /** Path relative to `/workspace/outputs`. */
  readonly path: string;
  readonly size: number;
  readonly digest: string;
  readonly contentType?: string;
  readonly turnId: string;
  readonly version: number;
  readonly state: ArtifactState;
  readonly publishedAt?: string;
}

export interface PublicationResult {
  readonly turnId: string;
  readonly state: ArtifactState;
  readonly artifacts: readonly ArtifactInfo[];
  readonly error?: string;
}

export interface VaultInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "apphost" | "user";
  readonly credentials: readonly { readonly env?: string; readonly mcpServer?: string; readonly hosts?: readonly string[] }[];
  readonly createdAt: string;
}

export interface CreateVaultRequest {
  readonly name: string;
  readonly credentials: readonly (
    | { readonly env: string; readonly value: string; readonly hosts: readonly string[]; readonly headers?: readonly string[] }
    | { readonly mcpServer: string; readonly value: string; readonly header?: string }
  )[];
}

export type ScheduleState = "active" | "paused";
export type ScheduleRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "skipped";

export interface ScheduleRun {
  readonly id: string;
  readonly scheduleId: string;
  /** Stable occurrence identity; deduplicates session creation and input submission. */
  readonly occurrenceId: string;
  readonly scheduledFor: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status: ScheduleRunStatus;
  readonly sessionId?: string;
  /** Runtime message ID of the delivered prompt (matches the `user.message` event's `data.messageId`). */
  readonly messageId?: string;
  /** `cron`, `once` (runAt), or `manual` (runNow). */
  readonly trigger?: "cron" | "once" | "manual";
  readonly reason?: string;
}

/** `POST /v1/schedules/:id/run`. The invocation ID makes retries of the same request idempotent. */
export interface RunScheduleRequest {
  readonly invocationId?: string;
}

export interface ScheduleInfo {
  readonly id: string;
  readonly name: string;
  readonly cron?: string;
  /** One-shot schedules (agent reminders) use `runAt` instead of `cron`. */
  readonly runAt?: string;
  readonly timeZone: string;
  readonly environment: string;
  readonly prompt: string;
  readonly state: ScheduleState;
  /** Why the schedule is paused when the platform paused it (logout, revoked sign-in, policy change). */
  readonly pausedReason?: string;
  readonly createdBy: "user" | "agent" | "apphost";
  readonly target?: { readonly sessionId: string };
  readonly session?: { readonly agent?: string; readonly model?: string; readonly tools?: readonly ToolDeclaration[] };
  readonly webhook?: string;
  readonly nextRunAt?: string;
  readonly lastRun?: ScheduleRun;
  readonly createdAt: string;
}

export interface CreateScheduleRequest {
  readonly name: string;
  readonly cron?: string;
  readonly runAt?: string;
  readonly timeZone?: string;
  readonly environment?: string;
  readonly target?: { readonly sessionId: string };
  readonly session?: { readonly agent?: string; readonly model?: string; readonly tools?: readonly ToolDeclaration[] };
  readonly webhook?: string;
  readonly prompt: string;
}

export interface AttachMaterial {
  readonly transport: "ahp";
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly ahpSessionId: string;
  readonly serverKey?: string;
}

export interface PromoteResult {
  readonly sessionId: string;
  readonly placement: Placement;
  readonly sandboxId: string;
  readonly generation: number;
}

export interface HandleActionResult {
  readonly actionId: string;
  readonly state: ActionState;
}

/** Answer to a claimed action, submitted by a live client, webhook worker, or poller. */
export interface ActionResultRequest {
  readonly claimToken: string;
  readonly result?: unknown;
  readonly error?: string;
  /** Give the claim back without answering (for example a permission handler that returned `no-result`). */
  readonly release?: boolean;
}

/** `POST /v1/sessions/:id/actions/:actionId/claim`. Repeat with `claimToken` to renew the lease. */
export interface ActionClaimRequest {
  readonly claimToken?: string;
  readonly leaseSeconds?: number;
  /** Take over an action in `needs_reconciliation` after checking its downstream effect with the idempotency key. */
  readonly reconcile?: boolean;
  /** Label recorded with the claim, for example a worker name. */
  readonly responder?: string;
}

export interface ActionClaim {
  readonly action: PendingAction;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
}

export interface BackgroundCredentialStatus {
  readonly account: AccountInfo;
  readonly active: boolean;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  /** When the platform last verified the stored credential with GitHub. */
  readonly lastVerifiedAt?: string;
  /** Why background work is unavailable, e.g. after `logout` or a revoked token. */
  readonly reason?: string;
}
