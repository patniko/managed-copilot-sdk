// The contract between the Dispatch server and its web UI: REST bodies and server-sent events.

export type WorkerState = "starting" | "working" | "idle" | "failed" | "stopped";

export interface AccountView {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export type PlatformState = "connecting" | "connected" | "reconnecting" | "unavailable";

export interface PlatformStatus {
  readonly state: PlatformState;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: AccountView;
  /** What is wrong, in plain words, when not connected. */
  readonly message?: string;
}

export type BlueprintKind = "python" | "node" | "web" | "writer" | "other";

export interface NetworkView {
  readonly access: "enabled" | "disabled" | "restricted";
  readonly hosts: readonly string[];
}

/** A worker environment the coordinator can create sandboxes from. */
export interface Blueprint {
  readonly name: string;
  readonly kind: BlueprintKind;
  /** Short human name, for example "Python lab". */
  readonly label: string;
  readonly description?: string;
  readonly size: string;
  readonly cpus?: number;
  readonly memoryGiB?: number;
  readonly network: NetworkView;
  readonly agents: readonly string[];
  /** The coordinator's default when it names none. */
  readonly isDefault: boolean;
}

export interface CoordinatorInfo {
  readonly environment: string;
  readonly model: string;
  readonly maxWorkers: number;
  readonly description?: string;
}

/** What one coordinator tool call did, attributed to the user message it served. */
export type DecisionKind = "create" | "message" | "copy" | "stop" | "wait" | "read" | "list";
export type DecisionStatus = "asking" | "running" | "done" | "failed" | "denied";

export interface Decision {
  /** The tool call's ID. */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly status: DecisionStatus;
  readonly at: string;
  readonly endedAt?: string;
  /** The worker it concerns (create, message, stop, read). */
  readonly worker?: string;
  /** Workers waited for (wait). */
  readonly workers?: readonly string[];
  /** The blueprint a new sandbox comes from (create). */
  readonly environment?: string;
  /** The task (create) or the follow-up (message). */
  readonly task?: string;
  readonly from?: string;
  readonly to?: string;
  readonly paths?: readonly string[];
  readonly path?: string;
  /** The outcome in one line. */
  readonly detail?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "notice";
  readonly content: string;
  readonly at: string;
  /** User messages: their number in the conversation (#1, #2, ...). */
  readonly index?: number;
  /** User messages: sent from Dispatch, or from another client of the same session such as Copilot CLI. */
  readonly via?: "dispatch" | "other";
  /** User messages sent while the coordinator was busy: steering (same turn) or queued (next turn). */
  readonly delivery?: "steering" | "queued";
  readonly streaming?: boolean;
  /** User messages: what the coordinator did for this message. */
  readonly decisions?: readonly Decision[];
  readonly tone?: "danger" | "attention";
}

/** A sandbox the coordinator asked to create, waiting for the person's decision. */
export interface Approval {
  readonly id: string;
  /** The `start_worker` call it gates. */
  readonly decisionId?: string;
  readonly worker: string;
  readonly environment: string;
  readonly task: string;
  readonly agent?: string;
  readonly model?: string;
  readonly requestedAt: string;
  /** The user message it serves. */
  readonly messageIndex?: number;
}

export interface FileView {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface WorkerView {
  readonly id: string;
  readonly name: string;
  readonly environment: string;
  readonly state: WorkerState;
  readonly task: string;
  readonly result?: string;
  readonly error?: string;
  /** Messages it received, its task included. */
  readonly tasks: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agent?: string;
  readonly model?: string;
  readonly sandbox?: { readonly id: string; readonly state?: string; readonly size?: string };
  /** The user message whose handling created it. */
  readonly createdBy?: number;
  /** User messages whose handling sent it more work. */
  readonly sentWorkBy: readonly number[];
  /** Files it published in `outputs/`. */
  readonly outputs: readonly string[];
  /** Its workspace, as last listed. */
  readonly files?: readonly FileView[];
  readonly filesAt?: string;
  /** State changes as Dispatch saw them, for the timeline. */
  readonly timeline: readonly { readonly state: WorkerState; readonly at: string }[];
}

export type ApprovalMode = "ask" | "auto";

export interface ConversationSettings {
  /** Ask the person before each new sandbox, or create them as the coordinator decides. */
  readonly approvals: ApprovalMode;
}

export type ConversationStatus = "idle" | "working" | "asking" | "unavailable";

export interface ConversationSummary {
  /** The coordinator session's ID. */
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ConversationStatus;
  readonly messageCount: number;
  /** Sandboxes created, stopped ones included. */
  readonly sandboxCount: number;
  /** Sandboxes that still exist. */
  readonly liveSandboxes: number;
}

export interface ConversationView extends ConversationSummary {
  readonly messages: readonly ChatMessage[];
  readonly workers: readonly WorkerView[];
  readonly approvals: readonly Approval[];
  readonly settings: ConversationSettings;
  /** The coordinator's turn is running. */
  readonly busy: boolean;
  /** The coordinator is waiting for these workers (no model time). */
  readonly waiting?: { readonly workers: readonly string[]; readonly since: string };
  /** Why the conversation can't be used right now. */
  readonly problem?: string;
  readonly attachCommand: string;
}

export interface Template {
  readonly id: string;
  readonly title: string;
  /** An Octicon name. */
  readonly icon: string;
  readonly description: string;
  readonly prompt: string;
  /** The sandboxes it usually needs. */
  readonly uses: readonly { readonly kind: BlueprintKind; readonly count: number }[];
  readonly minutes: number;
  /** Follow-ups that show the coordinator reusing its sandboxes. */
  readonly followUps: readonly string[];
}

export interface DispatchState {
  readonly platform: PlatformStatus;
  readonly coordinator?: CoordinatorInfo;
  readonly blueprints: readonly Blueprint[];
  readonly conversations: readonly ConversationSummary[];
  readonly templates: readonly Template[];
  readonly defaults: ConversationSettings;
  /** `npx managed-copilot attach {sessionId}`, with `--url` when users reach the platform at another address. */
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus; readonly coordinator?: CoordinatorInfo; readonly blueprints: readonly Blueprint[] }
  | { readonly type: "conversations"; readonly conversations: readonly ConversationSummary[] }
  | { readonly type: "conversation"; readonly conversation: ConversationView }
  | { readonly type: "removed"; readonly id: string };

export interface CreateConversationRequest {
  readonly prompt: string;
  readonly approvals?: ApprovalMode;
}

export interface SendMessageRequest {
  readonly prompt: string;
}

export interface ApprovalAnswer {
  readonly approve: boolean;
  /** Why the person declined, passed to the coordinator (for example "use the Node environment for this"). */
  readonly reason?: string;
}

export interface SettingsRequest {
  readonly approvals: ApprovalMode;
}

export interface AttachResponse {
  readonly command: string;
  readonly launched: boolean;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
