import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ManagedCopilotError, type AttachMaterial, type PendingAction, type SessionInfo } from "@managed-copilot/protocol";
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
import { LISTENER_LOSS_GRACE_MS } from "../src/modules/attach/proxy.js";
import type { AttachActions, CliAttachment, CliAttachOptions, CliOperation, PromptVisibility, PromptVisibilityInput } from "../src/modules/attach/types.js";
import type { PromotionParticipant } from "../src/modules/promotion/contract.js";

const OWNER = 42;
const LISTENER_TOKEN = "listener-secret-token";
const CHAT = "ahp-chat:/c1";
const PERMISSION_METHOD = "session.permissions.handlePendingPermissionRequest";

/** Stands in for the runtime's AHP listener: token-protected, answers reads, records traffic, and can push frames. */
class FakeListener {
  readonly received: any[] = [];
  readonly upgrades: { url: string; headers: Record<string, unknown> }[] = [];
  readonly sockets = new Set<WebSocket>();
  /** Results by method, for requests the test wants answered differently. */
  readonly results = new Map<string, unknown>();
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
          if (message.id === undefined || !message.method) return;
          const result = this.results.has(message.method)
            ? this.results.get(message.method)
            : message.method === "initialize"
              ? { protocolVersion: "0.9.0" }
              : message.method === "listSessions"
                ? { items: [{ resource: "ahp-session:/s1" }] }
                : {};
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
      });
    });
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.port = (this.#server.address() as AddressInfo).port;
  }

  /** Sends a frame from the runtime to every attached relay. */
  push(message: unknown): void {
    for (const socket of this.sockets) socket.send(JSON.stringify(message));
  }

  dispatched(type: string): any[] {
    return this.received.filter((message) => message.method === "dispatchAction" && message.params?.action?.type === type);
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
  /** When set, `host.start` waits here. */
  startGate: Promise<void> | undefined;
  disposeError: Error | undefined;
  constructor(readonly connectionId: string, readonly listener: FakeListener) {
    this.closed = new Promise((resolve) => (this.close = resolve));
  }
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params });
    if (method === "host.start") {
      if (this.startGate) await this.startGate;
      return { hostId: params.hostId, url: `ws://127.0.0.1:${this.listener.port}/`, token: LISTENER_TOKEN } as T;
    }
    if (method === "host.publishSession") return { sessionId: params.sessionId, sessionUri: `ahp-session:/${params.sessionId}` } as T;
    if (method === "host.dispose" && this.disposeError) throw this.disposeError;
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

/** Core's handle for one attached CLI: records admitted writes and ledger answers. */
class FakeAttachment implements CliAttachment {
  readonly writes: CliOperation[] = [];
  readonly answers: { method: string; params: Record<string, unknown> }[] = [];
  closed = false;
  writeError: ManagedCopilotError | undefined;
  answerError: ManagedCopilotError | undefined;
  constructor(
    readonly connectionId: string,
    readonly incarnation: string,
    readonly generation: number,
  ) {}
  write(operation: CliOperation, send: () => void): void {
    if (this.closed) throw new ManagedCopilotError("conflict", "This Copilot CLI attachment was closed. Attach again.");
    if (this.writeError) throw this.writeError;
    this.writes.push(operation);
    send();
  }
  async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.answerError) throw this.answerError;
    this.answers.push({ method, params });
    return { success: true };
  }
  close(): void {
    this.closed = true;
  }
}

class FakeSessions implements AttachSessions {
  runtimeFor: FakeRuntime;
  states = new Map<string, SessionInfo["state"]>([
    ["s1", "idle"],
    ["s2", "idle"],
  ]);
  placements = new Map<string, string>([
    ["s1", "shared"],
    ["s2", "shared"],
  ]);
  readonly attachments: FakeAttachment[] = [];
  readonly attachOptions: CliAttachOptions[] = [];
  listener: ((event: SessionLifecycleEvent) => void) | undefined;
  /** When set, `runtime()` picks its answer, then waits here: a lookup that straddles a lifecycle change. */
  gate: Promise<void> | undefined;
  constructor(runtime: FakeRuntime) {
    this.runtimeFor = runtime;
  }
  async info(accountId: number, sessionId: string): Promise<SessionInfo> {
    const state = this.states.get(sessionId);
    if (accountId !== OWNER || !state) throw new ManagedCopilotError("not_found", "No such session");
    return { id: sessionId, state } as SessionInfo;
  }
  async runtime(): Promise<SessionRuntime> {
    const runtime = this.runtimeFor;
    if (this.gate) await this.gate;
    return runtime;
  }
  get(sessionId: string) {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    return { incarnation: `inc-${sessionId}`, type: "shared", placement: this.placements.get(sessionId) ?? "shared", state, generation: 0 };
  }
  async attachCli(accountId: number, sessionId: string, options: CliAttachOptions): Promise<CliAttachment> {
    if (accountId !== OWNER || !this.states.has(sessionId)) throw new ManagedCopilotError("not_found", "No such session");
    if (this.states.get(sessionId) === "promoting") throw new ManagedCopilotError("session_busy", "Moving");
    this.attachOptions.push(options);
    const attachment = new FakeAttachment(options.connectionId, `inc-${sessionId}`, 0);
    this.attachments.push(attachment);
    return attachment;
  }
  onLifecycle(listener: (event: SessionLifecycleEvent) => void) {
    this.listener = listener;
    return () => (this.listener = undefined);
  }
}

