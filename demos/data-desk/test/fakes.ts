// Fakes for Data Desk's platform seam: a stock-shaped session whose events and permission prompts the test drives,
// and a platform that keeps sessions, written files, and published outputs in memory.
import type { MessageOptions, PermissionRequest, ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { ArtifactInfo, PlatformEvent, SessionInfo } from "@managed-copilot/sdk";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeskConfig } from "../src/server/config.js";
import type { DeskPlatform, DeskSession } from "../src/server/platform.js";
import type { EnvironmentView, PlatformStatus } from "../src/shared/types.js";

let sequence = 0;
const base = Date.parse("2026-11-04T10:00:00.000Z");

/** A session event with a fresh ID and an increasing timestamp. */
export function event(type: string, data: Record<string, unknown> = {}, extra: { ephemeral?: boolean; agentId?: string; id?: string } = {}): SessionEvent {
  sequence += 1;
  return {
    id: extra.id ?? `event-${sequence}`,
    type,
    timestamp: new Date(base + sequence * 1000).toISOString(),
    parentId: null,
    ...(extra.ephemeral ? { ephemeral: true } : {}),
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    data,
  } as unknown as SessionEvent;
}

type Handlers = Pick<SessionConfig, "onEvent" | "onPermissionRequest">;

export class FakeSession implements DeskSession {
  readonly sessionId: string;
  /** The persisted history `getEvents` returns. */
  readonly history: SessionEvent[] = [];
  readonly sent: MessageOptions[] = [];
  handlers: Handlers;
  config: SessionConfig | ResumeSessionConfig;
  premiumRequests = 0;
  aborted = 0;
  disconnected = false;
  readonly rpc = { usage: { getMetrics: async () => ({ totalPremiumRequestCost: this.premiumRequests }) } };

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

  /** Asks the session's permission handler, as the runtime does. */
  ask(request: Record<string, unknown> & { readonly kind: string }): Promise<unknown> {
    const handler = this.handlers.onPermissionRequest;
    if (!handler) throw new Error("No permission handler");
    return Promise.resolve(handler(request as unknown as PermissionRequest, { sessionId: this.sessionId }));
  }

  on(): () => void {
    return () => undefined;
  }

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    return `${this.sessionId}-message-${this.sent.length}`;
  }

  async getEvents(): Promise<SessionEvent[]> {
    return [...this.history];
  }

  async abort(): Promise<void> {
    this.aborted += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export class FakePlatform implements DeskPlatform {
  status: PlatformStatus = { state: "connected", url: "http://gateway.test", mode: "local", deployment: "test", account: { login: "octocat" } };
  environments: readonly EnvironmentView[] = [
    { name: "data-desk", type: "promotable", network: "disabled" },
    { name: "data-desk-python", type: "isolated", network: "disabled", size: "small" },
  ];
  readonly sessions = new Map<string, FakeSession>();
  readonly infos = new Map<string, SessionInfo>();
  readonly written: { sessionId: string; path: string; bytes: number }[] = [];
  readonly artifacts = new Map<string, ArtifactInfo[]>();
  readonly deleted: string[] = [];
  /** Fails the next `writeFile` calls. */
  writeFailures = 0;
  /** While set, `writeFile` waits for it. */
  writeGate: Promise<void> | undefined;
  readonly #events = new Set<(event: PlatformEvent) => void>();
  readonly #connected = new Set<() => void>();
  #ids = 0;

  onStatus(): () => void {
    return () => undefined;
  }

  onConnected(listener: () => void): () => void {
    this.#connected.add(listener);
    return () => this.#connected.delete(listener);
  }

  onEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** Delivers a platform event (`session.promoted`, `artifact.published`, ...). */
  publish(value: Omit<PlatformEvent, "id" | "createdAt"> & { createdAt?: string }): void {
    for (const listener of this.#events) listener({ id: `evt-${++this.#ids}`, createdAt: value.createdAt ?? new Date().toISOString(), ...value } as PlatformEvent);
  }

  connect(): void {
    for (const listener of this.#connected) listener();
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    const id = `session-${++this.#ids}`;
    const session = new FakeSession(id, config);
    this.sessions.set(id, session);
    this.infos.set(id, info(id, "shared"));
    return session;
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSession> {
    const existing = this.sessions.get(sessionId);
    if (!existing || this.deleted.includes(sessionId)) throw new Error(`Session ${sessionId} not found`);
    const session = new FakeSession(sessionId, config);
    session.history.push(...existing.history);
    session.premiumRequests = existing.premiumRequests;
    this.sessions.set(sessionId, session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.infos.values()].filter((value) => !this.deleted.includes(value.id));
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const value = this.infos.get(sessionId);
    if (!value || this.deleted.includes(sessionId)) throw new Error(`Session ${sessionId} not found`);
    return value;
  }

  async writeFile(sessionId: string, path: string, data: Uint8Array): Promise<void> {
    await this.writeGate;
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      throw new Error("The sandbox isn't ready");
    }
    this.written.push({ sessionId, path, bytes: data.byteLength });
  }

  async outputs(sessionId: string): Promise<ArtifactInfo[]> {
    return this.artifacts.get(sessionId) ?? [];
  }

  async readOutput(_sessionId: string, path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><title>${path}</title></svg>`);
  }

  /** Moves a session's recorded placement into a sandbox. */
  promote(sessionId: string, sandboxId: string): void {
    this.infos.set(sessionId, info(sessionId, "sandbox", sandboxId));
  }
}

export function info(id: string, placement: "shared" | "sandbox", sandboxId?: string): SessionInfo {
  return {
    id,
    environment: "data-desk",
    type: "promotable",
    placement,
    state: "idle",
    owner: { id: 1, login: "octocat" },
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    ...(sandboxId ? { sandbox: { id: sandboxId, size: "small", state: "running", network: { access: "disabled", allowedDomains: [] } } } : {}),
    pendingActions: [],
  } as SessionInfo;
}

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function testConfig(dataDir: string): DeskConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    dev: false,
    packageRoot: PACKAGE_ROOT,
    webRoot: join(dataDir, "web"),
    samplesDir: join(PACKAGE_ROOT, "datasets"),
    repoRoot: join(PACKAGE_ROOT, "..", ".."),
    environment: "data-desk",
    model: "claude-sonnet-5",
    maxUploadBytes: 64 * 1024,
    healthIntervalMs: 60_000,
  };
}
