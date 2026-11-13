// Fakes for Help Desk's platform seam: a stock-shaped session whose events, permission prompts, and tool calls the test
// drives, and a platform that keeps sessions in memory. Software Factory is faked the same way: work orders in memory.
import { fileURLToPath } from "node:url";
import type { MessageOptions, PermissionRequest, ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import type { HelpDeskConfig } from "../src/server/config.js";
import type { FactoryClient, WorkOrderRequest, WorkOrderSummary } from "../src/server/factory.js";
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
  /** Fails `send` with this error while it's set. */
  failSend: Error | undefined;
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
    if (this.failSend) throw this.failSend;
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

/** The storefront codebase the demo sends to Software Factory. */
export const STOREFRONT_DIR = fileURLToPath(new URL("../storefront", import.meta.url));

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
    storefrontDir: STOREFRONT_DIR,
    factoryPollMs: 60_000,
    playerIdleMs: 30 * 60_000,
    ...overrides,
  };
}

/**
 * A customer tells their agent about a problem with the store's website, and the agent reports it: the session's own
 * `report_bug` tool runs, and the runtime's events for the call follow. Without `words`, only the report (a player's
 * first message already said it).
 */
export async function reportBug(session: FakeSession, words: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const toolCallId = `bug-${++sequence}`;
  if (words !== undefined) session.emit(event("user.message", { content: words }));
  session.emit(event("tool.execution_start", { toolCallId, toolName: "report_bug", arguments: args }));
  const result = await session.call("report_bug", args, toolCallId);
  session.emit(event("tool.execution_complete", { toolCallId, success: true, result: { content: JSON.stringify(result) } }));
  return result;
}

/**
 * What Downhill's server sends when Mona opens support under a rejected code: the launch offer's code, rejected, after
 * she bought Neon Mona anyway at full price.
 */
export const MONA = {
  product: "downhill",
  player: { name: "Mona", rider: "mona" },
  checkout: {
    code: "trail15",
    error: "Invalid code.",
    offer: "Launch week: 15% off everything with code trail15",
    items: [{ sku: "mona-neon", name: "Neon Mona", priceCents: 499 }],
    subtotalCents: 499,
    order: { id: "DH-1042", totalCents: 499, paidAt: "2026-11-12T17:30:00.000Z" },
  },
  gameVersion: "1.0.0",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  at: "2026-11-12T17:30:00.000Z",
} as const;

/** Mona's request with changes: `checkout: undefined` leaves it out (she hasn't tried a checkout), as do other keys. */
export function monaWith(changes: { readonly checkout?: Record<string, unknown> | undefined; readonly [key: string]: unknown }): Record<string, unknown> {
  const { checkout, ...rest } = changes;
  const { checkout: _mona, ...base } = MONA;
  return { ...base, ...rest, ...("checkout" in changes && checkout === undefined ? {} : { checkout: { ...MONA.checkout, ...checkout } }) };
}

/** What a customer's agent proposes with `report_known_issue` once a team member tells it about the launch code. */
export const TRAIL15_ISSUE = {
  title: "Launch code trail15 rejected at checkout",
  symptoms: "The promo code TRAIL15 (or trail15 from the launch banner) says 'Invalid code.' at checkout",
  update: "Our engineers are fixing it. Meanwhile, type TRAIL15 in capitals at checkout and it works.",
} as const;

/** What Mona's agent reports with `report_bug`. */
export const MONA_REPORT = {
  area: "promo-codes",
  title: "Launch code trail15 rejected in the Downhill Shop",
  whatHappened: "The shop's launch banner applied trail15 and checkout said 'Invalid code.', so she paid $4.99 for Neon Mona.",
  expected: "trail15 takes 15% off, as the banner says.",
  orderId: "DH-1042",
} as const;

/** A Software Factory that keeps its work orders in memory and records what it was sent. */
export class FakeFactory implements FactoryClient {
  configured = true;
  publicUrl: string | undefined = "http://factory.test";
  /** Newest first, as Software Factory lists them. */
  workOrders: WorkOrderSummary[] = [];
  readonly created: WorkOrderRequest[] = [];
  lists = 0;
  /** Fails every call with this error while it's set. */
  failWith: Error | undefined;

  async create(request: WorkOrderRequest): Promise<WorkOrderSummary> {
    if (this.failWith) throw this.failWith;
    this.created.push(request);
    const number = this.workOrders.length + 1;
    const order: WorkOrderSummary = { id: `wo_${number}`, number, title: request.title, status: "queued", ...(request.origin ? { origin: request.origin } : {}) };
    this.workOrders.unshift(order);
    return order;
  }

  async list(): Promise<WorkOrderSummary[]> {
    this.lists += 1;
    if (this.failWith) throw this.failWith;
    return this.workOrders.map((order) => ({ ...order }));
  }

  /** Moves a work order along, as the factory's pipeline does. */
  update(id: string, changes: Partial<WorkOrderSummary>): void {
    this.workOrders = this.workOrders.map((order) => (order.id === id ? { ...order, ...changes } : order));
  }
}

/** Waits for pending promise callbacks and timers (publishing is coalesced with short timers). */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setImmediate(resolve));
}
