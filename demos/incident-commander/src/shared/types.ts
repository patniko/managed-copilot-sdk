/** Types shared by the Incident Commander server and its web UI. */

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

/** Investigating until the coordinator hands work to workers, mitigating until the fix is deployed. */
export type IncidentStatus = "investigating" | "mitigating" | "resolved";

/** Where an alert came from: the labeled demo button, or a monitoring tool posting to `/api/alerts`. */
export type AlertSource = "simulated" | "alertmanager" | "grafana" | "generic";

export interface AlertLink {
  readonly title: string;
  readonly url: string;
}

export interface AlertInfo {
  readonly source: AlertSource;
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly service: string;
  readonly severity: Severity;
  readonly labels: Readonly<Record<string, string>>;
  readonly startsAt: string;
  /** Identifies the alert across repeated notifications, so a re-sent alert doesn't open a second incident. */
  readonly fingerprint: string;
  readonly links: readonly AlertLink[];
  /** When the alerting tool (or, for the demo service, its simulated monitoring) reported it resolved. */
  readonly resolvedAt?: string;
}

/**
 * - `starting`: its session is being created (or waits for the platform).
 * - `working`: running a turn.
 * - `waiting`: a request waits for a person on the platform; nothing runs.
 * - `idle`: its turn ended before the incident was resolved.
 * - `done`: the incident is resolved.
 * - `failed`: its session failed or is gone.
 */
export type CoordinatorState = "starting" | "working" | "waiting" | "idle" | "done" | "failed";

export interface CoordinatorView {
  readonly state: CoordinatorState;
  /** What it is doing right now, in a few words. */
  readonly activity?: string;
  /** Its latest message. */
  readonly lastMessage?: string;
  readonly sessionId?: string;
  readonly environment: string;
  readonly model: string;
  /** Whether this app holds a live connection to the session; otherwise its requests wait on the platform. */
  readonly attached: boolean;
}

export type SandboxState = "starting" | "working" | "idle" | "failed" | "stopped";

