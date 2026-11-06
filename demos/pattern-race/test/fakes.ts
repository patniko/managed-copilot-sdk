// Fakes for the race engine's tests: a platform and stock-shaped sessions driven by the test. Unit tests only.
import type {
  AssistantMessageEvent,
  AttributedPermissionResult,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
  UsageGetMetricsResult,
} from "@github/copilot-sdk";
import type { PlatformEvent, SessionInfo, WorkerInfo } from "@managed-copilot/sdk";
import { LANES, type LaneId } from "../src/shared/lanes.js";
import type { LaneAvailability, PlatformStatus } from "../src/shared/types.js";
import type { LaneSession, RacePlatform } from "../src/server/platform.js";

export class FakeSession implements LaneSession {
  readonly sessionId: string;
  readonly config: SessionConfig;
  prompt: string | undefined;
  aborted = false;
  usage = { totalPremiumRequestCost: 1, totalUserRequests: 1, modelMetrics: { "claude-sonnet-5": { requests: { count: 2, cost: 1 } } } };
  /** While set, reading usage waits for it. */
  gate: Promise<void> | undefined;
  readonly #handlers = new Set<(event: SessionEvent) => void>();
  #settle: { resolve: (reply: AssistantMessageEvent | undefined) => void; reject: (error: Error) => void } | undefined;
  readonly #sent: Promise<void>;
  #markSent!: () => void;

  constructor(config: SessionConfig) {
    this.sessionId = config.sessionId ?? "session";
    this.config = config;
    this.#sent = new Promise((resolve) => (this.#markSent = resolve));
  }

  readonly rpc = {
    usage: {
      getMetrics: async () => {
        await this.gate;
        return this.usage as unknown as UsageGetMetricsResult;
      },
    },
  };

  on(handler: (event: SessionEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  sendAndWait(options: MessageOptions): Promise<AssistantMessageEvent | undefined> {
    this.prompt = options.prompt;
    this.#markSent();
    return new Promise((resolve, reject) => (this.#settle = { resolve, reject }));
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#settle?.resolve(undefined);
  }

  /** Resolves once the lane sent its prompt. */
  sent(): Promise<void> {
    return this.#sent;
  }

  emit(type: string, data: Record<string, unknown>, agentId?: string): void {
    const event = { id: `${type}-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(), type, data, ...(agentId ? { agentId } : {}) } as unknown as SessionEvent;
    for (const handler of this.#handlers) handler(event);
  }

  answer(content: string): void {
    this.#settle?.resolve({ type: "assistant.message", data: { content, messageId: "m1" } } as unknown as AssistantMessageEvent);
  }

  fail(message: string): void {
    this.#settle?.reject(new Error(message));
  }

  ask(request: PermissionRequest): Promise<PermissionRequestResult | AttributedPermissionResult> {
    return Promise.resolve(this.config.onPermissionRequest!(request, { sessionId: this.sessionId }));
  }
}

export class FakePlatform implements RacePlatform {
  status: PlatformStatus = { state: "connected", url: "http://localhost:7400", mode: "local", deployment: "copilot", account: { login: "octocat" } };
  lanes: LaneAvailability[] = LANES.map((lane) => ({ lane: lane.id, available: true, sandboxEnvironment: lane.type === "isolated" ? lane.environment : "coder" }));
  readonly model = { id: "claude-sonnet-5", name: "Claude Sonnet 5" };
  readonly sessions = new Map<LaneId, FakeSession>();
  readonly deleted: string[] = [];
  readonly workerLists = new Map<string, WorkerInfo[]>();
  /** What `sessions.get` reports for a session, over the defaults. */
  readonly infos = new Map<string, Partial<SessionInfo>>();
  /** Lanes whose session can't be created, and why. */
  readonly refusals = new Map<LaneId, Error>();
  leftovers: string[] = [];
  readonly #created = new Map<LaneId, (session: FakeSession) => void>();
  readonly #eventListeners = new Set<(event: PlatformEvent) => void>();

  multiplier(): number | undefined {
    return undefined;
  }

  onChange(): () => void {
    return () => undefined;
  }

  onEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  emit(event: Partial<PlatformEvent> & Pick<PlatformEvent, "type">): void {
    for (const listener of this.#eventListeners) listener({ id: "evt", createdAt: new Date().toISOString(), data: {}, ...event } as PlatformEvent);
  }

  async createSession(lane: LaneId, config: SessionConfig): Promise<LaneSession> {
    const refusal = this.refusals.get(lane);
    if (refusal) throw refusal;
    const session = new FakeSession(config);
    this.sessions.set(lane, session);
    this.#created.get(lane)?.(session);
    return session;
  }

  /** The lane's session once the race created it and sent the prompt. */
  async session(lane: LaneId): Promise<FakeSession> {
    const existing = this.sessions.get(lane);
    const session = existing ?? (await new Promise<FakeSession>((resolve) => this.#created.set(lane, resolve)));
    await session.sent();
    return session;
  }

  async deleteSession(_lane: LaneId, sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    return { id: sessionId, placement: "shared", sandbox: { id: `sandbox-of-${sessionId}` }, ...this.infos.get(sessionId) } as unknown as SessionInfo;
  }

  async workers(sessionId: string): Promise<WorkerInfo[]> {
    return this.workerLists.get(sessionId) ?? [];
  }

  async deleteLeftovers(prefix: string): Promise<number> {
    const matching = this.leftovers.filter((id) => id.startsWith(prefix));
    this.deleted.push(...matching);
    return matching.length;
  }
}

export function worker(fields: Partial<WorkerInfo> & Pick<WorkerInfo, "id" | "name">): WorkerInfo {
  return { coordinatorId: "c", environment: "coder", state: "working", task: "t", messages: 1, createdAt: "", updatedAt: "", role: "worker", ...fields };
}
