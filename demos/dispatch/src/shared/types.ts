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

/**
 * How a coordinator gets work done (spec section 17): `delegate` starts worker agents in their own sandboxes; `direct`
 * runs commands and edits files itself, with its sub-agents, in a sandbox with no agent in it; `mixed` does either.
 */
export type ExecutionStyle = "delegate" | "direct" | "mixed";

export interface CoordinatorInfo {
  readonly environment: string;
  readonly model: string;
  readonly maxWorkers: number;
  readonly description?: string;
  readonly style: ExecutionStyle;
}

/** One position of the execution style switch: the orchestrator environment new conversations of that style use. */
export interface StyleInfo {
  readonly style: ExecutionStyle;
  readonly environment: string;
  /** Declared on this deployment with that execution style. */
  readonly available: boolean;
  /** Why it isn't available, in plain words. */
  readonly reason?: string;
  readonly coordinator?: CoordinatorInfo;
  /** Direct and mixed: the environment of the coordinator's own sandbox. */
  readonly handsEnvironment?: string;
  /** Direct and mixed: one sandbox for the coordinator and its sub-agents (`shared`), or one per sub-agent (`own`). */
  readonly subagents?: "shared" | "own";
  /** Delegate and mixed: the environments it can create workers from. */
  readonly workers: readonly string[];
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
  /** That worker's session ID, once it is known. */
  readonly workerId?: string;
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

/** What a hands tool call does, to a person reading along. */
export type CommandKind = "run" | "input" | "output" | "stop" | "list" | "create" | "edit" | "view" | "search";
export type CommandStatus = "asking" | "running" | "done" | "failed" | "denied";

/** One hands tool call (bash, create, edit, view, ...) by the coordinator or one of its sub-agents, in its own sandbox. */
export interface Command {
  /** The tool call's ID. */
  readonly id: string;
  readonly tool: string;
  readonly kind: CommandKind;
  readonly status: CommandStatus;
  readonly at: string;
  readonly endedAt?: string;
  /** The sub-agent that made the call; absent for the coordinator itself. */
  readonly agentId?: string;
  /** The command (bash) or the input sent (write_bash). */
  readonly command?: string;
  /** What the agent said the command is for (bash's `description`). */
  readonly description?: string;
  /** The file or directory (create, edit, view) or where a search looked. */
  readonly path?: string;
  /** What a search looked for (glob, grep). */
  readonly pattern?: string;
  /** The command it concerns (read_bash, write_bash, stop_bash), or the one bash started. */
  readonly shellId?: string;
  readonly exitCode?: number;
  /** The outcome in a few words, for example "exit code 0", "still running", or why it failed. */
  readonly outcome?: string;
  /** The end of its output, as the agent saw it. */
  readonly output?: string;
}

/** A stock sub-agent the coordinator started with its `task` tool (direct and mixed). */
export interface SubAgent {
  /** The sub-agent's ID (the `agentId` on its events and tool calls), once it started. */
  readonly id?: string;
  /** The `task` call that started it. */
  readonly toolCallId: string;
  readonly name: string;
  readonly description?: string;
  readonly type?: string;
  readonly status: "running" | "done" | "failed";
  readonly at: string;
  readonly endedAt?: string;
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
  /** User messages: the runtime's message ID, which `session.send` returns to the sender. */
  readonly messageId?: string;
  readonly streaming?: boolean;
  /** User messages: what the coordinator did for this message. */
  readonly decisions?: readonly Decision[];
  /** User messages: the commands the coordinator and its sub-agents ran in their own sandbox for it (direct, mixed). */
  readonly commands?: readonly Command[];
  /** User messages: the sub-agents the coordinator started for it. */
  readonly subagents?: readonly SubAgent[];
  readonly tone?: "danger" | "attention";
}

/**
 * Something the coordinator wants to do, waiting for the person's decision: a new sandbox (`start_worker`), or a
 * command or file change in its own sandbox (`bash`, `write_bash`, `create`, `edit`).
 */
export interface Approval {
  readonly id: string;
  readonly kind: "sandbox" | "command";
  /** The tool call it gates: a decision (sandbox) or a command. */
  readonly decisionId?: string;
  /** Sandbox: the worker's name, blueprint, and task. */
  readonly worker?: string;
  readonly environment?: string;
  readonly task?: string;
  readonly agent?: string;
  readonly model?: string;
  /** Command: the tool, and what it would run or change. */
  readonly tool?: string;
  readonly command?: string;
  readonly path?: string;
  /** Command: the sub-agent asking; absent for the coordinator. */
  readonly agentId?: string;
  readonly requestedAt: string;
  /** The user message it serves. */
  readonly messageIndex?: number;
}

/** A command recorded in a sandbox the coordinator works in (`managed.exec.list`): durable, whoever ran it. */
export interface CommandRecord {
  readonly id: string;
  readonly command: string;
  readonly state: string;
  readonly exitCode?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly background: boolean;
  /** The tool that ran it (`bash`), or "api" for `managed.exec`. */
  readonly tool: string;
  /** The sub-agent that ran it; absent for the coordinator. */
  readonly agentId?: string;
}

export interface FileView {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface WorkerView {
  readonly id: string;
  /** `hands`: the sandbox a direct or mixed coordinator (or one of its sub-agents) works in itself, with no agent in it. */
  readonly role: "worker" | "hands";
  /** Hands sandboxes of one sub-agent (`subagents: "own"`). */
  readonly agentId?: string;
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
  /** User messages whose handling sent it more work (hands: ran commands in it). */
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
  /** The execution style of the orchestrator environment it was created in (fixed for the conversation). */
  readonly style: ExecutionStyle;
  readonly environment: string;
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
  /** Sub-agents by ID, for labelling their commands (including ones started for earlier messages). */
  readonly agents: Readonly<Record<string, string>>;
  /** Messages whose remaining commands were approved at once ("approve the rest of this message"). */
  readonly approvedRest: readonly number[];
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

/** New conversations' defaults. */
export interface ConversationDefaults extends ConversationSettings {
  readonly style: ExecutionStyle;
}

export interface DispatchState {
  readonly platform: PlatformStatus;
  /** The default style's coordinator. */
  readonly coordinator?: CoordinatorInfo;
  /** The execution style switch: delegate, direct, and mixed, each with its orchestrator environment. */
  readonly styles: readonly StyleInfo[];
  readonly blueprints: readonly Blueprint[];
  readonly conversations: readonly ConversationSummary[];
  readonly templates: readonly Template[];
  readonly defaults: ConversationDefaults;
  /** `npx managed-copilot attach {sessionId}`, with `--url` when users reach the platform at another address. */
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
}

export type ServerEvent =
  | {
      readonly type: "platform";
      readonly platform: PlatformStatus;
      readonly coordinator?: CoordinatorInfo;
      readonly styles: readonly StyleInfo[];
      readonly blueprints: readonly Blueprint[];
    }
  | { readonly type: "conversations"; readonly conversations: readonly ConversationSummary[] }
  | { readonly type: "conversation"; readonly conversation: ConversationView }
  | { readonly type: "removed"; readonly id: string };

export interface CreateConversationRequest {
  readonly prompt: string;
  readonly approvals?: ApprovalMode;
  /** Which orchestrator environment to create it in. Defaults to the deployment's default style. */
  readonly style?: ExecutionStyle;
}

export interface SendMessageRequest {
  readonly prompt: string;
}

export interface SendMessageResponse {
  /** The runtime's ID for the message; the conversation's `ChatMessage.messageId` once it arrives. */
  readonly messageId?: string;
}

export interface ApprovalAnswer {
  readonly approve: boolean;
  /** Why the person declined, passed to the coordinator (for example "use the Node environment for this"). */
  readonly reason?: string;
  /** Commands: also approve every later command and file change for the same message. */
  readonly rest?: boolean;
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
