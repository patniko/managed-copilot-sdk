/**
 * Turns stock Copilot SDK session events into chat timeline items. The same reducer rebuilds the chat from
 * `session.getEvents()` after a resume and applies live events, so history and streaming render identically.
 */
import { createHash } from "node:crypto";
import type { SessionEvent } from "@github/copilot-sdk";
import type { ApprovalItem, ApprovalStatus, AssistantItem, TimelineItem, ToolItem } from "../shared/protocol.js";
import { describeApproval, describeTool, HIDDEN_TOOLS, isBackgroundWorkError, scheduleIdFrom } from "./describe.js";
import { APPROVAL_TOOLS, SCHEDULING_TOOLS } from "./tools/index.js";

export type TimelineChange =
  | { readonly type: "item"; readonly item: TimelineItem }
  | { readonly type: "delta"; readonly id: string; readonly text: string }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "schedules-changed" }
  /** A proactive (schedule-started) turn finished with this message. */
  | { readonly type: "proactive"; readonly itemId: string; readonly text: string };

export interface TimelineContext {
  timeZone(): string;
  /** Name of the schedule that delivered a `source: "system"` prompt, when known. */
  scheduleNameFor(messageId: string | undefined, text: string): string | undefined;
  isOffline(toolCallId: string): boolean;
  /** Whether a live permission handler currently holds this request, so the UI can answer it. */
  isActionable(requestId: string): boolean;
}

const MAX_ERROR_LENGTH = 400;

/**
 * Approval cards are keyed by tool call so the permission event and the live permission callback meet on one item.
 * Without a tool call ID (not expected from the stock runtime) the key covers the full arguments, never a prefix.
 */
export function approvalItemId(request: { toolCallId?: string; toolName?: string; args?: unknown }): string {
  if (request.toolCallId) return `approval:${request.toolCallId}`;
  const digest = createHash("sha256")
    .update(JSON.stringify(request.args ?? {}))
    .digest("base64url")
    .slice(0, 22);
  return `approval:${request.toolName}:${digest}`;
}

