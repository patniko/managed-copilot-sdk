// Fakes for unit tests: a platform whose coordinator sessions record what the app does with them, and Software Factory's
// API on a local port, whose work orders the tests move along by hand.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { MessageOptions, PermissionRequest, PermissionRequestResult, ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type { ExecInfo, SessionInfo, WorkerInfo } from "@managed-copilot/sdk";
import type { FactoryStatus, FactoryTests, PlatformStatus } from "../src/shared/types.js";
import type { AppConfig, FactoryTarget } from "../src/server/config.js";
import type { CoordinatorSession, IncidentPlatform } from "../src/server/platform.js";

type Config = SessionConfig | ResumeSessionConfig;

export class FakeSession implements CoordinatorSession {
  readonly sent: MessageOptions[] = [];
  disconnected = 0;

  constructor(
    readonly sessionId: string,
    readonly config: Config,
  ) {}

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  async disconnect(): Promise<void> {
    this.disconnected++;
  }

  emit(event: Partial<SessionEvent> & { type: string; data?: unknown }): void {
    this.config.onEvent?.({ id: `event-${Math.random()}`, timestamp: new Date().toISOString(), parentId: null, ephemeral: false, data: {}, ...event } as unknown as SessionEvent);
  }

  permission(request: PermissionRequest): Promise<PermissionRequestResult> {
    return Promise.resolve(this.config.onPermissionRequest!(request, { sessionId: this.sessionId }) as PermissionRequestResult);
  }

  tool(name: string): Tool<unknown> {
    const tool = (this.config.tools ?? []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool as Tool<unknown>;
  }

  /** Runs one of the app's tools the way the runtime would. */
  async call(name: string, args: unknown, toolCallId = "call-1"): Promise<unknown> {
    return this.tool(name).handler!(args, { sessionId: this.sessionId, toolCallId, toolName: name, arguments: args });
  }
}

export function deployRequest(args: Record<string, unknown>, toolCallId = "deploy-call"): PermissionRequest {
  return { kind: "custom-tool", toolName: "deploy_fix", toolCallId, toolDescription: "Deploys the verified fix", args } as PermissionRequest;
}

export function worker(overrides: Partial<WorkerInfo> & Pick<WorkerInfo, "id" | "name">): WorkerInfo {
  const now = new Date().toISOString();
  return { coordinatorId: "coordinator", environment: "incident-commander-node", state: "working", task: "", messages: 1, createdAt: now, updatedAt: now, role: "worker", ...overrides };
}

export class FakePlatform implements IncidentPlatform {
  status: PlatformStatus = {
    state: "connected",
    url: "http://gateway.test",
    mode: "local",
    deployment: "copilot",
    account: { login: "octocat" },
    environments: [
      { name: "incident-commander", role: "coordinator", network: "Off" },
      { name: "incident-commander-triage", role: "own", network: "Off" },
      { name: "incident-commander-node", role: "worker", network: "registry.npmjs.org only" },
    ],
  };
  readonly url = "http://gateway.test";
  readonly sessions: FakeSession[] = [];
  readonly files = new Map<string, string>();
  readonly deleted: string[] = [];
  workerList: WorkerInfo[] = [];
  execList: ExecInfo[] = [];
  lastTurn: SessionInfo["lastTurn"] = { turnId: "turn-1", status: "running" };
  /** Runs right after a resume, while the resume is still "in flight" (where the platform replays waiting requests). */
  onResume: ((session: FakeSession) => Promise<void> | void) | undefined;
  #created = 0;

  onStatus(): () => void {
    return () => undefined;
  }