export interface SandboxView {
  /** The sandbox's session ID. */
  readonly id: string;
  /** `own`: the coordinator's own sandbox, where it runs commands itself. `worker`: another agent, in its own sandbox. */
  readonly role: "own" | "worker";
  readonly name: string;
  readonly environment: string;
  readonly state: SandboxState;
  /** A worker that reported back (its state may since be `stopped`). */
  readonly done: boolean;
  readonly task?: string;
  readonly report?: string;
  readonly error?: string;
  /** Own sandbox: how many commands ran in it, and the latest shell command. */
  readonly commands?: number;
  readonly lastCommand?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface DiffLine {
  readonly kind: "context" | "add" | "del" | "gap";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface FileChange {
  /** Relative to the service's folder. */
  readonly path: string;
  readonly status: "modified" | "added";
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
}

/**
 * - `waiting`: the request waits on the platform for a person.
 * - `approved` / `declined`: decided here; being delivered to the coordinator.
 * - `deployed` / `failed`: the deploy ran (or couldn't).
 * - `expired`: the coordinator's request ended before anyone answered it.
 */
export type ApprovalState = "waiting" | "approved" | "declined" | "deployed" | "failed" | "expired";

export interface ApprovalView {
  /** The tool call that asked. */
  readonly id: string;
  readonly state: ApprovalState;
  readonly summary: string;
  readonly tests?: string;
  readonly files: readonly FileChange[];
  /** Why the changes couldn't be shown, if they couldn't. */
  readonly problem?: string;
  readonly requestedAt: string;
  /** When the platform's webhook told this app the request was waiting. */
  readonly announcedAt?: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface DeployView {
  /** `demo`: the bundled demo service's simulated production. `webhook`: your deploy pipeline (`INCIDENT_DEPLOY_URL`). */
  readonly target: "demo" | "webhook";
  readonly ok: boolean;
  readonly version?: string;
  readonly previousVersion?: string;
  readonly message: string;
  readonly files: readonly string[];
  readonly at: string;
}

export interface PostmortemView {
  readonly summary: string;
  readonly impact: string;
  readonly rootCause: string;
  readonly fix: string;
  readonly followUps: readonly string[];
  readonly publishedAt: string;
}

export type TimelineKind = "alert" | "note" | "sandbox" | "worker" | "approval" | "deploy" | "postmortem" | "person" | "resolved" | "platform" | "error";

export interface TimelineEntry {
  readonly id: string;
  readonly at: string;
  readonly kind: TimelineKind;
  readonly text: string;
  /** More, shown on demand. */
  readonly detail?: string;
}

export interface Findings {
  readonly rootCause?: string;
  readonly evidence: readonly string[];
}

export interface Milestones {
  readonly triagedAt?: string;
  readonly mitigatingAt?: string;
  readonly resolvedAt?: string;
}

export interface IncidentSummary {
  /** `INC-1001`, ... */
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly severity: Severity;
  readonly status: IncidentStatus;
  /** A request waits for a person. */
  readonly needsYou: boolean;
  /** The incident is about the bundled demo service. */
  readonly demo: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export interface IncidentView extends IncidentSummary {
  readonly alert: AlertInfo;
  /** The service's version in production when the incident opened. */
  readonly serviceVersion?: string;
  readonly coordinator: CoordinatorView;
  readonly sandboxes: readonly SandboxView[];
  readonly findings: Findings;
  readonly approval?: ApprovalView;
  readonly deploy?: DeployView;
  readonly postmortem?: PostmortemView;
  readonly timeline: readonly TimelineEntry[];
  readonly milestones: Milestones;
  /** Something the person should know (the platform is unreachable, the session is gone, ...). */
  readonly problem?: string;
}

export interface EnvironmentSummary {
  readonly name: string;
  /** `coordinator`: the orchestrator; `own`: its own sandbox's environment; `worker`: its workers'. */
  readonly role: "coordinator" | "own" | "worker";
  readonly description?: string;
  readonly size?: string;
  /** Plain words: "Off", "npm registry only", ... */
  readonly network: string;
}

export interface PlatformStatus {
  readonly state: "connecting" | "connected" | "reconnecting" | "unavailable";
  readonly message?: string;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: { readonly login: string; readonly name?: string; readonly avatarUrl?: string };
  readonly environments: readonly EnvironmentSummary[];
}

export interface IntegrationsView {
  /** Where monitoring tools post alerts. */
  readonly alertsUrl: string;
  /** `INCIDENT_ALERT_SECRET` is set, so `/api/alerts` accepts alerts. */
  readonly alertsConfigured: boolean;
  /** `INCIDENT_WEBHOOK_SECRET` is set, so the platform's webhook is verified and handled. */
  readonly webhookConfigured: boolean;
  readonly lastWebhookAt?: string;
  /** `INCIDENT_DEPLOY_URL` is set: fixes for your own services go to your deploy pipeline. */
  readonly deployConfigured: boolean;
}

export interface AppState {
  readonly platform: PlatformStatus;
  readonly integrations: IntegrationsView;
  /** Newest first. */
  readonly incidents: readonly IncidentSummary[];
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus }
  | { readonly type: "integrations"; readonly integrations: IntegrationsView }
  | { readonly type: "incidents"; readonly incidents: readonly IncidentSummary[] }
  | { readonly type: "incident"; readonly incident: IncidentView }
  | { readonly type: "removed"; readonly id: string };

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export interface DecisionRequest {
  readonly approve: boolean;
  readonly reason?: string;
}

export interface NoteRequest {
  readonly text: string;
}

export interface CreatedIncident {
  readonly id: string;
}

export interface AlertsAccepted {
  /** The incidents the alerts opened or updated. */
  readonly incidents: readonly string[];
}
