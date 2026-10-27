// The conversation as Dispatch shows it, projected from the coordinator session's own events: the user's messages,
// the coordinator's replies, and what it did with its worker tools for each message (sandboxes created, work sent to
// existing ones, files copied, stops). Pure and replayable: the same events give the same transcript, whether they
// arrive live or from the session's history after a restart.
import type { ChatMessage, Decision, DecisionKind, DecisionStatus } from "../shared/types.js";

/** A coordinator session event as the stock SDK delivers it: the fields Dispatch reads. */
export interface CoordinatorEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly ephemeral?: boolean;
  /** Set on a subagent's events; Dispatch follows the coordinator's own. */
  readonly agentId?: string;
  readonly data?: unknown;
}

/** The coordinator's worker tools (spec section 17) and what each one is to a person reading along. */
export const WORKER_TOOLS: Readonly<Record<string, DecisionKind>> = {
  start_worker: "create",
  message_worker: "message",
  copy_worker_files: "copy",
  stop_worker: "stop",
  wait_for_workers: "wait",
  read_worker_file: "read",
  list_workers: "list",
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DecisionRecord = Mutable<Decision> & { workerId?: string };
type MessageRecord = Mutable<ChatMessage> & { decisionIds?: string[] };

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The first meaningful line of a tool result, for a one-line outcome. */
export function firstLine(value: string | undefined, max = 220): string | undefined {
  const line = value
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A worker ID in `start_worker`'s answer: `Started worker "name" (ID <uuid>) in environment ...`. */
const STARTED = /\(ID ([0-9a-fA-F-]{36})\)/;

export class Transcript {
  readonly #messages: MessageRecord[] = [];
  readonly #decisions = new Map<string, DecisionRecord>();
  /** Assistant messages still streaming, by the runtime's message ID. */
  readonly #streaming = new Map<string, MessageRecord>();
  /** Persisted events already applied (history and live delivery overlap after a resume). */
  readonly #seen = new Set<string>();
  /** Each worker name's current worker ID, from `start_worker` answers. */
  readonly #workerIds = new Map<string, string>();
  /** Assistant messages already complete: a late delta (live delivery overlapping history) must not reopen them. */
  readonly #completed = new Set<string>();
  /** Permission request IDs to the `start_worker` call they gate. */
  readonly #requests = new Map<string, string>();
  #users = 0;
  #current: MessageRecord | undefined;
  title: string | undefined;
  busy = false;
  waiting: { workers: string[]; since: string; toolCallId: string } | undefined;
  updatedAt: string | undefined;

  /**
   * `isOwn` tells whether a user message (by the ID `session.send` returned, or its text while that send is in flight)
   * was sent from Dispatch, so messages from other clients of the same session (Copilot CLI) are labelled.
   * `defaultEnvironment` is the first worker environment.
   */
  constructor(
    private readonly isOwn: (messageId: string | undefined, content: string) => boolean,
    private readonly defaultEnvironment?: string,
  ) {}

  get userMessages(): number {
    return this.#users;
  }

  /** The user message the coordinator is working on (the latest one). */
  get currentIndex(): number | undefined {
    return this.#current?.index;
  }

  /** Applies one event; returns whether anything a person would see changed. */
  apply(event: CoordinatorEvent): boolean {
    if (event.agentId) return false;
    if (!event.ephemeral) {
      if (this.#seen.has(event.id)) return false;
      this.#seen.add(event.id);
    }
    const data = record(event.data);
    switch (event.type) {
      case "user.message":
        return this.#user(event, data);
      case "assistant.message_delta":
        return this.#delta(event, data);
      case "assistant.message":
        return this.#assistant(event, data);
      case "tool.execution_start":
        return this.#toolStart(event, data);
      case "tool.execution_complete":
        return this.#toolEnd(event, data);
      case "permission.requested":
        return this.#permissionRequested(event, data);
      case "permission.completed":
        return this.#permissionCompleted(event, data);
      case "session.idle":
        return this.#idle(event);
      case "abort":
        this.busy = false;
        this.waiting = undefined;
        return true;
      case "session.error": {
        const message = text(data["message"]) ?? "The coordinator reported an error.";
        this.#messages.push({ id: event.id, role: "notice", content: message, at: event.timestamp, tone: data["errorType"] === "interrupted" ? "attention" : "danger" });
        this.updatedAt = event.timestamp;
        return true;
      }
      case "session.title_changed": {
        const title = text(data["title"]);
        if (!title || title === this.title) return false;
        this.title = title;
        return true;
      }
      default:
        return false;
    }
  }

  #user(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    // Autopilot continuations and skill prompts are part of a run, not something the person said.
    if (data["isAutopilotContinuation"] === true || String(data["source"] ?? "").startsWith("skill-")) return false;
    const delivery = data["delivery"] === "steering" || data["delivery"] === "queued" ? data["delivery"] : undefined;
    const content = typeof data["content"] === "string" ? data["content"] : "";
    const message: MessageRecord = {
      id: event.id,
      role: "user",
      content,
      at: event.timestamp,
      index: ++this.#users,
      via: this.isOwn(text(data["messageId"]), content) ? "dispatch" : "other",
      ...(delivery ? { delivery } : {}),
      decisionIds: [],
    };
    this.#messages.push(message);
    this.#current = message;
    this.busy = true;
    this.updatedAt = event.timestamp;
    return true;
  }

  #delta(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const id = text(data["messageId"]);
    const delta = typeof data["deltaContent"] === "string" ? data["deltaContent"] : "";
    if (!id || !delta || this.#completed.has(id)) return false;
    let message = this.#streaming.get(id);
    if (!message) {
      message = { id: `assistant:${id}`, role: "assistant", content: "", at: event.timestamp, streaming: true };
      this.#streaming.set(id, message);
      this.#messages.push(message);
    }
    message.content += delta;
    return true;
  }

  #assistant(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const content = typeof data["content"] === "string" ? data["content"].trim() : "";
    const id = text(data["messageId"]) ?? event.id;
    const streamed = this.#streaming.get(id);
    this.#streaming.delete(id);
    this.#completed.add(id);
    if (streamed) {
      if (!content) {
        this.#messages.splice(this.#messages.indexOf(streamed), 1);
        return true;
      }
      streamed.content = content;
      streamed.streaming = false;
      this.updatedAt = event.timestamp;
      return true;
    }
    if (!content) return false;
    this.#messages.push({ id: `assistant:${id}`, role: "assistant", content, at: event.timestamp });
    this.updatedAt = event.timestamp;
    return true;
  }

  #toolStart(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const kind = WORKER_TOOLS[String(data["toolName"] ?? "")];
    const id = text(data["toolCallId"]);
    if (!kind || !id) return false;
    const existing = this.#decisions.get(id);
    if (existing) {
      // Known from its permission prompt: running means it was approved.
      if (existing.status !== "asking") return false;
      existing.status = "running";
      return true;
    }
    const args = record(data["arguments"]);
    const decision: DecisionRecord = { id, kind, status: "running", at: event.timestamp };
    switch (kind) {
      case "create":
        this.#describeCreate(decision, args);
        break;
      case "message": {
        const worker = text(args["worker"]);
        Object.assign(decision, { ...(worker ? { worker, workerId: this.#workerIds.get(worker) ?? worker } : {}), ...(text(args["message"]) ? { task: String(args["message"]) } : {}) });
        break;
      }
      case "stop": {
        const worker = text(args["worker"]);
        if (worker) Object.assign(decision, { worker, workerId: this.#workerIds.get(worker) ?? worker });
        break;
      }
      case "read": {
        const worker = text(args["worker"]);
        Object.assign(decision, { ...(worker ? { worker } : {}), ...(text(args["path"]) ? { path: String(args["path"]) } : {}) });
        break;
      }
      case "copy":
        Object.assign(decision, { ...(text(args["from"]) ? { from: String(args["from"]) } : {}), ...(text(args["to"]) ? { to: String(args["to"]) } : {}), paths: texts(args["paths"]) });
        break;
      case "wait": {
        const workers = texts(args["workers"]);
        decision.workers = workers;
        this.waiting = { workers, since: event.timestamp, toolCallId: id };
        break;
      }
      case "list":
        break;
    }
    this.#decisions.set(id, decision);
    this.#current?.decisionIds?.push(id);
    this.updatedAt = event.timestamp;
    return true;
  }

  #toolEnd(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const id = text(data["toolCallId"]);
    const decision = id ? this.#decisions.get(id) : undefined;
    if (!decision) return false;
    const result = record(data["result"]);
    const error = record(data["error"]);
    const outcome = text(result["content"]) ?? text(result["textResultForLlm"]) ?? text(error["message"]);
    const failed = data["success"] === false;
    if (decision.status !== "denied") decision.status = failed ? "failed" : "done";
    decision.endedAt = event.timestamp;
    const line = firstLine(outcome);
    if (line && decision.status !== "denied") decision.detail = line;
    if (decision.kind === "create" && !failed && decision.worker) {
      const started = outcome ? STARTED.exec(outcome) : null;
      if (started?.[1]) {
        decision.workerId = started[1];
        this.#workerIds.set(decision.worker, started[1]);
      }
    }
    if (decision.kind === "wait" && this.waiting?.toolCallId === id) this.waiting = undefined;
    this.updatedAt = event.timestamp;
    return true;
  }

  #describeCreate(decision: DecisionRecord, args: Record<string, unknown>): void {
    const name = text(args["name"]);
    const environment = text(args["environment"]) ?? this.defaultEnvironment;
    const task = text(args["task"]);
    Object.assign(decision, { ...(name ? { worker: name } : {}), ...(environment ? { environment } : {}), ...(task ? { task } : {}) });
  }

  /** The coordinator asked to start a worker: the session's permission prompt for `start_worker`. */
  #permissionRequested(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const request = record(data["permissionRequest"]);
    if (request["kind"] !== "custom-tool" || request["toolName"] !== "start_worker" || data["resolvedByHook"] === true) return false;
    const requestId = text(data["requestId"]);
    const id = text(request["toolCallId"]) ?? requestId;
    if (!id) return false;
    if (requestId) this.#requests.set(requestId, id);
    const existing = this.#decisions.get(id);
    if (existing) {
      if (existing.status !== "running") return false;
      existing.status = "asking";
      return true;
    }
    const decision: DecisionRecord = { id, kind: "create", status: "asking", at: event.timestamp };
    this.#describeCreate(decision, record(request["args"]));
    this.#decisions.set(id, decision);
    this.#current?.decisionIds?.push(id);
    this.updatedAt = event.timestamp;
    return true;
  }

  #permissionCompleted(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const requestId = text(data["requestId"]);
    const id = text(data["toolCallId"]) ?? (requestId ? this.#requests.get(requestId) : undefined);
    const decision = id ? this.#decisions.get(id) : undefined;
    if (!decision || decision.kind !== "create") return false;
    const result = record(data["result"]);
    const kind = String(result["kind"] ?? "");
    if (kind.startsWith("approved")) {
      if (decision.status !== "asking") return false;
      decision.status = "running";
      return true;
    }
    const status: DecisionStatus = kind === "cancelled" ? "failed" : "denied";
    const detail = kind === "cancelled" ? "Cancelled before anyone answered." : (firstLine(text(result["feedback"])) ?? "Declined.");
    if (decision.status === status && decision.detail === detail) return false;
    decision.status = status;
    decision.endedAt ??= event.timestamp;
    decision.detail = detail;
    this.updatedAt = event.timestamp;
    return true;
  }

  #idle(event: CoordinatorEvent): boolean {
    this.busy = false;
    this.waiting = undefined;
    for (const message of this.#streaming.values()) message.streaming = false;
    this.#streaming.clear();
    this.updatedAt = event.timestamp;
    return true;
  }

  /** Marks the `start_worker` call an approval gates (`asking`, then `running` or `denied`). */
  markDecision(decisionId: string | undefined, status: DecisionStatus, detail?: string): boolean {
    const decision = decisionId ? this.#decisions.get(decisionId) : undefined;
    if (!decision || (decision.status === status && (detail === undefined || decision.detail === detail))) return false;
    decision.status = status;
    if (detail !== undefined) decision.detail = detail;
    return true;
  }

  /** The user message (number) the decision for `decisionId` serves. */
  messageIndexOf(decisionId: string | undefined): number | undefined {
    if (!decisionId) return undefined;
    return this.#messages.find((message) => message.decisionIds?.includes(decisionId))?.index;
  }

  /** Which user messages created a worker and sent it work: by its ID, or by its name before its ID is known. */
  attribution(worker: { readonly id: string; readonly name: string }): { createdBy?: number; sentWorkBy: number[] } {
    let createdBy: number | undefined;
    const sentWorkBy = new Set<number>();
    for (const message of this.#messages) {
      for (const decisionId of message.decisionIds ?? []) {
        const decision = this.#decisions.get(decisionId);
        if (!decision || decision.status === "denied" || decision.status === "failed") continue;
        const matches = decision.workerId ? decision.workerId === worker.id || decision.workerId === worker.name : decision.worker === worker.name;
        if (!matches || message.index === undefined) continue;
        if (decision.kind === "create") createdBy = message.index;
        else if (decision.kind === "message") sentWorkBy.add(message.index);
      }
    }
    return { ...(createdBy !== undefined ? { createdBy } : {}), sentWorkBy: [...sentWorkBy].sort((a, b) => a - b) };
  }

  /** The transcript as the UI shows it: each user message carries the decisions made for it. */
  messages(): ChatMessage[] {
    return this.#messages.map((message) => {
      const { decisionIds, ...rest } = message;
      if (message.role !== "user") return { ...rest };
      const decisions = (decisionIds ?? []).map((id) => this.#decisions.get(id)).filter((decision): decision is DecisionRecord => decision !== undefined);
      return { ...rest, decisions: decisions.map(({ workerId: _workerId, ...decision }) => ({ ...decision })) };
    });
  }

  /** Decisions still running, for status (for example a pending approval's `start_worker`). */
  decision(decisionId: string): Decision | undefined {
    const decision = this.#decisions.get(decisionId);
    if (!decision) return undefined;
    const { workerId: _workerId, ...rest } = decision;
    return rest;
  }
}
