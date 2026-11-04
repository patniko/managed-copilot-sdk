// Fakes for Research Swarm's platform seam: a stock-shaped lead session whose tools, prompts, and events the test
// drives, and a platform that keeps sessions, workers, and researchers' files in memory.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageOptions, PermissionRequest, SessionConfig, SessionEvent, Tool, ToolInvocation } from "@github/copilot-sdk";
import { ManagedCopilotError, type PlatformEvent, type SessionInfo, type WorkerInfo, type WorkerState } from "@managed-copilot/sdk";
import type { SwarmConfig } from "../src/server/config.js";
import { createRequestHandler } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import type { LeadSession, SwarmPlatform } from "../src/server/platform.js";
import { RunManager } from "../src/server/runs.js";
import { Store } from "../src/server/store.js";
import type { PlatformStatus, Run, SwarmInfo } from "../src/shared/types.js";

let sequence = 0;

/** A session event with a fresh ID. */
export function event(type: string, data: Record<string, unknown> = {}): SessionEvent {
  sequence += 1;
  return { id: `event-${sequence}`, type, timestamp: new Date().toISOString(), parentId: null, data } as unknown as SessionEvent;
}

export const SWARM: SwarmInfo = {
  lead: { environment: "research-swarm", model: "claude-sonnet-5" },
  researchers: { environment: "research-swarm-web", model: "claude-haiku-5.5", max: 4, size: "small", hosts: ["en.wikipedia.org", "developer.mozilla.org"] },
};

export class FakeSession implements LeadSession {
  readonly sessionId: string;
  readonly config: SessionConfig;
  readonly sent: MessageOptions[] = [];
  aborted = false;
  disconnected = false;

  constructor(sessionId: string, config: SessionConfig) {
    this.sessionId = sessionId;
    this.config = config;
  }

  emit(value: SessionEvent): void {
    this.config.onEvent?.(value);
  }

  /** Asks the session's permission handler, as the runtime does for `start_worker`. */
  ask(request: Record<string, unknown> & { kind: string }): Promise<unknown> {
    return Promise.resolve(this.config.onPermissionRequest!(request as unknown as PermissionRequest, { sessionId: this.sessionId }));
  }

