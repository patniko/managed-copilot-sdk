/**
 * The operator control plane (spec section 16): the operator API under `/v1/operator` and the console the gateway
 * serves at `/console`. Operators see infrastructure health, deployed state, every session's metadata, and its
 * harness configuration, across owners. They never see conversation content (prompts, messages, tool arguments or
 * results) or secrets (tokens, vault values, keys).
 *
 * Browser-safe: types and constants only (the console imports `@managed-copilot/protocol/operator`).
 */
import type { AccountInfo, ActionKind, ActionState, Placement, SandboxState, ScheduleInfo, ScheduleRun, SessionState } from "./api.js";
import type { EnvironmentType, Packages, SandboxSize } from "./config.js";
import type { PlatformEventType } from "./events.js";
import type { EgressBlockReason, NetworkPolicy } from "./network.js";
import type { SandboxSetupRecord } from "./sandbox.js";

const e = encodeURIComponent;

export const OPERATOR_ROUTES = {
  /** The caller's operator identity; `forbidden` when the caller is not an operator. */
  me: "/v1/operator/me",
  /** `POST` (GitHub bearer token): a one-time console sign-in ticket. */
  consoleTickets: "/v1/operator/console/tickets",
  /**
   * `POST { ticket }` redeems a ticket (used up even when the sign-in then fails) for a console session cookie and
   * answers with the `OperatorIdentity`; `DELETE` signs out.
   */
  consoleSession: "/v1/operator/console/session",
  overview: "/v1/operator/overview",
  infrastructure: "/v1/operator/infrastructure",
  environments: "/v1/operator/environments",
  environment: (name: string) => `/v1/operator/environments/${e(name)}`,
  /** `GET ?path=agents/planner.agent.md`: one deployed customization file. */
  environmentFile: (name: string) => `/v1/operator/environments/${e(name)}/file`,
  /** `GET ?owner=&environment=&state=&placement=&q=&limit=` (deleted sessions are not listed). */
  sessions: "/v1/operator/sessions",
  session: (id: string) => `/v1/operator/sessions/${e(id)}`,
  connections: "/v1/operator/connections",
  /** `GET ?state=&limit=` (without `state`: every sandbox but deleted ones). */
  sandboxes: "/v1/operator/sandboxes",
  /** `POST`: stops the session's sandbox compute after its work drains (state is kept). */
  sandboxStop: (sessionId: string) => `/v1/operator/sandboxes/${e(sessionId)}/stop`,
  /** `POST`: checks the sandbox backend now. */
  sandboxesProbe: "/v1/operator/sandboxes/probe",
  schedules: "/v1/operator/schedules",
  scheduleRuns: (id: string) => `/v1/operator/schedules/${e(id)}/runs`,
  /** `POST { reason? }`: an operator's pause (blocks every run until lifted). */
  schedulePause: (id: string) => `/v1/operator/schedules/${e(id)}/pause`,
  /** `POST`: lifts an operator's pause (an owner's or the platform's pause is the owner's to lift). */
  scheduleResume: (id: string) => `/v1/operator/schedules/${e(id)}/resume`,
  /** `GET ?state=&limit=` */
  webhooks: "/v1/operator/webhooks",
  /** `POST`: one more attempt for a failed delivery. */
  webhookRetry: (deliveryId: string) => `/v1/operator/webhooks/deliveries/${e(deliveryId)}/retry`,
  /** `GET ?state=open|attention|all|<state>&session=&limit=` (`open` by default; `attention` is needs_reconciliation). */
  actions: "/v1/operator/actions",
  accounts: "/v1/operator/accounts",
  /** `GET ?limit=&type=`: recent platform events of every owner (metadata only). */
  events: "/v1/operator/events",
  /**
   * Server-sent events: `event: platform` (an `OperatorEvent`), `event: log` (an `OperatorLogEntry`), and `: ping`
   * every 15 s. There are no `id:` lines to resume from: after reconnecting, read recent history from `events` and `logs`.
   */
  stream: "/v1/operator/stream",
  /** `GET ?level=&limit=`: the gateway's recent log entries at `level` and above (`warn`: warnings and errors). */
  logs: "/v1/operator/logs",
  /** `GET ?limit=`: operator actions and console sign-ins. */
  audit: "/v1/operator/audit",
} as const;

