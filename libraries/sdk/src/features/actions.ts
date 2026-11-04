// Claim-then-answer for pending actions (spec section 12, "One owner for each action").
import type { PermissionRequest, PermissionRequestResult, Tool, ToolInvocation } from "@github/copilot-sdk";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  ROUTES,
  type ActionClaim,
  type ActionResultRequest,
  type ActionState,
  type HandleActionResult,
  type PendingAction,
} from "@managed-copilot/protocol";
import type { HttpClient } from "../http.js";
import type { ActionHandlers, ManagedContext } from "../types.js";

export interface RunActionsOptions {
  /** Only these actions (a webhook capability's listed actions). */
  readonly actionIds?: readonly string[];
  /** Label recorded with each claim. */
  readonly responder?: string;
}

type Answer = Pick<ActionResultRequest, "result" | "error" | "release">;

const TOOL_RESULT_TYPES = new Set(["success", "failure", "rejected", "denied", "timeout"]);

/** The stock SDK's conversion of a handler's return value (`CopilotSession._executeToolAndRespond`). */
export function toToolResult(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).textResultForLlm === "string" &&
    TOOL_RESULT_TYPES.has(String((value as Record<string, unknown>).resultType))
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claims and answers a session's eligible pending actions under the same claim/result contract as live delivery:
 * an action is executed only after this process holds its claim, the lease is renewed while a handler runs, and the
 * result is submitted with the claim token (retried, since duplicate submissions return the recorded state).
 * Actions without a matching handler stay pending for another responder. Returns one entry per action attempted.
 */
export async function runActions(http: HttpClient, sessionId: string, handlers: ActionHandlers, options: RunActionsOptions = {}): Promise<HandleActionResult[]> {
  const tools = new Map<string, Tool<any>>();
  for (const tool of handlers.tools ?? []) if (tool.handler) tools.set(tool.name, tool);
  const listed = await http.get<PendingAction[]>(ROUTES.actions(sessionId), { query: { state: "pending" } });
  const eligible = listed.filter(
    (action) =>
      action.state === "pending" &&
      (!options.actionIds || options.actionIds.includes(action.id)) &&
      ((action.kind === "tool" && action.tool !== undefined && tools.has(action.tool)) ||
        // A prompt known only from its derived form has no request to hand a handler; it is a person's to answer.
        (action.kind === "permission" && handlers.onPermissionRequest !== undefined && action.payload !== undefined)),
  );
  return Promise.all(eligible.map((action) => runOne(http, sessionId, action, handlers, tools, options)));
}

async function runOne(
  http: HttpClient,
  sessionId: string,
  action: PendingAction,
  handlers: ActionHandlers,
  tools: Map<string, Tool<any>>,
  options: RunActionsOptions,
): Promise<HandleActionResult> {
  let claim: ActionClaim;
  try {
    claim = await http.post<ActionClaim>(ROUTES.actionClaim(sessionId, action.id), options.responder ? { responder: options.responder } : {});
  } catch (error) {
    // Another responder owns it (or it was answered meanwhile): report its state, never execute it.
    if (isManagedCopilotError(error, "conflict")) return { actionId: action.id, state: (error.details?.state as ActionState | undefined) ?? "claimed" };
    throw error;
  }

  const controller = new AbortController();
  const leaseMs = Math.max(5_000, Date.parse(claim.leaseExpiresAt) - Date.now());
  const heartbeat = setInterval(() => {
    http.post(ROUTES.actionClaim(sessionId, action.id), { claimToken: claim.claimToken }).catch((error: unknown) => {
      // Losing the claim mid-run means another outcome is now authoritative; let the handler observe it.
      if (isManagedCopilotError(error, "conflict")) controller.abort();
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  let answer: Answer;
  try {
    answer = await execute(claim.action, handlers, tools, controller.signal);
  } finally {
    clearInterval(heartbeat);
  }
  return submit(http, sessionId, action.id, { claimToken: claim.claimToken, ...answer });
}

async function execute(action: PendingAction, handlers: ActionHandlers, tools: Map<string, Tool<any>>, signal: AbortSignal): Promise<Answer> {
  if (action.kind === "tool") {
    const tool = tools.get(action.tool!)!;
    const invocation: ToolInvocation = {
      sessionId: action.sessionId,
      toolCallId: action.toolCallId ?? action.requestId,
      toolName: action.tool!,
      arguments: action.arguments,
      signal,
      requestId: action.requestId,
    };
    try {
      return { result: toToolResult(await tool.handler!(action.arguments as never, invocation)) };
    } catch (error) {
      return { error: messageOf(error) };
    }
  }
  try {
    const decision = await handlers.onPermissionRequest!(action.payload as PermissionRequest, { sessionId: action.sessionId });
    const result: PermissionRequestResult = decision.kind === "attributed" ? decision.result : decision;
    // A handler that makes no decision (e.g. approveAll under managed settings) leaves the prompt for someone else.
    if (result.kind === "no-result") return { release: true };
    return { result };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

async function submit(http: HttpClient, sessionId: string, actionId: string, body: ActionResultRequest): Promise<HandleActionResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await http.post<HandleActionResult>(ROUTES.actionResult(sessionId, actionId), body);
    } catch (error) {
      // The handler already ran; only transport failures and timeouts are retried (the gateway deduplicates the same
      // result, so a submission that arrived before its answer was lost is not applied twice).
      const transient = error instanceof ManagedCopilotError && (error.code === "capability_unavailable" || error.code === "internal" || error.code === "timeout");
      if (attempt >= 4 || !transient) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

export async function handleSessionActions(ctx: ManagedContext, sessionId: string, handlers: ActionHandlers): Promise<HandleActionResult[]> {
  // Act as the identity that created or resumed the session, falling back to the connection's own identity.
  return runActions(ctx.httpFor(sessionId), sessionId, handlers, ctx.clientName ? { responder: ctx.clientName } : {});
}
