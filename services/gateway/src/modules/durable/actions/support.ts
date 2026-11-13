// Durable actions: options, dependencies, and the pure rules for parsing, routing, and deciding actions.
import { ManagedCopilotError, type ActionKind, type PlatformEvent } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import type { Logger } from "../../../log.js";
import {
  ANSWER_METHODS,
  EXECUTION_EVENT_TYPES,
  type AttachedResponder,
  type DurablePlatformToolsPort,
  type DurableSessionsPort,
  type PlatformEventMeta,
  type RuntimeSessionEvent,
} from "../contract.js";
import { parseJson } from "../ids.js";
import { runtimeRequestId, type ActionRow } from "./store.js";

export interface ActionsOptions {
  /** Answer deadline for every action (spec: proposed 24 hours). */
  readonly answerTimeoutMs: number;
  /** Default and maximum lease for REST claims (webhook workers and pollers renew while they work). */
  readonly defaultLeaseMs: number;
  readonly minLeaseMs: number;
  readonly maxLeaseMs: number;
  /** Lifetime of webhook action capabilities. */
  readonly capabilityTtlMs: number;
  readonly sweepIntervalMs: number;
  /** Coalesces `session.action_required` for actions requested together (parallel tool calls). */
  readonly notifyDebounceMs: number;
  /** Upper bound for one upstream call (answers, pending lists). */
  readonly upstreamTimeoutMs: number;
  readonly maxForwardAttempts: number;
}

export const DEFAULT_ACTIONS_OPTIONS: ActionsOptions = {
  answerTimeoutMs: 24 * 60 * 60 * 1000,
  defaultLeaseMs: 60_000,
  minLeaseMs: 5_000,
  maxLeaseMs: 15 * 60_000,
  capabilityTtlMs: 15 * 60_000,
  sweepIntervalMs: 1_000,
  notifyDebounceMs: 100,
  upstreamTimeoutMs: 15_000,
  maxForwardAttempts: 30,
};

export interface ActionsDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly capabilityKey: Buffer;
  /** Public base URL of this deployment (capability audience). */
  readonly publicUrl: string;
  readonly sessions: () => DurableSessionsPort | undefined;
  readonly platformTools: () => DurablePlatformToolsPort | undefined;
  /** Publishes a platform event to SSE subscribers and webhooks. */
  readonly publish: (event: PlatformEvent, meta: PlatformEventMeta) => void;
  readonly now?: () => number;
  readonly options?: Partial<ActionsOptions>;
}

/** Ledger changes other durable components react to (schedule runs move between `running` and `waiting`). */
export type ActionChange = { readonly type: "pending" | "resolved"; readonly sessionId: string; readonly actionId: string };

interface ParsedAction {
  readonly kind: ActionKind;
  readonly requestId: string;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly providerId?: string;
  readonly arguments?: unknown;
}

export const EXECUTION_TYPES: ReadonlySet<string> = new Set(EXECUTION_EVENT_TYPES);

export const COMPLETION_KIND: Readonly<Record<string, ActionKind>> = {
  "external_tool.completed": "tool",
  "permission.completed": "permission",
  "elicitation.completed": "elicitation",
};

export const METHOD_KIND: Readonly<Record<string, ActionKind>> = {
  [ANSWER_METHODS.tool]: "tool",
  [ANSWER_METHODS.permission]: "permission",
  [ANSWER_METHODS.elicitation]: "elicitation",
};

const TOOL_RESULT_TYPES = new Set(["success", "failure", "rejected", "denied", "timeout"]);

export const ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);

/** Reconciliation never closes an action this young: the runtime's lists may lag the event that created it. */
export const RECONCILE_GRACE_MS = 2_000;

/** A pending action still unannounced after this long lost its notification (for example to a crash). */
export const ANNOUNCE_REPAIR_AFTER_MS = 5_000;

/** Bound for in-memory per-connection and per-incarnation counters. */
export const MAX_REMEMBERED = 10_000;

export const MOVED_WHILE_RUNNING =
  "The session moved to a new placement while this tool was running; it may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.";

export const RESTARTED_WHILE_RUNNING =
  "The runtime restarted while this tool was being handled; it may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.";

export const SHUTTING_DOWN = () => new ManagedCopilotError("capability_unavailable", "The gateway is shutting down; try again shortly");

export const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The runtime event an action was recorded from. */
export const eventData = (row: Pick<ActionRow, "event">): Record<string, unknown> | undefined => parseJson<RuntimeSessionEvent>(row.event)?.data;

/**
 * A permission action recorded from the runtime's pending list alone carries only the derived prompt: an
 * application's handler needs the raw request, so only a person (an attached CLI) can answer it.
 */
export const lacksRawRequest = (row: Pick<ActionRow, "kind" | "event">) => row.kind === "permission" && eventData(row)?.permissionRequest === undefined;

/** Live connections that held an action, with the placement generation each last held it in. */
export function liveClaimants(row: Pick<ActionRow, "live_claimants">): Record<string, number> {
  const parsed = parseJson<Record<string, number>>(row.live_claimants);
  return parsed !== null && typeof parsed === "object" ? parsed : {};
}

