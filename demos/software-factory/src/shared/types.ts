/**
 * Contract between the factory server and the factory floor UI (REST + server-sent events).
 * Everything here is JSON-serializable. Timestamps are ISO-8601 strings.
 */

// ─── Platform ────────────────────────────────────────────────────────────────────────────────────────────────

export type NetworkAccess = "enabled" | "restricted" | "disabled";

export interface NetworkView {
  readonly access: NetworkAccess;
  /** Host patterns when `access` is `restricted`. */
  readonly allowedDomains: readonly string[];
}

/** `developer`: GitHub work orders, which change an existing repository in one `factory-repo` sandbox. */
export type StationRole = "planner" | "builder" | "reviewer" | "release" | "coordinator" | "developer";

export interface EnvironmentView {
  readonly role: StationRole;
  readonly name: string;
  readonly type: "shared" | "isolated" | "promotable" | "orchestrator";
  readonly description?: string;
  readonly network: NetworkView;
  readonly size?: "small" | "medium" | "large";
  readonly agents: readonly string[];
  /** Model the factory uses for this role. */
  readonly model: string;
}

/** `reconnecting`: the factory was connected, lost the connection, and is retrying; paused work orders resume when it's back. */
export type PlatformState = "connecting" | "connected" | "reconnecting" | "unavailable" | "misconfigured";

export interface PlatformStatus {
  readonly state: PlatformState;
  /** Gateway URL, when known. */
  readonly url?: string;
  /** Friendly explanation for non-connected states (never a stack trace). */
  readonly message?: string;
  /** Actionable hint, e.g. "Start the platform with `aspire run`". */
  readonly hint?: string;
  readonly deployment?: {
    readonly name: string;
    readonly mode: "local" | "azure";
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly copilotSdk: string;
    readonly copilotRuntime: string;
  };
  readonly account?: { readonly login: string; readonly name?: string; readonly avatarUrl?: string };
  readonly environments: readonly EnvironmentView[];
  readonly missingEnvironments: readonly string[];
  /** What this deployment lets the factory do. */
  readonly features: {
    readonly runs: boolean;
    /** Agent-led work orders: the `factory-coordinator` orchestrator environment and the `orchestrator` capability. */
    readonly agentLed: boolean;
    readonly isolated: boolean;
    readonly artifacts: boolean;
    readonly files: boolean;
    readonly attach: boolean;
    /** GitHub work orders: the `factory-repo` environment and sandbox commands (`exec`). */
    readonly github: boolean;
  };
  /** Why agent-led work orders can't run here, when `features.agentLed` is false while classic ones can. */
  readonly agentLedHint?: string;
  /** Why GitHub work orders can't run on this deployment, when `features.github` is false while classic ones can. */
  readonly githubHint?: string;
  readonly checkedAt: string;
}

// ─── Work orders ─────────────────────────────────────────────────────────────────────────────────────────────

export type WorkOrderStatus = "queued" | "planning" | "building" | "releasing" | "completed" | "failed" | "cancelled";

/**
 * - `agent`: agent-led. A coordinator agent in an orchestrator environment decides which sandboxes to create (a builder
 *   per task, reused for review fixes, then a release worker); the factory still validates the plan, checks builds,
 *   reviews them on a second model, and accepts the release.
 * - `classic`: the factory app runs the pipeline itself, one session per station.
 */
export type WorkOrderMode = "agent" | "classic";

export type StationKind = "plan" | "coordinate" | "build" | "review" | "release";

/** A worker's state on the platform (`managed.workers(coordinator)`). */
export type WorkerState = "starting" | "working" | "idle" | "failed" | "stopped";

/** The worker the coordinator created for a build or release station (agent-led work orders). */
export interface WorkerView {
  /** The worker's own session ID. */
  readonly id: string;
  /** The name the coordinator gave it, unique within the coordinator session. */
  readonly name: string;
  readonly state: WorkerState;
  /** The build round it was created for; later rounds in the same sandbox reuse it. */
  readonly createdRound: number;
  /** Messages it received from the coordinator, its first task included. */
  readonly messages: number;
  /** Latest runtime turn, including turns sent from an attached CLI rather than by the coordinator. */
  readonly turnId?: string;
  readonly error?: string;
}

export type StationStatus =
  /** Not started; upstream work is not finished. */
  | "waiting"
  /** Creating the session (and its sandbox, for isolated stations). */
  | "starting"
  /** The agent is working on a turn. */
  | "working"
  /** Collecting published artifacts and test results. */
  | "collecting"
  /** Review station only: the reviewer sent the work back for fixes. */
  | "changes_requested"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export interface TestSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs?: number;
  readonly at: string;
}