function errorText(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH - 1)}…` : clean;
}

function approvalStatusFor(kind: string): ApprovalStatus {
  if (kind.startsWith("approved")) return "approved";
  if (kind === "cancelled") return "expired";
  return "denied";
}

export class Timeline {
  readonly #ctx: TimelineContext;
  readonly #items = new Map<string, TimelineItem>();
  #order: string[] = [];
  readonly #seen = new Set<string>();
  readonly #tools = new Map<string, { name: string; args: unknown; at: Date }>();
  /** Runtime permission request ID → approval item ID. */
  readonly #approvals = new Map<string, string>();
  /** Looked-up approval card details by item ID; kept across rebuilds (tool call IDs are unique). */
  readonly #details = new Map<string, Pick<ApprovalItem, "title" | "preview">>();
  #origin: "user" | "schedule" = "user";
  #busy = false;
  /** A turn started and has not ended (`session.idle` is not persisted, so history replays rely on this). */
  #turnOpen = false;
  #lastProactive: { itemId: string; text: string } | undefined;

  constructor(ctx: TimelineContext) {
    this.#ctx = ctx;
  }

  get busy(): boolean {
    return this.#busy;
  }

  list(): TimelineItem[] {
    return this.#order.map((id) => this.#items.get(id)).filter((item): item is TimelineItem => item !== undefined);
  }

  get(id: string): TimelineItem | undefined {
    return this.#items.get(id);
  }

  /** Inserts or replaces an item (used for live approval state and server notices). */
  set(item: TimelineItem): TimelineChange {
    if (!this.#items.has(item.id)) this.#order.push(item.id);
    this.#items.set(item.id, item);
    return { type: "item", item };
  }

  clear(): void {
    this.#items.clear();
    this.#order = [];
    this.#seen.clear();
    this.#tools.clear();
    this.#approvals.clear();
    this.#origin = "user";
    this.#busy = false;
    this.#turnOpen = false;
    this.#lastProactive = undefined;
  }

  /** Rebuilds the timeline from persisted history; returns nothing because callers broadcast a full snapshot. */
  replaceAll(events: readonly SessionEvent[]): void {
    const notices = this.list().filter((item) => item.kind === "notice" && item.id.startsWith("notice:"));
    this.clear();
    for (const event of events) this.apply(event);
    // `session.idle` is not persisted: a run is still going only if its last turn never ended.
    this.#busy = this.#turnOpen;
    if (!this.#busy) this.#settle();
    this.#lastProactive = undefined;
    for (const notice of notices) this.set(notice);
  }

  /**
   * Remembers what an approval card should show (the live permission handler looks up the event being changed), so
   * rebuilding from history, which only has the request's arguments, keeps those details.
   */
  enrichApproval(id: string, details: Pick<ApprovalItem, "title" | "preview">): void {
    this.#details.set(id, details);
  }

  /** Nothing is running: finish streaming messages and mark tools that never completed as interrupted. */
  #settle(): TimelineChange[] {
    const changes: TimelineChange[] = [];
    for (const item of this.#items.values()) {
      if (item.kind === "assistant" && item.streaming) changes.push(this.set({ ...item, streaming: false }));
      if (item.kind === "tool" && item.status === "running") changes.push(this.set({ ...item, status: "failed", error: "Stopped before it finished." }));
    }
    return changes;
  }

  /** Refreshes derived flags (offline badges, actionable approvals, schedule names) after the context changed. */
  refresh(): TimelineChange[] {
    const changes: TimelineChange[] = [];
    for (const item of this.#items.values()) {
      if (item.kind === "tool") {
        const handledOffline = this.#ctx.isOffline(item.id) || undefined;
        if (handledOffline !== item.handledOffline) changes.push(this.set({ ...item, handledOffline }));
      } else if (item.kind === "approval" && item.status === "pending") {
        const actionable = this.#ctx.isActionable(item.id);
        if (actionable !== item.actionable) changes.push(this.set({ ...item, actionable }));
      } else if (item.kind === "trigger" && !item.scheduleName) {
        const scheduleName = this.#ctx.scheduleNameFor(undefined, item.text);
        if (scheduleName) changes.push(this.set({ ...item, scheduleName }));
      }
    }
    return changes;
  }

  apply(event: SessionEvent): TimelineChange[] {
    if (!event.ephemeral) {
      if (this.#seen.has(event.id)) return [];
      this.#seen.add(event.id);
    }
    // Sub-agent activity stays out of the chat; the root agent reports its results.
    if ("agentId" in event && event.agentId) return [];
    const at = event.timestamp;
    switch (event.type) {
      case "user.message": {
        const { content, source, messageId } = event.data;
        const id = messageId ?? event.id;
        if (source === "system") {
          this.#origin = "schedule";
          return [this.set({ kind: "trigger", id, at, text: content, scheduleName: this.#ctx.scheduleNameFor(messageId, content) })];
        }
        if (source && source !== "user") return [];
        this.#origin = "user";
        return [this.set({ kind: "user", id, at, text: content })];
      }
      case "assistant.turn_start":
        this.#turnOpen = true;
        if (this.#busy) return [];
        this.#busy = true;
        return [{ type: "busy", busy: true }];
      case "assistant.turn_end":
        this.#turnOpen = false;
        return [];
      case "assistant.message_delta": {
        const { messageId, deltaContent, parentToolCallId } = event.data;
        if (parentToolCallId || !deltaContent) return [];
        const existing = this.#items.get(messageId);
        if (existing?.kind === "assistant") {
          // A late delta (buffered while history loaded) for a message that already completed adds nothing.
          if (!existing.streaming) return [];
          this.#items.set(messageId, { ...existing, text: existing.text + deltaContent });
          return [{ type: "delta", id: messageId, text: deltaContent }];
        }
        return [this.set({ kind: "assistant", id: messageId, at, text: deltaContent, streaming: true, proactive: this.#origin === "schedule" })];
      }
      case "assistant.message": {
        const { messageId, content, parentToolCallId } = event.data;
        if (parentToolCallId) return [];
        const existing = this.#items.get(messageId) as AssistantItem | undefined;
        if (!content?.trim()) {
          if (existing && !existing.text.trim()) {
            this.#items.delete(messageId);
            this.#order = this.#order.filter((id) => id !== messageId);
          }
          return [];
        }
        const proactive = existing?.proactive ?? this.#origin === "schedule";
        const item: AssistantItem = { kind: "assistant", id: messageId, at: existing?.at ?? at, text: content, streaming: false, proactive };
        if (proactive) this.#lastProactive = { itemId: messageId, text: content };
        return [this.set(item)];
      }
      case "tool.execution_start": {
        const { toolCallId, toolName, arguments: args, parentToolCallId } = event.data;
        if (parentToolCallId) return [];
        const started = new Date(at);
        this.#tools.set(toolCallId, { name: toolName, args, at: started });
        if (HIDDEN_TOOLS.has(toolName)) return [];
        const description = describeTool(toolName, args, "running", undefined, this.#ctx.timeZone(), started);
        const item: ToolItem = {
          kind: "tool",
          id: toolCallId,
          at,
          name: toolName,
          icon: description.icon,
          title: description.title,
          detail: description.detail,
          status: "running",
          handledOffline: this.#ctx.isOffline(toolCallId) || undefined,
        };
        return [this.set(item)];
      }
      case "tool.execution_complete": {
        const { toolCallId, success, result, error, parentToolCallId } = event.data;
        if (parentToolCallId) return [];
        const started = this.#tools.get(toolCallId);
        if (!started || HIDDEN_TOOLS.has(started.name)) return [];
        const existing = this.#items.get(toolCallId) as ToolItem | undefined;
        const status = success ? "succeeded" : "failed";
        const content = result?.content;
        const description = describeTool(started.name, started.args, status, content, this.#ctx.timeZone(), started.at);
        const scheduling = SCHEDULING_TOOLS.has(started.name);
        const failure = success ? undefined : (error?.message ?? content ?? "The tool failed.");
        // The platform's message suggests a terminal command; this app offers a button instead.
        const needsBackgroundWork = scheduling && !success && isBackgroundWorkError(failure);
        const item: ToolItem = {
          kind: "tool",
          id: toolCallId,
          at: existing?.at ?? at,
          name: started.name,
          icon: description.icon,
          title: description.title,
          detail: description.detail,
          status,
          error: failure === undefined ? undefined : needsBackgroundWork ? "Background work is off, so nothing can be scheduled to run while you're away yet." : errorText(failure),
          handledOffline: this.#ctx.isOffline(toolCallId) || undefined,
          scheduleId: scheduling && success && started.name === "schedule_task" ? scheduleIdFrom(content) : undefined,
          needsBackgroundWork: needsBackgroundWork || undefined,
          endedAt: at,
        };
        const changes: TimelineChange[] = [this.set(item)];
        if (scheduling) changes.push({ type: "schedules-changed" });
        return changes;
      }
      case "permission.requested": {
        const { requestId, permissionRequest, resolvedByHook } = event.data;
        if (resolvedByHook || permissionRequest.kind !== "custom-tool" || !APPROVAL_TOOLS.has(permissionRequest.toolName)) return [];
        const id = approvalItemId(permissionRequest);
        this.#approvals.set(requestId, id);
        if (this.#items.has(id)) return [];
        const description = this.#details.get(id) ?? describeApproval(permissionRequest.toolName, permissionRequest.args, this.#ctx.timeZone());
        return [
          this.set({
            kind: "approval",
            id,
            at,
            tool: permissionRequest.toolName,
            title: description.title,
            preview: description.preview,
            status: "pending",
            actionable: this.#ctx.isActionable(id),
          }),
        ];
      }
      case "permission.completed": {
        const { requestId, result, toolCallId } = event.data;
        const id = this.#approvals.get(requestId) ?? (toolCallId ? `approval:${toolCallId}` : undefined);
        const existing = id ? this.#items.get(id) : undefined;
        if (existing?.kind !== "approval") return [];
        const feedback = "feedback" in result && typeof result.feedback === "string" ? result.feedback : undefined;
        return [this.set({ ...existing, status: approvalStatusFor(result.kind), actionable: false, decidedAt: at, feedback })];
      }
      case "session.error":
        // An error ends the turn (it may never reach turn_end), so a replay doesn't think it is still running.
        this.#turnOpen = false;
        return [this.set({ kind: "notice", id: event.id, at, level: "error", text: errorText(event.data.message) })];
      case "abort":
        this.#turnOpen = false;
        return [this.set({ kind: "notice", id: event.id, at, level: "info", text: "Stopped." })];
      case "session.idle": {
        this.#turnOpen = false;
        const changes = this.#settle();
        if (this.#busy) {
          this.#busy = false;
          changes.push({ type: "busy", busy: false });
        }
        if (this.#lastProactive) {
          changes.push({ type: "proactive", ...this.#lastProactive });
          this.#lastProactive = undefined;
        }
        return changes;
      }
      default:
        return [];
    }
  }
}
