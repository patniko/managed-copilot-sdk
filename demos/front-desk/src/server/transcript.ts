/**
 * Turns a session's events into the chat Front Desk shows: the person's messages, the assistant's answers (streamed as
 * they're written), what it did with their memory, and notices. History from `session.getEvents()` and live events go
 * through the same reducer, deduplicated by event ID.
 */
import type { SessionEvent } from "@github/copilot-sdk";
import type { ChatItem } from "../shared/types.js";
import { isMemoryTool } from "./tools.js";

export type TranscriptChange =
  | { readonly type: "item"; readonly item: ChatItem }
  | { readonly type: "delta"; readonly itemId: string; readonly delta: string }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "memory" };

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function describeTool(tool: string, args: unknown): { label: string; detail?: string } {
  const value = (key: string) => {
    const field = (args as Record<string, unknown> | undefined)?.[key];
    return typeof field === "string" && field.trim() ? field.trim() : undefined;
  };
  switch (tool) {
    case "remember": {
      const fact = value("fact");
      return fact ? { label: "Remembered", detail: fact } : { label: "Remembered something" };
    }
    case "recall": {
      const query = value("query");
      return query ? { label: "Looked through your memory", detail: query } : { label: "Looked through your memory" };
    }
    case "forget":
      return { label: "Forgot an item" };
    default:
      return { label: tool };
  }
}

export class Transcript {
  #items: ChatItem[] = [];
  readonly #index = new Map<string, number>();
  readonly #seen = new Set<string>();
  #busy = false;
  #lastActivity = Date.now();