/** Where the gateway serves the console. */
export const CONSOLE_PATH = "/console";

/**
 * Cookie-authenticated operator requests must carry this header (value `1`). A cross-site page cannot set it without
 * a CORS preflight, which the gateway never grants.
 */
export const CONSOLE_REQUEST_HEADER = "x-managed-copilot-console";

/** How long a console sign-in ticket is valid. */
export const CONSOLE_TICKET_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------------------------------------------
// Identity and console sign-in

/**
 * Why an account is an operator: named in the AppHost's `operators`, or `local`: a loopback gateway with no operators
 * named treats every account that can use it as an operator.
 */
export type OperatorGrant = "configured" | "local";

export interface OperatorIdentity {
  readonly account: AccountInfo;
  readonly grant: OperatorGrant;
  /** How this request authenticated: a GitHub bearer token, or a console session cookie. */
  readonly via: "token" | "console";
  /** When the console session ends (console requests only). */
  readonly sessionExpiresAt?: string;
}

/** `POST /v1/operator/console/tickets`. */
export interface ConsoleTicket {
  /** One-time; expires after `CONSOLE_TICKET_TTL_SECONDS`. */
  readonly ticket: string;
  readonly expiresAt: string;
  /** Opens the console and signs in. The ticket travels in the URL fragment, which browsers never send to servers. */
  readonly url: string;
}

