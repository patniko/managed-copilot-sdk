// The contract between Data Desk's server and its UI: REST answers and server-sent events.

export type PlatformState = "connecting" | "connected" | "reconnecting" | "unavailable";

export interface AccountView {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface PlatformStatus {
  readonly state: PlatformState;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: AccountView;
  /** What is wrong, in plain words, when not connected. */
  readonly message?: string;
}

/** One of the environments Data Desk uses, as the deployment declares it. */
export interface EnvironmentView {
  readonly name: string;
  readonly type: string;
  readonly network: "enabled" | "disabled" | "restricted";
  readonly size?: string;
}

// ─── Datasets ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ColumnType = "number" | "date" | "text";

export interface ColumnInfo {
  readonly name: string;
  readonly type: ColumnType;
  /** Empty values. */
  readonly missing: number;
  /** Numbers and dates: the smallest and largest value. */
  readonly min?: number | string;
  readonly max?: number | string;
  /** Numbers only. */
  readonly mean?: number;
  readonly sum?: number;
  /** Text only: how many different values, and the most common ones. */
  readonly distinct?: number;
  readonly top?: readonly { readonly value: string; readonly count: number }[];
}

/** A prompt to start with: one the app's own tools answer, or one that needs code (and so a sandbox). */
export interface SuggestedPrompt {
  readonly text: string;
  readonly needs: "tools" | "code";
}

export interface DatasetSummary {
  /** `sample-<name>` for the bundled ones, `upload-<digest>` for uploaded files. */
  readonly id: string;
  readonly name: string;
  /** The file's name in the sandbox, under `data/`. */
  readonly fileName: string;
  readonly description?: string;
  readonly sample: boolean;
  readonly rows: number;
  readonly bytes: number;
  readonly columns: readonly ColumnInfo[];
  readonly prompts: readonly SuggestedPrompt[];
}

/** A page of a dataset's rows for the grid. */
export interface RowsPage {
  readonly offset: number;
  readonly total: number;
  readonly rows: readonly (readonly string[])[];
}

// ─── Analyses ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where an analysis's session runs: on the shared runtime, on its way into a sandbox, or in its own sandbox. */
export type Placement = "shared" | "moving" | "sandbox";

/** A table the agent made with one of Data Desk's tools; the grid shows it. */
export interface ResultView {
  /** The tool call that made it. */
  readonly id: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Rows or groups that matched, before the limit. */
  readonly total: number;
  /** What it counts: filtered rows (`query_rows`) or groups (`aggregate`). */
  readonly unit: "row" | "group";
  readonly at: string;
}

/** What a tool call is to a person reading along. */
export type StepType = "data" | "move" | "shell" | "file" | "read" | "other";
export type StepStatus = "running" | "done" | "failed" | "asking" | "declined";

export type ChatItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly at: string; readonly via: "app" | "cli" }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly at: string; readonly streaming?: boolean }
  | {
      readonly kind: "step";
      readonly id: string;
      readonly tool: string;
      readonly type: StepType;
      readonly label: string;
      /** The full command or arguments, for a tooltip. */
      readonly detail?: string;
      readonly status: StepStatus;
      readonly at: string;
      /** One line on how it ended: rows matched, an exit code, why it failed. */
      readonly outcome?: string;
      /** A `ResultView` this step made. */
      readonly resultId?: string;
    }
  | { readonly kind: "moved"; readonly id: string; readonly at: string; readonly durationMs?: number; readonly sandboxId?: string }
  | { readonly kind: "error"; readonly id: string; readonly text: string; readonly at: string };

/** The agent asked to move into a sandbox and waits for the person. */
export interface MoveRequest {
  readonly id: string;
  readonly reason: string;
  readonly requestedAt: string;
}

/** A file the agent published under `outputs/`: charts show as images, the rest as files. */
export interface OutputFile {
  readonly path: string;
  readonly version: number;
  readonly size: number;
  readonly publishedAt?: string;
  readonly kind: "chart" | "file";
}

export interface UsageView {
  /** Premium requests the session has used, across the move. */
  readonly premiumRequests: number;
  /** Of those, the ones counted when it moved: its time on the shared runtime. */
  readonly beforeMove?: number;
}

export interface AnalysisSummary {
  /** The session ID: the same before and after the move. */
  readonly id: string;
  readonly title: string;
  readonly datasetId: string;
  readonly placement: Placement;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly busy: boolean;
  /** Waiting for the person to answer a move request. */
  readonly needsYou: boolean;
  readonly charts: number;
}

export interface AnalysisView extends AnalysisSummary {
  readonly dataset?: DatasetSummary;
  readonly model: string;
  readonly items: readonly ChatItem[];
  readonly results: readonly ResultView[];
  readonly outputs: readonly OutputFile[];
  readonly moveRequest?: MoveRequest;
  /** Set once it moved. */
  readonly sandboxId?: string;
  readonly movedAt?: string;
  readonly moveMs?: number;
  /** When the move started (approved), while it runs. */
  readonly movingSince?: string;
  readonly usage?: UsageView;
  /** Something went wrong that the person should know: one line. */
  readonly problem?: string;
}

// ─── API ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeskState {
  readonly platform: PlatformStatus;
  readonly environments: readonly EnvironmentView[];
  readonly datasets: readonly DatasetSummary[];
  readonly analyses: readonly AnalysisSummary[];
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
  /** Largest CSV upload, in bytes. */
  readonly maxUploadBytes: number;
}

export interface CreateAnalysisRequest {
  readonly datasetId: string;
}

export interface SendMessageRequest {
  readonly prompt: string;
}

export interface MoveAnswer {
  readonly approve: boolean;
}

export interface AttachResponse {
  readonly command: string;
  readonly launched: boolean;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus; readonly environments: readonly EnvironmentView[] }
  | { readonly type: "datasets"; readonly datasets: readonly DatasetSummary[] }
  | { readonly type: "analyses"; readonly analyses: readonly AnalysisSummary[] }
  | { readonly type: "analysis"; readonly analysis: AnalysisView }
  | { readonly type: "removed"; readonly id: string };