export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Model API calls. */
  readonly requests: number;
  readonly durationMs: number;
}

export interface SandboxView {
  readonly id: string;
  readonly size: "small" | "medium" | "large";
  readonly state: string;
  readonly image?: string;
  readonly network: NetworkView;
  readonly startedAt?: string;
}

export interface FactoryError {
  /** A `@managed-copilot/protocol` error code or a factory code such as `tests_failed`. */
  readonly code: string;
  readonly message: string;
}

export type ReviewVerdict = "approve" | "request_changes";

export interface ReviewFinding {
  readonly severity: "blocker" | "major" | "minor";
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

export interface ReviewRecord {
  readonly round: number;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly at: string;
}

export interface Station {
  /** `plan`, `coordinator`, `build:<taskId>`, `review:<taskId>`, or `release`. */
  readonly id: string;
  readonly kind: StationKind;
  readonly title: string;
  readonly taskId?: string;
  readonly status: StationStatus;
  /** Short live description, e.g. "Running tests" or "Waiting for csv-parser". */
  readonly detail?: string;
  readonly role: StationRole;
  readonly environment: string;
  readonly placement: "shared" | "sandbox";
  readonly agent: string;
  readonly model?: string;
  readonly sessionId?: string;
  /** Earlier sessions replaced by a retry. */
  readonly previousSessionIds?: readonly string[];
  readonly sandbox?: SandboxView;
  /** Build/review rounds started (a review that requests changes starts another round). */
  readonly round: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly tests?: TestSummary;
  readonly usage?: UsageSummary;
  /** Review stations: one record per round. */
  readonly reviews?: readonly ReviewRecord[];
  /** Review stations: approved after the maximum rounds with findings still open. */
  readonly acceptedWithFindings?: boolean;
  /** The current or last agent turn; lets the factory pick up an in-flight turn after a restart. */
  readonly turn?: {
    readonly kind: "work" | "fix" | "nudge" | "review" | "retry" | "continue";
    readonly round: number;
    readonly sentAt: string;
    readonly completedAt?: string;
  };
  /** Checkpoint: version of `test-report.json` the factory last checked, to notice a check that wasn't re-run. */
  readonly reportVersion?: number;
  /** Checkpoint: the build round whose factory check passed. */
  readonly passedRound?: number;
  /** Checkpoint: set by a retry so the agent first hears why its previous attempt stopped. */
  readonly retryNote?: string;
  /** Checkpoint: every seed file was written into the sandbox. */
  readonly seeded?: boolean;
  /** The platform's view of `sessionId`, reconciled with `managed.sessions.list()`; `deleted` when it no longer exists. */
  readonly sessionState?: string;
  /** Set once the platform answered `not_found` for `sessionId`, so reconciliation stops looking it up. */
  readonly sessionGone?: boolean;
  /** Agent-led build and release stations: the worker the coordinator created (its session is `sessionId`). */
  readonly worker?: WorkerView;
  /** Agent-led checkpoint: factory checks that failed in the current round (bounded like classic nudges). */
  readonly failedChecks?: number;
  /** Agent-led: a check is idempotent for a worker's message number; new messages require a fresh report. */
  readonly workerCheck?: {
    readonly messages: number;
    readonly turnId?: string;
    readonly passed: boolean;
    readonly code: string;
    readonly problem: string;
  };
  /** Agent-led: the worker message whose passing output received the latest review. */
  readonly reviewedMessages?: number;
  readonly reviewedTurnId?: string;
  /** Agent-led checkpoint: the `test-report.json` version published before the latest work was sent; a check needs a newer one. */
  readonly staleReportVersion?: number;
  /** Agent-led checkpoint: the review requested changes, so the next work sent to this builder starts the next round. */
  readonly awaitingFix?: boolean;
  /** Agent-led release: pins its inputs to the accepted builders and their checked message numbers. */
  readonly inputRevision?: string;
  readonly error?: FactoryError;
}

export interface PlanTask {
  /** kebab-case, unique within the plan. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Workspace-relative files this task owns. */
  readonly files: readonly string[];
  /** Exported API, CLI contract, or other interface other tasks rely on. */
  readonly interface?: string;
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface Plan {
  readonly summary: string;
  readonly projectName: string;
  readonly packageDescription: string;
  /** Command name → workspace-relative script, merged into package.json `bin`. */
  readonly bin: Readonly<Record<string, string>>;
  readonly tasks: readonly PlanTask[];
  /** Guidance for the release station: how the pieces fit and what to verify end to end. */
  readonly integration: string;
}

/** A file the release added, changed, or removed in the project a work order brought along. */
export interface ReleaseChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
}

export interface ReleaseSummary {
  readonly files: number;
  readonly bytes: number;
  readonly tests?: TestSummary;
  readonly patchBytes?: number;
  /** Release notes (markdown) from `outputs/RELEASE.md`. */
  readonly notes?: string;
  /** Work orders with a `project`: what the release changed in it. */
  readonly changes?: readonly ReleaseChange[];
}

/** `github`: a change to an existing repository that ends in a pull request (see `WorkOrder.github`). */
export interface WorkOrderSource {
  readonly kind: "brief" | "template" | "github";
  readonly templateId?: string;
}

// ─── Routed work orders ──────────────────────────────────────────────────────────────────────────────────────

/** The app that routed a work order to the factory (Help Desk, Incident Commander, Data Desk, or your own). */
export interface WorkOrderOrigin {
  /** The app's ID: lowercase letters, digits, and hyphens, e.g. `help-desk`. */
  readonly app: string;
  /** Its name for people, e.g. "Help Desk". */
  readonly name: string;
  /** What in that app the work came from, e.g. "Promo codes · 2 tickets" or "INC-1004 · checkout". */
  readonly label?: string;
  /** A link back to it, for people. */
  readonly url?: string;
  /** The app's own key for the item, so it can find this work order again. */
  readonly key?: string;
}

/** A text file a routed work order brings along. */
export interface InputFile {
  /** Relative POSIX path. */
  readonly path: string;
  readonly content: string;
  /** One line: what it is. */
  readonly description?: string;
}

/**
 * What a routed work order brought along, as the floor lists it. The files themselves are the `intake` station's
 * artifacts: `context/<path>` and `project/<path>`.
 */
export interface WorkOrderInputs {
  /** Reference material: in every sandbox under `.factory/context/`, and in the planner's prompt. */
  readonly context: readonly { readonly path: string; readonly size: number; readonly description?: string }[];
  /** An existing project the work order changes: every builder's and the release's workspace starts from its files. */
  readonly project?: { readonly name: string; readonly files: number; readonly bytes: number };
}

/** `GET /api/work-orders/:id/release`: the released project as text, for the app that routed the work order. */
export interface ReleaseFiles {
  readonly workOrderId: string;
  readonly number: number;
  readonly projectName: string;
  readonly tests?: TestSummary;
  readonly notes?: string;
  /** Every file of the released project. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Work orders with a `project`: what the release changed in it. */
  readonly changes?: readonly ReleaseChange[];
}

// ─── GitHub work orders ──────────────────────────────────────────────────────────────────────────────────────

/** The factory's own GitHub sign-in (the same account it uses for Managed Copilot), used to browse and open PRs. */
export interface GitHubStatus {
  readonly available: boolean;
  readonly login?: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** Why it isn't available, for the form. */
  readonly message?: string;
  readonly hint?: string;
}

export interface RepositorySummary {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly description?: string;
  readonly language?: string;
  readonly pushedAt?: string;
  readonly archived?: boolean;
  /** Whether the signed-in account can push branches (the factory needs it to open a pull request). */
  readonly canPush: boolean;
}

export interface IssueLabel {
  readonly name: string;
  /** Hex without `#`. */
  readonly color: string;
}

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly htmlUrl: string;
  readonly labels: readonly IssueLabel[];
  readonly author?: string;
  readonly comments: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueComment {
  readonly author?: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface IssueDetail extends IssueSummary {
  readonly body: string;
  /** The latest comments, oldest first. */
  readonly recentComments: readonly IssueComment[];
}

/** A screenshot or recording the developer captured into `outputs/media/`. */
export interface MediaItem {
  readonly stationId: string;
  /** Path relative to `/workspace/outputs`, e.g. `media/home.png`. */
  readonly path: string;
  readonly version: number;
  readonly caption: string;
  readonly kind: "image" | "video";
  readonly contentType: string;
  readonly size: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "type_changed";
  /** Absent for binary files. */
  readonly additions?: number;
  readonly deletions?: number;
}

/** The factory re-running the developer's test command in the sandbox after a change. */
export interface ChangeCheck {
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode?: number;
  readonly durationMs: number;
  /** The end of the command's output. */
  readonly output: string;
  readonly at: string;
}

/** One request in a GitHub work order: the original (number 1), then each "request changes" after it. */
export interface ChangeRevision {
  readonly number: number;
  readonly request: string;
  readonly requestedAt: string;
  readonly requestedBy?: string;
  /** Build round this revision's request was sent in. */
  readonly startRound?: number;
  /** From the developer's `submit_change`. */
  readonly title?: string;
  /** What changed and why (markdown); the pull request description or the revision's comment. */
  readonly summary?: string;
  /** An answer, when the request asked a question rather than for a change. */
  readonly answer?: string;
  readonly testCommand?: string;
  /** Every change since the base commit, as of this revision. */
  readonly files?: readonly ChangedFile[];
  readonly check?: ChangeCheck;
  readonly media?: readonly MediaItem[];
  /** What the developer listed in `submit_change`, before the factory matched it to published files. */
  readonly requestedMedia?: readonly { readonly path: string; readonly caption: string }[];
  /** The build round whose change the review accepted (or that had nothing to review). */
  readonly acceptedRound?: number;
  /** The commit the factory pushed for this revision. */
  readonly commitSha?: string;
  /** `commitSha` is on the branch on GitHub. */
  readonly pushed?: boolean;
  /** Revisions after the first: the pull request comment describing them. */
  readonly commentUrl?: string;
  readonly outcome?: "pull_request" | "pushed" | "no_changes";
  readonly completedAt?: string;
}

export interface PullRequestView {
  readonly number: number;
  readonly htmlUrl: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** GitHub's merge check: `null` while GitHub is still computing it. */
  readonly mergeable?: boolean | null;
  readonly mergeableState?: string;
  readonly commits?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly updatedAt?: string;
  readonly mergedAt?: string;
  readonly mergedBy?: string;
}

export interface GitHubWork {
  readonly repository: RepositorySummary & { readonly id: number };
  readonly issue?: IssueDetail;
  /** The default branch's head when the work order was created: the commit every change builds on. */
  readonly baseSha: string;
  /** The branch the factory pushes, e.g. `factory/wo-0012-fix-login`. */
  readonly branch: string;
  readonly revisions: readonly ChangeRevision[];
  readonly pullRequest?: PullRequestView;
  /** Media already uploaded to GitHub, keyed `<stationId>:<path>@<version>`, so a retry doesn't upload twice. */
  readonly uploads?: Readonly<Record<string, string>>;
}

export interface WorkOrderSummary {
  readonly id: string;
  /** Sequential number, displayed as WO-0007. */
  readonly number: number;
  readonly title: string;
  /** Absent on work orders recorded before agent-led mode existed: those are classic. */
  readonly mode?: WorkOrderMode;
  readonly status: WorkOrderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly taskCount: number;
  readonly tests?: TestSummary;
  readonly error?: FactoryError;
  /** GitHub work orders: the repository, issue, and pull request, for lists. */
  readonly github?: { readonly repository: string; readonly issue?: number; readonly pullRequest?: number; readonly pullRequestState?: PullRequestView["state"] };
  /** Set when another app routed the work order to the factory. */
  readonly origin?: WorkOrderOrigin;
}

export interface WorkOrder extends Omit<WorkOrderSummary, "github"> {
  readonly brief: string;
  readonly source: WorkOrderSource;
  /** Routed work orders: the reference material and project they brought along. */
  readonly inputs?: WorkOrderInputs;
  readonly maxReviewRounds: number;
  readonly plan?: Plan;
  readonly stations: readonly Station[];
  readonly release?: ReleaseSummary;
  readonly owner?: { readonly login: string; readonly avatarUrl?: string };
  /** Agent-led: sandboxes (workers) the coordinator created, replacements included. */
  readonly workersStarted?: number;
  /** GitHub work orders (`source.kind === "github"`). */
  readonly github?: GitHubWork;
}

export interface WorkOrderTemplate {
  readonly id: string;
  readonly title: string;
  readonly tagline: string;
  readonly brief: string;
  /** Rough wall-clock estimate, e.g. "~4 min". */
  readonly estimate: string;
  readonly tags: readonly string[];
  /** The scripted happy path used by `pnpm happy-path` and the README. */
  readonly featured?: boolean;
}

export interface CreateWorkOrderRequest {
  readonly title: string;
  readonly brief: string;
  readonly templateId?: string;
  /** 1-3; defaults to 2. */
  readonly maxReviewRounds?: number;
  /** Defaults to `agent`. Ignored for GitHub work orders, which the factory drives itself. */
  readonly mode?: WorkOrderMode;
  /**
   * A change to an existing repository instead of a new project: the factory checks out its default branch, makes the
   * change in a sandbox, and opens a pull request. `title` may be empty (it comes from the issue or the request).
   */
  readonly github?: {
    /** `owner/name`. */
    readonly repository: string;
    readonly issue?: number;
  };
  /** Set by an app that routes work to the factory: the floor shows where the work order came from, with a link back. */
  readonly origin?: WorkOrderOrigin;
  /**
   * Reference material (bug reports, findings, data): up to 12 text files, 256 KB each and 512 KB together. Every
   * sandbox gets them under `.factory/context/`, and the planner reads them. Not for GitHub work orders.
   */
  readonly context?: readonly InputFile[];
  /**
   * An existing project to change instead of starting empty: up to 300 text files, 512 KB each and 2 MB together,
   * `package.json` included. Every builder's and the release's workspace starts from these files, and the release
   * reports what changed. Not for GitHub work orders.
   */
  readonly project?: { readonly name: string; readonly files: readonly InputFile[] };
}

/** `POST /api/work-orders/:id/revisions`: more changes to a GitHub work order's pull request. */
export interface CreateRevisionRequest {
  readonly request: string;
}

/** `POST /api/work-orders/:id/merge`. */
export interface MergeRequest {
  /** Defaults to `squash`. */
  readonly method?: "merge" | "squash" | "rebase";
}

// ─── Activity ────────────────────────────────────────────────────────────────────────────────────────────────

export type ActivityKind =
  /** Station lifecycle, e.g. "Sandbox sbx_7f3a ready (small, restricted network)". */
  | "status"
  /** A complete assistant message (markdown). */
  | "message"
  /** The agent's stated intent, e.g. "Writing the CSV parser". */
  | "intent"
  | "tool"
  /** A test run of the factory harness, with its summary. */
  | "test"
  | "skill"
  | "review"
  | "artifact"
  /** Agent-led: something the coordinator decided, e.g. "Created builder-csv2json in factory-builder". */
  | "decision"
  | "error";

export type DecisionAction =
  | "create"
  | "prepare"
  | "message"
  | "wait"
  | "check"
  | "review"
  | "copy"
  | "read"
  | "list"
  | "stop"
  | "status"
  | "declined";

/** A coordinator decision (`ActivityItem.kind === "decision"`); `text` says it in a sentence with **names** in bold. */
export interface DecisionView {
  readonly action: DecisionAction;
  readonly status: "running" | "done" | "failed";
  /** Workers it concerns, by name. */
  readonly workers?: readonly string[];
  /** `new` when it created a sandbox, `reused` when it sent work to one that already existed. */
  readonly tag?: "new" | "reused";
}

export interface ToolActivity {
  readonly callId: string;
  readonly name: string;
  /** One-line summary: the shell command, the file path, or the tool title. */
  readonly summary: string;
  readonly status: "running" | "succeeded" | "failed";
  /** Truncated output or result text. */
  readonly output?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

export interface ActivityItem {
  /** Stable ID; an item is replaced when the server re-sends the same ID (e.g. a tool call completing). */
  readonly id: string;
  readonly workOrderId: string;
  readonly stationId: string;
  readonly at: string;
  readonly kind: ActivityKind;
  /** Message or status text (markdown for `message`). */
  readonly text?: string;
  readonly tool?: ToolActivity;
  readonly tests?: TestSummary;
  readonly review?: { readonly round: number; readonly verdict: ReviewVerdict; readonly findings: number };
  readonly decision?: DecisionView;
  /** Set when a sub-agent produced the item. */
  readonly subagent?: string;
  readonly level?: "info" | "success" | "warning" | "error";
}

// ─── Artifacts ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ArtifactVersionView {
  readonly version: number;
  readonly size: number;
  readonly digest: string;
  readonly publishedAt: string;
  /** The build/review round that produced this version. */
  readonly round: number;
  /** False when this version is binary or too large for the factory to keep (no preview or download). */
  readonly viewable: boolean;
}

export interface ArtifactFileView {
  readonly stationId: string;
  /** Path relative to `/workspace/outputs`. */
  readonly path: string;
  readonly contentType: string;
  /** Newest first. */
  readonly versions: readonly ArtifactVersionView[];
  /** The newest version's `viewable`. */
  readonly viewable: boolean;
  /** An image or recording the factory kept: preview it from `/media`. */
  readonly media?: boolean;
}

export interface ArtifactIndex {
  readonly workOrderId: string;
  readonly files: readonly ArtifactFileView[];
}

// ─── Sandbox kit outputs (`/workspace/outputs`, written by the factory-check skill) ──────────────────────────

/** `outputs/test-report.json` */
export interface TestReport {
  readonly schema: "factory.test-report/v1";
  readonly mode: "task" | "release";
  readonly taskId?: string;
  /** The command that ran, e.g. `node --test test/csv.test.js`. */
  readonly command: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  /** Test files that ran, relative to the project root. */
  readonly files: readonly string[];
  readonly tests: readonly {
    readonly name: string;
    readonly file?: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly durationMs?: number;
    readonly error?: string;
  }[];
  /** Tail of the human-readable test output. */
  readonly output?: string;
}

/** `outputs/manifest.json` */
export interface OutputManifest {
  readonly schema: "factory.manifest/v1";
  readonly mode: "task" | "release";
  readonly taskId?: string;
  readonly generatedAt: string;
  /** Builder mode: files the task added or changed (published under `outputs/files/`). Release: the bundle. */
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    /** Builder mode: whether the plan assigned this file to the task. */
    readonly owned?: boolean;
  }[];
}

/** Last line the harness prints, so live tool output reveals test results before publication. */
export const TEST_SUMMARY_MARKER = "FACTORY_TEST_SUMMARY";

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FactoryState {
  readonly platform: PlatformStatus;
  readonly workOrders: readonly WorkOrderSummary[];
  readonly templates: readonly WorkOrderTemplate[];
  /** Command shown for "Open in Copilot CLI"; `{sessionId}` is replaced. */
  readonly attachCommand: string;
  /** Whether the server can launch a terminal window on this machine. */
  readonly canLaunchTerminal: boolean;
  /** The GitHub account the factory browses repositories and opens pull requests with. */
  readonly github: GitHubStatus;
}

export interface AttachResponse {
  readonly command: string;
  readonly launched: boolean;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: FactoryError;
}

/** Messages on `GET /api/events` (server-sent events; the SSE `event` field is `type`). */
export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus }
  | { readonly type: "workOrder"; readonly workOrder: WorkOrder }
  | { readonly type: "workOrderDeleted"; readonly workOrderId: string }
  | { readonly type: "activity"; readonly item: ActivityItem }
  /** Streaming assistant text, not persisted; superseded by the `message` activity with the same `messageId`. */
  | {
      readonly type: "delta";
      readonly workOrderId: string;
      readonly stationId: string;
      readonly messageId: string;
      readonly text: string;
    }
  | { readonly type: "artifacts"; readonly workOrderId: string };

