import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedCopilotError, type AttachMaterial, type SessionInfo } from "@managed-copilot/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GatewayApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { attachModule, type AttachSessions, type SessionLifecycleEvent, type SessionRuntime } from "../src/modules/attach/index.js";
import { CREDENTIAL_REFUSAL, filterAhpClientFrame as filterClientFrame } from "@managed-copilot/protocol";
import { AttachTickets } from "../src/modules/attach/tickets.js";
import { AhpHosts } from "../src/modules/attach/hosts.js";

const OWNER = 42;
const LISTENER_TOKEN = "listener-secret-token";

/** Stands in for the runtime's AHP listener: token-protected, answers initialize/listSessions, records traffic. */
class FakeListener {
  readonly received: unknown[] = [];
  readonly upgrades: { url: string; headers: Record<string, unknown> }[] = [];
  readonly sockets = new Set<WebSocket>();
  #server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.#server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    this.#server.on("upgrade", (req, socket, head) => {
      this.upgrades.push({ url: req.url ?? "", headers: { ...req.headers } });
      if (new URL(req.url ?? "/", "http://x").searchParams.get("tkn") !== LISTENER_TOKEN) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on("close", () => this.sockets.delete(ws));
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { id?: number; method?: string };
          this.received.push(message);
          if (message.method === "initialize") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "0.9.0" } }));
          if (message.method === "listSessions") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { items: [{ resource: "ahp-session:/s1" }] } }));
        });
      });
    });
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

class FakeRuntime implements SessionRuntime {
  readonly requests: { method: string; params: any }[] = [];
  readonly closed: Promise<void>;
  close!: () => void;
  constructor(readonly connectionId: string, readonly listener: FakeListener) {
    this.closed = new Promise((resolve) => (this.close = resolve));
  }
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params });
    if (method === "host.start") return { hostId: params.hostId, url: `ws://127.0.0.1:${this.listener.port}/`, token: LISTENER_TOKEN } as T;
    if (method === "host.publishSession") return { sessionId: params.sessionId, sessionUri: `ahp-session:/${params.sessionId}` } as T;
    return {} as T;
  }
  async connect(port: number) {
    const socket = netConnect(port, "127.0.0.1");
    await once(socket, "connect");
    return socket;
  }
  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }
}

class FakeSessions implements AttachSessions {
  runtimeFor: FakeRuntime;
  states = new Map<string, SessionInfo["state"]>([["s1", "idle"], ["s2", "idle"]]);
  listener: ((event: SessionLifecycleEvent) => void) | undefined;
  constructor(runtime: FakeRuntime) {
    this.runtimeFor = runtime;
  }
  async info(accountId: number, sessionId: string): Promise<SessionInfo> {
    const state = this.states.get(sessionId);
    if (accountId !== OWNER || !state) throw new ManagedCopilotError("not_found", "No such session");
    return { id: sessionId, state } as SessionInfo;
  }
  async runtime(): Promise<SessionRuntime> {
    return this.runtimeFor;
  }
  onLifecycle(listener: (event: SessionLifecycleEvent) => void) {
    this.listener = listener;
    return () => (this.listener = undefined);
  }
}