  /** Calls one of the app's tools, as the runtime does when the lead uses it. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = (this.config.tools ?? []).find((candidate: Tool<unknown>) => candidate.name === name);
    if (!tool?.handler) throw new Error(`No tool ${name}`);
    const invocation: ToolInvocation = { sessionId: this.sessionId, toolCallId: `call-${name}-${++sequence}`, toolName: name, arguments: args };
    return tool.handler(args, invocation);
  }

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    return `${this.sessionId}-message-${this.sent.length}`;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export class FakePlatform implements SwarmPlatform {
  status: PlatformStatus = { state: "connected", url: "http://localhost:7400", mode: "local", deployment: "copilot", account: { login: "octocat" } };
  swarm: SwarmInfo | undefined = SWARM;
  readonly sessions: FakeSession[] = [];
  readonly deleted: string[] = [];
  readonly workerList = new Map<string, WorkerInfo[]>();
  /** Files by session ID, then path. */
  readonly files = new Map<string, Map<string, string>>();
  readonly sandboxes = new Map<string, string>();
  createError: Error | undefined;
  /** When set, creating a session waits for it. */
  createGate: Promise<void> | undefined;
  deleteError: Error | undefined;
  readonly #status = new Set<(status: PlatformStatus) => void>();
  readonly #events = new Set<(event: PlatformEvent) => void>();

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }

  onEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  setStatus(status: PlatformStatus): void {
    this.status = status;
    for (const listener of this.#status) listener(status);
  }

  emit(type: PlatformEvent["type"], sessionId: string, data: Record<string, unknown>): void {
    const value: PlatformEvent = { id: `platform-${++sequence}`, type, createdAt: new Date().toISOString(), sessionId, data };
    for (const listener of this.#events) listener(value);
  }

  async createSession(config: SessionConfig): Promise<LeadSession> {
    await this.createGate;
    if (this.createError) throw this.createError;
    const session = new FakeSession(`lead-${this.sessions.length + 1}`, config);
    this.sessions.push(session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(sessionId);
  }

  async workers(sessionId: string): Promise<WorkerInfo[]> {
    return this.workerList.get(sessionId) ?? [];
  }

  async readFile(sessionId: string, path: string): Promise<string> {
    const file = this.files.get(sessionId)?.get(path);
    if (file === undefined) throw new ManagedCopilotError("not_found", `No file ${path}`);
    return file;
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const sandbox = this.sandboxes.get(sessionId);
    return {
      id: sessionId,
      environment: "research-swarm-web",
      type: "isolated",
      placement: "sandbox",
      state: "running",
      owner: { id: 1, login: "octocat" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingActions: [],
      ...(sandbox ? { sandbox: { id: sandbox, size: "small", state: "running", network: { access: "restricted", allowedDomains: [] } } } : {}),
    } as SessionInfo;
  }

  /** Sets a lead's worker listing entry. */
  worker(leadId: string, worker: { id: string; name: string; state: WorkerState; task?: string; result?: string; error?: string }): void {
    const list = this.workerList.get(leadId) ?? [];
    const now = new Date().toISOString();
    const info: WorkerInfo = {
      id: worker.id,
      name: worker.name,
      coordinatorId: leadId,
      environment: "research-swarm-web",
      state: worker.state,
      task: worker.task ?? `Research: ${worker.name}`,
      model: "claude-haiku-5.5",
      messages: 1,
      createdAt: now,
      updatedAt: now,
      ...(worker.result ? { result: worker.result } : {}),
      ...(worker.error ? { error: worker.error } : {}),
    };
    this.workerList.set(leadId, [...list.filter((existing) => existing.id !== worker.id), info]);
  }

  /** Writes a researcher's source log as `research read` does. */
  pages(workerId: string, pages: readonly { url: string; title: string }[]): void {
    const lines = pages.map((page, index) => JSON.stringify({ n: index + 1, url: page.url, title: page.title, at: "2026-11-04T06:00:00Z" }));
    const files = this.files.get(workerId) ?? new Map<string, string>();
    files.set("research/sources.jsonl", `${lines.join("\n")}\n`);
    this.files.set(workerId, files);
  }
}

/** Resolves once `predicate` holds, checking after each pending callback has run. */
export async function until(predicate: () => boolean, what = "the condition", ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function testConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: mkdtempSync(join(tmpdir(), "research-swarm-data-")),
    dev: false,
    packageRoot: "",
    webRoot: mkdtempSync(join(tmpdir(), "research-swarm-web-")),
    environment: "research-swarm",
    model: "claude-sonnet-5",
    researcherModel: "claude-haiku-5.5",
    maxRuns: 2,
    runTimeoutMs: 60_000,
    pollMs: 20,
    healthIntervalMs: 60_000,
    ...overrides,
  };
}

/** Research Swarm's HTTP server over a fake platform, on a free port. */
export async function startServer(seed: readonly Run[] = []) {
  const config = testConfig();
  const platform = new FakePlatform();
  const store = new Store(config.dataDir);
  for (const run of seed) store.put(run);
  const hub = new EventHub();
  const runs = new RunManager(platform, config, store, hub);
  runs.start();
  const server = createServer(createRequestHandler({ runs, hub, config }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    platform,
    store,
    close: async () => {
      await runs.close();
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Plays a lead and its two researchers through a whole run, from plan to report. */
export async function playRun(platform: FakePlatform, session: FakeSession): Promise<void> {
  await session.call("plan_research", { subQuestions: ["What is WebAssembly?", "Which browsers support it?"] });
  for (const [id, name] of [["w1", "r1"], ["w2", "r2"]] as const) {
    session.emit(event("tool.execution_start", { toolCallId: `start-${name}`, toolName: "start_worker", arguments: { name, task: "..." } }));
    platform.emit("worker.started", session.sessionId, { workerId: id, name, environment: "research-swarm-web", state: "starting" });
  }
  platform.pages("w1", [{ url: "https://en.wikipedia.org/wiki/WebAssembly", title: "WebAssembly - Wikipedia" }]);
  platform.pages("w2", [{ url: "https://developer.mozilla.org/en-US/docs/WebAssembly", title: "WebAssembly | MDN" }]);
  for (const [id, name] of [["w1", "r1"], ["w2", "r2"]] as const) {
    platform.worker(session.sessionId, { id, name, state: "idle", result: "- A finding" });
    platform.emit("worker.idle", session.sessionId, { workerId: id, name, environment: "research-swarm-web", state: "idle" });
  }
  await session.call("list_sources");
  await session.call("submit_report", { title: "WebAssembly today", summary: "A portable binary format [1] that every major browser runs [2].", body: "## What it is\n\nA compilation target [1].\n\n## Support\n\nAll major browsers [2]." });
  session.emit(event("session.idle"));
}
