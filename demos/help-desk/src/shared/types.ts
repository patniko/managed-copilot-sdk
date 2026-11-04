// Shapes shared by the Help Desk server and its web UI.

export type PlatformState = "connecting" | "connected" | "reconnecting" | "unavailable";

export interface AccountSummary {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface PlatformStatus {
  readonly state: PlatformState;
  /** Why it isn't connected, in plain words. */
  readonly message?: string;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: AccountSummary;
}

/** The environment every customer's session runs in, and the model and tools each session gets. */
export interface DeskInfo {
  readonly environment: string;
  readonly model?: string;
  /** Premium requests one customer message costs with that model. */
  readonly multiplier?: number;
  readonly tools: readonly ToolInfo[];
}

export interface ToolInfo {
  readonly name: ToolName;
  readonly description: string;
  /** Runs only after the operator approves it. */
  readonly approval: boolean;
}

export const TOOL_NAMES = ["list_my_orders", "get_order", "track_shipment", "request_refund", "cancel_order", "resolve_conversation"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Primer display colors for customer avatars. */
export const AVATAR_COLORS = ["blue", "green", "orange", "purple", "pink", "teal", "indigo", "yellow", "red"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** A customer of the demo store, shown on the wall before and during a simulation. */
export interface CustomerCard {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly color: AvatarColor;
  readonly email: string;
  readonly memberSince: number;
  readonly orderIds: readonly string[];
  /** What they write first when the simulation starts. */
  readonly opening: string;
}

/**
 * - `starting`: its session is being created.
 * - `answering`: the agent is working on the customer's message.
 * - `approval`: a refund or cancellation waits for the operator.
 * - `waiting`: the agent answered and waits for the customer.
 * - `resolved`: the agent marked the request handled.
 * - `failed`: the session couldn't start or the platform reported an error.
 */
export type TicketStatus = "starting" | "answering" | "approval" | "waiting" | "resolved" | "failed";

/**
 * A tool call as the transcript shows it.
 * - `running`: called, no result yet.
 * - `asking`: waits for the operator's approval.
 * - `done`: the tool did what was asked.
 * - `refused`: the tool said no (not this customer's order, or against store policy).
 * - `declined`: the operator declined it.
 * - `failed`: it errored.
 */
export type ToolCallStatus = "running" | "asking" | "done" | "refused" | "declined" | "failed";

export interface MessageItem {
  readonly kind: "message";
  readonly id: string;
  readonly from: "customer" | "agent";
  readonly text: string;
  readonly at: string;
  /** Still being written. */
  readonly streaming?: boolean;
}

export interface ToolItem {
  readonly kind: "tool";
  /** The tool call's ID; an approval for it has the same ID. */
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly at: string;
  readonly status: ToolCallStatus;
  /** What the tool returned to the agent. */
  readonly result?: Readonly<Record<string, unknown>>;
  /** The call named an order that belongs to another customer, and the tool refused it. */
  readonly blocked?: boolean;
}

export type TranscriptItem = MessageItem | ToolItem;

/** A refund or cancellation waiting for the operator. */
export interface ApprovalRequest {
  readonly id: string;
  readonly action: "refund" | "cancel";
  readonly orderId: string;
  /** USD. */
  readonly amount: number;
  readonly reason?: string;
  readonly requestedAt: string;
}

/** One customer's conversation: a session of the help desk environment. */
export interface Ticket {
  readonly customerId: string;
  readonly sessionId?: string;
  readonly status: TicketStatus;
  readonly items: readonly TranscriptItem[];
  readonly approval?: ApprovalRequest;
  /** Calls that named another customer's order. */
  readonly blocked: number;
  readonly premiumRequests?: number;
  readonly problem?: string;
  readonly updatedAt: string;
}

export interface Counters {
  readonly sessions: number;
  /** Runtime processes hosting those sessions: the shared runtime, plus one per session placed in a sandbox. */
  readonly runtimes: number;
  readonly sandboxes: number;
  readonly messages: number;
  readonly premiumRequests: number;
}

export interface RunInfo {
  readonly id: string;
  readonly size: number;
  readonly startedAt: string;
  /** Its sessions are being deleted. */
  readonly ending?: boolean;
}

export const SIMULATION_SIZES = [5, 10, 25] as const;
export type SimulationSize = (typeof SIMULATION_SIZES)[number];

export interface HelpDeskState {
  readonly platform: PlatformStatus;
  readonly desk: DeskInfo;
  readonly customers: readonly CustomerCard[];
  readonly run?: RunInfo;
  readonly tickets: readonly Ticket[];
  readonly counters: Counters;
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus; readonly desk: DeskInfo }
  | { readonly type: "run"; readonly run?: RunInfo; readonly tickets: readonly Ticket[] }
  | { readonly type: "ticket"; readonly ticket: Ticket }
  | { readonly type: "counters"; readonly counters: Counters };

export interface SimulateRequest {
  readonly size: number;
}

export interface SendRequest {
  readonly text: string;
}

export interface ApprovalAnswer {
  readonly approve: boolean;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
