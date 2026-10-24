// Test harness: a fake runtime that speaks the stock runtime's JSON-RPC over TCP (LSP framing), a GitHub API stub,
// a gateway wired to both, and a raw bridge-protocol client. Used by router/integration tests; never by demos.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
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
}

interface FakeSession {
  readonly id: string;
  createParams: Record<string, unknown>;
  token?: string;
  agent?: string;
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
  #server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const endpoint of this.#endpoints) endpoint.close();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  /** Drops every connection, as if the runtime crashed. */
  dropConnections(): void {
    for (const endpoint of this.#endpoints) endpoint.close();
  }

  calls(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  #accept(socket: Socket): void {
    let authenticated = false;
    const endpoint: RpcEndpoint = new RpcEndpoint(streamTransport(socket), {
      name: "fake runtime",
      onNotification: (method, params) => this.notifications.push({ method, params: (params ?? {}) as Record<string, unknown> }),
      onRequest: async (method, params, context) => {
        const body = (params ?? {}) as Record<string, unknown>;
        this.requests.push({ method, params: body });
        if (method === "connect") {
          if (body["token"] !== this.token) throw new RpcError(-32001, "Invalid connection token");
          authenticated = true;
          return { ok: true, protocolVersion: 3, version: "1.0.103", taskKinds: ["agent", "shell", "client"] };
        }
        if (!authenticated) throw new RpcError(-32001, "Not connected");
        return this.#handle(endpoint, method, body, context.signal);
      },
    });
    this.#endpoints.add(endpoint);
    endpoint.transport.onClose(() => this.#endpoints.delete(endpoint));
  }

  #emit(endpoint: RpcEndpoint, session: FakeSession, type: string, data: Record<string, unknown>): string {
    const event = { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data };
    session.events.push(event);
    endpoint.notify("session.event", { sessionId: session.id, event });
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
        const created: FakeSession = { id, createParams: params, events: [] };
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
        endpoint.notify("session.lifecycle", { type: "session.created", sessionId: id, metadata: { startTime: new Date().toISOString(), modifiedTime: new Date().toISOString() } });
        return { sessionId: id, workspacePath: "/platform/host/session-state", capabilities: { ui: { elicitation: false } } };
      }
      case "session.resume": {
        if (!session) throw new RpcError(-32603, `Session not found: ${sessionId}`);
        session.createParams = { ...session.createParams, ...params };
        if (typeof params["agent"] === "string") {
          if (!session.token) throw new RpcError(-32603, `Custom agent '${params["agent"]}' not found`);
          session.agent = params["agent"];
        }
        return { sessionId, workspacePath: "/platform/host/session-state", capabilities: {} };
      }
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
          const completionEventId = await this.#turn(endpoint, session, String(params["prompt"] ?? ""), randomUUID());
          const response = [...session.events].reverse().find((event) => event.type === "assistant.message");
          return { completionEventId, response };
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
      case "session.permissions.handlePendingPermissionRequest":
        return { success: true };
      case "session.getMessages":
        return { events: session?.events ?? [] };
      case "session.detach":
        return { success: true };
      case "session.delete":
        this.sessions.delete(String(sessionId));
        return { success: true };
      case "session.abort":
        return {};
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
    return this.#emit(endpoint, session, "session.idle", {});
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
