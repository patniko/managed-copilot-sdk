// What Copilot is asked to do in a run's two agent steps, the one tool Repo Doctor gives it, and how its standard session
// events become step logs. The tool's handler runs here in the app; everything else Copilot does runs in its sandbox.
import { defineTool, type SessionEvent, type Tool } from "@github/copilot-sdk";
import type { LogLine, TestReport } from "../shared/types.js";

export const REPO_DIR = "/workspace/repo";

export const SYSTEM_MESSAGE = [
  `You are Repo Doctor, a CI fixer working in your own Linux sandbox. The repository is checked out at ${REPO_DIR}.`,
  "- The network allows GitHub and the package registries only. Other hosts are blocked; don't try to work around that.",
  "- Don't push, open pull requests, or rewrite git history: Repo Doctor turns your changes into a patch.",
  "- Keep replies to a sentence or two.",
].join("\n");

export const SETUP_PROMPT = [
  `Get ${REPO_DIR} ready to run its tests, then stop.`,
  "1. Find how the project runs its tests (its README, package.json scripts, pyproject.toml, Makefile, or CI workflows).",
  "2. Install the dependencies the tests need.",
  "3. Run the tests once to check the command works. Failing tests are expected: don't fix anything yet.",
  `4. Call report_test_command with the exact command that runs the whole test suite from ${REPO_DIR}.`,
  "If the repository has no automated tests, call report_no_tests instead, and stop.",
].join("\n");

export function fixPrompt(report: TestReport): string {
  const counted = report.failed !== undefined ? `${report.failed} of ${report.total ?? report.failed + (report.passed ?? 0)} tests failed` : `it exited with code ${report.exitCode ?? "unknown"}`;
  const failures = report.failures.length ? ["Failing tests:", ...report.failures.slice(0, 10).map((name) => `- ${name}`), ""] : [];
  return [
    `Repo Doctor ran \`${report.command}\` in ${REPO_DIR}: ${counted}.`,
    "",
    ...failures,
    "The end of its output:",
    "```",
    report.tail.slice(-3_000),
    "```",
    "",
    "Fix the code so these tests pass:",
    "- Change the source, not the tests, unless a test is clearly wrong.",
    "- Keep the change as small as you can, and don't add dependencies.",
    "- Run the test command to confirm.",
    "Then reply in one or two sentences: the root cause, and what you changed.",
  ].join("\n");
}

const COMMAND_LIMIT = 500;
/** Commands that print or exit instead of running tests. */
const PLACEHOLDER = /^(?:echo|printf|true|false|:|exit)(?:\s|$)/;

function failure(text: string) {
  return { resultType: "failure" as const, textResultForLlm: text };
}