  get items(): readonly ChatItem[] {
    return this.#items;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** When the last event arrived (to notice a turn that will never finish). */
  get lastActivity(): number {
    return this.#lastActivity;
  }

  /** Rebuilds from history. Persisted history has no deltas or idle events, so an unfinished last turn reads as busy. */
  replaceAll(events: readonly SessionEvent[]): void {
    this.#items = [];
    this.#index.clear();
    this.#seen.clear();
    this.#busy = false;
    for (const event of events) this.apply(event);
    this.#busy = this.#unfinished(events);
    if (!this.#busy) this.#settleStreaming();
  }

  apply(event: SessionEvent): TranscriptChange[] {
    if (event.id && this.#seen.has(event.id)) return [];
    if (event.id) this.#seen.add(event.id);
    this.#lastActivity = Date.now();
    const changes: TranscriptChange[] = [];
    const data = (event as { data?: Record<string, unknown> }).data ?? {};
    // Sub-agent events belong to their parent's tool call, not to the conversation.
    if (typeof data.parentToolCallId === "string" || (event as { agentId?: string }).agentId) return changes;
    switch (event.type) {
      case "user.message": {
        const id = typeof data.messageId === "string" ? data.messageId : event.id;
        changes.push(this.#set({ kind: "user", id, text: String(data.content ?? ""), at: event.timestamp }));
        changes.push(...this.#setBusy(true));
        break;
      }
      case "assistant.turn_start":
        changes.push(...this.#setBusy(true));
        break;
      case "assistant.message_delta": {
        const id = String(data.messageId ?? "");
        const delta = String(data.deltaContent ?? "");
        if (!id || !delta) break;
        const existing = this.#get(id);
        if (existing?.kind === "assistant") {
          this.#replace({ ...existing, text: existing.text + delta, streaming: true });
          changes.push({ type: "delta", itemId: id, delta });
        } else {
          changes.push(this.#set({ kind: "assistant", id, text: delta, at: event.timestamp, streaming: true }));
        }
        changes.push(...this.#setBusy(true));
        break;
      }
      case "assistant.message": {
        const id = String(data.messageId ?? event.id);
        const text = String(data.content ?? "");
        const existing = this.#get(id);
        if (!text.trim()) {
          // A message that only asks for tools: drop any empty streaming placeholder.
          if (existing?.kind === "assistant" && !existing.text.trim()) this.#remove(id);
          break;
        }
        changes.push(
          this.#set({
            kind: "assistant",
            id,
            text,
            at: existing?.at ?? event.timestamp,
            ...(typeof data.model === "string" ? { model: data.model } : {}),
          }),
        );
        break;
      }
      case "tool.execution_start": {
        const tool = String(data.toolName ?? "");
        if (!isMemoryTool(tool)) break;
        const { label, detail } = describeTool(tool, data.arguments);
        changes.push(this.#set({ kind: "tool", id: String(data.toolCallId), tool, label, ...(detail ? { detail } : {}), status: "running", at: event.timestamp }));
        break;
      }
      case "tool.execution_complete": {
        const existing = this.#get(String(data.toolCallId ?? ""));
        if (existing?.kind !== "tool") break;
        const item: ToolItem = { ...existing, status: data.success === false ? "failed" : "done" };
        changes.push(this.#set(item));
        if (item.status === "done" && item.tool !== "recall") changes.push({ type: "memory" });
        break;
      }
      case "session.idle":
        changes.push(...this.#settle());
        break;
      case "abort":
        changes.push(this.#notice(event, "info", "Stopped."));
        changes.push(...this.#settle());
        break;
      case "session.error": {
        const message = typeof data.message === "string" && data.message.trim() ? data.message.trim() : "Something went wrong while answering.";
        changes.push(this.#notice(event, "danger", message));
        changes.push(...this.#settle());
        break;
      }
      case "session.title_changed":
        if (typeof data.title === "string" && data.title.trim()) changes.push({ type: "title", title: data.title.trim() });
        break;
      default:
        break;
    }
    return changes;
  }

  /** Marks the conversation as working right after a message was accepted, before the runtime's first event. */
  markBusy(): TranscriptChange[] {
    this.#lastActivity = Date.now();
    return this.#setBusy(true);
  }

  /** Marks the conversation as no longer working, e.g. after a stop that the runtime didn't report. */
  settle(note?: string): TranscriptChange[] {
    const changes = this.#settle();
    if (note) changes.unshift(this.#set({ kind: "notice", id: `notice-${Date.now()}`, tone: "warning", text: note, at: new Date().toISOString() }));
    return changes;
  }

  #unfinished(events: readonly SessionEvent[]): boolean {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      const data = (event as { data?: Record<string, unknown> }).data ?? {};
      if (typeof data.parentToolCallId === "string" || (event as { agentId?: string }).agentId) continue;
      switch (event.type) {
        case "assistant.turn_end":
        case "abort":
        case "session.error":
          return false;
        case "assistant.message":
          // The final answer of a turn asks for no more tools.
          return Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
        case "user.message":
        case "assistant.turn_start":
        case "tool.execution_start":
        case "tool.execution_complete":
          return true;
        default:
          continue;
      }
    }
    return false;
  }

  #settle(): TranscriptChange[] {
    return [...this.#settleStreaming(), ...this.#setBusy(false)];
  }

  #settleStreaming(): TranscriptChange[] {
    const changes: TranscriptChange[] = [];
    for (const item of this.#items) {
      if (item.kind === "assistant" && item.streaming) changes.push(this.#set({ ...item, streaming: false }));
      if (item.kind === "tool" && item.status === "running") changes.push(this.#set({ ...item, status: "failed" }));
    }
    return changes;
  }

  #setBusy(busy: boolean): TranscriptChange[] {
    if (this.#busy === busy) return [];
    this.#busy = busy;
    return [{ type: "busy", busy }];
  }

  #notice(event: SessionEvent, tone: "info" | "warning" | "danger", text: string): TranscriptChange {
    return this.#set({ kind: "notice", id: event.id, tone, text, at: event.timestamp });
  }

  #get(id: string): ChatItem | undefined {
    const index = this.#index.get(id);
    return index === undefined ? undefined : this.#items[index];
  }

  #set(item: ChatItem): TranscriptChange {
    this.#replace(item);
    return { type: "item", item };
  }

  #replace(item: ChatItem): void {
    const index = this.#index.get(item.id);
    if (index === undefined) {
      this.#index.set(item.id, this.#items.length);
      this.#items.push(item);
    } else {
      this.#items[index] = item;
    }
  }

  #remove(id: string): void {
    const index = this.#index.get(id);
    if (index === undefined) return;
    this.#items.splice(index, 1);
    this.#index.clear();
    this.#items.forEach((item, position) => this.#index.set(item.id, position));
  }
}