export const ACTIVE_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = ["queued", "planning", "building", "releasing"];
export const TERMINAL_STATION_STATUSES: readonly StationStatus[] = ["done", "failed", "cancelled", "skipped"];

/** A work order's mode; records from before agent-led mode existed are classic. */
export function workOrderMode(workOrder: Pick<WorkOrderSummary, "mode">): WorkOrderMode {
  return workOrder.mode ?? "classic";
}

/** Whether a work order changes an existing GitHub repository (and ends in a pull request) rather than building a project. */
export function isGitHubWorkOrder(workOrder: { readonly source?: WorkOrderSource; readonly github?: unknown }): boolean {
  return workOrder.source?.kind === "github" || workOrder.github !== undefined;
}

/** Media types the factory keeps, serves, and attaches to pull requests (no SVG: it can carry script). */
export const MEDIA_TYPES: Readonly<Record<string, { readonly contentType: string; readonly kind: "image" | "video" }>> = {
  png: { contentType: "image/png", kind: "image" },
  jpg: { contentType: "image/jpeg", kind: "image" },
  jpeg: { contentType: "image/jpeg", kind: "image" },
  gif: { contentType: "image/gif", kind: "image" },
  webp: { contentType: "image/webp", kind: "image" },
  mp4: { contentType: "video/mp4", kind: "video" },
  webm: { contentType: "video/webm", kind: "video" },
  mov: { contentType: "video/quicktime", kind: "video" },
};

export function mediaTypeOf(path: string): { readonly contentType: string; readonly kind: "image" | "video" } | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : undefined;
}

export function formatWorkOrderNumber(n: number): string {
  return `WO-${String(n).padStart(4, "0")}`;
}