describe("attach module", () => {
  let dataDir: string;
  let listener: FakeListener;
  let runtime: FakeRuntime;
  let sessions: FakeSessions;
  let app: GatewayApp;
  let server: Server;
  let base: string;
  const clients: WebSocket[] = [];

  async function startApp(env: Record<string, string> = {}) {
    const config = loadConfig({ PORT: "0", MANAGED_COPILOT_DATA_DIR: dataDir, MANAGED_COPILOT_WRITE_DISCOVERY: "0", MANAGED_COPILOT_ATTACH_IDLE_MS: "60000", ...env });
    app = new GatewayApp(config, openDatabase(":memory:"), createLogger("test", "error"));
    app.provide("auth", {
      authenticate: async (token) => {
        if (token === "user-42") return { accountId: OWNER, login: "octo", token };
        if (token === "user-7") return { accountId: 7, login: "other", token };
        throw new ManagedCopilotError("authentication_required", "bad token");
      },
    });
    (app.services as Record<string, unknown>).sessions = sessions;
    attachModule.register(app);
    server = createServer((req, res) => void app.routes.handle(app, req, res));
    server.on("upgrade", (req, socket, head) => void app.upgrades.handle(app, req, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await app.start();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function stopApp() {
    for (const client of clients.splice(0)) client.terminate();
    await app.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.db.close();
  }

  async function attach(sessionId = "s1", token = "user-42"): Promise<Response> {
    return fetch(`${base}/v1/sessions/${sessionId}/attach`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  }

  async function material(sessionId = "s1"): Promise<AttachMaterial> {
    const response = await attach(sessionId);
    expect(response.status).toBe(200);
    return (await response.json()) as AttachMaterial;
  }

  /** Opens the attach socket like the CLI relay (ticket as bearer) or a generic AHP client (`?tkn=`). */
  function open(sessionId: string, ticket: string, mode: "bearer" | "query" = "bearer"): Promise<WebSocket> {
    const url = `${base.replace("http", "ws")}/v1/sessions/${sessionId}/ahp${mode === "query" ? `?tkn=${encodeURIComponent(ticket)}` : ""}`;
    // The stock CLI also sends its own GitHub token; it must be ignored and never forwarded.
    const headers = mode === "bearer" ? { authorization: `Bearer ${ticket}` } : { authorization: "Bearer gho_clitokenclitokenclitokenclitoken" };
    const ws = new WebSocket(url, { headers });
    clients.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once("error", reject);
    });
  }

  function next(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mc-attach-"));
    listener = new FakeListener();
    await listener.start();
  });

  afterAll(async () => {
    await listener.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await stopApp();
  });

  async function fresh(env?: Record<string, string>) {
    runtime = new FakeRuntime("conn-1", listener);
    sessions = new FakeSessions(runtime);
    await startApp(env);
  }

  it("returns short-lived attach material and publishes only that session", async () => {
    await fresh();
    const before = Date.now();
    const body = await material("s1");
    expect(body.transport).toBe("ahp");
    expect(body.url).toMatch(/^ws:\/\/localhost:\d+\/v1\/sessions\/s1\/ahp$/);
    expect(body.token).toMatch(/^mcat_[A-Za-z0-9_-]{40,}$/);
    expect(body.ahpSessionId).toBe("ahp-session:/s1");
    const expires = Date.parse(body.expiresAt);
    expect(expires).toBeGreaterThan(before + 50_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(JSON.stringify(body)).not.toContain(LISTENER_TOKEN);

    const start = runtime.requests.find((request) => request.method === "host.start")!;
    expect(start.params).toMatchObject({
      authentication: { mode: "none" },
      computeId: "mc-session-s1",
      localServer: { hostname: "127.0.0.1", port: 0 },
      allowCreatingNewSessions: false,
    });
    expect(runtime.requests.find((request) => request.method === "host.publishSession")?.params).toEqual({ hostId: start.params.hostId, sessionId: "s1" });
  });

  it("does not reveal or attach sessions the caller does not own", async () => {
    await fresh();
    const response = await attach("s1", "user-7");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await attach("s1", "nope")).status).toBe(401);
    expect(runtime.count("host.start")).toBe(0);
  });

  it("relays AHP to the session listener with the listener token, never the client's credentials", async () => {
    await fresh();
    const { token } = await material();
    const ws = await open("s1", token);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersions: ["0.9.0"] } }));
    expect(await next(ws)).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "0.9.0" } });

    const upgrade = listener.upgrades.at(-1)!;
    expect(new URL(upgrade.url, "http://x").searchParams.get("tkn")).toBe(LISTENER_TOKEN);
    expect(upgrade.headers.authorization).toBeUndefined();
    expect(JSON.stringify(upgrade)).not.toContain(token);
  });

  it("answers credential-bearing AHP requests itself instead of forwarding them", async () => {
    await fresh();
    const ws = await open("s1", (await material()).token, "query");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "authenticate", params: { resource: "https://api.github.com", token: "gho_clitokenclitokenclitokenclitoken" } }));
    expect(await next(ws)).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: CREDENTIAL_REFUSAL } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "listSessions", params: {} }));
    expect((await next(ws)).result.items).toEqual([{ resource: "ahp-session:/s1" }]);
    expect(JSON.stringify(listener.received)).not.toContain("gho_");
    expect(listener.received.some((message: any) => message.method === "authenticate")).toBe(false);
  });

  it("accepts each ticket once, only for its session, and only before it expires", async () => {
    await fresh();
    const { token } = await material("s1");
    await expect(open("s2", token)).rejects.toMatchObject({ status: 401 });
    // A ticket presented for the wrong session is not consumed by that attempt.
    await open("s1", token);
    await expect(open("s1", token)).rejects.toMatchObject({ status: 401 });
    await expect(open("s1", "mcat_forgedforgedforgedforgedforgedforgedforged")).rejects.toMatchObject({ status: 401 });
    await stopApp();

    await fresh({ MANAGED_COPILOT_ATTACH_TICKET_TTL_MS: "1" });
    const expired = await material("s1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(open("s1", expired.token)).rejects.toMatchObject({ status: 401 });
  });

  it("reuses the host on the same runtime connection and replaces it on a new one", async () => {
    await fresh();
    await material("s1");
    await material("s1");
    expect(runtime.count("host.start")).toBe(1);

    const replacement = new FakeRuntime("conn-2", listener);
    sessions.runtimeFor = replacement;
    await material("s1");
    expect(runtime.count("host.dispose")).toBe(1);
    expect(replacement.count("host.start")).toBe(1);
  });

  it("refuses a malformed Sec-WebSocket-Protocol header without spending the ticket", async () => {
    await fresh();
    const { token } = await material("s1");
    const { hostname, port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: hostname,
        port,
        path: "/v1/sessions/s1/ahp",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          "sec-websocket-protocol": "ahp, ahp",
          authorization: ["Bearer", token].join(" "),
        },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => reject(new Error("The gateway accepted a malformed header")));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(runtime.count("host.start")).toBe(1);
    await open("s1", token);
  });

  it("tells attached clients the session moved when it is promoted, then hosts it on the new runtime", async () => {
    await fresh();
    const ws = await open("s1", (await material("s1")).token);
    const closed = once(ws, "close");
    const sandbox = new FakeRuntime("sandbox:s1#1", listener);
    sessions.runtimeFor = sandbox;
    sessions.listener?.({ sessionId: "s1", type: "promoted" });
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4307);
    expect(reason.toString()).toBe("The session moved into a sandbox. Reconnecting.");
    expect(runtime.count("host.dispose")).toBe(1);
    const again = await open("s1", (await material("s1")).token);
    expect(sandbox.count("host.start")).toBe(1);
    expect(sandbox.requests.find((request) => request.method === "host.publishSession")?.params.sessionId).toBe("s1");
    again.close();
  });

  it("closes attached clients when the session is deleted or its runtime connection closes", async () => {
    await fresh();
    const ws = await open("s1", (await material("s1")).token);
    const closed = once(ws, "close");
    sessions.listener?.({ sessionId: "s1", type: "deleted" });
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4410);
    expect(reason.toString()).toBe("The session was deleted.");
    expect(runtime.count("host.dispose")).toBe(1);

    sessions.states.set("s1", "deleted");
    const response = await attach("s1");
    expect(response.status).toBe(409);
    sessions.states.set("s1", "idle");

    const again = await open("s1", (await material("s1")).token);
    const closedAgain = once(again, "close");
    runtime.close();
    expect(((await closedAgain) as [number])[0]).toBe(4410);
  });
});