/** The actions ledger as attach sees it. */
class FakeActions implements AttachActions {
  open: Partial<PendingAction>[] = [];
  promptVisibility?: (input: PromptVisibilityInput) => Promise<PromptVisibility>;
  list(sessionId: string): readonly PendingAction[] {
    return this.open.filter((action) => (action.sessionId ?? "s1") === sessionId) as PendingAction[];
  }
}

function toolCallReady(toolCallId: string, requestId: string, serverSeq = 10) {
  return {
    jsonrpc: "2.0",
    method: "action",
    params: {
      channel: CHAT,
      serverSeq,
      action: {
        type: "chat/toolCallReady",
        turnId: "t1",
        toolCallId,
        invocationMessage: "lookup_order",
        _meta: { requestId, permissionRequest: { kind: "custom-tool", toolCallId, toolName: "lookup_order", args: { id: "1234" } } },
      },
    },
  };
}

describe("attach module", () => {
  let dataDir: string;
  let listener: FakeListener;
  let runtime: FakeRuntime;
  let sessions: FakeSessions;
  let actions: FakeActions;
  let participant: PromotionParticipant | undefined;
  let app: GatewayApp;
  let server: Server;
  let base: string;
  const clients: WebSocket[] = [];
  const inboxes = new WeakMap<WebSocket, any[]>();

  async function startApp(env: Record<string, string> = {}) {
    const config = loadConfig({
      PORT: "0",
      MANAGED_COPILOT_DATA_DIR: dataDir,
      MANAGED_COPILOT_WRITE_DISCOVERY: "0",
      MANAGED_COPILOT_ATTACH_IDLE_MS: "60000",
      MANAGED_COPILOT_ATTACH_LEDGER_WAIT_MS: "60",
      ...env,
    });
    app = new GatewayApp(config, openDatabase(":memory:"), createLogger("test", "error"));
    app.provide("auth", {
      authenticate: async (token) => {
        if (token === "user-42") return { accountId: OWNER, login: "octo", token };
        if (token === "user-7") return { accountId: 7, login: "other", token };
        throw new ManagedCopilotError("authentication_required", "bad token");
      },
    });
    const services = app.services as Record<string, unknown>;
    services.sessions = sessions;
    services.actions = actions;
    services.promotion = {
      participate: (registered: PromotionParticipant) => {
        participant = registered;
        return () => (participant = undefined);
      },
    };
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
    const inbox: any[] = [];
    inboxes.set(ws, inbox);
    ws.on("message", (data) => inbox.push(JSON.parse(data.toString())));
    clients.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: Buffer.concat(chunks).toString() })));
      });
      ws.once("error", reject);
    });
  }

  async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
      await sleep(5);
    }
  }

  /** The first message the client received that matches, waiting for it if needed. */
  async function received(ws: WebSocket, matches: (message: any) => boolean): Promise<any> {
    const inbox = inboxes.get(ws)!;
    await waitFor(() => inbox.some(matches));
    return inbox.find(matches);
  }

  function next(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
  }

  /** An attached client that completed the AHP handshake, and core's handle for it. */
  async function connect(sessionId = "s1"): Promise<{ ws: WebSocket; attachment: FakeAttachment }> {
    const ws = await open(sessionId, (await material(sessionId)).token);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { channel: "ahp-root://", protocolVersions: ["0.9.0"], clientId: "cli-test" } }));
    await received(ws, (message) => message.id === 1);
    return { ws, attachment: sessions.attachments.at(-1)! };
  }

  function dispatch(ws: WebSocket, clientSeq: number, channel: string, action: Record<string, unknown>): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq, action } }));
  }

  /** The envelope the gateway sent back for the client's own action `clientSeq` (an echo or a rejection). */
  function answerTo(ws: WebSocket, clientSeq: number): Promise<any> {
    return received(ws, (message) => message.method === "action" && message.params?.origin?.clientSeq === clientSeq).then((message) => message.params);
  }

  beforeAll(async () => {
    // A space in the path: AHP carries it percent-encoded in file: URIs.
    dataDir = mkdtempSync(join(tmpdir(), "mc attach-"));
    listener = new FakeListener();
    await listener.start();
  });

  afterAll(async () => {
    await listener.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await stopApp();
    listener.received.length = 0;
    listener.results.clear();
  });

  async function fresh(env?: Record<string, string>) {
    runtime = new FakeRuntime("conn-1", listener);
    sessions = new FakeSessions(runtime);
    actions = new FakeActions();
    participant = undefined;
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

  it("attaches the CLI as a cli responder with the ticket's principal and detaches it when the CLI leaves", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    expect(sessions.attachOptions).toHaveLength(1);
    expect(sessions.attachOptions[0]!.principal).toMatchObject({ accountId: OWNER, login: "octo" });
    expect(sessions.attachOptions[0]!.connectionId).toMatch(/^cli_/);
    expect(attachment.closed).toBe(false);
    ws.close();
    await waitFor(() => attachment.closed);
  });

  it("sends the CLI's messages, steering, and cancels only from inside core's admitted, fenced write", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    dispatch(ws, 1, CHAT, { type: "chat/turnStarted", turnId: "t1", startedAt: "2026-10-24T00:00:00Z", message: { text: "Hello", origin: { kind: "user" } } });
    await waitFor(() => listener.dispatched("chat/turnStarted").length === 1);
    expect(attachment.writes).toEqual([{ kind: "turn", text: "Hello" }]);

    // Refused by core (fenced, moved, or not admitted): nothing reaches the runtime and the CLI reverts its copy.
    attachment.writeError = new ManagedCopilotError("session_busy", "This session is moving into a sandbox.");
    dispatch(ws, 2, CHAT, { type: "chat/pendingMessageSet", kind: "steering", id: "m2", message: { text: "Also this", origin: { kind: "user" } } });
    expect(await answerTo(ws, 2)).toMatchObject({ channel: CHAT, origin: { clientId: "cli-test", clientSeq: 2 }, rejectionReason: "This session is moving into a sandbox." });
    expect(listener.dispatched("chat/pendingMessageSet")).toHaveLength(0);

    attachment.writeError = undefined;
    dispatch(ws, 3, CHAT, { type: "chat/turnCancelled", turnId: "t1", duration: 5 });
    await waitFor(() => listener.dispatched("chat/turnCancelled").length === 1);
    expect(attachment.writes.at(-1)).toEqual({ kind: "abort" });

    // A model on the message is admitted by core before the turn.
    dispatch(ws, 4, CHAT, { type: "chat/turnStarted", turnId: "t2", startedAt: "2026-10-24T00:00:01Z", message: { text: "Again", origin: { kind: "user" }, model: { id: "gpt-5" } } });
    await waitFor(() => listener.dispatched("chat/turnStarted").length === 2);
    expect(attachment.writes.slice(-2)).toEqual([{ kind: "model", modelId: "gpt-5" }, { kind: "turn", text: "Again" }]);
  });

  it("answers a permission prompt through the actions ledger by the runtime's request ID and never forwards the CLI's decision", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    listener.push(toolCallReady("tc1", "req-1", 12));
    await received(ws, (message) => message.params?.action?.type === "chat/toolCallReady");
    actions.open = [{ id: "act_1", kind: "permission", state: "pending", requestId: "req-1" }];
    // The client's own _meta is never trusted for the request ID.
    dispatch(ws, 7, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc1", approved: true, confirmed: "user-action", _meta: { requestId: "req-spoofed" } });
    const echo = await answerTo(ws, 7);
    expect(echo.rejectionReason).toBeUndefined();
    expect(echo).toMatchObject({ channel: CHAT, serverSeq: 12, action: { type: "chat/toolCallConfirmed", toolCallId: "tc1", approved: true } });
    expect(attachment.answers).toEqual([{ method: PERMISSION_METHOD, params: { requestId: "req-1", result: { kind: "approve-once", approvedInteractively: true } } }]);

    // A denial carries the person's feedback.
    listener.push(toolCallReady("tc2", "req-2", 13));
    await received(ws, (message) => message.params?.action?.toolCallId === "tc2");
    actions.open.push({ id: "act_2", kind: "permission", state: "pending", requestId: "req-2" });
    dispatch(ws, 8, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc2", approved: false, reason: "denied", reasonMessage: "Not that order" });
    await answerTo(ws, 8);
    expect(attachment.answers.at(-1)).toEqual({ method: PERMISSION_METHOD, params: { requestId: "req-2", result: { kind: "reject", feedback: "Not that order" } } });
    expect(listener.dispatched("chat/toolCallConfirmed")).toHaveLength(0);
  });

  it("refuses a CLI approval for a prompt another responder owns", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    listener.push(toolCallReady("tc1", "req-1"));
    await received(ws, (message) => message.params?.action?.type === "chat/toolCallReady");
    const asked: PromptVisibilityInput[] = [];
    actions.promptVisibility = async (input) => {
      asked.push(input);
      return { status: "observe", actionId: "act_1", state: "executing", claimedBy: "live:conn_app" };
    };
    dispatch(ws, 3, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc1", approved: true, confirmed: "user-action" });
    expect((await answerTo(ws, 3)).rejectionReason).toBe("Your application is answering this request.");
    expect(asked[0]).toMatchObject({ sessionId: "s1", incarnation: "inc-s1", generation: 0, kind: "permission", requestId: "req-1", responder: { kind: "cli", connectionId: attachment.connectionId } });
    expect(attachment.answers).toHaveLength(0);

    // Claimable by the ledger, but the answer loses the race: still refused, still never forwarded.
    actions.promptVisibility = async () => ({ status: "actionable", actionId: "act_1" });
    attachment.answerError = new ManagedCopilotError("conflict", "Another responder took this action first");
    dispatch(ws, 4, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc1", approved: true, confirmed: "user-action" });
    expect((await answerTo(ws, 4)).rejectionReason).toBe("Another responder took this action first");
    expect(listener.dispatched("chat/toolCallConfirmed")).toHaveLength(0);
  });

  it("refuses approvals for prompts it was never shown or the ledger never recorded", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    dispatch(ws, 1, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc-unknown", approved: true, confirmed: "user-action", _meta: { requestId: "req-1" } });
    expect((await answerTo(ws, 1)).rejectionReason).toBe("This approval isn't available to Copilot CLI.");
    listener.push(toolCallReady("tc2", "req-2"));
    await received(ws, (message) => message.params?.action?.toolCallId === "tc2");
    dispatch(ws, 2, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc2", approved: true, confirmed: "user-action" });
    expect((await answerTo(ws, 2)).rejectionReason).toMatch(/no open record of this request/);
    // Editing a tool's input before approving it is not a decision the ledger can record.
    dispatch(ws, 3, CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc2", approved: true, confirmed: "user-action", editedToolInput: '{"id":"9"}' });
    expect((await answerTo(ws, 3)).rejectionReason).toMatch(/Editing a tool's input/);
    expect(attachment.answers).toHaveLength(0);
    expect(listener.dispatched("chat/toolCallConfirmed")).toHaveLength(0);
  });

  it("answers ask_user through core's user-input gate and elicitations through the ledger", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    const question = (id: string, meta?: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      method: "action",
      params: { channel: CHAT, serverSeq: 20, action: { type: "chat/inputRequested", request: { id, message: "Color?", questions: [{ kind: "text", id: "answer", message: "Color?" }], ...(meta ? { _meta: meta } : {}) } } },
    });
    const answer = { answer: { state: "submitted", value: { kind: "text", value: "teal" } } };

    listener.push(question("ui-1"));
    await received(ws, (message) => message.params?.action?.request?.id === "ui-1");
    dispatch(ws, 1, CHAT, { type: "chat/inputCompleted", requestId: "ui-1", response: "accept", answers: answer });
    await waitFor(() => listener.dispatched("chat/inputCompleted").length === 1);
    expect(attachment.writes).toEqual([{ kind: "userInput" }]);

    // Linked to a runtime elicitation: recorded in the ledger, never forwarded.
    listener.push(question("ui-2", { requestId: "el-1" }));
    await received(ws, (message) => message.params?.action?.request?.id === "ui-2");
    actions.open = [{ id: "act_e", kind: "elicitation", state: "pending", requestId: "el-1" }];
    dispatch(ws, 2, CHAT, { type: "chat/inputCompleted", requestId: "ui-2", response: "accept", answers: answer });
    expect((await answerTo(ws, 2)).rejectionReason).toBeUndefined();
    expect(attachment.answers).toEqual([{ method: "session.ui.handlePendingElicitation", params: { requestId: "el-1", result: { action: "accept", content: { answer: "teal" } } } }]);

    // A question it can't link while the ledger holds an elicitation: it could be that one, so it is refused.
    listener.push(question("ui-3"));
    await received(ws, (message) => message.params?.action?.request?.id === "ui-3");
    dispatch(ws, 3, CHAT, { type: "chat/inputCompleted", requestId: "ui-3", response: "accept", answers: answer });
    expect((await answerTo(ws, 3)).rejectionReason).toBe("Answer this question in your application.");
    expect(listener.dispatched("chat/inputCompleted")).toHaveLength(1);
  });

  it("refuses everything else an attached CLI could reach on the host", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    const refusedRequests: [string, Record<string, unknown>][] = [
      ["createTerminal", { channel: "ahp-terminal:/x", claim: { kind: "client", clientId: "cli-test" } }],
      ["createSession", { channel: "ahp-session:/other", config: {} }],
      ["resourceRead", { channel: "ahp-root://", uri: "file:///C:/Windows/win.ini" }],
      ["invokeChangesetOperation", { channel: "ahp-changeset:/c1/session" }],
      ["extensions/addProject", { channel: "ahp-root://", path: "C:/" }],
      ["subscribe", { channel: "ahp-changeset:/c1/session" }],
      ["subscribe", { channel: "ahp-terminal:/x" }],
    ];
    let id = 100;
    for (const [method, params] of refusedRequests) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
      const reply = await received(ws, (message) => message.id === id);
      expect(reply.error).toMatchObject({ code: -32009 });
    }
    const refusedActions: [string, Record<string, unknown>][] = [
      ["ahp-session:/s1", { type: "session/configChanged", config: { approvalMode: "allow-all" } }],
      [CHAT, { type: "chat/toolCallComplete", turnId: "t1", toolCallId: "tc1", result: { success: true } }],
      [CHAT, { type: "chat/truncated" }],
      [CHAT, { type: "chat/turnStarted", turnId: "t3", startedAt: "x", message: { text: "!dir C:\\", origin: { kind: "user" } } }],
      [CHAT, { type: "chat/turnStarted", turnId: "t4", startedAt: "x", message: { text: "/chronicle search secrets", origin: { kind: "user" } } }],
      [CHAT, { type: "chat/turnStarted", turnId: "t5", startedAt: "x", message: { text: "Read this", origin: { kind: "user" }, attachments: [{ type: "resource", label: "f", uri: "file:///etc/passwd" }] } }],
      ["ahp-session:/s1", { type: "session/activeClientSet", activeClient: { clientId: "cli-test", tools: [{ name: "local_shell" }] } }],
      ["ahp-session:/s1", { type: "session/activeClientSet", activeClient: { clientId: "someone-else", tools: [] } }],
      ["ahp-terminal:/x", { type: "terminal/input", data: "dir\r" }],
    ];
    let seq = 10;
    for (const [channel, action] of refusedActions) {
      dispatch(ws, ++seq, channel, action);
      expect((await answerTo(ws, seq)).rejectionReason).toEqual(expect.any(String));
    }
    // What the CLI may do: switch modes, register itself without tools, compact the conversation.
    dispatch(ws, 50, "ahp-session:/s1", { type: "session/configChanged", config: { mode: "plan" } });
    dispatch(ws, 51, "ahp-session:/s1", { type: "session/activeClientSet", activeClient: { clientId: "cli-test", displayName: "Copilot CLI", tools: [] } });
    dispatch(ws, 52, CHAT, { type: "chat/turnStarted", turnId: "t6", startedAt: "x", message: { text: "/compact", origin: { kind: "user" } } });
    await waitFor(() => listener.dispatched("chat/turnStarted").length === 1 && listener.dispatched("session/activeClientSet").length === 1);
    expect(listener.dispatched("session/configChanged").map((message) => message.params.action.config)).toEqual([{ mode: "plan" }]);
    expect(attachment.writes).toEqual([{ kind: "turn", text: "/compact" }]);
    const methods = listener.received.map((message) => message.method);
    for (const method of ["createTerminal", "createSession", "resourceRead", "invokeChangesetOperation", "extensions/addProject"]) expect(methods).not.toContain(method);
    expect(listener.received.filter((message) => message.method === "subscribe")).toHaveLength(0);
    for (const type of ["chat/toolCallComplete", "chat/truncated", "terminal/input"]) expect(listener.dispatched(type)).toHaveLength(0);
  });

  it("scrubs platform host paths and drops the host's shell prefix from what the CLI sees", async () => {
    await fresh();
    const workspace = join(dataDir, "runtime", "shared", "workspaces", "s1");
    listener.results.set("initialize", { protocolVersion: "0.9.0", serverSeq: 3, terminalCommandPrefix: "!", defaultDirectory: pathToFileURL(join(dataDir, "runtime", "shared")).href, snapshots: [] });
    listener.results.set("listSessions", { items: [{ resource: "ahp-session:/s1", workingDirectories: [pathToFileURL(workspace).href, `file:///${workspace.replace(/\\/g, "/")}`] }] });
    listener.results.set("extensions/getPlan", { plan: { path: join(dataDir, "runtime", "shared", "copilot-home", "session-state", "s1", "plan.md") } });
    const ws = await open("s1", (await material()).token);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { channel: "ahp-root://", protocolVersions: ["0.9.0"], clientId: "cli-test" } }));
    const init = await received(ws, (message) => message.id === 1);
    expect(init.result).toEqual({ protocolVersion: "0.9.0", serverSeq: 3, snapshots: [] });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "listSessions", params: { channel: "ahp-root://" } }));
    expect((await received(ws, (message) => message.id === 2)).result.items[0].workingDirectories).toEqual(["file:///workspace", "file:///workspace"]);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "extensions/getPlan", params: { channel: "ahp-session:/s1" } }));
    expect((await received(ws, (message) => message.id === 3)).result.plan.path).toBe("/platform/copilot-home/session-state/s1/plan.md");
    listener.push({ jsonrpc: "2.0", method: "action", params: { channel: "ahp-session:/s1", serverSeq: 4, action: { type: "session/metaChanged", _meta: { "copilot.context": { cwd: workspace } } } } });
    expect((await received(ws, (message) => message.params?.serverSeq === 4)).params.action._meta["copilot.context"].cwd).toBe("/workspace");
    const seen = JSON.stringify(inboxes.get(ws));
    for (const form of [dataDir, dataDir.replace(/\\/g, "/"), encodeURI(dataDir.replace(/\\/g, "/")), JSON.stringify(dataDir).slice(1, -1)]) expect(seen).not.toContain(form);
  });

  it("answers the runtime's requests to the client itself and keeps host telemetry on the platform", async () => {
    await fresh();
    const { ws } = await connect();
    listener.push({ jsonrpc: "2.0", id: 77, method: "resourceRead", params: { channel: "ahp-root://", uri: "virtual://cli-test/notes.md" } });
    listener.push({ jsonrpc: "2.0", method: "otlp/exportLogs", params: { channel: "ahp-otlp:/logs", resourceLogs: [] } });
    listener.push({ jsonrpc: "2.0", method: "action", params: { channel: "ahp-session:/s1", serverSeq: 30, action: { type: "session/titleChanged", title: "after" } } });
    await received(ws, (message) => message.params?.serverSeq === 30);
    await waitFor(() => listener.received.some((message) => message.id === 77 && message.error));
    expect(listener.received.find((message) => message.id === 77).error).toMatchObject({ code: -32601 });
    const methods = inboxes.get(ws)!.map((message) => message.method);
    expect(methods).not.toContain("resourceRead");
    expect(methods).not.toContain("otlp/exportLogs");
  });

  it("fences attached clients before a promotion checkpoints the source: input stops, the host is disposed, attaches wait", async () => {
    await fresh();
    const { ws, attachment } = await connect();
    expect(participant?.name).toBe("Copilot CLI attach");
    const closed = once(ws, "close");
    const fencing = participant!.fence("s1", new AbortController().signal);
    // Fenced synchronously: what the CLI sends from now on never reaches the source runtime.
    dispatch(ws, 9, CHAT, { type: "chat/turnStarted", turnId: "late", startedAt: "x", message: { text: "late", origin: { kind: "user" } } });
    await fencing;
    expect(runtime.count("host.dispose")).toBe(1);
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4307);
    expect(reason.toString()).toBe("The session is moving into a sandbox. Reconnecting.");
    expect(attachment.closed).toBe(true);
    expect(listener.dispatched("chat/turnStarted")).toHaveLength(0);

    const busy = await attach("s1");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "session_busy" } });

    // Aborted after the checkpoint (sealed): publish again on a fresh host even though the runtime connection is the same.
    participant!.release("s1", { committed: false, sealed: true });
    const again = await connect();
    expect(runtime.count("host.start")).toBe(2);
    dispatch(again.ws, 1, CHAT, { type: "chat/turnStarted", turnId: "t1", startedAt: "x", message: { text: "Back", origin: { kind: "user" } } });
    await waitFor(() => listener.dispatched("chat/turnStarted").length === 1);
  });

  it("waits for a host still starting on the source, disposes it, and refuses that attach", async () => {
    await fresh();
    let started!: () => void;
    runtime.startGate = new Promise((resolve) => (started = resolve));
    const pending = attach("s1");
    await waitFor(() => runtime.count("host.start") === 1);
    let fenced = false;
    const fencing = participant!.fence("s1", new AbortController().signal).then(() => (fenced = true));
    await sleep(30);
    expect(fenced).toBe(false);
    started();
    await fencing;
    expect(runtime.count("host.publishSession")).toBe(1);
    expect(runtime.count("host.dispose")).toBe(1);
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "session_busy" } });
    participant!.release("s1", { committed: true, sealed: true });
  });

  it("fails the fence when the runtime can't stop the host, so the move fails before the checkpoint", async () => {
    await fresh();
    await connect();
    runtime.disposeError = new Error("the listener is busy");
    await expect(participant!.fence("s1", new AbortController().signal)).rejects.toMatchObject({ code: "upstream_unavailable" });
    participant!.release("s1", { committed: false, sealed: false });
  });

  it("never waits on session routing during a fence, and refuses an attach that straddled it", async () => {
    await fresh();
    const { token } = await material("s1");
    let proceed!: () => void;
    sessions.gate = new Promise((resolve) => (proceed = resolve));
    const upgrade = open("s1", token).then(
      () => 0,
      (error: { status: number; body: string }) => error,
    );
    await sleep(20);
    // The upgrade is waiting in sessions.runtime(); the fence must not wait for it.
    await participant!.fence("s1", new AbortController().signal);
    participant!.release("s1", { committed: false, sealed: false });
    sessions.gate = undefined;
    proceed();
    const refused = (await upgrade) as { status: number; body: string };
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "session_busy" } });
    expect(sessions.attachments).toHaveLength(0);
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
    await sleep(20);
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
    sessions.placements.set("s1", "sandbox");
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

  it("never leaves a host on the runtime a session moved off while an attach was resolving it", async () => {
    await fresh();
    let proceed!: () => void;
    sessions.gate = new Promise((resolve) => (proceed = resolve));
    const pending = attach("s1"); // resolves the shared runtime, then waits
    await sleep(20);
    const sandbox = new FakeRuntime("sandbox:s1#1", listener);
    sessions.runtimeFor = sandbox;
    sessions.listener?.({ sessionId: "s1", type: "promoted" });
    sessions.gate = undefined;
    proceed();
    expect((await pending).status).toBe(200);
    await sleep(50);
    // The host started on the stale shared runtime was released by the promotion queued behind it.
    expect(runtime.count("host.start")).toBe(1);
    expect(runtime.count("host.dispose")).toBe(1);
    const ws = await open("s1", (await material("s1")).token);
    expect(sandbox.count("host.start")).toBe(1);
    ws.close();
  });

  it("keeps a host started on the new runtime after a promotion event", async () => {
    await fresh();
    const sandbox = new FakeRuntime("sandbox:s1#1", listener);
    sessions.runtimeFor = sandbox;
    sessions.listener?.({ sessionId: "s1", type: "promoted" });
    const ws = await open("s1", (await material("s1")).token);
    await sleep(30);
    expect(sandbox.count("host.start")).toBe(1);
    expect(sandbox.count("host.dispose")).toBe(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes clients with the lifecycle's code when the listener connection drops just before the event", async () => {
    await fresh();
    const ws = await open("s1", (await material("s1")).token);
    const closed = once(ws, "close");
    for (const socket of listener.sockets) socket.terminate(); // the runtime went away
    await sleep(50);
    runtime.close();
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4410);
    expect(reason.toString()).toBe("The session's runtime stopped. Attach again to resume it.");
  });

  it("closes clients with 1011 when the listener connection drops without a lifecycle event", async () => {
    await fresh();
    const ws = await open("s1", (await material("s1")).token);
    const closed = once(ws, "close");
    const dropped = Date.now();
    for (const socket of listener.sockets) socket.terminate();
    const [code] = (await closed) as [number];
    expect(code).toBe(1011);
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(LISTENER_LOSS_GRACE_MS - 50);
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
        await sleep(15);
        return super.request<T>(method, params);
      }
    }
    const slow = new SlowRuntime("conn-1", listener);
    const hosts = new AhpHosts(createLogger("test", "error"), 60_000);
    const current = async () => slow;
    const [first, , second] = await Promise.all([hosts.ensure("s1", current), hosts.release("s1", "The session was deleted."), hosts.ensure("s1", current)]);
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
    const host = await hosts.ensure("s1", async () => quiet);
    await sleep(80);
    expect(host.closed).toBe(true);
    expect(quiet.count("host.dispose")).toBe(1);
  });

  it("bounds a fence by its signal", async () => {
    const listener = new FakeListener();
    listener.port = 1;
    class StuckRuntime extends FakeRuntime {
      override async request<T>(method: string, params: any): Promise<T> {
        if (method === "host.dispose") return new Promise<T>(() => undefined);
        return super.request<T>(method, params);
      }
    }
    const stuck = new StuckRuntime("conn-1", listener);
    const hosts = new AhpHosts(createLogger("test", "error"), 60_000);
    await hosts.ensure("s1", async () => stuck);
    const controller = new AbortController();
    const fencing = hosts.fence("s1", controller.signal);
    controller.abort(new ManagedCopilotError("timeout", "too slow"));
    await expect(fencing).rejects.toMatchObject({ code: "timeout" });
    expect(hosts.isFenced("s1")).toBe(true);
    hosts.unfence("s1");
    expect(hosts.isFenced("s1")).toBe(false);
  });

  it("starts nothing on the source when a fence goes up while an attach waits for the previous host to stop", async () => {
    const listener = new FakeListener();
    listener.port = 1;
    let unstall!: () => void;
    const stalled = new Promise<void>((resolve) => (unstall = resolve));
    class StallingRuntime extends FakeRuntime {
      disposes = 0;
      override async request<T>(method: string, params: any): Promise<T> {
        // The first host.dispose stalls (as a busy runtime might), so the first fence times out.
        if (method === "host.dispose" && this.disposes++ === 0) {
          this.requests.push({ method, params });
          await stalled;
          return {} as T;
        }
        return super.request<T>(method, params);
      }
    }
    const source = new StallingRuntime("conn-1", listener);
    const hosts = new AhpHosts(createLogger("test", "error"), 60_000);
    await hosts.ensure("s1", async () => source);
    // First move: the fence's dispose stalls, promotion's bound aborts it, and the attempt is released.
    const first = new AbortController();
    const fencing = hosts.fence("s1", first.signal);
    first.abort(new ManagedCopilotError("promotion_busy", "bounded"));
    await expect(fencing).rejects.toMatchObject({ code: "promotion_busy" });
    hosts.unfence("s1");
    // A CLI reconnects: its attach resolves the source again and waits for the stalled disposal.
    const reconnect = hosts.ensure("s1", async () => source);
    await sleep(20);
    // A second move fences: no host and nothing starting, so it resolves at once.
    await hosts.fence("s1", new AbortController().signal);
    const startsBefore = source.count("host.start");
    unstall();
    await expect(reconnect).rejects.toMatchObject({ code: "session_busy" });
    await sleep(20);
    expect(source.count("host.start")).toBe(startsBefore);
    expect(source.count("host.publishSession")).toBe(1);
    hosts.unfence("s1");
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

  it("keeps the requester's credential in memory only, until the ticket is redeemed", () => {
    const db = openDatabase(":memory:");
    const principal = { accountId: OWNER, login: "octo", token: "gho_requestertokenrequestertoken" };
    const tickets = new AttachTickets(db);
    const first = tickets.mint(principal, "s1", 60_000, { incarnation: "inc-1" });
    expect(tickets.redeem(first.token, "s1")).toMatchObject({ principal, incarnation: "inc-1" });
    const dump = JSON.stringify(db.prepare("SELECT * FROM attach_tickets").all());
    expect(dump).not.toContain(principal.token);
    // After a restart the ticket is still single-use, but its requester's credential is gone.
    const second = tickets.mint(principal, "s1", 60_000);
    const restarted = new AttachTickets(db);
    const redeemed = restarted.redeem(second.token, "s1");
    expect(redeemed).toMatchObject({ sessionId: "s1", accountId: OWNER });
    expect(redeemed?.principal).toBeUndefined();
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
