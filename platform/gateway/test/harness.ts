// Test harness: a fake runtime that speaks the stock runtime's JSON-RPC over TCP (LSP framing), a GitHub API stub,
// a gateway wired to both, and a raw bridge-protocol client. Used by router/integration tests; never by demos.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as connectTcp, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_HELLO, BRIDGE_SUBPROTOCOL, type EnvironmentRequest } from "@managed-copilot/protocol";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { RpcEndpoint, RpcError, streamTransport, webSocketTransport } from "../src/modules/core/rpc.js";
import { startGateway, type RunningGateway } from "../src/server.js";

export interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Which connection to the fake runtime sent it (1 = the first). */
  readonly connection?: number;
}

interface FakeSession {
  readonly id: string;
  createParams: Record<string, unknown>;
  token?: string;
  agent?: string;
  /** The connection that last created or resumed the session: where its events go. */
  endpoint?: RpcEndpoint;
  /** Answers an in-flight `sendAndWait` as aborted (what `session.suspend` does). */
  suspend?: () => void;
  readonly events: { id: string; type: string; data: Record<string, unknown> }[];
}

/** A minimal stand-in for the stock runtime's headless JSON-RPC surface. */
export class FakeRuntime {
  readonly token = `fake-${randomUUID()}`;
  readonly requests: RecordedRequest[] = [];
  readonly notifications: RecordedRequest[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly #pendingTools = new Map<string, { sessionId: string; toolName: string; toolCallId: string; arguments: unknown; resolve: (answer: Record<string, unknown>) => void }>();
  readonly #endpoints = new Set<RpcEndpoint>();
  #connections = 0;
  #server: Server | undefined;
  port = 0;
  /** Like stock runtime 1.0.103: lifecycle notifications follow the create/resume answer (default: before it). */
  lifecycleAfterAnswer = false;

  async start(): Promise<void> {
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const endpoint of this.#endpoints) endpoint.close();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  /** Drops every connection, as if the runtime crashed: turns in flight are lost, pending tool calls are kept. */
  dropConnections(): void {
    this.#processing.clear();
    for (const endpoint of this.#endpoints) endpoint.close();
  }

  /** Sessions whose turn is running (between its root `user.message` and `session.idle`). */
  readonly #processing = new Set<string>();

  calls(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Emits a session event from the runtime, on the connection that owns the session (test hook). */
  emitEvent(sessionId: string, type: string, data: Record<string, unknown> = {}): string {
    const session = this.sessions.get(sessionId);
    if (!session?.endpoint) throw new Error(`No open session ${sessionId}`);
    return this.#emit(session.endpoint, session, type, data);
  }

  /** Emits a session event on one runtime connection (1 = the first), whichever connection the session is open on (test hook). */
  emitEventOn(connection: number, sessionId: string, type: string, data: Record<string, unknown> = {}): string {
    const endpoint = this.#byConnection.get(connection);
    const session = this.sessions.get(sessionId);
    if (!endpoint || !session) throw new Error(`No connection ${connection} or session ${sessionId}`);
    const event = { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data };
    session.events.push(event);
    endpoint.notify("session.event", { sessionId, event });
    return event.id;
  }

  /** Answers a pending tool call inside the runtime, as if a responder had (test hook). */
  answerTool(requestId: string, result: unknown): void {
    const pending = this.#pendingTools.get(requestId);
    if (!pending) throw new Error(`No pending tool call ${requestId}`);
    this.#pendingTools.delete(requestId);
    pending.resolve({ requestId, result });
  }

  /** Holds the response to the next request of `method` (optionally for one session) until `release()` (test hook). */
  holdNext(method: string, sessionId?: string): { readonly held: Promise<void>; release(): void } {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    this.#holds.push({ method, sessionId, gate, arrived });
    return { held, release };
  }

  /** Fails the next request of `method` (optionally for one session) with a runtime error (test hook). */
  failNext(method: string, sessionId?: string, message = "The runtime failed the request"): void {
    this.#failures.push({ method, sessionId, message });
  }

  /** Sends a runtime → gateway request on one connection (1 = the first), as the runtime would (test hook). */
  requestOn(connection: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    const endpoint = this.#byConnection.get(connection);
    if (!endpoint) throw new Error(`No connection ${connection}`);
    return endpoint.request(method, params);
  }

  readonly #holds: { method: string; sessionId: string | undefined; gate: Promise<void>; arrived: () => void }[] = [];
  readonly #failures: { method: string; sessionId: string | undefined; message: string }[] = [];
  readonly #byConnection = new Map<number, RpcEndpoint>();

  #accept(socket: Socket): void {
    let authenticated = false;
    const connection = ++this.#connections;
    const endpoint: RpcEndpoint = new RpcEndpoint(streamTransport(socket), {
      name: "fake runtime",
      onNotification: (method, params) => this.notifications.push({ method, params: (params ?? {}) as Record<string, unknown>, connection }),
      onRequest: async (method, params, context) => {
        const body = (params ?? {}) as Record<string, unknown>;
        this.requests.push({ method, params: body, connection });
        if (method === "connect") {
          if (body["token"] !== this.token) throw new RpcError(-32001, "Invalid connection token");
          authenticated = true;
          return { ok: true, protocolVersion: 3, version: "1.0.103", taskKinds: ["agent", "shell", "client"] };
        }
        if (!authenticated) throw new RpcError(-32001, "Not connected");
        const matches = (candidate: { method: string; sessionId: string | undefined }) => candidate.method === method && (candidate.sessionId === undefined || candidate.sessionId === body["sessionId"]);
        const failAt = this.#failures.findIndex(matches);
        const failure = failAt >= 0 ? this.#failures.splice(failAt, 1)[0] : undefined;
        const run = () => (failure ? Promise.reject(new RpcError(-32603, failure.message)) : this.#handle(endpoint, method, body, context.signal));
        const hold = this.#holds.findIndex(matches);
        if (hold >= 0) {
          const [entry] = this.#holds.splice(hold, 1);
          const settled = await run().then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          entry!.arrived();
          await entry!.gate;
          if (!settled.ok) throw settled.error;
          return settled.value;
        }
        return run();
      },
    });
    this.#byConnection.set(connection, endpoint);
    this.#endpoints.add(endpoint);
    endpoint.transport.onClose(() => this.#endpoints.delete(endpoint));
  }

  #emit(endpoint: RpcEndpoint, session: FakeSession, type: string, data: Record<string, unknown>): string {
    const event = { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data };
    session.events.push(event);
    // Events follow the session to the connection that opened it last (a turn continues where it was resumed).
    (session.endpoint ?? endpoint).notify("session.event", { sessionId: session.id, event });
    return event.id;
  }

  async #handle(endpoint: RpcEndpoint, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const sessionId = params["sessionId"] as string | undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    switch (method) {
      case "models.list":
        return { models: [{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5" }, { id: "gpt-5.4", name: "GPT-5.4" }] };
      case "session.create": {
        const id = sessionId ?? randomUUID();
        const created: FakeSession = { id, createParams: params, endpoint, events: [] };
        this.sessions.set(id, created);
        if (typeof params["gitHubTokenProviderRegistrationId"] === "string") {
          const answer = (await endpoint.request("gitHubToken.getToken", { registrationId: params["gitHubTokenProviderRegistrationId"], host: "https://github.com", sessionId: id, reason: "initial" })) as { kind: string; accessToken?: string };
          if (answer.kind !== "token") {
            this.sessions.delete(id);
            throw new RpcError(-32603, "Session authentication was cancelled");
          }
          created.token = answer.accessToken;
        }
        // Like the stock runtime: custom agents resolve only for a session that is authenticated at construction.
        if (typeof params["agent"] === "string") {
          if (!created.token) {
            this.sessions.delete(id);
            throw new RpcError(-32603, `session construction failed: Custom agent '${params["agent"]}' not found`);
          }
          created.agent = params["agent"];
        }
        this.#emit(endpoint, created, "session.start", { sessionId: id, context: { cwd: "/platform/host/path" } });
        if (typeof params["workingDirectory"] === "string") this.#emit(endpoint, created, "session.info", { infoType: "cwd", message: `Working in ${params["workingDirectory"]}` });
        const lifecycle = () => endpoint.notify("session.lifecycle", { type: "session.created", sessionId: id, metadata: { startTime: new Date().toISOString(), modifiedTime: new Date().toISOString() } });
        if (this.lifecycleAfterAnswer) setTimeout(lifecycle, 50);
        else lifecycle();
        return { sessionId: id, workspacePath: "/platform/host/session-state", capabilities: { ui: { elicitation: false } } };
      }
      case "session.resume": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        session.createParams = { ...session.createParams, ...params };
        session.endpoint = endpoint;
        if (typeof params["agent"] === "string") {
          if (!session.token) throw new RpcError(-32603, `Custom agent '${params["agent"]}' not found`);
          session.agent = params["agent"];
        }
        return { sessionId, workspacePath: "/platform/host/session-state", capabilities: {} };
      }
      case "session.suspend": {
        // Like the stock runtime: the in-flight request answers aborted, pending tool calls stay pending, and the
        // session emits its handoff artifacts.
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        session.suspend?.();
        this.#emit(endpoint, session, "agent.interrupted", {});
        this.#emit(endpoint, session, "session.idle", { aborted: true });
        this.#emit(endpoint, session, "session.shutdown", {});
        return { success: true };
      }
      case "sessions.close":
        return { success: true };
      case "session.gitHubAuth.setCredentials": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        session.token = (params["credentials"] as { token?: string } | undefined)?.token;
        return { success: true };
      }
      case "session.agent.select": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        if (!session.token) throw new RpcError(-32603, `Custom agent '${String(params["name"])}' not found`);
        session.agent = String(params["name"]);
        return { agent: this.#agentInfo(session) };
      }
      case "session.agent.deselect":
        if (session) delete session.agent;
        return {};
      case "session.agent.getCurrent":
        return { agent: session?.agent ? this.#agentInfo(session) : null };
      case "session.options.update":
      case "session.tools.set":
      case "session.model.switchTo":
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        return { success: true };
      case "session.send": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        const messageId = randomUUID();
        void this.#turn(endpoint, session, String(params["prompt"] ?? ""), messageId);
        return { messageId };
      }
      case "session.sendAndWait": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        if (params["prompt"] !== "slow") {
          const messageId = randomUUID();
          const lastResponse = () => [...session.events].reverse().find((event) => event.type === "assistant.message");
          const finished = this.#turn(endpoint, session, String(params["prompt"] ?? ""), messageId).then((completionEventId) => ({ messageId, completionEventId, response: lastResponse() }));
          const suspended = new Promise<Record<string, unknown>>((resolve) => {
            session.suspend = () => resolve({ messageId, aborted: true, completionEventId: randomUUID(), response: lastResponse() });
          });
          try {
            return await Promise.race([finished, suspended]);
          } finally {
            session.suspend = undefined;
          }
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new RpcError(-32800, "Request cancelled"));
          });
        });
        return { completionEventId: randomUUID() };
      }
      case "session.tools.handlePendingToolCall": {
        const pending = this.#pendingTools.get(String(params["requestId"]));
        if (!pending) return { success: false, error: "No pending tool call" };
        this.#pendingTools.delete(String(params["requestId"]));
        pending.resolve(params);
        return { success: true };
      }
      case "session.tools.listPendingRequests":
        return {
          items: [...this.#pendingTools.entries()]
            .filter(([, pending]) => pending.sessionId === sessionId)
            .map(([requestId, pending]) => ({ requestId, toolName: pending.toolName, toolCallId: pending.toolCallId, arguments: pending.arguments })),
        };
      case "session.permissions.pendingRequests":
        return { items: [] };
      case "session.metadata.isProcessing":
        return { processing: this.#processing.has(String(sessionId)) || [...this.#pendingTools.values()].some((pending) => pending.sessionId === sessionId) };
      case "session.permissions.handlePendingPermissionRequest":
        return { success: true };
      case "session.getMessages":
        return { events: session?.events ?? [] };
      case "session.eventLog.read":
        return { events: session?.events ?? [], cursor: `cursor-${session?.events.length ?? 0}` };
      case "session.detach":
        return { success: true };
      case "session.delete":
        this.sessions.delete(String(sessionId));
        return { success: true };
      case "session.abort":
        return {};
      case "ping":
        return { message: params["message"] ?? "pong", timestamp: Date.now(), protocolVersion: 3 };
      case "runtime.shutdown":
        return {};
      default:
        throw new RpcError(-32601, `Unhandled method ${method}`);
    }
  }