export function withLiveClaimant(row: Pick<ActionRow, "live_claimants">, connectionId: string, generation: number): string {
  return JSON.stringify({ ...liveClaimants(row), [connectionId]: generation });
}

/**
 * A connection that held this action only under an older placement (its claim voided by a move, or released before
 * it) may still be running that old callback. The stock protocol cannot tell its late answer from a new one, so it
 * is never offered the action again and its answers are refused; other responders can answer.
 */
export function heldBefore(row: Pick<ActionRow, "live_claimants" | "live_connection" | "generation">, connectionId: string): boolean {
  const generation = liveClaimants(row)[connectionId];
  return generation !== undefined && generation < row.generation && row.live_connection !== connectionId;
}

export const conflict = (message: string, row?: ActionRow) =>
  new ManagedCopilotError("conflict", message, row ? { actionId: row.id, state: row.state, ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}) } : undefined);

/** `${sessionId}:${toolCallId}` for tools, so live handlers can derive the same key from their `ToolInvocation`. */
export function idempotencyKeyFor(sessionId: string, action: { readonly kind: ActionKind; readonly toolCallId?: string | undefined; readonly requestId: string }): string {
  return action.kind === "tool" && action.toolCallId ? `${sessionId}:${action.toolCallId}` : `${sessionId}:${action.kind}:${action.requestId}`;
}

export function parseExecutionEvent(event: RuntimeSessionEvent): ParsedAction | undefined {
  const data = event.data ?? {};
  const requestId = str(data.requestId);
  if (!requestId) return undefined;
  switch (event.type) {
    case "external_tool.requested": {
      const tool = str(data.toolName);
      if (!tool) return undefined;
      return {
        kind: "tool",
        requestId,
        tool,
        ...(str(data.toolCallId) ? { toolCallId: str(data.toolCallId)! } : {}),
        ...(str(data.providerId) ? { providerId: str(data.providerId)! } : {}),
        arguments: data.arguments ?? {},
      };
    }
    case "permission.requested": {
      // A permissionRequest hook already decided; nothing waits for a responder.
      if (data.resolvedByHook === true) return undefined;
      // A prompt reconstructed from the runtime's pending list may carry only its derived form.
      const request = (data.permissionRequest ?? data.promptRequest) as Record<string, unknown> | undefined;
      return {
        kind: "permission",
        requestId,
        // Custom and MCP tool prompts name their tool, which makes pending prompts readable.
        ...(str(request?.toolName) ? { tool: str(request?.toolName)! } : {}),
        ...(str(request?.toolCallId) ? { toolCallId: str(request?.toolCallId)! } : {}),
      };
    }
    case "elicitation.requested": {
      const { message, requestedSchema, mode, elicitationSource, url } = data;
      return { kind: "elicitation", requestId, arguments: { message, requestedSchema, mode, elicitationSource, url } };
    }
    default:
      return undefined;
  }
}

export function isEligible(responder: AttachedResponder, action: { readonly kind: ActionKind; readonly tool?: string | null | undefined }): boolean {
  switch (action.kind) {
    case "tool":
      // A person can approve a prompt but cannot run an application's function.
      return responder.kind === "sdk" && !!action.tool && responder.tools.includes(action.tool);
    case "permission":
      return responder.kind === "cli" || responder.requestPermission;
    case "elicitation":
      return responder.kind === "cli" || responder.requestElicitation;
    default:
      return false;
  }
}

/**
 * Preference order (shared with core's fallback): the creating connection, then the others by attach time. An
 * attached person answers prompts only when no application handler is attached, except prompts that managed policy
 * reserves for a person: an attached Copilot CLI gets those first.
 */
export function chooseOwner(eligible: readonly AttachedResponder[], kind: ActionKind, personRequired = false): AttachedResponder | undefined {
  const person = kind === "tool" ? undefined : eligible.find((responder) => responder.kind === "cli");
  if (personRequired && person) return person;
  return eligible.find((responder) => responder.kind === "sdk") ?? person;
}

/** Prompt kinds whose derived `promptRequest` decides whether a person is still required (stock SDK guidance). */
const STANDARD_PROMPT_KINDS: ReadonlySet<string> = new Set(["commands", "read", "write", "url", "workflow"]);

const marked = (value: unknown) => value !== undefined && value !== false;

/**
 * Whether managed policy requires a person to answer a permission prompt (`managedApprovalRequired`, read the way the
 * stock SDK documents it: the derived `promptRequest` decides for standard prompt kinds, the raw request otherwise).
 * A prompt known only from its derived form, without the raw request, always needs a person, whatever its kind: the
 * derived form alone cannot prove that no person is required.
 */
export function needsPerson(data: Record<string, unknown> | undefined): boolean {
  const raw = data?.permissionRequest as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return true;
  const prompt = data?.promptRequest as Record<string, unknown> | undefined;
  if (prompt && typeof prompt.kind === "string" && STANDARD_PROMPT_KINDS.has(prompt.kind)) return marked(prompt.managedApprovalRequired);
  return marked(raw.managedApprovalRequired);
}

