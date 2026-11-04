/** Research Swarm's API and server-sent events, shared by the server and the web UI. */

/**
 * - `planning`: the lead is splitting the question.
 * - `researching`: researchers are reading the web.
 * - `writing`: the lead is writing the report from their findings.
 * - `done`: the report is ready.
 * - `failed` / `stopped`: it ended without a report.
 */
export type RunStatus = "planning" | "researching" | "writing" | "done" | "failed" | "stopped";

export type ResearcherState = "queued" | "starting" | "reading" | "done" | "failed" | "stopped";

/** A page a researcher read with `research read`, as its sandbox recorded it. */
export interface PageRead {
  readonly url: string;
  readonly title: string;
  readonly host: string;
  readonly at?: string;
}

/** A host the researcher's sandbox network rules refused (`network.blocked`). */
export interface BlockedHost {
  readonly host: string;
  readonly reason: string;
  readonly at: string;
}

export interface Researcher {
  /** `r1`, `r2`, …: the worker name the lead starts it with. */
  readonly id: string;
  readonly question: string;
  readonly state: ResearcherState;
  readonly pages: readonly PageRead[];
  readonly blocked: readonly BlockedHost[];
  /** The worker's own session ID, once it started. */
  readonly workerId?: string;
  readonly sandboxId?: string;
  readonly environment?: string;
  readonly model?: string;
  /** Its report to the lead (Markdown). */
  readonly report?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface ReportSource {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly host: string;
  /** The researchers that read it, in plan order. */
  readonly readBy: readonly string[];
}

export interface Report {
  readonly title: string;
  /** The direct answer, in a sentence or two. */
  readonly summary: string;
  /** Markdown. Citations are `[n]`, numbered by first appearance into `sources`. */
  readonly body: string;
  readonly sources: readonly ReportSource[];
}

export interface Run {
  readonly id: string;
  readonly question: string;
  readonly status: RunStatus;
  /** What the lead is doing now, while it works. */
  readonly activity?: string;
  readonly researchers: readonly Researcher[];
  readonly report?: Report;
  readonly error?: string;
  /** The lead's session, once created. */
  readonly sessionId?: string;
  readonly model: string;
  /** The lead's session, and with it every researcher's sandbox, was deleted when the run ended. */
  readonly cleanedUp?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
}

export interface RunSummary {
  readonly id: string;
  readonly question: string;
  readonly title?: string;
  readonly status: RunStatus;
  readonly researchers: number;
  readonly sources: number;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

/** Where a run's work happens, as this deployment declares it. */
export interface SwarmInfo {
  readonly lead: { readonly environment: string; readonly model: string };
  readonly researchers: {
    readonly environment: string;
    readonly model: string;
    /** Researchers one question can have at once. */
    readonly max: number;
    readonly size?: string;
    /** Hosts their sandboxes may reach. */
    readonly hosts: readonly string[];
  };
}

export type PlatformState = "connecting" | "connected" | "reconnecting" | "unavailable";

export interface PlatformStatus {
  readonly state: PlatformState;
  readonly message?: string;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: { readonly login: string; readonly name?: string; readonly avatarUrl?: string };
}

export interface AppState {
  readonly platform: PlatformStatus;
  readonly swarm?: SwarmInfo;
  /** Most recent first. */
  readonly runs: readonly RunSummary[];
}

export type ServerEvent =
  | { readonly type: "state"; readonly state: AppState }
  | { readonly type: "run"; readonly run: Run }
  | { readonly type: "removed"; readonly id: string };

export interface StartRunRequest {
  readonly question: string;
  /** The most researchers the lead may plan, from 2 to the deployment's limit. Defaults to the limit. */
  readonly researchers?: number;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** Research Swarm's local port, before MANAGED_COPILOT_PORT_OFFSET. */
export const DEFAULT_PORT = 7425;

/** The longest question the app takes. */
export const QUESTION_MAX = 500;

/** Questions that work well with the researchers' sites. */
export const SAMPLE_QUESTIONS: readonly string[] = [
  "How does WebAssembly garbage collection work, and which browsers support it?",
  "What are the trade-offs of Python's free-threaded build?",
  "How do Node.js and Python differ in how they handle async I/O?",
  "What is retrieval-augmented generation, and where does it fall short?",
];