  #agentInfo(session: FakeSession): Record<string, unknown> {
    const directory = (session.createParams["agentDirectories"] as string[] | undefined)?.[0] ?? "/agents";
    return { name: session.agent, id: session.agent, path: `${directory}/${session.agent}.agent.md`, source: "user" };
  }

  async #turn(endpoint: RpcEndpoint, session: FakeSession, prompt: string, messageId: string): Promise<string> {
    this.#emit(endpoint, session, "user.message", { content: prompt, messageId });
    this.#processing.add(session.id);
    // `stall` stays mid-inference until the runtime "crashes" (`dropConnections`), which loses the turn.
    if (prompt === "stall") {
      this.#emit(endpoint, session, "assistant.turn_start", { turnId: "0" });
      return new Promise<string>(() => undefined);
    }
    // `tool:<name>` calls a tool, optionally with JSON arguments: `tool:web_fetch {"url":"https://example.com"}`.
    const call = /tool:([a-z_]+)(?:\s+(\{[\s\S]*\}))?/.exec(prompt);
    const tool = call?.[1];
    let content = `echo: ${prompt}`;
    if (tool) {
      const requestId = randomUUID();
      const toolCallId = `call_${requestId}`;
      const args: unknown = call?.[2] ? JSON.parse(call[2]) : { id: "1234" };
      const answered = new Promise<Record<string, unknown>>((resolve) => this.#pendingTools.set(requestId, { sessionId: session.id, toolName: tool, toolCallId, arguments: args, resolve }));
      this.#emit(endpoint, session, "external_tool.requested", { requestId, sessionId: session.id, toolCallId, toolName: tool, arguments: args, workingDirectory: "/platform/host/path" });
      const answer = await answered;
      this.#emit(endpoint, session, "external_tool.completed", { requestId });
      const result = answer["result"] as { textResultForLlm?: unknown } | string | undefined;
      content = `tool said: ${typeof result === "string" ? result : typeof result?.textResultForLlm === "string" ? result.textResultForLlm : JSON.stringify(result ?? answer["error"])}`;
    }
    this.#emit(endpoint, session, "assistant.message_delta", { messageId: "m1", deltaContent: content.slice(0, 5) });
    this.#emit(endpoint, session, "assistant.message", { messageId: "m1", content, originatingMessageId: messageId });
    this.#processing.delete(session.id);
    return this.#emit(endpoint, session, "session.idle", {});
  }
}

