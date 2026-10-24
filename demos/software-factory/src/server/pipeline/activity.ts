import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@github/copilot-sdk";
import type { ActivityItem, TestSummary, ToolActivity, UsageSummary } from "../../shared/types.js";
import { TEST_SUMMARY_MARKER } from "../../shared/types.js";

const OUTPUT_LIMIT = 6_000;
/** Tools whose calls are reflected by other activity (intent, skill) rather than as tool rows. */
const QUIET_TOOLS = new Set(["report_intent", "update_todo", "skill"]);
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "sh", "run_in_terminal"]);

export interface ActivitySink {
  item(item: ActivityItem): void;
  delta(messageId: string, text: string): void;
  tests?(summary: TestSummary): void;
  usage?(usage: UsageSummary): void;
}

/** Parses the harness's summary line (`FACTORY_TEST_SUMMARY {"total":..}` at the start of a line); the last one wins. */
export function parseTestSummary(output: string, at = new Date().toISOString()): TestSummary | undefined {
  const pattern = new RegExp(`^${TEST_SUMMARY_MARKER} (\\{[^\\r\\n]*\\})[ \\t]*\\r?$`, "gm");
  const matches = [...output.matchAll(pattern)];
  const json = matches.at(-1)?.[1];
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as Partial<Record<"total" | "passed" | "failed" | "skipped" | "durationMs", unknown>>;
    const num = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : 0);
    return {
      total: num(value.total),
      passed: num(value.passed),
      failed: num(value.failed),
      skipped: num(value.skipped),
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
      at,
    };
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function oneLine(text: string, limit = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A readable one-liner for a tool call: the command, the file, or the pattern. */
export function summarizeToolCall(name: string, args: unknown, title?: string): string {
  const a = asRecord(args);
  const path = str(a.path) ?? str(a.filePath) ?? str(a.file_path);
  if (SHELL_TOOLS.has(name)) return oneLine(str(a.command) ?? str(a.cmd) ?? title ?? name);
  if (name === "submit_plan") return "Submitting the plan";
  if (name === "submit_review") return `Submitting the review: ${str(a.verdict) === "approve" ? "approve" : "request changes"}`;
  if (path) return oneLine(`${title ?? name} ${path.replace(/^\/workspace\//, "")}`);
  const pattern = str(a.pattern) ?? str(a.query) ?? str(a.url);
  if (pattern) return oneLine(`${name} ${pattern}`);
  return oneLine(title ?? name);
}

function tail(text: string, limit = OUTPUT_LIMIT): string {
  return text.length > limit ? `…\n${text.slice(text.length - limit)}` : text;
}

/** Friendly text for runtime errors: never a stack trace. */
export function describeSessionError(data: { errorType?: string; message?: string; statusCode?: number }): string {
  const message = (data.message ?? "").split("\n")[0]?.trim() || "The agent hit an error.";
  switch (data.errorType) {
    case "rate_limit":
      return `Model rate limit reached: ${message}`;
    case "authentication":
    case "authorization":
      return `The model rejected the request: ${message}`;
    default:
      return message;
  }
}

interface RunningTool {
  readonly item: ActivityItem;
  readonly startedAt: number;
}

/**
 * Turns one station's stock session events into activity items, streamed text, usage, and test results.
 * Sub-agent output is attributed but not streamed.
 */
export class StationActivityMapper {
  readonly #workOrderId: string;
  readonly #stationId: string;
  readonly #sink: ActivitySink;
  readonly #tools = new Map<string, RunningTool>();
  #lastIntent: string | undefined;
  #usage: UsageSummary;
  #lastMessage: string | undefined;

  constructor(workOrderId: string, stationId: string, sink: ActivitySink, usage?: UsageSummary) {
    this.#workOrderId = workOrderId;
    this.#stationId = stationId;
    this.#sink = sink;
    this.#usage = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0, durationMs: 0 };
  }

  /** The most recent root-agent message (the station's summary). */
  get lastMessage(): string | undefined {
    return this.#lastMessage;
  }

  get usage(): UsageSummary {
    return this.#usage;
  }

  #emit(partial: Omit<ActivityItem, "workOrderId" | "stationId" | "at" | "id"> & { id?: string; at?: string }): ActivityItem {
    const item: ActivityItem = {
      ...partial,
      id: partial.id ?? `${this.#stationId}:${randomUUID()}`,
      workOrderId: this.#workOrderId,
      stationId: this.#stationId,
      at: partial.at ?? new Date().toISOString(),
    };
    this.#sink.item(item);
    return item;
  }

  status(text: string, level: ActivityItem["level"] = "info"): void {
    this.#emit({ kind: "status", text, level });
  }

  error(text: string): void {
    this.#emit({ kind: "error", text, level: "error" });
  }

  handle(event: SessionEvent): void {
    const subagent = event.agentId ? { subagent: event.agentId } : {};
    switch (event.type) {
      case "assistant.message_delta": {
        if (!event.agentId && !event.data.parentToolCallId && event.data.deltaContent) this.#sink.delta(event.data.messageId, event.data.deltaContent);
        return;
      }
      case "assistant.message": {
        const content = event.data.content?.trim();
        if (!content) return;
        if (!event.agentId && !event.data.parentToolCallId) this.#lastMessage = content;
        this.#emit({ id: `msg:${event.data.messageId}`, kind: "message", text: content, ...subagent });
        return;
      }
      case "assistant.intent": {
        const intent = event.data.intent?.trim();
        if (!intent || intent === this.#lastIntent) return;
        this.#lastIntent = intent;
        this.#emit({ kind: "intent", text: intent, ...subagent });
        return;
      }
      case "tool.execution_start": {
        const { toolName, toolCallId } = event.data;
        if (QUIET_TOOLS.has(toolName)) return;
        const summary =
          event.data.shellToolInfo?.displayCommand?.trim() || summarizeToolCall(toolName, event.data.arguments, event.data.toolTitle);
        const tool: ToolActivity = { callId: toolCallId, name: toolName, summary: oneLine(summary, 240), status: "running" };
        const item = this.#emit({ id: `tool:${toolCallId}`, kind: "tool", tool, ...subagent });
        this.#tools.set(toolCallId, { item, startedAt: Date.now() });
        return;
      }
      case "tool.execution_complete": {
        const running = this.#tools.get(event.data.toolCallId);
        if (!running) return;
        this.#tools.delete(event.data.toolCallId);
        const output = event.data.result?.content ?? event.data.error?.message ?? "";
        const exitCode = event.data.shellExecution?.exitCode;
        const tool: ToolActivity = {
          ...running.item.tool!,
          status: event.data.success && (exitCode === undefined || exitCode === 0) ? "succeeded" : "failed",
          ...(output ? { output: tail(output) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          durationMs: Date.now() - running.startedAt,
        };
        this.#sink.item({ ...running.item, tool });
        // Only a shell run of the harness counts as a test run; viewing the skill's docs must not.
        const tests = output && SHELL_TOOLS.has(running.item.tool!.name) ? parseTestSummary(output) : undefined;
        if (tests) {
          this.#emit({
            id: `test:${event.data.toolCallId}`,
            kind: "test",
            tests,
            level: tests.failed > 0 || tests.total === 0 ? "error" : "success",
            text: tests.total === 0 ? "No tests found" : `${tests.passed} passed · ${tests.failed} failed${tests.skipped ? ` · ${tests.skipped} skipped` : ""}`,
          });
          this.#sink.tests?.(tests);
        }
        return;
      }
      case "skill.invoked": {
        this.#emit({ kind: "skill", text: `Using skill ${event.data.name}`, ...subagent });
        return;
      }
      case "subagent.started": {
        this.#emit({ kind: "status", text: `Started sub-agent ${event.data.agentDisplayName || event.data.agentName}` });
        return;
      }
      case "assistant.usage": {
        const data = event.data;
        this.#usage = {
          inputTokens: this.#usage.inputTokens + (data.inputTokens ?? 0),
          outputTokens: this.#usage.outputTokens + (data.outputTokens ?? 0),
          cacheReadTokens: this.#usage.cacheReadTokens + (data.cacheReadTokens ?? 0),
          requests: this.#usage.requests + 1,
          durationMs: this.#usage.durationMs + (data.duration ?? 0),
        };
        this.#sink.usage?.(this.#usage);
        return;
      }
      case "session.error": {
        this.error(describeSessionError(event.data));
        return;
      }
      case "session.warning": {
        this.#emit({ kind: "status", text: event.data.message, level: "warning" });
        return;
      }
      case "abort": {
        this.#emit({ kind: "status", text: "Turn stopped", level: "warning" });
        this.#failRunningTools();
        return;
      }
      default:
        return;
    }
  }

  /** Marks tool calls that never completed (abort, disconnect) as failed so the UI doesn't spin forever. */
  #failRunningTools(): void {
    for (const [callId, running] of this.#tools) {
      this.#sink.item({ ...running.item, tool: { ...running.item.tool!, status: "failed", durationMs: Date.now() - running.startedAt } });
      this.#tools.delete(callId);
    }
  }

  close(): void {
    this.#failRunningTools();
  }
}
