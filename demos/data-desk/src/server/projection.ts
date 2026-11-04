// The conversation as Data Desk shows it, projected from the session's own events: the person's messages, Copilot's
// replies, each tool call as a one-line step, the tables Data Desk's tools returned (shown in the grid), and the moment
// the session moved into its sandbox. Pure and replayable: the same events give the same transcript, live or from the
// session's history after a restart.
import type { ChatItem, ResultView, StepType } from "../shared/types.js";

/** A session event as the stock SDK delivers it: the fields Data Desk reads. */
export interface DeskEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly ephemeral?: boolean;
  /** Set on a sub-agent's events. */
  readonly agentId?: string;
  readonly data?: unknown;
}

/** Data Desk's own tools; their results are the grid's tables. */
export const DATA_TOOLS: ReadonlySet<string> = new Set(["describe_dataset", "query_rows", "aggregate"]);

/** The platform tool a promotable session calls to move into its sandbox. */
export const MOVE_TOOL = "request_sandbox";

/** Bookkeeping tools a person doesn't need to see. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["report_intent", "update_todo", "task_complete", "think"]);

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The first meaningful line of some text, shortened. */
export function firstLine(value: string | undefined, max = 140): string | undefined {
  const line = value
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** An error as a person reads it: no `code:` prefix, one line. */
export function plainError(message: string | undefined): string | undefined {
  return firstLine(message?.replace(/^[a-z_]+:\s+/, ""), 200);
}

const basename = (path: string): string => path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;

/** The exit code a shell tool's answer ends with (`<shellId: 0 completed with exit code 0>` and similar). */
export function exitCode(content: string | undefined): number | undefined {
  const match = /exit(?:ed with)? code (-?\d+)\s*>?\s*$/.exec(content?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

/** A shell command as a person reads it: the Python script it runs, or its first line. */
export function summarizeCommand(command: string): string | undefined {
  const script = /\bpython3?\s+(?:-u\s+)?([\w./-]+\.py)\b/.exec(command)?.[1];
  if (script) return `Ran ${basename(script)}`;
  if (/\bpython3?\b/.test(command)) return "Ran Python";
  return firstLine(command);
}

/** A data tool's arguments as one readable line: "sum(revenue) by store · where month ≥ 2025-01 · sorted by sum(revenue) ↓". */
export function describeQuery(args: Record<string, unknown>): string | undefined {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
  const ops: Record<string, string> = { ">=": "≥", "<=": "≤", "!=": "≠" };
  const parts: string[] = [];
  const metrics = list(args["metrics"]).map((metric) => (metric["fn"] === "count" ? "count" : `${String(metric["fn"])}(${String(metric["column"] ?? "")})`));
  const groups = Array.isArray(args["groupBy"]) ? args["groupBy"].map(String) : [];
  if (metrics.length) parts.push(`${metrics.join(", ")}${groups.length ? ` by ${groups.join(", ")}` : ""}`);
  else if (Array.isArray(args["columns"]) && args["columns"].length) parts.push(args["columns"].map(String).join(", "));
  const filters = list(args["filters"]).map((filter) => `${String(filter["column"])} ${ops[String(filter["op"])] ?? String(filter["op"])} ${String(filter["value"])}`);
  if (filters.length) parts.push(`where ${filters.join(", ")}`);
  if (text(args["sortBy"])) parts.push(`sorted by ${String(args["sortBy"])} ${args["descending"] ? "↓" : "↑"}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** How a tool call reads as a step: its type, a one-line label, and the full text behind it. */
export function describeStep(tool: string, args: Record<string, unknown>): { type: StepType; label: string; detail?: string } {
  switch (tool) {
    case "describe_dataset":
      return { type: "data", label: "Read the dataset's columns" };
    case "query_rows":
    case "aggregate": {
      const title = text(args["title"]);
      const detail = describeQuery(args);
      return { type: "data", label: title ?? (tool === "aggregate" ? "Grouped the rows" : "Filtered the rows"), ...(detail ? { detail } : {}) };
    }
    case MOVE_TOOL:
      return { type: "move", label: "Asked for a sandbox", ...(text(args["reason"]) ? { detail: text(args["reason"]) } : {}) };
    case "bash": {
      const command = text(args["command"]);
      return { type: "shell", label: firstLine(text(args["description"])) ?? (command ? summarizeCommand(command) : undefined) ?? "Ran a command", ...(command ? { detail: command } : {}) };
    }
    case "create":
    case "edit": {
      const path = text(args["path"]);
      return { type: "file", label: `${tool === "create" ? "Wrote" : "Edited"} ${path ? basename(path) : "a file"}`, ...(path ? { detail: path } : {}) };
    }
    case "view": {
      const path = text(args["path"]);
      return { type: "read", label: `Read ${path ? basename(path) : "a file"}`, ...(path ? { detail: path } : {}) };
    }
    default:
      return { type: "other", label: tool.replace(/_/g, " ") };
  }
}

/** A data tool's answer as a grid table, when it is one (`query_rows` and `aggregate` answer with rows). */
export function resultView(id: string, at: string, content: string | undefined, unit: ResultView["unit"] = "row"): ResultView | undefined {
  if (!content) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const value = record(parsed);
  const columns = value["columns"];
  const rows = value["rows"];
  if (!Array.isArray(columns) || !Array.isArray(rows) || !columns.every((column) => typeof column === "string")) return undefined;
  return {
    id,
    title: text(value["title"]) ?? "Result",
    columns: columns as string[],
    rows: rows.filter(Array.isArray).map((row) => (row as unknown[]).map((cell) => (cell === null || cell === undefined ? "" : String(cell)))),
    total: typeof value["matched"] === "number" ? value["matched"] : rows.length,
    unit,
    at,
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type StepRecord = Mutable<Extract<ChatItem, { kind: "step" }>>;
type AssistantRecord = Mutable<Extract<ChatItem, { kind: "assistant" }>>;

export class Transcript {
  readonly #items: ChatItem[] = [];
  readonly #steps = new Map<string, StepRecord>();
  /** Assistant messages still streaming, by the runtime's message ID. */
  readonly #streaming = new Map<string, AssistantRecord>();
  /** Assistant messages complete: a late delta (live delivery overlapping history) must not reopen them. */
  readonly #completed = new Set<string>();
  /** Persisted events already applied (history and live delivery overlap after a resume). */
  readonly #seen = new Set<string>();
  /** Permission request IDs to the tool call they gate. */
  readonly #requests = new Map<string, string>();
  /** Tool calls whose permission prompt was answered or withdrawn (`permission.completed`). */
  readonly #answered = new Set<string>();
  readonly #results = new Map<string, ResultView>();
  /** `request_sandbox` calls the person approved: the move runs until the call completes. */
  readonly #approvedMoves = new Set<string>();
  #lastMoveId: string | undefined;
  busy = false;
  updatedAt: string | undefined;

  /** `isOwn` tells whether a user message was sent from Data Desk; others came from another client (Copilot CLI). */
  constructor(private readonly isOwn: (content: string) => boolean) {}

  get items(): readonly ChatItem[] {
    return this.#items;
  }

  /** The grid tables Data Desk's tools returned, oldest first. */
  get results(): readonly ResultView[] {
    return [...this.#results.values()];
  }

  /** Whether the session already moved into its sandbox, as its own history says. */
  get moved(): boolean {
    return this.#items.some((item) => item.kind === "moved");
  }

  /** Whether an approved move is under way: its `request_sandbox` call hasn't completed yet. */
  get moving(): boolean {
    const step = this.#lastMoveId ? this.#steps.get(this.#lastMoveId) : undefined;
    return step !== undefined && step.status === "running" && this.#approvedMoves.has(step.id);
  }

  /** The latest `request_sandbox` call. */
  get lastMoveId(): string | undefined {
    return this.#lastMoveId;
  }

  /** Whether a tool call's permission prompt was answered or withdrawn (here or in another client), or the call ended. */
  isSettled(toolCallId: string | undefined): boolean {
    if (!toolCallId) return false;
    if (this.#answered.has(toolCallId)) return true;
    const step = this.#steps.get(toolCallId);
    return step !== undefined && step.status !== "asking" && step.status !== "running";
  }

  /** Applies one event; returns whether anything a person would see changed. */
  apply(event: DeskEvent): boolean {
    if (event.agentId) return false;
    if (!event.ephemeral) {
      if (this.#seen.has(event.id)) return false;
      this.#seen.add(event.id);
    }
    const data = record(event.data);
    if (text(data["parentToolCallId"])) return false;
    const at = event.timestamp;
    switch (event.type) {
      case "user.message": {
        const content = typeof data["content"] === "string" ? data["content"] : "";
        if (data["isAutopilotContinuation"] === true || !content.trim()) return false;
        this.#items.push({ kind: "user", id: event.id, text: content, at, via: this.isOwn(content) ? "app" : "cli" });
        this.busy = true;
        this.updatedAt = at;
        return true;
      }
      case "assistant.message_delta": {
        const messageId = text(data["messageId"]);
        const delta = typeof data["deltaContent"] === "string" ? data["deltaContent"] : "";
        if (!messageId || !delta || this.#completed.has(messageId)) return false;
        let item = this.#streaming.get(messageId);
        if (!item) {
          item = { kind: "assistant", id: messageId, text: "", at, streaming: true };
          this.#streaming.set(messageId, item);
          this.#items.push(item);
        }
        item.text += delta;
        return true;
      }
      case "assistant.message": {
        const messageId = text(data["messageId"]) ?? event.id;
        const content = typeof data["content"] === "string" ? data["content"].trim() : "";
        this.#completed.add(messageId);
        const streaming = this.#streaming.get(messageId);
        this.#streaming.delete(messageId);
        if (!content) {
          if (streaming) this.#items.splice(this.#items.indexOf(streaming), 1);
          return streaming !== undefined;
        }
        if (streaming) {
          streaming.text = content;
          delete streaming.streaming;
        } else this.#items.push({ kind: "assistant", id: messageId, text: content, at });
        this.updatedAt = at;
        return true;
      }
      case "tool.execution_start": {
        const toolCallId = text(data["toolCallId"]);
        const tool = text(data["toolName"]);
        if (!toolCallId || !tool || HIDDEN_TOOLS.has(tool) || this.#steps.has(toolCallId)) return false;
        const step: StepRecord = { kind: "step", id: toolCallId, tool, ...describeStep(tool, record(data["arguments"])), status: "running", at };
        this.#steps.set(toolCallId, step);
        this.#items.push(step);
        if (tool === MOVE_TOOL) this.#lastMoveId = toolCallId;
        return true;
      }
      case "tool.execution_complete":
        return this.#complete(data, at);
      case "permission.requested": {
        const requestId = text(data["requestId"]);
        const request = record(data["permissionRequest"]);
        const toolCallId = text(request["toolCallId"]);
        if (requestId && toolCallId) this.#requests.set(requestId, toolCallId);
        const step = toolCallId ? this.#steps.get(toolCallId) : undefined;
        if (!step || step.tool !== MOVE_TOOL || step.status !== "running") return false;
        step.status = "asking";
        return true;
      }
      case "permission.completed": {
        const requestId = text(data["requestId"]);
        const toolCallId = text(data["toolCallId"]) ?? (requestId ? this.#requests.get(requestId) : undefined);
        if (toolCallId) this.#answered.add(toolCallId);
        const step = toolCallId ? this.#steps.get(toolCallId) : undefined;
        if (!step || step.status !== "asking") return false;
        const kind = text(record(data["result"])["kind"]) ?? "";
        step.status = kind.startsWith("approved") ? "running" : kind.startsWith("denied") ? "declined" : "failed";
        if (step.status === "running") this.#approvedMoves.add(step.id);
        if (step.status === "declined") step.outcome = "Not now";
        return true;
      }
      case "session.error": {
        const message = plainError(text(data["message"]));
        this.#items.push({ kind: "error", id: event.id, text: message ?? "Something went wrong in this turn.", at });
        this.#settle();
        return true;
      }
      case "abort":
      case "session.idle":
        return this.#settle();
      default:
        return false;
    }
  }

  #complete(data: Record<string, unknown>, at: string): boolean {
    const toolCallId = text(data["toolCallId"]);
    const step = toolCallId ? this.#steps.get(toolCallId) : undefined;
    if (!step) return false;
    const result = record(data["result"]);
    const content = typeof result["content"] === "string" ? result["content"] : undefined;
    const success = data["success"] === true;
    if (!success) {
      step.status = step.status === "declined" ? "declined" : "failed";
      if (step.status === "failed") step.outcome = plainError(text(record(data["error"])["message"]) ?? content) ?? "Failed";
      return true;
    }
    switch (step.type) {
      case "move":
        step.status = "done";
        this.#items.push({ kind: "moved", id: `moved-${step.id}`, at });
        return true;
      case "shell": {
        const code = exitCode(content);
        step.status = code === undefined || code === 0 ? "done" : "failed";
        if (code !== undefined && code !== 0) step.outcome = `Exit code ${code}`;
        return true;
      }
      case "data": {
        const error = (() => {
          try {
            return text(record(JSON.parse(content ?? "")).error);
          } catch {
            return undefined;
          }
        })();
        if (error) {
          step.status = "failed";
          step.outcome = firstLine(error, 200);
          return true;
        }
        step.status = "done";
        const unit = step.tool === "aggregate" ? "group" : "row";
        const view = resultView(step.id, at, content, unit) ?? resultView(step.id, at, typeof result["detailedContent"] === "string" ? result["detailedContent"] : undefined, unit);
        if (view) {
          this.#results.set(step.id, view);
          step.resultId = step.id;
          step.outcome = `${view.total.toLocaleString("en-US")} ${view.unit}${view.total === 1 ? "" : "s"}`;
        }
        return true;
      }
      default:
        step.status = "done";
        return true;
    }
  }

  /** The turn ended: nothing streams anymore, and calls still running were cut short. */
  #settle(): boolean {
    const changed = this.busy || this.#streaming.size > 0 || [...this.#steps.values()].some((step) => step.status === "running" || step.status === "asking");
    this.busy = false;
    for (const item of this.#streaming.values()) delete item.streaming;
    this.#streaming.clear();
    for (const step of this.#steps.values()) {
      if (step.status !== "running" && step.status !== "asking") continue;
      step.status = "failed";
      step.outcome = "Stopped";
    }
    return changed;
  }

  /** A turn the platform reports finished has ended (history never holds `session.idle`). */
  settle(): void {
    this.#settle();
  }
}

/**
 * The session's history (`getEvents()`, persisted events only) with the events delivered live while it loaded, in the
 * order they happened. Live events already in the history are dropped; the rest (ephemeral ones such as
 * `session.idle`, and anything persisted after the history was read) are placed by timestamp, so an earlier
 * `session.idle` can't end a newer turn that the history already shows.
 */
export function mergeHistory<T extends { readonly id: string; readonly timestamp: string; readonly type: string }>(history: readonly T[], live: readonly T[]): T[] {
  const known = new Set(history.map((event) => event.id));
  const merged: T[] = [];
  let next = 0;
  for (const event of live) {
    if (known.has(event.id)) continue;
    const at = Date.parse(event.timestamp);
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