type Send = (method: string, params?: unknown) => Promise<unknown>;

/**
 * Core's `sandboxes` port backed by the fake runtime: every "sandbox" is its own connection to it. Like the real
 * sandbox module, the runtime receives no GitHub credential until `sessionOpened` installs one, and a requested
 * agent is deferred out of create/resume params and selected after that.
 */
export class FakeSandboxes {
  readonly log: { op: string; sessionId: string; detail?: Record<string, unknown> }[] = [];
  readonly streams = new Map<string, Socket>();
  /** Runtime → gateway requests this "sandbox module" answers itself (like brokered inference). */
  readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  /** The backend's readiness, as the real service reports it. */
  available = true;
  failCreate: Error | undefined;
  /** Fails the next `prepareSessionParams` (test hook). */
  failNextPrepare: Error | undefined;
  /** Errors the next `initialize` calls throw, in order (test hook; e.g. a runtime restart asking to reopen). */
  readonly initializeFailures: Error[] = [];
  readonly #openHolds: { gate: Promise<void>; arrived: () => void }[] = [];

  constructor(private readonly runtime: FakeRuntime) {}

  /** Holds the next `openRuntime` until `release()` (test hook). */
  holdNextOpen(): { readonly held: Promise<void>; release(): void } {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    this.#openHolds.push({ gate, arrived });
    return { held, release };
  }