  onConnected(): () => void {
    return () => undefined;
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.#requireConnected();
    const session = new FakeSession(`coordinator-${++this.#created}`, config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSession> {
    this.#requireConnected();
    const session = new FakeSession(sessionId, config);
    this.sessions.push(session);
    await this.onResume?.(session);
    return session;
  }

  #requireConnected(): void {
    if (this.status.state !== "connected") throw new Error("Managed Copilot isn't connected yet.");
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    return {
      id: sessionId,
      environment: "incident-commander",
      type: "orchestrator",
      placement: "shared",
      state: "running",
      owner: { id: 1, login: "octocat" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingActions: [],
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
    };
  }

  async workers(): Promise<WorkerInfo[]> {
    return this.workerList;
  }

  async execs(): Promise<ExecInfo[]> {
    return this.execList;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    this.files.set(`${sandboxId}:${path}`, content);
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const content = this.files.get(`${sandboxId}:${path}`);
    if (content === undefined) throw new Error(`No such file: ${path}`);
    return content;
  }

  /** The most recent session object. */
  get session(): FakeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No session yet");
    return session;
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 7445,
    host: "127.0.0.1",
    dataDir: "",
    dev: false,
    packageRoot: "",
    webRoot: "",
    environment: "incident-commander",
    model: "claude-sonnet-5",
    publicUrl: "http://localhost:7445",
    alertSecret: "alert-secret",
    webhookSecret: "webhook-secret",
    demoServicesDir: fileURLToPath(new URL("../demo-services", import.meta.url)),
    healthIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    factoryPollMs: 60_000,
    ...overrides,
  };
}

/** Lets queued callbacks (setImmediate, resolved promises) run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface FakeWorkOrder {
  id: string;
  number: number;
  title: string;
  status: FactoryStatus;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  tests?: FactoryTests;
  error?: { code: string; message: string };
  origin?: { app: string; name: string; label?: string; url?: string; key?: string };
}

/** Software Factory's API (its routing contract) on a local port. Tests move its work orders along with `set`. */
export class FakeFactory {
  /** The bodies of `POST /api/work-orders`. */
  readonly created: Record<string, unknown>[] = [];
  /** `GET /api/work-orders/wo_12`, ... */
  readonly requests: string[] = [];
  readonly orders = new Map<string, FakeWorkOrder>();
  /** What `GET /api/work-orders/:id/release` answers; 404 until set. */
  readonly releases = new Map<string, unknown>();
  /** While set, every request answers this error. */
  refuse: { readonly status: number; readonly code: string; readonly message: string } | undefined;
  url = "";
  #server: Server | undefined;
  #next = 12;

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.#handle(req, res));
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this;
  }

  /** How Incident Commander reaches it; links go to a public address. */
  get target(): FactoryTarget {
    return { url: this.url, publicUrl: "http://factory.test" };
  }

  /** Stops answering: Software Factory is down. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  /** A work order the factory has (as if created before the app recorded it). */
  add(order: Partial<FakeWorkOrder> = {}): FakeWorkOrder {
    const number = this.#next++;
    const now = new Date().toISOString();
    const created: FakeWorkOrder = { id: `wo_${number}`, number, title: "A work order", status: "queued", createdAt: now, updatedAt: now, taskCount: 0, ...order };
    this.orders.set(created.id, created);
    return created;
  }

  /** Moves a work order along. */
  set(id: string, change: Partial<FakeWorkOrder>): void {
    const order = this.orders.get(id);
    if (!order) throw new Error(`No work order ${id}`);
    Object.assign(order, change, { updatedAt: new Date().toISOString() });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const path = new URL(req.url ?? "/", "http://factory.test").pathname;
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    this.requests.push(`${req.method} ${path}`);
    if (this.refuse) return send(this.refuse.status, { error: { code: this.refuse.code, message: this.refuse.message } });
    if (req.method === "POST" && path === "/api/work-orders") {
      const body = JSON.parse(raw) as Record<string, unknown> & { title: string; origin?: FakeWorkOrder["origin"] };
      this.created.push(body);
      return send(201, this.add({ title: body.title, ...(body.origin ? { origin: body.origin } : {}) }));
    }
    if (req.method === "GET" && path === "/api/work-orders") return send(200, [...this.orders.values()].reverse());
    const match = /^\/api\/work-orders\/([^/]+)(\/release)?$/.exec(path);
    const order = match ? this.orders.get(decodeURIComponent(match[1]!)) : undefined;
    if (req.method === "GET" && order && !match?.[2]) return send(200, order);
    const release = order ? this.releases.get(order.id) : undefined;
    if (req.method === "GET" && release) return send(200, release);
    send(404, { error: { code: "not_found", message: order ? "This work order has no release yet." : "There's no such work order." } });
  }
}
