import { join } from "node:path";
import type { AssistantMessageEvent, MessageOptions, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type { SandboxInfo } from "@managed-copilot/protocol";
import { ManagedCopilotError } from "@managed-copilot/sdk";
import type { DoctorConfig } from "../src/server/config.js";
import { loadConfig } from "../src/server/config.js";
import type { BlockedRequest, CommandOptions, CommandResult, DoctorPlatform, DoctorSession } from "../src/server/platform.js";
import type { PlatformStatus } from "../src/shared/types.js";

export function testConfig(dataDir: string, overrides: Partial<DoctorConfig> = {}): DoctorConfig {
  const base = loadConfig({ REPO_DOCTOR_DATA_DIR: dataDir });
  return { ...base, dev: false, webRoot: join(dataDir, "no-web"), timeouts: { ...base.timeouts, graceMs: 0, deleteRetriesMs: [] }, ...overrides };
}

let eventId = 0;
function event<T extends SessionEvent["type"]>(type: T, data: Extract<SessionEvent, { type: T }>["data"]): SessionEvent {
  return { id: `e${++eventId}`, parentId: null, timestamp: new Date().toISOString(), type, data } as SessionEvent;
}

/** What the fake agent does for a prompt: the events it emits, the tool calls it makes, and its reply. */
export type Script = (session: FakeSession, prompt: string) => Promise<string | undefined>;

export class FakeSession implements DoctorSession {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  readonly #handlers = new Set<(event: SessionEvent) => void>();
  readonly #tools: Tool[];
  readonly #script: Script;
  aborted = false;
  disconnected = false;
  /** Resolves a turn that's waiting for abort(). */
  #release: (() => void) | undefined;

  constructor(sessionId: string, config: SessionConfig, script: Script) {
    this.sessionId = sessionId;
    this.#tools = (config.tools ?? []) as Tool[];
    this.#script = script;
  }

  on(handler: (event: SessionEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(type: SessionEvent["type"], data: unknown): void {
    const value = event(type as never, data as never);
    for (const handler of this.#handlers) handler(value);
  }

  /** Runs a shell command the way the runtime reports it: start, then completion with output and exit code. */
  shell(command: string, output: string, exitCode = 0): void {
    const toolCallId = `call-${++eventId}`;
    this.emit("tool.execution_start", { toolCallId, toolName: "bash", arguments: { command } });
    this.emit("tool.execution_complete", { toolCallId, success: exitCode === 0, result: { content: output }, shellExecution: { exitCode } });
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    if (!tool?.handler) throw new Error(`No tool ${name}`);
    return tool.handler(args as never, { sessionId: this.sessionId, toolCallId: `call-${++eventId}`, toolName: name, arguments: args } as never);
  }

  /** Blocks the current turn until abort(). */
  hang(): Promise<void> {
    return new Promise((resolve) => (this.#release = resolve));
  }

  async sendAndWait(options: MessageOptions): Promise<AssistantMessageEvent | undefined> {
    this.prompts.push(options.prompt);
    const reply = await this.#script(this, options.prompt);
    if (this.aborted) throw new Error("The requested run was aborted before completion.");
    if (reply === undefined) return undefined;
    this.emit("assistant.message", { messageId: `m${++eventId}`, content: reply });
    return event("assistant.message", { messageId: `m${eventId}`, content: reply } as never) as AssistantMessageEvent;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#release?.();
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

/** Answers a command in the sandbox: its output and exit code, or undefined for "not handled here". */
export type Commands = (script: string, platform: FakePlatform) => CommandResult | undefined;

export const TREE_BEFORE = "a".repeat(40);
export const TREE_AFTER = "b".repeat(40);

export const SAMPLE_DIFF = [
  "diff --git a/src/next-version.js b/src/next-version.js",
  "index 1111111..2222222 100644",
  "--- a/src/next-version.js",
  "+++ b/src/next-version.js",
  "@@ -13,7 +13,7 @@ export function releaseType(message) {",
  "   const [, type, breaking] = match;",
  '   if (breaking || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";',
  '-  if (type === "feature") return "minor";',
  '+  if (type === "feat") return "minor";',
  '   if (type === "fix" || type === "perf") return "patch";',
  "   return undefined;",
  " }",
  "",
].join("\n");

export const FAILING_OUTPUT = [
  "✔ a fix bumps the patch version (0.5ms)",
  "✖ a feature bumps the minor version (1.2ms)",
  "✔ a breaking change bumps the major version (0.2ms)",
  "✔ docs, chores, and tests don't release (0.1ms)",
  "✖ the biggest change wins (0.1ms)",
  "✔ scopes don't change the release (0.1ms)",
  "ℹ tests 6",
  "ℹ suites 0",
  "ℹ pass 4",
  "ℹ fail 2",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 85.7",
].join("\n");

export const PASSING_OUTPUT = ["ℹ tests 6", "ℹ pass 6", "ℹ fail 0", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0"].join("\n");

/** The usual sandbox: a sample checkout, tests that fail until the fix, and a one-line patch. */
export function standardCommands(state: { fixed: boolean }): Commands {
  return (script) => {
    if (script.includes("npm config get registry")) return { exitCode: 0, state: "completed", output: "npm=https://registry.example.com/npm/\npip=\n" };
    if (script.includes("git init")) return { exitCode: 0, state: "completed", output: "HEAD abc1234 bumpkit 1.4.2\n" };
    if (script.includes("git clone")) return { exitCode: 0, state: "completed", output: "Cloning into 'repo'...\nHEAD def5678 Initial commit\n" };
    if (script.includes("repo-doctor-before.index")) return { exitCode: 0, state: "completed", output: `${TREE_BEFORE}\n` };
    if (script.includes("repo-doctor-after.index")) return { exitCode: 0, state: "completed", output: `${TREE_AFTER}\n` };
    if (script.includes("--stat")) return { exitCode: 0, state: "completed", output: " src/next-version.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n" };
    if (script.includes("git diff")) return { exitCode: 0, state: "completed", output: SAMPLE_DIFF };
    if (script.endsWith("&& npm test")) return state.fixed ? { exitCode: 0, state: "completed", output: PASSING_OUTPUT } : { exitCode: 1, state: "completed", output: FAILING_OUTPUT };
    return undefined;
  };
}

/** Copilot as the tests need it: installs and reports `npm test`, then fixes the bug. */
export function standardScript(state: { fixed: boolean }): Script {
  return async (session, prompt) => {
    if (prompt.startsWith("Get /workspace/repo ready")) {
      session.emit("tool.execution_start", { toolCallId: "intent-1", toolName: "report_intent", arguments: { intent: "Installing dependencies" } });
      session.shell("npm install", "added 1 package in 1s");
      session.shell("npm test", FAILING_OUTPUT, 1);
      await session.callTool("report_test_command", { command: "npm test" });
      return "The tests run with npm test; two fail.";
    }
    session.emit("tool.execution_start", { toolCallId: "edit-1", toolName: "edit", arguments: { path: "/workspace/repo/src/next-version.js" } });
    session.emit("tool.execution_complete", { toolCallId: "edit-1", success: true });
    state.fixed = true;
    session.shell("npm test", PASSING_OUTPUT, 0);
    return "releaseType looked for `feature` instead of `feat`, so features never bumped the minor version. I changed the check to `feat`.";
  };
}

export class FakePlatform implements DoctorPlatform {
  status: PlatformStatus = { state: "connected", url: "http://localhost:9100", mode: "local", deployment: "copilot", account: { login: "octocat" } };
  readonly sessions = new Map<string, FakeSession>();
  /** Sessions the platform has, whether or not createSession answered. */
  readonly created = new Set<string>();
  readonly deleted: string[] = [];
  readonly files = new Map<string, string>();
  readonly scripts: string[] = [];
  readonly #status = new Set<(status: PlatformStatus) => void>();
  readonly #blocked = new Set<(request: BlockedRequest) => void>();
  #count = 0;
  script: Script;
  commands: Commands;
  /** Fails deleteSession with this error. */
  deleteError: Error | undefined;
  /** Fails createSession with this error; `platformHasIt` says whether the platform created the session anyway. */
  createError: { readonly error: Error; readonly platformHasIt: boolean } | undefined;
  /** Runs as each session is created, before createSession returns (the sandbox starting up). */
  onCreate: ((session: FakeSession) => void) | undefined;

  constructor(options: { script?: Script; commands?: Commands } = {}) {
    const state = { fixed: false };
    this.script = options.script ?? standardScript(state);
    this.commands = options.commands ?? standardCommands(state);
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }

  setStatus(status: PlatformStatus): void {
    this.status = status;
    for (const listener of this.#status) listener(status);
  }

  onBlocked(listener: (request: BlockedRequest) => void): () => void {
    this.#blocked.add(listener);
    return () => this.#blocked.delete(listener);
  }

  block(request: BlockedRequest): void {
    for (const listener of this.#blocked) listener(request);
  }

  async createSession(config: SessionConfig): Promise<DoctorSession> {
    const sessionId = config.sessionId ?? `session-${++this.#count}`;
    if (this.createError) {
      if (this.createError.platformHasIt) this.created.add(sessionId);
      throw this.createError.error;
    }
    this.created.add(sessionId);
    const session = new FakeSession(sessionId, config, this.script);
    this.sessions.set(session.sessionId, session);
    this.onCreate?.(session);
    return session;
  }

  async sandbox(): Promise<SandboxInfo | undefined> {
    return {
      id: "sbx_0123456789abcdef01234567",
      size: "medium",
      state: "running",
      network: { access: "restricted", allowedDomains: ["github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.example.com", "pypi.org", "files.pythonhosted.org"] },
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    if (!this.created.has(sessionId) || this.deleted.includes(sessionId)) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
    this.deleted.push(sessionId);
  }

  async run(_sessionId: string, command: string, options: CommandOptions): Promise<CommandResult> {
    this.scripts.push(command);
    const result = this.commands(command, this);
    if (!result) throw new Error(`Unexpected command: ${command}`);
    if (result.output) options.onOutput?.(result.output);
    return result;
  }

  async writeFile(_sessionId: string, path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

/** Waits until `check` passes (or fails after `ms`). */
export async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