  ops(sessionId: string): string[] {
    return this.log.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.op);
  }

  detail(sessionId: string, op: string): Record<string, unknown> {
    return this.log.filter((entry) => entry.sessionId === sessionId && entry.op === op).at(-1)?.detail ?? {};
  }

  async create(request: { sessionId: string; ownerId: number; environment: string; size: string }): Promise<unknown> {
    this.log.push({ op: "create", sessionId: request.sessionId, detail: { ...request } });
    if (this.failCreate) throw this.failCreate;
    return { sandboxId: `sbx-${request.sessionId}` };
  }

  async ensureRunning(sessionId: string): Promise<unknown> {
    this.log.push({ op: "ensureRunning", sessionId });
    return { sandboxId: `sbx-${sessionId}` };
  }

  async openRuntime(sessionId: string, options: { resolveToken(): Promise<string> }) {
    this.log.push({ op: "openRuntime", sessionId });
    const hold = this.#openHolds.shift();
    if (hold) {
      hold.arrived();
      await hold.gate;
    }
    const socket = connectTcp(this.runtime.port, "127.0.0.1");
    await once(socket, "connect");
    this.streams.set(sessionId, socket);
    let send: Send | undefined;
    const deferred = new Map<string, string>();
    return {
      stream: socket,
      connectionToken: this.runtime.token,
      handlers: this.handlers,
      initialize: async (upstream: Send) => {
        send = upstream;
        this.log.push({ op: "initialize", sessionId });
        const failure = this.initializeFailures.shift();
        if (failure) throw failure;
      },
      prepareSessionParams: async (method: string, params: Record<string, unknown>) => {
        this.log.push({ op: `prepare ${method}`, sessionId, detail: params });
        const failure = this.failNextPrepare;
        this.failNextPrepare = undefined;
        if (failure) throw failure;
        const { gitHubToken: _token, gitHubTokenProviderRegistrationId: _registration, agent, ...rest } = params;
        if (typeof agent === "string") deferred.set(sessionId, agent);
        return rest;
      },
      sessionOpened: async (id: string) => {
        this.log.push({ op: "sessionOpened", sessionId: id });
        await options.resolveToken();
        await send!("session.gitHubAuth.setCredentials", { sessionId: id, credentials: { type: "token", host: "https://github.com", token: "mcrt_placeholder" } });
        const agent = deferred.get(id);
        deferred.delete(id);
        if (agent) await send!("session.agent.select", { sessionId: id, name: agent });
      },
      close: () => socket.destroy(),
    };
  }

  async delete(sessionId: string): Promise<void> {
    this.log.push({ op: "delete", sessionId });
  }

  get(): undefined {
    return undefined;
  }
}

