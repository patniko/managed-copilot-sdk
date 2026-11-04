/**
 * REST data transfer objects shared by the gateway, SDK, CLI, and demos.
 * All timestamps are ISO-8601 strings. All routes are owner-scoped by the authenticated GitHub account.
 */
import type { EnvironmentRequest, EnvironmentType, SandboxSize, ToolDeclaration } from "./config.js";
import type { NetworkPolicy } from "./network.js";
import type { ExecState } from "./sandbox.js";
import type { ExecutionStyle, SubagentSandboxes } from "./workers.js";

export interface AccountInfo {
  /**
   * Stable account ID; ownership binds to this, never to the mutable login. GitHub account IDs are positive. An app's
   * own users (`kind: "app-user"`) get negative IDs this deployment assigns, so the two never collide.
   */
  readonly id: number;
  /** A GitHub login, `<app>/<user ID>` for an app user (never a GitHub login), or the app's name. */
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** Absent or `github`: a GitHub account. `app-user`: one of an app's own users. `app`: an app acting for itself. */
  readonly kind?: AccountKind;
  /** The app an app user belongs to, or that the request came through. */
  readonly app?: string;
  /** App users: the ID the app's own sign-in gave them. */
  readonly userId?: string;
}

export type AccountKind = "github" | "app-user" | "app";

/** Where a session's model calls go, fixed when it is created (spec section 15). */
/** Where a session's model calls go: its owner's Copilot plan, or an Azure AI Foundry account's deployment. */
export type SessionInference = { readonly route: "copilot" } | { readonly route: "foundry"; readonly foundry: string; readonly deployment?: string };

export interface EnvironmentInfo {
  readonly name: string;
  readonly type: EnvironmentType;
  readonly description?: string;
  readonly models?: readonly string[];
  readonly network: NetworkPolicy;
  readonly size?: SandboxSize;
  readonly promoteTo?: string;
  /** Orchestrator environments: the isolated environments workers run in (the first is the default), and how many at once. */
  readonly workers?: readonly string[];
  readonly maxWorkers?: number;
  /** Orchestrator environments: how the coordinator gets work done, and (direct and mixed) its sub-agents' sandboxes. */
  readonly execution?: ExecutionStyle;
  readonly subagents?: SubagentSandboxes;
  readonly scheduling: boolean;
  readonly agents: readonly string[];
  /** Present when the environment sends model calls to Azure AI Foundry instead of each user's Copilot plan. */
  readonly inference?: { readonly foundry: string };
  /**
   * Isolated environments: whether `managed.exec`, `managed.sandboxes.create`, and the exec routes work in this
   * environment's sandboxes (operators turn them off with `exec: false`).
   */
  readonly exec?: boolean;
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
  /** Where the session's model calls go: the owner's Copilot plan, or a Foundry account. */
  readonly inference?: SessionInference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sandbox?: SandboxInfo;
  readonly pendingActions: readonly PendingAction[];
  readonly lastTurn?: { readonly turnId: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly completedAt?: string };
  /** Present when created by a schedule run. */
  readonly scheduleId?: string;
  /** Present on an orchestrator's workers: the coordinator session that started this one. */
  readonly parentSessionId?: string;
  /**
   * `workspace`: a workspace-only sandbox (`managed.sandboxes.create`): commands and files, no agent or runtime, so
   * prompts, resume, and Copilot CLI attach are refused. Absent for agent sessions.
   */
  readonly kind?: "workspace";
}

/** `POST /v1/sandboxes`: a workspace-only sandbox of an isolated environment, owned by the caller. */
export interface CreateSandboxRequest {
  readonly environment: string | EnvironmentRequest;
  /** Caller-chosen ID; the same ID again (same owner) answers with that sandbox. */
  readonly sessionId?: string;
}

/** Who ran a command: the owner through the API (`managed.exec`, REST, CLI), or the platform (an orchestrator's tools). */
export interface ExecCaller {
  readonly kind: "api" | "platform";
  readonly accountId?: number;
  readonly login?: string;
  /** Platform callers: what ran it, e.g. a tool name. */
  readonly name?: string;
  /** Platform callers: the sub-agent that called the tool (undefined for the root agent). */
  readonly agentId?: string;
}

/** `POST /v1/sessions/:id/exec`. */
export interface ExecRequest {
  readonly command: string;
  /** Idempotency key (`[A-Za-z0-9_-]{1,64}`): the same ID again answers with that command; it is never run twice. */
  readonly id?: string;
  /** Kills the command's process group after this long. Default: 10 minutes, none for `background` commands. */
  readonly timeoutMs?: number;
  /** Start it and answer at once (stdin stays open for `input`). */
  readonly background?: boolean;
  /** How long this call waits for the command to finish (at most 30 s; default 30 s, 0 for background). */
  readonly waitMs?: number;
  /** Default `closed` (`open` for background commands). */
  readonly stdin?: "open" | "closed";
}

/** `POST /v1/sessions/:id/exec/:execId/input`. */
export interface ExecInputRequest {
  readonly data?: string;
  /** Closes stdin after `data`. */
  readonly eof?: boolean;
}

/** A command run directly in a sandbox, as the journal records it. */
export interface ExecInfo {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  /**
   * `completed` (any exit code), `timed_out`, `stopped` (with a `reason`, e.g. an idle stop or a restart), `failed`
   * (could not start), or `uncertain`: the platform lost track of it, so it may or may not have run. It is never run
   * again by itself.
   */
  readonly state: ExecState;
  readonly background: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly reason?: string;
  readonly timeoutMs?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly lastOutputAt?: string;
  readonly outputBytes: number;
  readonly caller?: ExecCaller;
}

/** A command and its output from an offset: what `POST .../exec` and `GET .../exec/:execId?offset=` answer. */
export interface ExecResult extends ExecInfo {
  readonly output: string;
  /** Read from here next. */
  readonly offset: number;
  /** Output older than what the journal keeps (the newest 1 MiB), skipped by this read. */
  readonly skippedBytes?: number;
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
/**
 * `needs_reconciliation`: a crash left it unknown whether the runtime accepted the run's input, and the session's
 * history could not settle it. The platform never resends in that state.
 */
export type ScheduleRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "skipped" | "needs_reconciliation";

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
