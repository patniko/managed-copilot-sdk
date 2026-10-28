// The conversation as Dispatch shows it, projected from the coordinator session's own events: the user's messages,
// the coordinator's replies, and what it did with its worker tools for each message (sandboxes created, work sent to
// existing ones, files copied, stops). Pure and replayable: the same events give the same transcript, whether they
// arrive live or from the session's history after a restart.
import type { ChatMessage, Command, CommandKind, CommandStatus, Decision, DecisionKind, DecisionStatus, SubAgent } from "../shared/types.js";

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

/**
 * A direct or mixed coordinator's hands tools (spec section 17): the stock shell and file tools' names, acting in its
 * own sandbox. Its sub-agents call them too; their calls carry the sub-agent's `agentId`.
 */
export const HANDS_TOOLS: Readonly<Record<string, CommandKind>> = {
  bash: "run",
  write_bash: "input",
  read_bash: "output",
  stop_bash: "stop",
  list_bash: "list",
  view: "view",
  create: "create",
  edit: "edit",
  glob: "search",
  grep: "search",
};

/** Hands tools that ask for permission, once per call: they run something or change a file. */
export const ASKING_TOOLS: ReadonlySet<string> = new Set(["bash", "write_bash", "create", "edit"]);

/** Events a sub-agent's work is followed through: its hands tool calls and their permission prompts, and its start and end. */
const SUBAGENT_EVENTS: ReadonlySet<string> = new Set([
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "permission.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);

/** The output kept for a command: its end, which is what usually matters. */
const OUTPUT_KEPT = 2_000;

/**
 * The status line the platform's `bash` and `read_bash` end their answer with: `<exited with exit code 0; shellId: …>`,
 * `<command with shellId: … is still running …>`, or `<command started in the background with shellId: …>`.
 */
const STATUS_LINE = /\n?<((?:exited with exit code|killed by|timed out|stopped|could not start|outcome unknown|command with shellId|command started in the background)[^\n]*)>\s*$/;

/** A bash answer's outcome, exit code, and output (without the status line). */
export function parseCommandResult(content: string): { output: string; outcome?: string; exitCode?: number; shellId?: string; running?: boolean } {
  const match = STATUS_LINE.exec(content);
  const output = (match ? content.slice(0, match.index) : content).replace(/\s+$/, "");
  const kept = output.length > OUTPUT_KEPT ? `…${output.slice(-OUTPUT_KEPT)}` : output;
  if (!match) return { output: kept };
  const status = match[1]!;
  const shellId = /shellId: ([^\s;>.]+)/.exec(status)?.[1];
  const code = /exited with exit code (-?\d+)/.exec(status)?.[1];
  const running = /^command with shellId: .* is still running|^command started in the background/.test(status);
  const outcome = code !== undefined ? `exit code ${code}` : running ? (status.startsWith("command started") ? "started in the background" : "still running") : status.replace(/;\s*shellId:.*$/, "");
  return { output: kept, outcome, ...(code !== undefined ? { exitCode: Number(code) } : {}), ...(shellId ? { shellId } : {}), ...(running ? { running } : {}) };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DecisionRecord = Mutable<Decision> & { workerId?: string };
type CommandRecord = Mutable<Command>;
type SubAgentRecord = Mutable<SubAgent>;
type MessageRecord = Mutable<ChatMessage> & { decisionIds?: string[]; commandIds?: string[]; subagentIds?: string[] };

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
 * timestamp. Appending them instead could let an earlier `session.idle` undo a newer turn that the history already
 * shows. On a tie, a live event goes after the history's other events of that millisecond (an idle ends its own turn,
 * after its reply) but before a `user.message` (an idle precedes the next turn).
 */
export function mergeHistory<T extends { readonly id: string; readonly timestamp: string; readonly type: string }>(history: readonly T[], live: readonly T[]): T[] {
  const known = new Set(history.map((event) => event.id));
  const merged: T[] = [];
  let next = 0;
  for (const event of live) {
    if (known.has(event.id)) continue;
    const at = Date.parse(event.timestamp);
    // On a tie, a live event follows the history's events of its own turn but precedes the next turn's message.
    while (next < history.length) {
      const candidate = history[next]!;
      const time = Date.parse(candidate.timestamp);
      if (time > at || (time === at && candidate.type === "user.message")) break;
      merged.push(candidate);
      next += 1;
    }
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
  /** Every assistant message shown, by the runtime's message ID. */
  readonly #assistantMessages = new Map<string, MessageRecord>();
  /** Persisted events already applied (history and live delivery overlap after a resume). */
  readonly #seen = new Set<string>();
  /** Each worker name's current worker ID, from `start_worker` answers. */
  readonly #workerIds = new Map<string, string>();
  /** Assistant messages already complete: a late delta (live delivery overlapping history) must not reopen them. */
  readonly #completed = new Set<string>();
  /** Permission request IDs to the `start_worker` call (or hands tool call) they gate. */
  readonly #requests = new Map<string, string>();
  /** Tool calls whose permission prompt was answered or withdrawn (`permission.completed`). */
  readonly #settled = new Set<string>();
  /** Hands tool calls, by tool call ID. */
  readonly #commands = new Map<string, CommandRecord>();
  /** Sub-agents, by the `task` call that started them. */
  readonly #subagents = new Map<string, SubAgentRecord>();
  /** Sub-agent names by their ID. */
  readonly #agentNames = new Map<string, string>();
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
    // A sub-agent's own messages and reasoning stay its own; its hands work and its start and end are shown.
    if (event.agentId && !SUBAGENT_EVENTS.has(event.type)) return false;
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
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        return this.#subagent(event, data);
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
    const messageId = text(data["messageId"]);
    const message: MessageRecord = {
      id: event.id,
      role: "user",
      content,
      at: event.timestamp,
      index: ++this.#users,
      via: this.isOwn(messageId, content) ? "dispatch" : "other",
      ...(messageId ? { messageId } : {}),
      ...(delivery ? { delivery } : {}),
      decisionIds: [],
      commandIds: [],
      subagentIds: [],
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
    // Still being written, or cut off by its turn's end and continuing: either way, the same message.
    let message = this.#streaming.get(id) ?? this.#assistantMessages.get(id);
    if (!message) {
      message = { id: `assistant:${id}`, role: "assistant", content: "", at: event.timestamp, streaming: true };
      this.#assistantMessages.set(id, message);
      this.#messages.push(message);
    }
    message.streaming = true;
    this.#streaming.set(id, message);
    message.content += delta;
    return true;
  }

  #assistant(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const content = typeof data["content"] === "string" ? data["content"].trim() : "";
    const id = text(data["messageId"]) ?? event.id;
    // One message per ID, whatever order its pieces arrived in.
    const existing = this.#streaming.get(id) ?? this.#assistantMessages.get(id);
    this.#streaming.delete(id);
    this.#completed.add(id);
    if (existing) {
      if (!content) {
        this.#messages.splice(this.#messages.indexOf(existing), 1);
        this.#assistantMessages.delete(id);
        return true;
      }
      existing.content = content;
      existing.streaming = false;
      this.updatedAt = event.timestamp;
      return true;
    }
    if (!content) return false;
    const message: MessageRecord = { id: `assistant:${id}`, role: "assistant", content, at: event.timestamp };
    this.#assistantMessages.set(id, message);
    this.#messages.push(message);
    this.updatedAt = event.timestamp;
    return true;
  }

  #toolStart(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const toolName = String(data["toolName"] ?? "");
    if (toolName in HANDS_TOOLS) return this.#commandStart(event, data);
    if (toolName === "task") return this.#taskStart(event, data);
    if (event.agentId) return false;
    const kind = WORKER_TOOLS[toolName];
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
    if (id && this.#commands.has(id)) return this.#commandEnd(event, data, this.#commands.get(id)!);
    if (id && this.#subagents.has(id)) return this.#taskEnd(event, data, this.#subagents.get(id)!);
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

  /** A hands tool call, by the coordinator or a sub-agent (known first from its permission prompt, or from its start). */
  #command(id: string, toolName: string, args: Record<string, unknown>, event: CoordinatorEvent, status: CommandStatus): CommandRecord {
    const kind = HANDS_TOOLS[toolName]!;
    const command: CommandRecord = { id, tool: toolName, kind, status, at: event.timestamp, ...(event.agentId ? { agentId: event.agentId } : {}) };
    const shellId = text(args["shellId"]);
    switch (kind) {
      case "run":
        Object.assign(command, { ...(text(args["command"]) ? { command: String(args["command"]) } : {}), ...(text(args["description"]) ? { description: String(args["description"]) } : {}) });
        break;
      case "input":
        Object.assign(command, { ...(typeof args["input"] === "string" ? { command: args["input"] } : {}), ...(shellId ? { shellId } : {}) });
        break;
      case "output":
      case "stop":
        if (shellId) command.shellId = shellId;
        break;
      case "search":
        Object.assign(command, { ...(text(args["pattern"]) ? { pattern: String(args["pattern"]) } : {}), ...(text(args["path"]) ? { path: String(args["path"]) } : {}) });
        break;
      case "view":
      case "create":
      case "edit":
        if (text(args["path"])) command.path = String(args["path"]);
        break;
      case "list":
        break;
    }
    this.#commands.set(id, command);
    this.#current?.commandIds?.push(id);
    this.updatedAt = event.timestamp;
    return command;
  }

  #commandStart(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const id = text(data["toolCallId"]);
    if (!id) return false;
    const existing = this.#commands.get(id);
    if (existing) {
      // Known from its permission prompt: running means it was approved.
      if (existing.status !== "asking") return false;
      existing.status = "running";
      return true;
    }
    this.#command(id, String(data["toolName"]), record(data["arguments"]), event, "running");
    return true;
  }

  #commandEnd(event: CoordinatorEvent, data: Record<string, unknown>, command: CommandRecord): boolean {
    const result = record(data["result"]);
    const error = record(data["error"]);
    const content = text(result["content"]) ?? text(result["textResultForLlm"]);
    const failed = data["success"] === false;
    command.endedAt = event.timestamp;
    if (command.status === "denied") return true;
    if (failed) {
      command.status = "failed";
      const why = firstLine(text(error["message"]) ?? content);
      if (why) command.outcome = why;
      this.updatedAt = event.timestamp;
      return true;
    }
    command.status = "done";
    if (command.kind === "run" || command.kind === "output" || command.kind === "input" || command.kind === "stop") {
      const parsed = parseCommandResult(content ?? "");
      if (parsed.output) command.output = parsed.output;
      if (parsed.outcome) command.outcome = parsed.outcome;
      if (parsed.exitCode !== undefined) command.exitCode = parsed.exitCode;
      if (parsed.shellId && !command.shellId) command.shellId = parsed.shellId;
    } else {
      const line = firstLine(content, 160);
      if (line) command.outcome = line;
    }
    this.updatedAt = event.timestamp;
    return true;
  }

  /** The coordinator (or a sub-agent) started a sub-agent with the stock `task` tool. */
  #taskStart(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const id = text(data["toolCallId"]);
    if (!id || this.#subagents.has(id)) return false;
    const args = record(data["arguments"]);
    const description = text(args["description"]);
    const subagent: SubAgentRecord = {
      toolCallId: id,
      name: text(args["name"]) ?? description ?? "sub-agent",
      ...(description ? { description } : {}),
      ...(text(args["agent_type"]) ? { type: String(args["agent_type"]) } : {}),
      status: "running",
      at: event.timestamp,
    };
    this.#subagents.set(id, subagent);
    this.#current?.subagentIds?.push(id);
    this.updatedAt = event.timestamp;
    return true;
  }

  #taskEnd(event: CoordinatorEvent, data: Record<string, unknown>, subagent: SubAgentRecord): boolean {
    if (subagent.status !== "running") return false;
    const failed = data["success"] === false;
    subagent.status = failed ? "failed" : "done";
    subagent.endedAt = event.timestamp;
    if (failed) {
      const why = firstLine(text(record(data["error"])["message"]));
      if (why) subagent.detail = why;
    }
    this.updatedAt = event.timestamp;
    return true;
  }

  /** `subagent.started`, `subagent.completed`, `subagent.failed`: its ID (the `agentId` on its calls) and how it ended. */
  #subagent(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const toolCallId = text(data["toolCallId"]);
    const subagent = toolCallId ? this.#subagents.get(toolCallId) : undefined;
    const name = text(data["agentDisplayName"]) ?? text(data["agentName"]);
    if (event.agentId && (name ?? subagent?.name)) this.#agentNames.set(event.agentId, (subagent?.name ?? name)!);
    if (!subagent) return event.type === "subagent.started" && event.agentId !== undefined;
    if (event.agentId) subagent.id = event.agentId;
    if (event.type === "subagent.started") {
      if (!subagent.type && text(data["agentType"])) subagent.type = String(data["agentType"]);
    } else if (subagent.status === "running") {
      subagent.status = event.type === "subagent.failed" ? "failed" : "done";
      subagent.endedAt = event.timestamp;
      const why = event.type === "subagent.failed" ? firstLine(text(data["error"])) : data["cancelled"] === true ? "Cancelled before it finished." : undefined;
      if (why) subagent.detail = why;
    }
    this.updatedAt = event.timestamp;
    return true;
  }

  /** The coordinator asked to start a worker, or (direct, mixed) it or a sub-agent asked to run a command or change a file. */
  #permissionRequested(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const request = record(data["permissionRequest"]);
    const toolName = String(request["toolName"] ?? "");
    if (request["kind"] !== "custom-tool" || data["resolvedByHook"] === true) return false;
    if (ASKING_TOOLS.has(toolName)) return this.#commandAsked(event, data, request, toolName);
    if (toolName !== "start_worker" || event.agentId) return false;
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

  #commandAsked(event: CoordinatorEvent, data: Record<string, unknown>, request: Record<string, unknown>, toolName: string): boolean {
    const requestId = text(data["requestId"]);
    const id = text(request["toolCallId"]) ?? requestId;
    if (!id) return false;
    if (requestId) this.#requests.set(requestId, id);
    const existing = this.#commands.get(id);
    if (existing) {
      if (existing.status !== "running") return false;
      existing.status = "asking";
      return true;
    }
    this.#command(id, toolName, record(request["args"]), event, "asking");
    return true;
  }

  #permissionCompleted(event: CoordinatorEvent, data: Record<string, unknown>): boolean {
    const requestId = text(data["requestId"]);
    const id = text(data["toolCallId"]) ?? (requestId ? this.#requests.get(requestId) : undefined);
    if (id) this.#settled.add(id);
    const result = record(data["result"]);
    const kind = String(result["kind"] ?? "");
    const command = id ? this.#commands.get(id) : undefined;
    if (command) {
      if (kind.startsWith("approved")) {
        if (command.status !== "asking") return false;
        command.status = "running";
        return true;
      }
      const status: CommandStatus = kind === "cancelled" ? "failed" : "denied";
      const outcome = kind === "cancelled" ? "Cancelled before anyone answered." : (firstLine(text(result["feedback"])) ?? "Declined.");
      if (command.status === status && command.outcome === outcome) return false;
      command.status = status;
      command.endedAt ??= event.timestamp;
      command.outcome = outcome;
      this.updatedAt = event.timestamp;
      return true;
    }
    const decision = id ? this.#decisions.get(id) : undefined;
    if (!decision || decision.kind !== "create") return false;
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
      // A request its turn left unanswered can't be answered anymore: a stale delivery of it isn't asked.
      if (decision.status === "asking") this.#settled.add(decision.id);
      decision.detail = decision.status === "asking" ? "Cancelled before anyone answered." : "Interrupted: the turn ended before this finished.";
      decision.status = "failed";
      decision.endedAt ??= at;
      changed = true;
    }
    for (const command of this.#commands.values()) {
      if (command.status !== "running" && command.status !== "asking") continue;
      if (command.status === "asking") this.#settled.add(command.id);
      command.outcome = command.status === "asking" ? "Cancelled before anyone answered." : "Interrupted: the turn ended before this finished.";
      command.status = "failed";
      command.endedAt ??= at;
      changed = true;
    }
    for (const subagent of this.#subagents.values()) {
      if (subagent.status !== "running") continue;
      subagent.status = "failed";
      subagent.detail = "Interrupted: the turn ended before it finished.";
      subagent.endedAt ??= at;
      changed = true;
    }
    return changed;
  }

  /** Whether the permission prompt for tool call `toolCallId` was answered or withdrawn, here or elsewhere. */
  isSettled(toolCallId: string | undefined): boolean {
    return toolCallId !== undefined && this.#settled.has(toolCallId);
  }

  /** Marks the `start_worker` call or hands tool call an approval gates (`asking`, then `running` or `denied`). */
  markDecision(decisionId: string | undefined, status: DecisionStatus, detail?: string): boolean {
    const command = decisionId ? this.#commands.get(decisionId) : undefined;
    if (command) {
      if (command.status === status && (detail === undefined || command.outcome === detail)) return false;
      command.status = status;
      if (detail !== undefined) command.outcome = detail;
      return true;
    }
    const decision = decisionId ? this.#decisions.get(decisionId) : undefined;
    if (!decision || (decision.status === status && (detail === undefined || decision.detail === detail))) return false;
    decision.status = status;
    if (detail !== undefined) decision.detail = detail;
    return true;
  }

  /** The user message (number) the decision or command `decisionId` serves. */
  messageIndexOf(decisionId: string | undefined): number | undefined {
    if (!decisionId) return undefined;
    return this.#messages.find((message) => message.decisionIds?.includes(decisionId) || message.commandIds?.includes(decisionId))?.index;
  }

  /** A hands tool call, for its approval (who asks, and what it would run). */
  command(id: string | undefined): Command | undefined {
    return id ? this.#commands.get(id) : undefined;
  }

  /** Sub-agents' names by ID. */
  agentNames(): Record<string, string> {
    return Object.fromEntries(this.#agentNames);
  }

  /**
   * Which user messages created a hands sandbox and ran more commands in it. `agentId` is the sub-agent the sandbox
   * belongs to (`subagents: "own"`); `own` says whether sub-agents have sandboxes of their own (else every command of
   * the conversation ran in the one sandbox).
   */
  handsAttribution(agentId: string | undefined, own: boolean): { createdBy?: number; sentWorkBy: number[] } {
    const used: number[] = [];
    for (const message of this.#messages) {
      if (message.index === undefined || !message.commandIds?.length) continue;
      const ran = message.commandIds.some((id) => {
        const command = this.#commands.get(id);
        if (!command || command.status === "denied" || command.outcome === "Cancelled before anyone answered.") return false;
        return !own || command.agentId === agentId;
      });
      if (ran) used.push(message.index);
    }
    const [createdBy, ...rest] = used;
    return { ...(createdBy !== undefined ? { createdBy } : {}), sentWorkBy: rest };
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
      const { decisionIds, commandIds, subagentIds, ...rest } = message;
      if (message.role !== "user") return { ...rest };
      const decisions = (decisionIds ?? []).map((id) => this.#decisions.get(id)).filter((decision): decision is DecisionRecord => decision !== undefined);
      const commands = (commandIds ?? []).map((id) => this.#commands.get(id)).filter((command): command is CommandRecord => command !== undefined);
      const subagents = (subagentIds ?? []).map((id) => this.#subagents.get(id)).filter((subagent): subagent is SubAgentRecord => subagent !== undefined);
      return {
        ...rest,
        decisions: decisions.map(({ workerId: _workerId, ...decision }) => {
          const workerId = resolved.get(decision.id);
          return { ...decision, ...(workerId ? { workerId } : {}) };
        }),
        ...(commands.length ? { commands: commands.map((command) => ({ ...command })) } : {}),
        ...(subagents.length ? { subagents: subagents.map((subagent) => ({ ...subagent })) } : {}),
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