export interface StubUser {
  readonly id: number;
  readonly login: string;
  readonly orgs?: readonly string[];
}

/** A GitHub REST stub: `/user` and org membership for known tokens. */
export async function startGitHubStub(users: Record<string, StubUser>): Promise<{ url: string; calls: number; close(): Promise<void> }> {
  const state = { calls: 0 };
  const server: HttpServer = createHttpServer((req, res) => {
    state.calls++;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const user = token ? users[token] : undefined;
    if (!user) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    if (req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: user.id, login: user.login, name: `${user.login} name` }));
      return;
    }
    const membership = /^\/orgs\/([^/]+)\/members\/([^/]+)$/.exec(req.url ?? "");
    if (membership) {
      res.writeHead(membership[2] === user.login && user.orgs?.includes(membership[1]!) ? 204 : 404);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface TestGateway {
  readonly gateway: RunningGateway;
  readonly url: string;
  readonly dataDir: string;
  close(options?: { keepData?: boolean }): Promise<void>;
}

export const TEST_DEPLOYMENT = {
  name: "copilot",
  environments: {
    chat: { type: "shared", models: ["claude-haiku-4.5"], description: "Chat" },
    open: { type: "shared" },
    coder: { type: "isolated", size: "small" },
  },
  inline: { types: ["shared", "isolated"], sizes: ["small"] },
};

export async function startTestGateway(options: { runtime: FakeRuntime; githubUrl: string; dataDir?: string; deployment?: unknown; env?: Record<string, string> }): Promise<TestGateway> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "mc-core-test-"));
  const gateway = await startGateway(
    loadConfig({
      PORT: "0",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "error",
      MANAGED_COPILOT_DATA_DIR: dataDir,
      MANAGED_COPILOT_WRITE_DISCOVERY: "0",
      MANAGED_COPILOT_GITHUB_API_URL: options.githubUrl,
      MANAGED_COPILOT_RUNTIME_URL: `tcp://127.0.0.1:${options.runtime.port}`,
      MANAGED_COPILOT_RUNTIME_TOKEN: options.runtime.token,
      MANAGED_COPILOT_CONFIG: JSON.stringify(options.deployment ?? TEST_DEPLOYMENT),
      // Hermetic by default: isolated placement fails fast (no Docker builds) and no egress container starts.
      DOCKER_HOST: "tcp://127.0.0.1:1",
      MANAGED_COPILOT_EGRESS: "off",
      ...options.env,
    }),
  );
  return {
    gateway,
    url: gateway.url,
    dataDir,
    close: async (closeOptions = {}) => {
      await gateway.close();
      if (!closeOptions.keepData) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** A raw bridge-protocol client (what bridge.js does, without the SDK), for router tests. */
export class RawClient {
  readonly notifications: { method: string; params: Record<string, unknown> }[] = [];
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  endpoint!: RpcEndpoint;
  ws!: WebSocket;
  welcome!: { connectionId: string; environment: string };
  closeInfo: { code: number; reason: string } | undefined;
  #waiters: { match: (method: string, params: Record<string, unknown>) => boolean; resolve: (params: Record<string, unknown>) => void }[] = [];
  answer: (method: string, params: Record<string, unknown>) => unknown = () => {
    throw new RpcError(-32601, "not handled");
  };

  static async connect(url: string, token: string, environment: EnvironmentRequest | string): Promise<RawClient> {
    const client = new RawClient();
    const target = new URL("/v1/connect", url);
    target.protocol = "ws:";
    client.ws = new WebSocket(target, [BRIDGE_SUBPROTOCOL], { headers: { authorization: `Bearer ${token}` } });
    client.ws.on("close", (code, reason) => {
      client.closeInfo = { code, reason: reason.toString() };
    });
    await new Promise<void>((resolve, reject) => {
      client.ws.once("open", () => resolve());
      client.ws.once("error", reject);
      client.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    client.ws.send(JSON.stringify({ type: BRIDGE_HELLO, version: 1, environment: typeof environment === "string" ? { name: environment } : environment }));
    client.welcome = await new Promise((resolve, reject) => {
      client.ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      client.ws.once("close", (code, reason) => reject(Object.assign(new Error(`closed ${code} ${reason.toString()}`), { code, reason: reason.toString() })));
    });
    client.endpoint = new RpcEndpoint(webSocketTransport(client.ws), {
      name: "raw client",
      onNotification: (method, params) => {
        const body = (params ?? {}) as Record<string, unknown>;
        client.notifications.push({ method, params: body });
        client.#waiters = client.#waiters.filter((waiter) => {
          if (!waiter.match(method, body)) return true;
          waiter.resolve(body);
          return false;
        });
      },
      onRequest: (method, params) => {
        const body = (params ?? {}) as Record<string, unknown>;
        client.requests.push({ method, params: body });
        return client.answer(method, body);
      },
    });
    return client;
  }

  request<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    return this.endpoint.request<T>(method, params);
  }

  events(type?: string): Record<string, unknown>[] {
    return this.notifications
      .filter((notification) => notification.method === "session.event")
      .map((notification) => notification.params["event"] as Record<string, unknown>)
      .filter((event) => !type || event["type"] === type);
  }

  waitForEvent(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = this.events(type)[0];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      this.#waiters.push({
        match: (method, params) => method === "session.event" && (params["event"] as { type?: string } | undefined)?.type === type,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params["event"] as Record<string, unknown>);
        },
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close(1000);
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
