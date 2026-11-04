/** Types shared by Repo Doctor's server and its UI. */

/** A run's steps, in order. Each one runs in the run's sandbox. */
export const STEP_IDS = ["checkout", "setup", "reproduce", "fix", "patch", "verify"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Readonly<Record<StepId, string>> = {
  checkout: "Checkout",
  setup: "Set up",
  reproduce: "Reproduce",
  fix: "Fix",
  patch: "Patch",
  verify: "Verify",
};

/** Who acts in the sandbox during a step: Copilot's agent loop, or Repo Doctor itself, running commands directly. */
export type Actor = "copilot" | "app";

export const STEP_ACTORS: Readonly<Record<StepId, Actor>> = {
  checkout: "app",
  setup: "copilot",
  reproduce: "app",
  fix: "copilot",
  patch: "app",
  verify: "app",
};

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/**
 * - `fixed`: the tests failed, Copilot changed the code, and the same tests now pass.
 * - `healthy`: the tests already passed, so there was nothing to fix.
 * - `not_fixed`: Copilot made changes, but tests still fail.
 * - `failed`: the run couldn't finish (the clone, setup, or the platform failed).
 */
export type RunStatus = "running" | "fixed" | "healthy" | "not_fixed" | "failed" | "stopped";

export interface LogLine {
  /** `blocked`: a request from the sandbox that its network rules refused, as the platform reported it. */
  readonly kind: "command" | "output" | "message" | "edit" | "read" | "note" | "blocked" | "error";
  /** Increases with every line of a run, across its steps. */
  readonly seq: number;
  readonly text: string;
  readonly at: string;
  /** Commands: how the command exited, once it did. */
  readonly exitCode?: number;
}

export interface StepView {
  readonly id: StepId;
  readonly status: StepStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** The step's result in a few words ("2 failing", "+3 −1", "npm test"). */
  readonly summary?: string;
  /** While it runs: what's happening now (Copilot's stated intent, or the command running). */
  readonly activity?: string;
}

export interface TestReport {
  readonly command: string;
  /** Absent when the command didn't finish (it timed out or was stopped). */
  readonly exitCode?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
  /** Failing tests' names as the test runner printed them (at most 20). */
  readonly failures: readonly string[];
  readonly durationMs: number;
  /** The end of the output. */
  readonly tail: string;
}

export interface PatchFileStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PatchView {
  readonly text: string;
  readonly files: readonly PatchFileStat[];
  readonly additions: number;
  readonly deletions: number;
}

/** What an allowed host serves: GitHub, the npm registry, the pip index, or something else the environment allows. */
export type HostRole = "github" | "npm" | "pip" | "other";

export interface AllowedHost {
  /** A host name, or a `*.example.com` pattern. */
  readonly host: string;
  readonly roles: readonly HostRole[];
  /** Set once a command that reaches this host succeeded: inferred from the command, not reported by the network. */
  readonly used?: { readonly at: string; readonly by: string };
}

export interface BlockedHost {
  readonly host: string;
  readonly port?: number;
  /** The platform's reason code, such as `host_not_allowed`. */
  readonly reason: string;
  /** Blocked attempts the platform reported (it reports a host at most every 10 seconds). */
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  /** The Copilot runtime's own call to GitHub's Copilot service: expected, since model calls go through the platform. */
  readonly runtime: boolean;
}

export interface NetworkView {
  readonly access: "restricted" | "enabled" | "disabled" | "unknown";
  readonly allowed: readonly AllowedHost[];
  readonly blocked: readonly BlockedHost[];
}

export type SandboxState = "creating" | "ready" | "deleting" | "deleted" | "failed";

export interface SandboxView {
  readonly state: SandboxState;
  readonly environment: string;
  readonly id?: string;
  readonly size?: string;
  /** How long the sandbox took to be ready. */
  readonly readyMs?: number;
}

export type RunSource =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly ref?: string }
  | { readonly kind: "sample" };

export interface RunSummary {
  readonly id: string;
  /** Shown as #n. */
  readonly number: number;
  readonly source: RunSource;
  /** `owner/repo`, or the sample's name. */
  readonly title: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly failingBefore?: number;
  readonly failingAfter?: number;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface RunView extends RunSummary {
  readonly model: string;
  readonly sessionId?: string;
  readonly sandbox: SandboxView;
  readonly steps: readonly StepView[];
  readonly testCommand?: string;
  readonly before?: TestReport;
  readonly after?: TestReport;
  readonly patch?: PatchView;
  /** Copilot's own words on the root cause and the fix. */
  readonly diagnosis?: string;
  readonly network: NetworkView;
  readonly error?: { readonly code: string; readonly message: string };
}

export type StepLogs = Readonly<Record<StepId, readonly LogLine[]>>;

export interface RunDetail {
  readonly run: RunView;
  readonly logs: StepLogs;
}

export interface AccountView {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface EnvironmentView {
  readonly name: string;
  readonly size?: string;
  readonly network: { readonly access: string; readonly hosts: readonly string[] };
}

export interface PlatformStatus {
  readonly state: "connecting" | "connected" | "reconnecting" | "unavailable";
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: AccountView;
  /** Why it isn't connected, in plain words. */
  readonly message?: string;
  /** Repo Doctor's environment, as the deployment declares it. */
  readonly environment?: EnvironmentView;
}

export interface SampleInfo {
  readonly name: string;
  readonly description: string;
}

export interface AppState {
  readonly platform: PlatformStatus;
  /** Newest first. */
  readonly runs: readonly RunSummary[];
  readonly sample: SampleInfo;
  readonly model: string;
  /** How many runs can go at once. */
  readonly maxRuns: number;
}

/** `POST /api/runs`: a public GitHub repository, or the bundled sample project. */
export type CreateRunRequest = { readonly repo: string } | { readonly sample: true };

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus }
  | { readonly type: "run"; readonly run: RunView }
  | { readonly type: "run.deleted"; readonly id: string }
  | { readonly type: "log"; readonly runId: string; readonly step: StepId; readonly line: LogLine };

export function summarize(run: RunView): RunSummary {
  return {
    id: run.id,
    number: run.number,
    source: run.source,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.failingBefore !== undefined ? { failingBefore: run.failingBefore } : {}),
    ...(run.failingAfter !== undefined ? { failingAfter: run.failingAfter } : {}),
    ...(run.additions !== undefined ? { additions: run.additions } : {}),
    ...(run.deletions !== undefined ? { deletions: run.deletions } : {}),
  };
}
