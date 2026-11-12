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

/** The environment every customer's session runs in, the model and tools each session gets, and where issues go. */
export interface DeskInfo {
  readonly environment: string;
  readonly model?: string;
  readonly tools: readonly ToolInfo[];
  readonly factory: FactoryInfo;
  readonly triage: TriageInfo;
  /** Classification with the support sessions' ordinary LLM, which Classify offers to compare with the decision model. */
  readonly llmTriage: TriageInfo;
}

/**
 * Ticket classification: a session in a second environment, whose model is a decision model, sorts each customer's
 * message into a category before the support agent answers. Optional (demos/help-desk/README.md).
 * - `off`: not set up.
 * - `connecting`: set up; its environment isn't connected yet.
 * - `ready`: classifying.
 * - `unavailable`: set up, but it can't classify right now (`message` says why).
 */
export interface TriageInfo {
  readonly state: "off" | "connecting" | "ready" | "unavailable";
  readonly environment?: string;
  readonly model?: string;
  readonly message?: string;
}

/** What a customer's message is about, as the decision model classifies it. */
export const TICKET_CATEGORIES = ["delivery", "refund", "cancellation", "order-change", "website-problem", "question"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_INFO: Readonly<Record<TicketCategory, { readonly label: string; readonly description: string }>> = {
  delivery: { label: "Delivery", description: "Where an order is: tracking, delivery dates, or a parcel shown as delivered that didn't arrive" },
  refund: { label: "Refunds", description: "Money back for a broken, faulty, or unwanted item" },
  cancellation: { label: "Cancellations", description: "Cancelling an order" },
  "order-change": { label: "Order changes", description: "Changing an order before it ships: the address, the items, or the quantities" },
  "website-problem": { label: "Website problems", description: "The store's website misbehaves: promo codes, the cart, or order pages showing the wrong thing" },
  question: { label: "Questions", description: "Store policies, order history, or anything else" },
};

/**
 * A ticket's classification, from its customer's latest message.
 * - `classifying`: the decision model is reading it.
 * - `done`: `category` and `urgent` are set.
 * - `failed`: `message` says why.
 */
export type TicketTriage =
  | { readonly state: "classifying" }
  | { readonly state: "done"; readonly category: TicketCategory; readonly urgent: boolean }
  | { readonly state: "failed"; readonly message: string };

/** Software Factory, which fixes the store's website when the operator sends it a software issue. */
export interface FactoryInfo {
  /** `SOFTWARE_FACTORY_URL` is set, so issues can be sent. */
  readonly configured: boolean;
  /** Where people open Software Factory. */
  readonly url?: string;
}

export interface ToolInfo {
  readonly name: ToolName;
  /** Runs only after the operator approves it. */
  readonly approval: boolean;
}

export const TOOL_NAMES = ["list_my_orders", "get_order", "track_shipment", "request_refund", "cancel_order", "report_bug", "resolve_conversation"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The parts of the store's website an agent reports problems with (`report_bug`). */
export const BUG_AREAS = ["promo-codes", "cart", "order-status", "other"] as const;
export type BugArea = (typeof BUG_AREAS)[number];

/** Each area's short label, and the title of the software issue its reports make up. */
export const BUG_AREA_INFO: Readonly<Record<BugArea, { readonly label: string; readonly issue: string }>> = {
  "promo-codes": { label: "Promo codes", issue: "Promo codes rejected at checkout" },
  cart: { label: "Cart", issue: "Wrong quantities in the cart" },
  "order-status": { label: "Order status", issue: "Wrong order status on My orders" },
  other: { label: "Other", issue: "Other problems with the website" },
};

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
 * - `approval`: a refund or a cancellation waits for the operator. A proposed team memory doesn't hold the ticket.
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
}

/**
 * A fact an agent proposed for the team knowledge base (`store_memory`), waiting for a team member to add it or not. The
 * agent's turn doesn't wait for the decision, and the agent never hears it: the customer's conversation is the same
 * whether the fact is added or not.
 */
export interface MemoryProposal {
  readonly id: string;
  /** A few words: what the fact is about. */
  readonly subject: string;
  readonly fact: string;
  /** Where it comes from, in the agent's words. */
  readonly citations?: string;
  /** Why the agent proposed it. */
  readonly reason?: string;
  /** The conversation it was learned in. */
  readonly source: { readonly customerId: string; readonly name: string; readonly sessionId: string };
  /** When the agent proposed it. */
  readonly at: string;
}

/** A fact in the team knowledge base: an agent proposed it and a team member approved it. */
export interface KnowledgeEntry {
  readonly id: string;
  readonly subject: string;
  readonly fact: string;
  readonly citations?: string;
  /** Why the agent stored it. */
  readonly reason?: string;
  /** The conversation it was learned in. */
  readonly source: { readonly customerId: string; readonly name: string; readonly sessionId: string };
  /** When it was approved and stored. */
  readonly at: string;
}

/** A problem with the store's website that a customer ran into, as their agent reported it with `report_bug`. */
export interface BugReport {
  readonly area: BugArea;
  /** One line. */
  readonly title: string;
  /** The customer's experience. */
  readonly whatHappened: string;
  /** What should have happened. */
  readonly expected: string;
  readonly orderId?: string;
  /** When the agent reported it. */
  readonly at: string;
}

/** One customer's conversation: a session of the help desk environment. */
export interface Ticket {
  readonly customerId: string;
  readonly sessionId?: string;
  readonly status: TicketStatus;
  readonly items: readonly TranscriptItem[];
  readonly approval?: ApprovalRequest;
  /** A fact the agent proposed for the team knowledge base. */
  readonly memory?: MemoryProposal;
  /** Calls that named another customer's order. */
  readonly blocked: number;
  /** The problem with the store's website the agent reported (its latest report). */
  readonly bug?: BugReport;
  readonly premiumRequests?: number;
  readonly problem?: string;
  /** Its classification, when classification is set up. */
  readonly triage?: TicketTriage;
}

/** One customer's report in a software issue. */
export interface IssueReport {
  readonly customerId: string;
  readonly name: string;
  readonly whatHappened: string;
  readonly orderId?: string;
  readonly at: string;
}

/** Software Factory's work order statuses. */
export const WORK_ORDER_STATUSES = ["queued", "planning", "building", "releasing", "completed", "failed", "cancelled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/** The work order Software Factory made of an issue. */
export interface RoutedWorkOrder {
  /** Software Factory's ID (`wo_…`). */
  readonly workOrderId: string;
  /** Shown as `WO-0012`. */
  readonly number: number;
  readonly title: string;
  readonly status: WorkOrderStatus;
  /** The work order's page in Software Factory. */
  readonly url: string;
  /** Why it failed. */
  readonly error?: string;
}

/** The current simulation's reports about one area of the website: one issue to send to Software Factory. */
export interface SoftwareIssue {
  readonly area: BugArea;
  /** What's wrong, for example "Promo codes rejected at checkout". */
  readonly title: string;
  /** Oldest first. */
  readonly reports: readonly IssueReport[];
  /** The work order it was sent as. */
  readonly routed?: RoutedWorkOrder;
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

/** How Classify classifies: with the decision model (Microsoft-Decision-1), or with the support sessions' ordinary LLM. */
export const CLASSIFICATION_METHODS = ["decision", "llm"] as const;
export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number];

/** The tokens classifications used, from their sessions' usage metrics. */
export interface ClassificationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Classify on its own: the first `size` customers' opening messages, classified without starting their sessions, to
 * show how fast and cheap the decision model is next to an ordinary LLM. Ends when a simulation starts.
 */
export interface ClassificationRun {
  readonly id: string;
  readonly method: ClassificationMethod;
  /** The model the classification sessions use. */
  readonly model?: string;
  readonly size: number;
  readonly startedAt: string;
  /** Each message's classification so far, by customer ID. */
  readonly results: Readonly<Record<string, TicketTriage>>;
  /** From the start to the last result, once every message has one. */
  readonly elapsedMs?: number;
  /** The classifications' usage so far, summed; `measured` of them could be read. */
  readonly usage: ClassificationUsage & { readonly measured: number };
}

/** The latest Classify of each method, to compare them; the latest of all is `HelpDeskState.classification`. */
export type ClassificationRuns = Readonly<Partial<Record<ClassificationMethod, ClassificationRun>>>;

export const SIMULATION_SIZES = [5, 10, 25] as const;
export type SimulationSize = (typeof SIMULATION_SIZES)[number];

export interface HelpDeskState {
  readonly platform: PlatformStatus;
  readonly desk: DeskInfo;
  readonly customers: readonly CustomerCard[];
  readonly run?: RunInfo;
  readonly tickets: readonly Ticket[];
  /** The latest Classify, when there's no simulation since. */
  readonly classification?: ClassificationRun;
  /** The latest Classify of each method, when there's no simulation since. */
  readonly classifications: ClassificationRuns;
  /** The current simulation's software issues. */
  readonly issues: readonly SoftwareIssue[];
  readonly counters: Counters;
  /** The team knowledge base, newest first. It outlives simulations. */
  readonly knowledge: readonly KnowledgeEntry[];
  /** Facts agents proposed that no one has added or declined yet, oldest first. */
  readonly proposals: readonly MemoryProposal[];
}

export type ServerEvent =
  | { readonly type: "platform"; readonly platform: PlatformStatus; readonly desk: DeskInfo }
  | { readonly type: "run"; readonly run?: RunInfo; readonly tickets: readonly Ticket[]; readonly issues: readonly SoftwareIssue[] }
  | { readonly type: "ticket"; readonly ticket: Ticket }
  | { readonly type: "issues"; readonly issues: readonly SoftwareIssue[] }
  | { readonly type: "counters"; readonly counters: Counters }
  | { readonly type: "knowledge"; readonly knowledge: readonly KnowledgeEntry[]; readonly proposals: readonly MemoryProposal[] }
  | { readonly type: "classification"; readonly classification?: ClassificationRun; readonly classifications: ClassificationRuns };

export interface SimulateRequest {
  readonly size: number;
}

export interface ClassifyRequest {
  readonly size: number;
  /** Defaults to `decision`. */
  readonly method?: ClassificationMethod;
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