/** `POST /v1/operator/console/session` body. */
export interface ConsoleSessionRequest {
  readonly ticket: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Health and overview

export type HealthStatus = "healthy" | "degraded" | "unavailable" | "disabled" | "unknown";

export type OperatorComponentId = "gateway" | "runtime" | "sandboxes" | "egress" | "scheduler" | "webhooks" | "storage";

export interface ComponentHealth {
  readonly id: OperatorComponentId;
  readonly name: string;
  readonly status: HealthStatus;
  /** One line, e.g. "Running · runtime 1.0.103 · generation 2". */
  readonly summary: string;
  /** What is wrong and what to do, when not healthy. */
  readonly detail?: string;
  readonly since?: string;
}

/** Console views an attention item or a link can point at. */
export type OperatorView =
  | "overview"
  | "infrastructure"
  | "environments"
  | "sessions"
  | "connections"
  | "sandboxes"
  | "schedules"
  | "webhooks"
  | "actions"
  | "accounts"
  | "events"
  | "logs"
  | "audit";

export interface AttentionItem {
  /** Stable while the condition lasts. */
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  readonly title: string;
  readonly detail?: string;
  readonly target?: { readonly view: OperatorView; readonly id?: string };
  readonly at?: string;
}

/** Per-minute counts for the last hour, oldest first (60 buckets; the last is the current minute). */
export interface TrafficSeries {
  readonly total: number;
  readonly perMinute: readonly number[];
}

export type TrafficCounter =
  | "http.requests"
  | "http.errors"
  | "rpc.requests"
  | "rpc.notifications"
  | "connections.opened"
  | "sessions.created"
  | "events.published"
  | "inference.requests";

export interface OperatorOverview {
  readonly deployment: {
    readonly name: string;
    readonly version: string;
    readonly mode: "local" | "azure";
    readonly publicUrl: string;
    readonly startedAt: string;
    readonly capabilities: readonly string[];
    readonly sdk: { readonly copilotSdk: string; readonly copilotRuntime: string };
  };
  readonly health: readonly ComponentHealth[];
  readonly counts: {
    readonly sessions: {
      readonly total: number;
      /** Resident now: open on a runtime connection. */
      readonly live: number;
      readonly byState: Readonly<Partial<Record<SessionState, number>>>;
      readonly byPlacement: Readonly<Partial<Record<Placement, number>>>;
      readonly byEnvironment: Readonly<Record<string, number>>;
    };
    readonly connections: { readonly sdk: number; readonly cli: number };
    readonly sandboxes: { readonly total: number; readonly byState: Readonly<Partial<Record<SandboxState, number>>> };
    readonly schedules: { readonly active: number; readonly paused: number };
    readonly actions: { readonly open: number; readonly needsReconciliation: number };
    readonly webhooks: { readonly pending: number; readonly failed: number };
    readonly accounts: number;
  };
  readonly traffic: Readonly<Partial<Record<TrafficCounter, TrafficSeries>>>;
  readonly attention: readonly AttentionItem[];
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Infrastructure

/** A labeled, non-secret fact about a component (Docker engine version, Azure region, ...). */
export interface InfraFact {
  readonly label: string;
  readonly value: string;
  /** Render in a monospace font (IDs, paths, versions). */
  readonly mono?: boolean;
}

export interface GatewayStatus {
  readonly version: string;
  readonly mode: "local" | "azure";
  readonly publicUrl: string;
  readonly listen: string;
  readonly pid: number;
  readonly node: string;
  readonly platform: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly memory: { readonly rssBytes: number; readonly heapUsedBytes: number; readonly heapTotalBytes: number };
  /** Event-loop delay over the last minute (milliseconds). */
  readonly eventLoopDelayMs: { readonly p50: number; readonly p99: number; readonly max: number };
  readonly modules: readonly string[];
  readonly capabilities: readonly string[];
  /** Who may use the deployment (`access` in the AppHost). `open`: any GitHub account. */
  readonly access: { readonly githubUsers: readonly string[]; readonly githubOrgs: readonly string[]; readonly open: boolean };
  /** Who may operate it (`operators` in the AppHost). */
  readonly operators: { readonly githubUsers: readonly string[]; readonly githubOrgs: readonly string[]; readonly localDefault: boolean };
  /** Hosting facts: instance, Container App revision and replica, lease generation, ... */
  readonly facts: readonly InfraFact[];
}

export type SharedRuntimeState = "stopped" | "starting" | "running" | "restarting" | "failed" | "disabled";

export interface SharedRuntimeStatus {
  readonly state: SharedRuntimeState;
  /** Connected to a runtime the gateway did not start (`MANAGED_COPILOT_RUNTIME_URL`). */
  readonly external: boolean;
  readonly version?: string;
  readonly protocolVersion?: number;
  readonly pid?: number;
  /** Increments with every new runtime connection. */
  readonly generation: number;
  readonly connectedAt?: string;
  readonly restarts: number;
  readonly lastError?: string;
  /** Shared sessions open on it now. */
  readonly sessions: number;
}

export interface SandboxBackendStatus {
  /** `docker` or `azure`; undefined when the gateway has no sandbox module. */
  readonly provider?: string;
  readonly available: boolean;
  readonly checkedAt?: string;
  readonly lastError?: string;
  readonly defaultIdleSeconds?: number;
  readonly facts: readonly InfraFact[];
  readonly counts: Readonly<Partial<Record<SandboxState, number>>>;
}

export interface EgressStatus {
  readonly mode: string;
  readonly connected: boolean;
  readonly instanceId?: string;
  readonly version?: string;
  readonly since?: string;
  /** SHA-256 fingerprint of the egress CA certificate (never the key). */
  readonly caFingerprint?: string;
  /** Sandboxes registered with the proxy. */
  readonly registrations: number;
  /** Blocked attempts recorded in the last 24 hours. */
  readonly blockedLastDay: number;
}

export interface SchedulerStatus {
  readonly running: boolean;
  readonly tickIntervalMs: number;
  readonly lastTickAt?: string;
  readonly lastTickError?: string;
  readonly nextDueAt?: string;
  readonly queuedRuns: number;
  readonly activeRuns: number;
}

export interface WebhookWorkerStatus {
  readonly running: boolean;
  readonly subscriptions: number;
  readonly counts: Readonly<Partial<Record<OperatorWebhookDeliveryState, number>>>;
}

export interface StorageStatus {
  readonly dataDir: string;
  readonly databaseBytes: number;
  readonly walBytes: number;
}

export interface OperatorInfrastructure {
  readonly gateway: GatewayStatus;
  readonly runtime: SharedRuntimeStatus;
  readonly sandboxes: SandboxBackendStatus;
  readonly egress?: EgressStatus;
  readonly scheduler?: SchedulerStatus;
  readonly webhooks?: WebhookWorkerStatus;
  readonly storage: StorageStatus;
  readonly health: readonly ComponentHealth[];
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Environments and harness configuration

export interface OperatorVaultRef {
  readonly name: string;
  /** What each credential is for; never its value. */
  readonly credentials: readonly { readonly env?: string; readonly hosts?: readonly string[]; readonly headers?: readonly string[]; readonly mcpServer?: string; readonly header?: string }[];
  /** Whether the gateway has every secret this vault references. */
  readonly configured: boolean;
}

export interface CustomizationFileInfo {
  /** Bundle-relative POSIX path, e.g. `agents/planner.agent.md`. */
  readonly path: string;
  readonly size: number;
  readonly kind: "agent" | "skill" | "instruction" | "other";
}

export interface OperatorCustomizations {
  /** The folder as declared in the AppHost. */
  readonly source: string;
  /** Content digest of the pinned copy sessions use. */
  readonly digest?: string;
  /** Why sessions in this environment fail (`policy_violation`) because of its customizations. */
  readonly problem?: string;
  readonly agents: readonly { readonly name: string; readonly description?: string; readonly model?: string; readonly tools?: readonly string[]; readonly file?: string }[];
  readonly skills: readonly { readonly name: string; readonly description?: string; readonly file: string }[];
  readonly instructions: readonly { readonly file: string }[];
  readonly files: readonly CustomizationFileInfo[];
}

/** What sessions of an environment may use, as enforced by admission. */
export interface OperatorToolPolicy {
  /** Built-in runtime tools: the session-safe allowlist (shared placement), or `all` workload tools (sandboxes). */
  readonly builtins: readonly string[] | "all";
  /** Platform tools injected into the environment's sessions, by placement. */
  readonly platform: readonly { readonly name: string; readonly description: string; readonly placements: readonly Placement[] }[];
  /** Remote http/sse MCP servers through the gateway (shared), or any MCP server inside the sandbox. */
  readonly mcp: "remote" | "any";
  /** Settings the platform enforces regardless of the caller. */
  readonly enforced: readonly string[];
}

export interface OperatorEnvironment {
  readonly name: string;
  readonly type: EnvironmentType;
  readonly description?: string;
  /** Allowed models; undefined means every model the caller's entitlement offers. */
  readonly models?: readonly string[];
  /** The policy ceiling: callers can narrow it, never broaden it. */
  readonly network: NetworkPolicy;
  readonly size?: SandboxSize;
  readonly resources?: { readonly cpus: number; readonly memoryMiB: number };
  /** The sandbox image source (an AppHost folder or a registry image). */
  readonly image?: string;
  readonly packages?: Packages;
  readonly setupCommands?: readonly string[];
  /** Non-secret variables sandbox code sees (secrets belong in vaults). */
  readonly env?: Readonly<Record<string, string>>;
  readonly vaults: readonly OperatorVaultRef[];
  readonly scheduling: boolean;
  readonly promoteTo?: string;
  readonly idleTimeoutSeconds?: number;
  readonly warm?: number;
  readonly inference?: { readonly foundry: string };
  readonly customizations?: OperatorCustomizations;
  readonly tools: OperatorToolPolicy;
  /** AppHost webhooks that receive this environment's events. */
  readonly webhooks: readonly string[];
  /** AppHost schedules that run in this environment. */
  readonly schedules: readonly string[];
  readonly sessions: { readonly total: number; readonly live: number };
}

export interface OperatorEnvironments {
  readonly environments: readonly OperatorEnvironment[];
  /** `inline` in the AppHost: what code may request without a name. */
  readonly inline?: { readonly types: readonly EnvironmentType[]; readonly sizes?: readonly SandboxSize[] };
  /** The deployment-wide network default (`network` at the top level). */
  readonly defaultNetwork: NetworkPolicy;
}

export interface CustomizationFile extends CustomizationFileInfo {
  readonly environment: string;
  readonly content: string;
  /** The file is larger than the console shows (`content` holds its beginning). */
  readonly truncated: boolean;
  /** Not text (`content` is empty). */
  readonly binary?: boolean;
}

/** A session's admitted harness: what the runtime was told to run with, secrets redacted. */
export interface OperatorHarness {
  readonly model?: string;
  readonly allowedModels?: readonly string[];
  readonly agent?: string;
  readonly reasoningEffort?: string;
  readonly systemMessage?: {
    readonly mode: string;
    readonly content?: string;
    readonly sections?: Readonly<Record<string, { readonly action: string; readonly content?: string }>>;
  };
  readonly availableTools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly tools: readonly OperatorHarnessTool[];
  readonly mcpServers: readonly OperatorMcpServer[];
  readonly customAgents: readonly OperatorCustomAgent[];
  /** Deployed customization directories the session reads. */
  readonly customizations: { readonly agents: boolean; readonly skills: boolean; readonly instructions: boolean };
  readonly skills: { readonly enabled: boolean; readonly disabled?: readonly string[] };
  /** Handlers clients registered (tool names and callback kinds such as `requestPermission`, `hooks`). */
  readonly callbacks: { readonly tools: readonly string[]; readonly flags: readonly string[] };
  readonly workingDirectory?: string;
  /** Other caller settings with simple values (`streaming`, `infiniteSessions`, ...). */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  /** Settings the platform enforces for this placement. */
  readonly enforced: readonly string[];
}

export interface OperatorHarnessTool {
  readonly name: string;
  readonly description?: string;
  /** `client`: a connected app's `defineTool`; `server`: a declaration stored for schedules; `platform`: injected by the gateway. */
  readonly source: "client" | "server" | "platform";
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly skipPermission?: boolean;
  readonly overridesBuiltInTool?: boolean;
}

export interface OperatorMcpServer {
  readonly name: string;
  readonly transport: string;
  /** Query values and user information are redacted. */
  readonly url?: string;
  readonly command?: string;
  /** Values that look like credentials are redacted. */
  readonly args?: readonly string[];
  /** Header names only. */
  readonly headers: readonly string[];
  /** Environment variable names only. */
  readonly env: readonly string[];
  readonly tools?: readonly string[];
  /** The custom agent that declares it, when not the session itself. */
  readonly agent?: string;
  /** Reached through the gateway's MCP adapter (shared placement), which applies network policy and vault credentials. */
  readonly adapter?: boolean;
}

export interface OperatorCustomAgent {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly prompt?: string;
  readonly mcpServers: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions, connections, sandboxes

export interface OperatorSessionQuery {
  /** Owner login or numeric account ID. */
  readonly owner?: string;
  readonly environment?: string;
  /** Any state but `deleted` (deleted sessions are not listed). */
  readonly state?: Exclude<SessionState, "deleted">;
  readonly placement?: Placement;
  /** Session ID prefix. */
  readonly q?: string;
  readonly limit?: number;
}

export interface OperatorSessionSummary {
  readonly id: string;
  readonly owner: AccountInfo;
  readonly environment: string;
  readonly type: EnvironmentType;
  readonly placement: Placement;
  readonly state: SessionState;
  readonly generation: number;
  readonly model?: string;
  readonly agent?: string;
  readonly clientName?: string;
  readonly scheduleId?: string;
  readonly lastTurn?: { readonly turnId: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly completedAt?: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Open on a runtime connection now. */
  readonly live: boolean;
  /** Clients attached now (SDK connections and Copilot CLI). */
  readonly attached: number;
}

export interface OperatorAttachment {
  readonly connectionId: string;
  readonly kind: "sdk" | "cli";
  readonly account: AccountInfo;
  readonly clientName?: string;
  readonly attachedAt: string;
  /** Client tool names and callback kinds this client registered. */
  readonly tools: readonly string[];
  readonly callbacks: readonly string[];
}

/** What the session asked for when it was created (file contents and variable values left out). */
export interface OperatorEnvironmentRequest {
  readonly name?: string;
  readonly type?: EnvironmentType;
  readonly size?: SandboxSize;
  readonly network?: unknown;
  readonly vaults?: readonly string[];
  readonly packages?: { readonly python?: readonly string[]; readonly npm?: readonly string[] };
  readonly env?: readonly string[];
  readonly files?: readonly { readonly path: string; readonly bytes: number }[];
}

export interface OperatorEgressBlock {
  readonly id: number;
  readonly sessionId: string;
  readonly sandboxId?: string;
  readonly at: string;
  readonly reason: EgressBlockReason;
  readonly host?: string;
  readonly port?: number;
  readonly method?: string;
  readonly path?: string;
  readonly message: string;
}

export interface OperatorPromotion {
  readonly id: string;
  readonly state: string;
  readonly trigger: string;
  readonly target: string;
  readonly fromGeneration: number;
  readonly toGeneration?: number;
  readonly sandboxId?: string;
  readonly errorCode?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export interface OperatorArtifactSummary {
  readonly count: number;
  readonly bytes: number;
  readonly latest: readonly { readonly path: string; readonly version: number; readonly size: number; readonly state: string; readonly publishedAt?: string }[];
}

export interface OperatorSessionDetail extends OperatorSessionSummary {
  readonly incarnation: string;
  readonly webhook?: string;
  readonly environmentRequest: OperatorEnvironmentRequest;
  readonly harness?: OperatorHarness;
  /** Why the harness could not be shown (an unreadable admitted configuration). */
  readonly harnessProblem?: string;
  readonly attachments: readonly OperatorAttachment[];
  /** In-memory state while the session is resident. */
  readonly runtime?: {
    readonly ready: boolean;
    readonly upstream?: string;
    readonly restoring: boolean;
    readonly cutover: boolean;
    readonly deleting: boolean;
    readonly waits: number;
    readonly presences: number;
  };
  readonly network?: { readonly policy: NetworkPolicy; readonly vaults: readonly string[]; readonly promotedTo?: string; readonly recentBlocks: readonly OperatorEgressBlock[] };
  readonly sandbox?: OperatorSandbox;
  readonly actions: readonly OperatorAction[];
  readonly promotion?: OperatorPromotion;
  readonly artifacts?: OperatorArtifactSummary;
  readonly schedules: readonly { readonly id: string; readonly name: string; readonly state: string }[];
}

export interface OperatorConnection {
  readonly id: string;
  readonly kind: "sdk" | "cli";
  readonly account: AccountInfo;
  readonly environment: string;
  readonly clientName?: string;
  readonly connectedAt?: string;
  readonly lastActivityAt?: string;
  /** JSON-RPC requests the client sent. */
  readonly requests?: number;
  /** Notifications the gateway sent it (events). */
  readonly notifications?: number;
  readonly sessions: readonly string[];
}

export interface OperatorUpstream {
  /** `shared`, or `sandbox:<sessionId>`. */
  readonly id: string;
  readonly kind: "shared" | "sandbox";
  readonly sessions: readonly string[];
  readonly version?: string;
}

export interface OperatorConnections {
  readonly connections: readonly OperatorConnection[];
  readonly upstreams: readonly OperatorUpstream[];
  readonly generatedAt: string;
}

export interface OperatorSandbox {
  readonly id: string;
  readonly sessionId: string;
  readonly owner: AccountInfo;
  readonly environment: string;
  readonly size: SandboxSize;
  readonly state: SandboxState;
  /** Image reference (tag) and pinned ID. */
  readonly image?: string;
  readonly imageId?: string;
  readonly network: NetworkPolicy;
  readonly vaults: readonly string[];
  readonly subnet?: string;
  readonly idleTimeoutSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly setup?: SandboxSetupRecord;
  /** In-memory activity while the gateway tracks it. */
  readonly activity?: { readonly runtimes: number; readonly busy: number; readonly turnRunning: boolean; readonly lastActivityAt: string; readonly pending: number };
}

// ---------------------------------------------------------------------------------------------------------------
// Durable work: schedules, webhooks, actions, accounts

export interface OperatorSchedule extends Omit<ScheduleInfo, "prompt"> {
  readonly owner: AccountInfo;
  /** Shown for AppHost schedules (operator configuration); a person's or agent's prompt is conversation content. */
  readonly prompt?: string;
}

export interface OperatorScheduleRuns {
  readonly schedule: OperatorSchedule;
  readonly runs: readonly ScheduleRun[];
}

export type OperatorWebhookDeliveryState = "pending" | "delivering" | "delivered" | "failed";

export interface OperatorWebhookSubscription {
  readonly name: string;
  /** Query values and user information are redacted. */
  readonly url: string;
  readonly environments: readonly string[];
  readonly events: readonly string[];
  /** Whether its signing secret is configured (deliveries fail visibly without it). */
  readonly signed: boolean;
}

export interface OperatorWebhookDelivery {
  readonly id: string;
  readonly webhook: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly environment?: string;
  readonly owner?: AccountInfo;
  readonly state: OperatorWebhookDeliveryState;
  readonly attempts: number;
  readonly lastStatus?: number;
  readonly lastError?: string;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deliveredAt?: string;
}

export interface OperatorWebhooks {
  readonly subscriptions: readonly OperatorWebhookSubscription[];
  readonly deliveries: readonly OperatorWebhookDelivery[];
  readonly counts: Readonly<Partial<Record<OperatorWebhookDeliveryState, number>>>;
}

/** A durable action's metadata (never its arguments, payload, or result). */
export interface OperatorAction {
  readonly id: string;
  readonly sessionId: string;
  readonly owner: AccountInfo;
  readonly environment: string;
  readonly kind: ActionKind;
  readonly state: ActionState;
  readonly tool?: string;
  /** `live`, `webhook`, `poll`, `cli`, or `platform`. */
  readonly responder?: string;
  readonly claimedBy?: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
  readonly leaseExpiresAt?: string;
  readonly completedAt?: string;
  /** Why it is in its state (platform-written: expiry, reconciliation, cancellation). */
  readonly reason?: string;
}

export interface OperatorAccount {
  readonly account: AccountInfo;
  readonly lastSeenAt: string;
  readonly sessions: { readonly total: number; readonly live: number };
  readonly connections: number;
  readonly schedules: { readonly active: number; readonly paused: number };
  /** Background sign-in (`managed-copilot login`); `none` when the account never stored one. */
  readonly background: { readonly state: "active" | "revoked" | "invalid" | "none"; readonly createdAt?: string; readonly lastVerifiedAt?: string; readonly reason?: string };
  /**
   * Named in the AppHost's `operators` by login (or every account, on a local gateway that names none). Organization
   * membership is checked with the account's own token when it signs in, so members of operator organizations show
   * `false` here.
   */
  readonly operator: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Events, logs, audit

/** A platform event with its owner, reduced to metadata (no prompts, arguments, results, or capabilities). */
export interface OperatorEvent {
  readonly id: string;
  readonly type: PlatformEventType;
  readonly createdAt: string;
  readonly owner: AccountInfo;
  readonly sessionId?: string;
  readonly environment?: string;
  readonly sandboxId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type OperatorLogLevel = "debug" | "info" | "warn" | "error";

export interface OperatorLogEntry {
  readonly seq: number;
  readonly at: string;
  readonly level: OperatorLogLevel;
  /** The component that logged it, e.g. `gateway:sandbox`. */
  readonly logger: string;
  readonly message: string;
  /** The entry's fields, with credential-like values masked (as in the gateway's log output). */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type OperatorAuditAction = "console.signin" | "console.signout" | "sandbox.stop" | "sandboxes.probe" | "schedule.pause" | "schedule.resume" | "webhook.retry";

export interface OperatorAuditEntry {
  readonly id: number;
  readonly at: string;
  readonly actor: AccountInfo;
  readonly action: OperatorAuditAction;
  /** What it acted on (a session, schedule, or delivery ID). */
  readonly target?: string;
  readonly outcome: "succeeded" | "failed";
  readonly detail?: string;
}

/** The answer to a guarded operator action. */
export interface OperatorActionResult {
  readonly ok: true;
  readonly message: string;
  readonly audit: OperatorAuditEntry;
}
