// Fakes for Dispatch's platform seam: a stock-shaped coordinator session whose events and permission prompts the test
// drives, and a platform that keeps sessions, workers, sandboxes, and files in memory.
import type { MessageOptions, PermissionRequest, ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { ArtifactInfo, FileEntry, PlatformEvent, SessionInfo, WorkerInfo } from "@managed-copilot/sdk";
import type { DispatchConfig } from "../src/server/config.js";
import type { CoordinatorSession, DispatchPlatform } from "../src/server/platform.js";
import type { Blueprint, CoordinatorInfo, PlatformStatus } from "../src/shared/types.js";

let sequence = 0;
const base = Date.parse("2026-10-27T10:00:00.000Z");

/** A coordinator session event with a fresh ID and an increasing timestamp. */
export function event(type: string, data: Record<string, unknown> = {}, extra: { ephemeral?: boolean; agentId?: string; id?: string; at?: number } = {}): SessionEvent {
  sequence += 1;
  return {
    id: extra.id ?? `event-${sequence}`,
    type,
    timestamp: new Date(extra.at ?? base + sequence * 1000).toISOString(),
    parentId: null,
    ...(extra.ephemeral ? { ephemeral: true } : {}),
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    data,
  } as unknown as SessionEvent;
}

type Handlers = Pick<SessionConfig, "onEvent" | "onPermissionRequest">;

/** A permission prompt as the runtime sends it (only the fields a test sets). */
export type Prompt = Record<string, unknown> & { readonly kind: string };

export class FakeSession implements CoordinatorSession {
  readonly sessionId: string;
  /** The persisted history `getEvents` returns. */
  readonly history: SessionEvent[] = [];
  readonly sent: MessageOptions[] = [];
  handlers: Handlers;
  config: SessionConfig | ResumeSessionConfig;
  disconnected = false;
  #messages = 0;

  constructor(sessionId: string, config: SessionConfig | ResumeSessionConfig) {
    this.sessionId = sessionId;
    this.config = config;
    this.handlers = config;
  }

  /** Delivers an event live (and keeps it in the history unless it is ephemeral). */
  emit(value: SessionEvent): void {
    if (!(value as { ephemeral?: boolean }).ephemeral) this.history.push(value);
    this.handlers.onEvent?.(value);
  }

  /** Asks the session's permission handler, as the runtime does for `start_worker`. */
  ask(request: Prompt): Promise<unknown> {
    const handler = this.handlers.onPermissionRequest;
    if (!handler) throw new Error("No permission handler");
    return Promise.resolve(handler(request as unknown as PermissionRequest, { sessionId: this.sessionId }));
  }

  on(): () => void {
    return () => undefined;
  }

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    this.#messages += 1;
    return `${this.sessionId}-message-${this.#messages}`;
  }

  async getEvents(): Promise<SessionEvent[]> {
    return [...this.history];
  }

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export const BLUEPRINTS: Blueprint[] = [
  { name: "dispatch-python", kind: "python", label: "Python lab", size: "medium", cpus: 2, memoryGiB: 4, network: { access: "disabled", hosts: [] }, agents: [], isDefault: true },
  { name: "dispatch-node", kind: "node", label: "Node workshop", size: "small", cpus: 1, memoryGiB: 2, network: { access: "restricted", hosts: ["registry.npmjs.org"] }, agents: [], isDefault: false },
];

export function worker(overrides: Partial<WorkerInfo> & Pick<WorkerInfo, "id" | "name">): WorkerInfo {
  return {
    coordinatorId: "coordinator",
    environment: "dispatch-python",
    state: "working",
    task: "Do the thing",
    messages: 1,
    createdAt: "2026-10-27T10:00:05.000Z",
    updatedAt: "2026-10-27T10:00:06.000Z",
    ...overrides,
  };
}

export class FakePlatform implements DispatchPlatform {
  status: PlatformStatus = { state: "connected", url: "http://gateway.test", mode: "local", deployment: "test", account: { login: "octocat" } };
  coordinator: CoordinatorInfo | undefined = { environment: "dispatch", model: "claude-sonnet-5", maxWorkers: 6 };
  blueprints: readonly Blueprint[] = BLUEPRINTS;
  readonly sessions = new Map<string, FakeSession>();
  /** Sessions that exist on the platform (listed in the orchestrator environment). */
  readonly listed = new Map<string, SessionInfo>();
  readonly workerLists = new Map<string, WorkerInfo[]>();
  readonly infos = new Map<string, SessionInfo>();
  readonly fileLists = new Map<string, FileEntry[]>();
  readonly fileContents = new Map<string, string>();
  readonly artifactLists = new Map<string, ArtifactInfo[]>();
  readonly deleted: string[] = [];
  readonly created: SessionConfig[] = [];
  readonly resumed: { sessionId: string; config: ResumeSessionConfig }[] = [];
  /** Every resume tried, including ones that failed. */
  readonly resumeAttempts: string[] = [];
  /** Permission prompts the platform delivers again when a session is resumed. */
  readonly pendingPrompts = new Map<string, Prompt[]>();
  readonly #status = new Set<(status: PlatformStatus) => void>();
  readonly #connected = new Set<() => void>();
  readonly #workers = new Set<(event: PlatformEvent) => void>();
  #ids = 0;

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connected.add(listener);
    return () => this.#connected.delete(listener);
  }

  onWorkerEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#workers.add(listener);
    return () => this.#workers.delete(listener);
  }

  connect(): void {
    for (const listener of this.#connected) listener();
  }

  setStatus(status: PlatformStatus): void {
    this.status = status;
    for (const listener of this.#status) listener(status);
  }

  workerEvent(event: PlatformEvent): void {
    for (const listener of this.#workers) listener(event);
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.#ids += 1;
    const id = `session-${this.#ids}`;
    const session = new FakeSession(id, config);
    this.sessions.set(id, session);
    this.created.push(config);
    this.listed.set(id, info(id));
    return session;
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSession> {
    this.resumeAttempts.push(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session || !this.listed.has(sessionId)) throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "not_found" });
    session.config = config;
    session.handlers = config;
    session.disconnected = false;
    this.resumed.push({ sessionId, config });
    // Prompts still waiting for an answer come to the new connection, as the gateway delivers them.
    for (const prompt of this.pendingPrompts.get(sessionId) ?? []) void session.ask(prompt);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
    this.listed.delete(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.listed.values()];
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const found = this.infos.get(sessionId) ?? this.listed.get(sessionId);
    if (!found) throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "not_found" });
    return found;
  }

  async workers(coordinatorId: string): Promise<WorkerInfo[]> {
    return [...(this.workerLists.get(coordinatorId) ?? [])];
  }

  async listFiles(sessionId: string): Promise<FileEntry[]> {
    return [...(this.fileLists.get(sessionId) ?? [])];
  }

  async readFile(sessionId: string, path: string): Promise<string> {
    const content = this.fileContents.get(`${sessionId}:${path}`);
    if (content === undefined) throw new Error("No such file");
    return content;
  }

  async artifacts(sessionId: string): Promise<ArtifactInfo[]> {
    return [...(this.artifactLists.get(sessionId) ?? [])];
  }
}

export function info(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    environment: "dispatch",
    type: "orchestrator",
    placement: "shared",
    state: "ready",
    owner: { login: "octocat" } as SessionInfo["owner"],
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    pendingActions: [],
    ...overrides,
  } as SessionInfo;
}

export function testConfig(dataDir: string, overrides: Partial<DispatchConfig> = {}): DispatchConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    dev: false,
    packageRoot: dataDir,
    webRoot: dataDir,
    repoRoot: dataDir,
    environment: "dispatch",
    model: "claude-sonnet-5",
    approvals: "ask",
    healthIntervalMs: 60_000,
    filesIntervalMs: 0,
    ...overrides,
  };
}

/** Waits for pending promise callbacks and timers (publishing is coalesced with short timers). */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setImmediate(resolve));
}
