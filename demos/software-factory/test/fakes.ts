import type { ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import { ManagedCopilotError, type ArtifactInfo, type EnvironmentInfo, type PublicationResult, type SessionInfo } from "@managed-copilot/sdk";
import type { FactoryPlatform, StationArtifacts, StationFiles, StationSession } from "../src/server/platform.js";
import type { OutputManifest, StationRole, TestReport } from "../src/shared/types.js";

let counter = 0;
const id = (prefix: string) => `${prefix}_${++counter}`;

/** Minimal stand-in for a stock CopilotSession: emits SDK-shaped events and runs a scripted agent per prompt. */
export class FakeSession implements StationSession {
  readonly sessionId: string;
  readonly role: StationRole;
  readonly config: SessionConfig | ResumeSessionConfig;
  readonly prompts: string[] = [];
  readonly #handlers = new Set<(event: SessionEvent) => void>();
  readonly #platform: FakePlatform;
  readonly #abort = new AbortController();
  aborted = false;
  /** What an in-flight turn rejects with when the session is aborted (the runtime's answer to the abort). */
  abortError: Error | undefined;

  constructor(platform: FakePlatform, role: StationRole, config: SessionConfig | ResumeSessionConfig, sessionId = id("sess")) {
    this.#platform = platform;
    this.role = role;
    this.config = config;
    this.sessionId = sessionId;
  }

  on(handler: (event: SessionEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    const event = { id: id("evt"), parentId: null, timestamp: new Date().toISOString(), type, data, ...extra } as unknown as SessionEvent;
    this.config.onEvent?.(event);
    for (const handler of this.#handlers) handler(event);
  }

  say(content: string): void {
    const messageId = id("msg");
    this.emit("assistant.message_delta", { messageId, deltaContent: content.slice(0, 5) });
    this.emit("assistant.message", { messageId, content });
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = (this.config.tools as Tool<unknown>[] | undefined)?.find((candidate) => candidate.name === name);
    if (!tool?.handler) throw new Error(`Tool ${name} is not registered`);
    const toolCallId = id("call");
    this.emit("tool.execution_start", { toolCallId, toolName: name, arguments: args });
    const result = await tool.handler(args, { sessionId: this.sessionId, toolCallId, toolName: name, arguments: args });
    this.emit("tool.execution_complete", { toolCallId, success: true, result: { content: String(result) } });
    return result;
  }

  shell(command: string, output: string, exitCode = 0): void {
    const toolCallId = id("call");
    this.emit("tool.execution_start", { toolCallId, toolName: "bash", arguments: { command } });
    this.emit("tool.execution_complete", { toolCallId, success: exitCode === 0, result: { content: output }, shellExecution: { exitCode } });
  }

  async sendAndWait(options: { prompt: string }): Promise<undefined> {
    if (this.aborted) throw new Error("Session aborted");
    this.prompts.push(options.prompt);
    this.emit("assistant.turn_start", { turnId: id("turn") });
    this.emit("assistant.usage", { model: "fake", inputTokens: 100, outputTokens: 20, duration: 50 });
    const aborted = new Promise<never>((_, reject) => {
      this.#abort.signal.addEventListener("abort", () => reject(this.abortError ?? new Error("Session aborted")), { once: true });
    });
    await Promise.race([this.#platform.script(this, options.prompt), aborted]);
    this.emit("session.idle", {});
    return undefined;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#abort.abort();
  }

  async disconnect(): Promise<void> {
    this.#handlers.clear();
  }
}

interface StoredFile {
  content: string;
  version: number;
}

export type Script = (session: FakeSession, prompt: string, platform: FakePlatform) => Promise<void>;

/** In-memory platform: sessions, sandbox workspaces, and turn-scoped artifact publication. */
export class FakePlatform implements FactoryPlatform {
  readonly models: Record<StationRole, string> = { planner: "fake-planner", builder: "fake-builder", reviewer: "fake-reviewer", release: "fake-release" };
  readonly sessions = new Map<string, FakeSession>();
  readonly workspaces = new Map<string, Map<string, string>>();
  readonly outputs = new Map<string, Map<string, StoredFile>>();
  readonly deleted: string[] = [];
  readonly scripts: Partial<Record<StationRole, Script>>;
  /** What `sessionInfo().lastTurn.status` reports per session (default "completed"). */
  readonly lastTurnStatus = new Map<string, "running" | "completed" | "failed" | "cancelled">();
  /** Session IDs whose resume fails, as if the platform lost them. */
  readonly lost = new Set<string>();
  /** Remaining injected failures per artifact path (reads) and workspace path (writes). */
  readonly readFailures = new Map<string, number>();
  readonly writeFailures = new Map<string, number>();
  /** Like the gateway's list cap: only the newest sessions are listed. */
  listLimit = Number.POSITIVE_INFINITY;
  /** Errors the next resumeSession calls throw, in order (e.g. a connection that drops again while reattaching). */
  readonly resumeErrors: unknown[] = [];
  createCount = 0;

  constructor(scripts: Partial<Record<StationRole, Script>>) {
    this.scripts = scripts;
  }

  async script(session: FakeSession, prompt: string): Promise<void> {
    await this.scripts[session.role]?.(session, prompt, this);
  }

  sessionsFor(role: StationRole): FakeSession[] {
    return [...this.sessions.values()].filter((session) => session.role === role);
  }

  async createSession(role: StationRole, config: SessionConfig): Promise<StationSession> {
    this.createCount++;
    const session = new FakeSession(this, role, config);
    this.sessions.set(session.sessionId, session);
    this.workspaces.set(session.sessionId, new Map());
    this.outputs.set(session.sessionId, new Map());
    return session;
  }

  async resumeSession(role: StationRole, sessionId: string, config: ResumeSessionConfig): Promise<StationSession> {
    const failure = this.resumeErrors.shift();
    if (failure !== undefined) throw failure;
    if (!this.sessions.has(sessionId) || this.lost.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    const session = new FakeSession(this, role, config, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session || this.lost.has(sessionId)) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
    return {
      id: sessionId,
      environment: "fake",
      type: session?.role === "builder" || session?.role === "release" ? "isolated" : "shared",
      placement: session?.role === "builder" || session?.role === "release" ? "sandbox" : "shared",
      state: "idle",
      owner: { id: 1, login: "octocat" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingActions: [],
      lastTurn: { turnId: "t", status: this.lastTurnStatus.get(sessionId) ?? "completed" },
      ...(session?.role === "builder" || session?.role === "release"
        ? { sandbox: { id: `sbx_${sessionId}`, size: "small", state: "running", network: { access: "restricted", allowedDomains: ["github.com"] } } }
        : {}),
    } as SessionInfo;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const ids = [...this.sessions.keys()].filter((sessionId) => !this.lost.has(sessionId)).reverse().slice(0, this.listLimit);
    return Promise.all(ids.map((sessionId) => this.sessionInfo(sessionId)));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  files(sessionId: string): StationFiles {
    return {
      write: async (path, data) => {
        const failures = this.writeFailures.get(path) ?? 0;
        if (failures > 0) {
          this.writeFailures.set(path, failures - 1);
          throw new Error(`upload of ${path} failed`);
        }
        this.workspaces.get(sessionId)!.set(path, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        return { path, type: "file", size: data.length, modifiedAt: new Date().toISOString() };
      },
    };
  }

  /** What the factory-check harness would publish under outputs/. */
  publish(sessionId: string, files: Record<string, string>): void {
    const outputs = this.outputs.get(sessionId)!;
    for (const [path, content] of Object.entries(files)) {
      const existing = outputs.get(path);
      if (existing?.content === content) continue;
      outputs.set(path, { content, version: (existing?.version ?? 0) + 1 });
    }
  }

  artifacts(sessionId: string): StationArtifacts {
    const outputs = () => this.outputs.get(sessionId) ?? new Map<string, StoredFile>();
    const info = (path: string, file: StoredFile): ArtifactInfo => ({
      id: `art_${path}_${file.version}`,
      path,
      size: Buffer.byteLength(file.content),
      digest: `sha256:${file.version}`,
      turnId: "t",
      version: file.version,
      state: "published",
      publishedAt: new Date().toISOString(),
    });
    return {
      waitForPublication: async (): Promise<PublicationResult> => ({
        turnId: "t",
        state: "published",
        artifacts: [...outputs()].map(([path, file]) => info(path, file)),
      }),
      list: async () => [...outputs()].map(([path, file]) => info(path, file)),
      read: async (path) => {
        const failures = this.readFailures.get(path) ?? 0;
        if (failures > 0) {
          this.readFailures.set(path, failures - 1);
          throw new Error(`download of ${path} failed`);
        }
        const file = outputs().get(path);
        if (!file) throw new Error(`No artifact ${path}`);
        return file.content;
      },
    };
  }

  environment(_role: StationRole): EnvironmentInfo | undefined {
    return undefined;
  }
}

export function testReport(passed: number, failed = 0, mode: "task" | "release" = "task"): string {
  const report: TestReport = {
    schema: "factory.test-report/v1",
    mode,
    command: "node --test test/a.test.js",
    startedAt: new Date().toISOString(),
    durationMs: 120,
    exitCode: failed > 0 ? 1 : 0,
    summary: { total: passed + failed, passed, failed, skipped: 0 },
    files: ["test/a.test.js"],
    tests: [
      ...Array.from({ length: passed }, (_, index) => ({ name: `passes ${index}`, status: "passed" as const, durationMs: 1 })),
      ...Array.from({ length: failed }, (_, index) => ({ name: `fails ${index}`, status: "failed" as const, error: "expected 1 to equal 2" })),
    ],
  };
  return JSON.stringify(report);
}

export function manifest(paths: string[], mode: "task" | "release" = "task"): string {
  const value: OutputManifest = {
    schema: "factory.manifest/v1",
    mode,
    generatedAt: new Date().toISOString(),
    files: paths.map((path) => ({ path, size: 10, sha256: "x" })),
  };
  return JSON.stringify(value);
}
