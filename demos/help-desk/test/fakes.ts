// Fakes for Help Desk's platform seam: a stock-shaped session whose events, permission prompts, and tool calls the test
// drives, and a platform that keeps sessions in memory.
import type { MessageOptions, PermissionRequest, ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import type { HelpDeskConfig } from "../src/server/config.js";
import type { DeskPlatform, SupportSession } from "../src/server/platform.js";
import type { PlatformStatus } from "../src/shared/types.js";

let sequence = 0;
const base = Date.parse("2026-11-03T10:00:00.000Z");

/** A session event with a fresh ID and an increasing timestamp. */
export function event(type: string, data: Record<string, unknown> = {}, extra: { ephemeral?: boolean; id?: string } = {}): SessionEvent {
  sequence += 1;
  return {
    id: extra.id ?? `event-${sequence}`,
    type,
    timestamp: new Date(base + sequence * 1000).toISOString(),
    parentId: null,
    ...(extra.ephemeral ? { ephemeral: true } : {}),
    data,
  } as unknown as SessionEvent;
}

type Config = SessionConfig | ResumeSessionConfig;

export class FakeSession implements SupportSession {
  readonly sessionId: string;
  /** The persisted history `getEvents` returns. */
  readonly history: SessionEvent[] = [];
  readonly sent: MessageOptions[] = [];
  config: Config;
  disconnected = false;
  premium = 0;
  readonly rpc = { usage: { getMetrics: async () => ({ totalPremiumRequestCost: this.premium }) } };

  constructor(sessionId: string, config: Config) {
    this.sessionId = sessionId;
    this.config = config;
  }

  /** Delivers an event live (and keeps it in the history unless it is ephemeral). */
  emit(value: SessionEvent): void {
    if (!(value as { ephemeral?: boolean }).ephemeral) this.history.push(value);
    this.config.onEvent?.(value);
  }

  /** Asks the session's permission handler, as the runtime does before a tool without `skipPermission`. */
  ask(request: Record<string, unknown>): Promise<unknown> {
    const handler = this.config.onPermissionRequest;
    if (!handler) throw new Error("No permission handler");
    return Promise.resolve(handler(request as unknown as PermissionRequest, { sessionId: this.sessionId }));
  }

  tool(name: string): Tool<unknown> {
    const found = this.config.tools?.find((candidate) => candidate.name === name);
    if (!found?.handler) throw new Error(`No tool ${name}`);
    return found as Tool<unknown>;
  }

  /** Runs one of the session's tools, as the runtime does when the agent calls it. */
  async call(name: string, args: Record<string, unknown>, toolCallId = `call-${++sequence}`): Promise<unknown> {
    return this.tool(name).handler!(args, { sessionId: this.sessionId, toolCallId, toolName: name, arguments: args });
  }

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    return `${this.sessionId}-message-${this.sent.length}`;
  }

  async getEvents(): Promise<SessionEvent[]> {
    return [...this.history];
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export class FakePlatform implements DeskPlatform {
  status: PlatformStatus = { state: "connected", url: "http://gateway.test", mode: "local", deployment: "test", account: { login: "octocat" } };
  model: string | undefined = "claude-haiku-4.5";
  placement: "shared" | "sandbox" | undefined = "shared";
  readonly sessions = new Map<string, FakeSession>();
  /** Sessions that exist on the platform. */
  readonly listed = new Map<string, SessionInfo>();
  readonly created: SessionConfig[] = [];
  readonly resumed: string[] = [];
  readonly deleted: string[] = [];
  /** Fails `createSession` for these customers' sessions. */
  readonly failCreate = new Set<string>();
  readonly #status = new Set<(status: PlatformStatus) => void>();
  readonly #connected = new Set<() => void>();

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connected.add(listener);
    return () => this.#connected.delete(listener);
  }

  connect(): void {
    for (const listener of this.#connected) listener();
  }

  setStatus(status: PlatformStatus): void {
    this.status = status;
    for (const listener of this.#status) listener(status);
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    const id = config.sessionId ?? `session-${this.sessions.size + 1}`;
    if ([...this.failCreate].some((customerId) => id.endsWith(`-${customerId}`))) throw new Error("The runtime is busy");
    const session = new FakeSession(id, config);
    this.sessions.set(id, session);
    this.created.push(config);
    this.listed.set(id, info(id));
    return session;
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSession> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.listed.has(sessionId)) throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "not_found" });
    session.config = config;
    session.disconnected = false;
    this.resumed.push(sessionId);
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
    const found = this.listed.get(sessionId);
    if (!found) throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "not_found" });
    return found;
  }

  /** A session that already exists on the platform, with its history (as after a Help Desk restart). */
  seed(sessionId: string, history: SessionEvent[] = [], overrides: Partial<SessionInfo> = {}): FakeSession {
    const session = new FakeSession(sessionId, {});
    session.history.push(...history);
    this.sessions.set(sessionId, session);
    this.listed.set(sessionId, info(sessionId, overrides));
    return session;
  }
}

export function info(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    environment: "help-desk",
    type: "shared",
    placement: "shared",
    state: "idle",
    owner: { id: 1, login: "octocat" },
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    pendingActions: [],
    lastTurn: { turnId: "turn-1", status: "completed", completedAt: "2026-11-03T10:00:30.000Z" },
    ...overrides,
  };
}

export function testConfig(overrides: Partial<HelpDeskConfig> = {}): HelpDeskConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dev: false,
    packageRoot: ".",
    webRoot: ".",
    environment: "help-desk",
    staggerMs: 0,
    healthIntervalMs: 60_000,
    countersIntervalMs: 60_000,
    ...overrides,
  };
}

/** Waits for pending promise callbacks and timers (publishing is coalesced with short timers). */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setImmediate(resolve));
}