/** Who answers a permission prompt: a webhook capability (application policy), the owner's poller or client, or a person at an attached CLI. */
export type DecisionResponder = "webhook" | "poll" | "live" | "cli";

const ONE_SHOT_APPROVALS: ReadonlySet<string> = new Set(["approve-once", "approved"]);

/** Approvals that also change what the session may do later, without asking again. */
const STANDING_APPROVALS: ReadonlySet<string> = new Set([
  "approve-for-session",
  "approve-read-only-for-session",
  "approve-for-location",
  "approve-permanently",
  "approved-for-session",
  "approved-for-location",
]);

const DENIALS: ReadonlySet<string> = new Set([
  "reject",
  "user-not-available",
  "denied-interactively-by-user",
  "denied-by-rules",
  "denied-no-approval-rule-and-could-not-request-from-user",
  "denied-by-content-exclusion-policy",
  "denied-by-permission-request-hook",
  "cancelled",
]);

/** All a webhook capability may decide: it is application policy, never a person and never a change of policy. */
const CAPABILITY_DECISIONS: ReadonlySet<string> = new Set(["approve-once", "reject", "user-not-available"]);

/**
 * Checks a permission decision against who answers and what the prompt requires; returns why it is refused.
 * - Only the owner's own paths may say a person decided (`approvedInteractively`, `denied-interactively-by-user`).
 * - A webhook capability approves once, rejects, or reports that nobody is available; it never grants standing
 *   approvals or answers for a person.
 * - A prompt that managed policy reserves for a person accepts an approval only from an attached Copilot CLI, or from
 *   the owner's client or poller attesting that a person approved it (`approvedInteractively: true`).
 */
export function permissionDecisionProblem(decision: Record<string, unknown>, responder: DecisionResponder, personRequired: boolean): string | undefined {
  const kind = String(decision.kind);
  const approval = ONE_SHOT_APPROVALS.has(kind) || STANDING_APPROVALS.has(kind);
  if (!approval && !DENIALS.has(kind)) return `"${kind}" is not a permission decision`;
  if (responder === "webhook") {
    if (decision.approvedInteractively === true || kind === "denied-interactively-by-user") return "A webhook cannot answer on a person's behalf";
    if (!CAPABILITY_DECISIONS.has(kind)) return `A webhook can approve this request once, reject it, or report that nobody is available; "${kind}" needs the session's owner`;
  }
  if (personRequired && approval && responder !== "cli") {
    // Away from an attached CLI, only the owner's client or poller may attest that a person approved this one request.
    const attested = responder !== "webhook" && kind === "approve-once" && decision.approvedInteractively === true;
    if (!attested) return "Managed policy requires a person to approve this request; reject it, or leave it for a person to answer";
  }
  return undefined;
}

/** Mirrors the stock SDK: nullish → "", strings and `ToolResultObject`s unchanged, anything else JSON-encoded. */
export function normalizeToolResult(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (isToolResultObject(value)) return value;
  return JSON.stringify(value);
}

function isToolResultObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.textResultForLlm === "string" && typeof candidate.resultType === "string" && TOOL_RESULT_TYPES.has(candidate.resultType);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedCopilotError("timeout", `${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function describeUnclaimable(row: ActionRow): string {
  switch (row.state) {
    case "claimed":
    case "executing":
      return `This action is already being handled${row.claimed_by ? ` by ${row.claimed_by}` : ""}`;
    case "completed":
    case "failed":
      return "This action was already answered";
    case "needs_reconciliation":
      return "This action may already have run; claim it with reconcile: true after checking its effect";
    default:
      return `This action was ${row.state}${row.reason ? `: ${row.reason}` : ""}`;
  }
}

/** The runtime RPC that delivers a recorded outcome. Expiry and failures never become approvals. */
export function forwardCall(row: ActionRow): { method: string; params: Record<string, unknown> } {
  const base = { sessionId: row.session_id, requestId: runtimeRequestId(row) };
  const result = parseJson(row.result);
  switch (row.kind) {
    case "tool":
      if (row.state === "completed") return { method: ANSWER_METHODS.tool, params: { ...base, result } };
      if (row.state === "expired") {
        return { method: ANSWER_METHODS.tool, params: { ...base, error: `No responder answered ${row.tool ?? "this tool"} before its deadline` } };
      }
      return { method: ANSWER_METHODS.tool, params: { ...base, error: row.error ?? "The tool failed" } };
    case "permission":
      return { method: ANSWER_METHODS.permission, params: { ...base, result: row.state === "completed" ? result : { kind: "user-not-available" } } };
    case "elicitation":
      return { method: ANSWER_METHODS.elicitation, params: { ...base, result: row.state === "completed" ? result : { action: "cancel" } } };
    default:
      throw new ManagedCopilotError("capability_unavailable", `Actions of kind ${row.kind} cannot be delivered yet`);
  }
}
