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

/** Event timestamps come from the runtime and worker times from the gateway; allow for a little difference. */
const CLOCK_SKEW_MS = 2_000;

/** What `resolveWorkers` needs to know about a worker. */
export interface WorkerRef {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * The session's history (`getEvents()`, persisted events only) with the events delivered live while it loaded, in the
 * order they happened. Live events already in the history are dropped; the rest (ephemeral ones such as
 * `session.idle`, which history never contains, and anything persisted after the history was read) are placed by
 * timestamp, before history events with the same timestamp. Appending them instead could let an earlier
 * `session.idle` undo a newer turn that the history already shows.
 */
export function mergeHistory<T extends { readonly id: string; readonly timestamp: string }>(history: readonly T[], live: readonly T[]): T[] {
  const known = new Set(history.map((event) => event.id));
  const merged: T[] = [];
  let next = 0;
  for (const event of live) {
    if (known.has(event.id)) continue;
    const at = Date.parse(event.timestamp);
    while (next < history.length && Date.parse(history[next]!.timestamp) < at) merged.push(history[next++]!);
    merged.push(event);
  }
  while (next < history.length) merged.push(history[next++]!);
  return merged;
}

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
  /** `start_worker` calls whose permission prompt was answered or withdrawn (`permission.completed`). */
  readonly #settled = new Set<string>();
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
        this.settle(event.timestamp);
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
    // A new turn: anything the previous one left open was cut short (its `session.idle` is never in the history).
    if (!delivery) this.settle(event.timestamp);
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
    if (id) this.#settled.add(id);
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
    this.settle(event.timestamp);
    this.updatedAt = event.timestamp;
    return true;
  }

  /**
   * The turn is over (`session.idle`, `abort`, a new turn, or the platform reporting it finished): it is no longer
   * busy, and decisions it left open were cut short. Returns whether anything changed.
   */
  settle(at: string): boolean {
    let changed = this.busy || this.waiting !== undefined || this.#streaming.size > 0;
    this.busy = false;
    this.waiting = undefined;
    for (const message of this.#streaming.values()) message.streaming = false;
    this.#streaming.clear();
    for (const decision of this.#decisions.values()) {
      if (decision.status !== "running" && decision.status !== "asking") continue;
      decision.detail = decision.status === "asking" ? "Cancelled before anyone answered." : "Interrupted: the turn ended before this finished.";
      decision.status = "failed";
      decision.endedAt ??= at;
      changed = true;
    }
    return changed;
  }

  /** Whether the permission prompt for `start_worker` call `toolCallId` was answered or withdrawn, here or elsewhere. */
  isSettled(toolCallId: string | undefined): boolean {
    return toolCallId !== undefined && this.#settled.has(toolCallId);
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

  /**
   * Which worker each decision concerns, by the worker's session ID. `start_worker` answers name the new worker's ID;
   * otherwise names are matched in time, because a name can be reused after its worker stopped: a creation is the
   * earliest worker with that name created after it, and other calls concern the latest one created before them.
   */
  resolveWorkers(workers: readonly WorkerRef[]): Map<string, string> {
    const byName = new Map<string, WorkerRef[]>();
    for (const worker of [...workers].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
      const list = byName.get(worker.name) ?? [];
      list.push(worker);
      byName.set(worker.name, list);
    }
    const ids = new Set(workers.map((worker) => worker.id));
    const resolved = new Map<string, string>();
    for (const decision of this.#decisions.values()) {
      if (decision.kind !== "create" && decision.kind !== "message" && decision.kind !== "stop" && decision.kind !== "read") continue;
      if (decision.kind === "create" && (decision.status === "denied" || decision.status === "failed")) continue;
      if (decision.workerId && ids.has(decision.workerId)) {
        resolved.set(decision.id, decision.workerId);
        continue;
      }
      const name = decision.worker ?? decision.workerId;
      const candidates = name ? (byName.get(name) ?? []) : [];
      const at = Date.parse(decision.at);
      const match =
        decision.kind === "create"
          ? candidates.find((worker) => Date.parse(worker.createdAt) >= at - CLOCK_SKEW_MS)
          : [...candidates].reverse().find((worker) => Date.parse(worker.createdAt) <= at + CLOCK_SKEW_MS);
      if (match) resolved.set(decision.id, match.id);
    }
    return resolved;
  }

  /** Which user messages created a worker and sent it work, given `resolveWorkers`'s answer. */
  attribution(workerId: string, resolved: ReadonlyMap<string, string>): { createdBy?: number; sentWorkBy: number[] } {
    let createdBy: number | undefined;
    const sentWorkBy = new Set<number>();
    for (const message of this.#messages) {
      if (message.index === undefined) continue;
      for (const decisionId of message.decisionIds ?? []) {
        const decision = this.#decisions.get(decisionId);
        if (!decision || resolved.get(decisionId) !== workerId || decision.status === "denied" || decision.status === "failed") continue;
        if (decision.kind === "create") createdBy = message.index;
        else if (decision.kind === "message") sentWorkBy.add(message.index);
      }
    }
    return { ...(createdBy !== undefined ? { createdBy } : {}), sentWorkBy: [...sentWorkBy].sort((a, b) => a - b) };
  }

  /** The transcript as the UI shows it: each user message carries the decisions made for it, with their workers. */
  messages(resolved: ReadonlyMap<string, string> = new Map()): ChatMessage[] {
    return this.#messages.map((message) => {
      const { decisionIds, ...rest } = message;
      if (message.role !== "user") return { ...rest };
      const decisions = (decisionIds ?? []).map((id) => this.#decisions.get(id)).filter((decision): decision is DecisionRecord => decision !== undefined);
      return {
        ...rest,
        decisions: decisions.map(({ workerId: _workerId, ...decision }) => {
          const workerId = resolved.get(decision.id);
          return { ...decision, ...(workerId ? { workerId } : {}) };
        }),
      };
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