describe("AhpHosts", () => {
  it("runs a session's starts and releases in order, so a release never interleaves with a start", async () => {
    const listener = new FakeListener();
    listener.port = 1;
    class SlowRuntime extends FakeRuntime {
      override async request<T>(method: string, params: any): Promise<T> {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return super.request<T>(method, params);
      }
    }
    const slow = new SlowRuntime("conn-1", listener);
    const hosts = new AhpHosts(createLogger("test", "error"), 60_000);
    const [first, , second] = await Promise.all([hosts.ensure("s1", slow), hosts.release("s1", "The session was deleted."), hosts.ensure("s1", slow)]);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(second).not.toBe(first);
    expect(slow.requests.map((request) => request.method)).toEqual(["host.start", "host.publishSession", "host.dispose", "host.start", "host.publishSession"]);
    await hosts.disposeAll("done");
    expect(second.closed).toBe(true);
  });

  it("disposes a host whose attach ticket is never redeemed once it has been idle", async () => {
    const listener = new FakeListener();
    listener.port = 1;
    const quiet = new FakeRuntime("conn-1", listener);
    const hosts = new AhpHosts(createLogger("test", "error"), 15);
    const host = await hosts.ensure("s1", quiet);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(host.closed).toBe(true);
    expect(quiet.count("host.dispose")).toBe(1);
  });
});

describe("attach tickets", () => {
  it("redeems a ticket once, for its own session, before expiry", () => {
    let now = 1_000_000;
    const db = openDatabase(":memory:");
    const tickets = new AttachTickets(db, () => now);
    const { token } = tickets.mint(OWNER, "s1", 60_000);
    expect(tickets.redeem(token, "s2")).toBeUndefined();
    expect(tickets.redeem(token, "s1")).toMatchObject({ sessionId: "s1", accountId: OWNER });
    expect(tickets.redeem(token, "s1")).toBeUndefined();
    const late = tickets.mint(OWNER, "s1", 60_000);
    now += 60_001;
    expect(tickets.redeem(late.token, "s1")).toBeUndefined();
    expect(tickets.redeem("gho_notaticket", "s1")).toBeUndefined();
    const stored = db.prepare("SELECT token_hash FROM attach_tickets").all() as { token_hash: string }[];
    expect(JSON.stringify(stored)).not.toContain(token);
    db.close();
  });
});

describe("filterClientFrame", () => {
  it("keeps ordinary AHP traffic byte for byte", () => {
    const frame = '{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{"channel":"ahp-session:/s1"}}';
    expect(filterClientFrame(frame)).toEqual({ forward: frame, replies: [], refused: [] });
  });

  it("refuses authenticate requests and credential actions, including inside batches", () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "authenticate", params: { token: "x" } },
      { jsonrpc: "2.0", id: 2, method: "listSessions" },
      { jsonrpc: "2.0", method: "dispatchAction", params: { action: { type: "session/mcpAuthTokenSet", token: "y" } } },
    ]);
    const result = filterClientFrame(batch);
    expect(JSON.parse(result.forward!)).toEqual([{ jsonrpc: "2.0", id: 2, method: "listSessions" }]);
    expect(JSON.parse(result.replies[0]!)).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: CREDENTIAL_REFUSAL } }]);
    expect(result.refused).toEqual(["authenticate", "dispatchAction"]);
  });

  it("flags frames that are not JSON", () => {
    expect(filterClientFrame("not json")).toEqual({ replies: [], refused: [], invalid: true });
  });
});