/** The tool Copilot reports the test command with. Its handler runs in this app; `onCommand` answers it. */
export function testCommandTool(onCommand: (command: string) => string): Tool {
  return defineTool("report_test_command", {
    description: `Record the shell command that runs this repository's whole test suite from ${REPO_DIR}. Call it once, after installing the dependencies and checking the command runs.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: `The exact command, run from ${REPO_DIR}, for example "npm test" or "python -m pytest".` },
      },
      required: ["command"],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args: unknown) => {
      const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command.trim() : "";
      if (!command || command.length > COMMAND_LIMIT || /[\r\n]/.test(command)) return failure(`Pass the test command as one line of at most ${COMMAND_LIMIT} characters.`);
      if (PLACEHOLDER.test(command)) return failure("That command doesn't run tests. If the repository has no automated tests, call report_no_tests.");
      return onCommand(command);
    },
  });
}

/** The tool Copilot reports a repository without tests with. */
export function noTestsTool(onNoTests: (reason: string) => string): Tool {
  return defineTool("report_no_tests", {
    description: `Report that ${REPO_DIR} has no automated tests to run, with the reason in one sentence. Repo Doctor then ends the run.`,
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "One sentence, for example: \"The repository has only a README.\"" } },
      required: ["reason"],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args: unknown) => {
      const reason = typeof (args as { reason?: unknown })?.reason === "string" ? (args as { reason: string }).reason.trim() : "";
      if (!reason) return failure("Pass the reason in one sentence.");
      return onNoTests(reason.slice(0, 300));
    },
  });
}

/** Where a run sends what Copilot does. */
export interface AgentSink {
  log(line: Omit<LogLine, "at" | "seq">): void;
  /** What Copilot is doing now, in a few words. */
  activity(text: string): void;
  /** A shell command that exited 0, and its output: the network view infers the hosts it reached. */
  succeeded(command: string, output: string): void;
}

const SHELL_TOOLS = new Set(["bash", "shell", "sh", "powershell"]);
const SHELL_IO_TOOLS = new Set(["read_bash", "write_bash", "stop_bash"]);
const EDIT_TOOLS = new Set(["edit", "create", "str_replace_editor", "str_replace", "apply_patch", "write", "write_file", "insert"]);
const READ_TOOLS = new Set(["view", "read", "read_file", "glob", "grep", "rg", "search", "list_dir", "ls"]);
const QUIET_TOOLS = new Set(["report_intent", "report_test_command", "report_no_tests", "think", "update_todo"]);
const OUTPUT_LIMIT = 4_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A workspace path as people read it: relative to the repository. */
export function displayPath(path: string): string {
  return path.replace(/^\/workspace\/repo\/?/, "").replace(/^\/workspace\//, "") || ".";
}

function oneLine(value: string, limit = 200): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Turns a session's standard events into log lines, activity, and successful commands. */
export class AgentObserver {
  readonly #sink: AgentSink;
  readonly #calls = new Map<string, { readonly tool: string; readonly command?: string }>();
  /** Copilot's latest reply. */
  lastMessage: string | undefined;

  constructor(sink: AgentSink) {
    this.#sink = sink;
  }

  handle(event: SessionEvent): void {
    switch (event.type) {
      case "tool.execution_start":
        return this.#start(event.data.toolCallId, event.data.toolName, event.data.arguments);
      case "tool.execution_complete":
        return this.#complete(event.data);
      case "assistant.message": {
        const content = event.data.content?.trim();
        if (!content) return;
        this.lastMessage = content;
        this.#sink.log({ kind: "message", text: content });
        return;
      }
      case "session.error":
        this.#sink.log({ kind: "error", text: event.data.message?.split("\n")[0]?.trim() || "Copilot hit an error." });
        return;
      default:
        return;
    }
  }

  #start(callId: string, tool: string, rawArgs: unknown): void {
    const args = record(rawArgs);
    if (tool === "report_intent") {
      const intent = text(args.intent);
      if (intent) {
        this.#sink.activity(intent);
        this.#sink.log({ kind: "note", text: intent });
      }
      return;
    }
    if (SHELL_TOOLS.has(tool)) {
      const command = text(args.command) ?? text(args.cmd);
      if (!command) return;
      this.#calls.set(callId, { tool, command });
      this.#sink.activity(oneLine(command, 120));
      this.#sink.log({ kind: "command", text: command });
      return;
    }
    this.#calls.set(callId, { tool });
    if (QUIET_TOOLS.has(tool) || SHELL_IO_TOOLS.has(tool)) return;
    const path = text(args.path) ?? text(args.file_path) ?? text(args.filePath);
    if (EDIT_TOOLS.has(tool)) {
      const file = path ? displayPath(path) : "a file";
      this.#sink.activity(`${tool === "create" ? "Creating" : "Editing"} ${file}`);
      this.#sink.log({ kind: "edit", text: `${tool === "create" ? "Created" : "Edited"} ${file}` });
    } else if (READ_TOOLS.has(tool)) {
      const pattern = text(args.pattern) ?? text(args.query);
      if (path || pattern) this.#sink.activity(path ? `Reading ${displayPath(path)}` : `Searching for ${oneLine(pattern!, 80)}`);
      this.#sink.log({ kind: "read", text: path ? `Read ${displayPath(path)}` : pattern ? `Searched for ${oneLine(pattern, 80)}` : tool });
    } else if (tool === "task") {
      this.#sink.log({ kind: "note", text: `Started a sub-agent${text(args.description) ? `: ${oneLine(text(args.description)!, 120)}` : ""}` });
    } else {
      this.#sink.log({ kind: "note", text: tool });
    }
  }

  #complete(data: Extract<SessionEvent, { type: "tool.execution_complete" }>["data"]): void {
    const call = this.#calls.get(data.toolCallId);
    this.#calls.delete(data.toolCallId);
    if (!call || !(SHELL_TOOLS.has(call.tool) || SHELL_IO_TOOLS.has(call.tool))) return;
    // The runtime ends shell output with its own exit marker; the exit code is shown on its own line instead.
    const output = (data.result?.detailedContent ?? data.result?.content ?? data.error?.message ?? "").replace(/\n?<(?:shellId: \S+ )?(?:completed|exited) with exit code -?\d+>\s*$/, "").replace(/\s+$/, "");
    if (output) this.#sink.log({ kind: "output", text: output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output });
    const exitCode = data.shellExecution?.exitCode;
    if (exitCode !== undefined && exitCode !== 0) this.#sink.log({ kind: "note", text: `Exit code ${exitCode}`, exitCode });
    if (call.command && exitCode === 0) this.#sink.succeeded(call.command, output);
  }
}
