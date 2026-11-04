// One customer's conversation, projected from the stock session events: live as they arrive, or from
// `session.getEvents()` after a restart (history has no `session.idle`, so the last turn is settled from the session's
// platform record). Pure: no I/O, so tests drive it with plain events.
import type { MessageItem, ToolCallStatus, ToolItem, TranscriptItem } from "../shared/types.js";

/** The parts of a stock `SessionEvent` the projection reads. */
export interface SessionEventLike {
  readonly id?: string;
  readonly type: string;
  readonly timestamp?: string;
  readonly data?: unknown;
}

/** A refund or cancellation the store carried out, as recorded in the session's history. */
export interface Effect {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A tool's result as the agent saw it: our tools return JSON objects. */
export function parseResult(content: unknown): Record<string, unknown> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { text: content };
  } catch {
    return { text: content };
  }
}

export class Transcript {
  readonly #items: (Mutable<MessageItem> | Mutable<ToolItem>)[] = [];
  readonly #tools = new Map<string, Mutable<ToolItem>>();
  readonly #messages = new Map<string, Mutable<MessageItem>>();
  readonly #seen = new Set<string>();
  /** Whether an order named by a refused call belongs to someone else. */
  readonly #othersOrder: (args: Readonly<Record<string, unknown>>) => boolean;
  #busy = false;
  #resolved = false;
  #problem: string | undefined;

  constructor(othersOrder: (args: Readonly<Record<string, unknown>>) => boolean = () => false) {
    this.#othersOrder = othersOrder;
  }

  get items(): readonly TranscriptItem[] {
    return this.#items;
  }

  /** A turn is running. */
  get busy(): boolean {
    return this.#busy;
  }

  /** The agent marked the customer's latest request handled. */
  get resolved(): boolean {
    return this.#resolved;
  }

  /** The platform reported an error in the latest turn. */
  get problem(): string | undefined {
    return this.#problem;
  }

  /** Tool calls waiting for the operator. */
  get asking(): readonly ToolItem[] {
    return this.#items.filter((item): item is Mutable<ToolItem> => item.kind === "tool" && item.status === "asking");
  }

  get blocked(): number {
    return this.#items.filter((item) => item.kind === "tool" && item.blocked).length;
  }

  /** Refunds and cancellations that went through. */
  effects(): Effect[] {
    return this.#items.flatMap((item) =>
      item.kind === "tool" && item.status === "done" && (item.name === "request_refund" || item.name === "cancel_order") ? [{ id: item.id, tool: item.name, args: item.args }] : [],
    );
  }

  /** Applies one event. Returns whether anything a person sees changed. */
  apply(event: SessionEventLike): boolean {
    if (event.id) {
      if (this.#seen.has(event.id)) return false;
      this.#seen.add(event.id);
    }
    const data = record(event.data);
    const at = event.timestamp ?? new Date().toISOString();
    return this.#apply(event.type, data, at, event.id ?? `${this.#items.length}`);
  }

  #apply(type: string, data: Record<string, unknown>, at: string, eventId: string): boolean {
    switch (type) {
      case "user.message": {
        const content = text(data["content"])?.trim();
        this.#busy = true;
        this.#resolved = false;
        this.#problem = undefined;
        if (!content) return true;
        this.#items.push({ kind: "message", id: `u:${eventId}`, from: "customer", text: content, at });
        return true;
      }
      case "assistant.turn_start":
        if (this.#busy) return false;
        this.#busy = true;
        return true;
      case "assistant.message_delta": {
        const id = text(data["messageId"]);
        const delta = text(data["deltaContent"]);
        if (!id || !delta || data["parentToolCallId"]) return false;
        const message = this.#agentMessage(id, at);
        message.text += delta;
        message.streaming = true;
        return true;
      }
      case "assistant.message": {
        const id = text(data["messageId"]);
        if (!id || data["parentToolCallId"]) return false;
        const content = text(data["content"])?.trim() ?? "";
        const existing = this.#messages.get(id);
        if (!content) {
          // A message that only calls tools: drop the placeholder its deltas may have made.
          if (existing) this.#remove(existing);
          return Boolean(existing);
        }
        const message = existing ?? this.#agentMessage(id, at);
        message.text = content;
        delete message.streaming;
        return true;
      }
      case "tool.execution_start": {
        const id = text(data["toolCallId"]);
        const name = text(data["toolName"]);
        if (!id || !name) return false;
        if (this.#tools.has(id)) return false;
        this.#tool(id, name, record(data["arguments"]), at);
        return true;
      }
      case "permission.requested": {
        const request = record(data["permissionRequest"]);
        const id = text(request["toolCallId"]);
        const name = text(request["toolName"]);
        if (request["kind"] !== "custom-tool" || !id || !name) return false;
        const item = this.#tools.get(id) ?? this.#tool(id, name, record(request["args"]), at);
        if (item.status !== "running") return false;
        item.status = "asking";
        return true;
      }
      case "permission.completed": {
        const item = this.#tools.get(text(data["toolCallId"]) ?? "");
        if (!item || item.status !== "asking") return false;
        const kind = text(record(data["result"])["kind"]) ?? "";
        item.status = kind.startsWith("approved") ? "running" : kind === "cancelled" ? "failed" : "declined";
        return true;
      }
      case "tool.execution_complete": {
        const item = this.#tools.get(text(data["toolCallId"]) ?? "");
        if (!item || item.status === "declined") return false;
        const result = parseResult(record(data["result"])["content"]);
        if (result) item.result = result;
        item.status = this.#outcome(data["success"] === true, result);
        if (item.status === "refused" && "orderId" in item.args && this.#othersOrder(item.args)) item.blocked = true;
        if (item.name === "resolve_conversation" && item.status === "done") this.#resolved = true;
        return true;
      }
      case "session.error":
        this.#problem = text(data["message"]) ?? "The session reported an error.";
        return true;
      case "session.idle":
      case "abort":
        return this.settle();
      default:
        return false;
    }
  }

  #outcome(success: boolean, result: Record<string, unknown> | undefined): ToolCallStatus {
    if (!success) return "failed";
    return result?.["ok"] === false ? "refused" : "done";
  }

  /** The turn ended: nothing is being written or waits anymore. */
  settle(): boolean {
    let changed = this.#busy;
    this.#busy = false;
    for (const item of this.#items) {
      if (item.kind === "message" && item.streaming) {
        delete item.streaming;
        changed = true;
      }
      if (item.kind === "tool" && (item.status === "running" || item.status === "asking")) {
        item.status = "failed";
        changed = true;
      }
    }
    return changed;
  }

  #agentMessage(id: string, at: string): Mutable<MessageItem> {
    let message = this.#messages.get(id);
    if (!message) {
      message = { kind: "message", id: `a:${id}`, from: "agent", text: "", at };
      this.#messages.set(id, message);
      this.#items.push(message);
    }
    return message;
  }

  #tool(id: string, name: string, args: Record<string, unknown>, at: string): Mutable<ToolItem> {
    const item: Mutable<ToolItem> = { kind: "tool", id, name, args, at, status: "running" };
    this.#tools.set(id, item);
    this.#items.push(item);
    return item;
  }

  #remove(message: Mutable<MessageItem>): void {
    const index = this.#items.indexOf(message);
    if (index >= 0) this.#items.splice(index, 1);
    for (const [key, value] of this.#messages) if (value === message) this.#messages.delete(key);
  }
}
