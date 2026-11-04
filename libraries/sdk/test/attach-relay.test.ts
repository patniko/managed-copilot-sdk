import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { AttachMaterial } from "@managed-copilot/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { HttpClient } from "../src/http.js";

const OWNER = { id: 42, login: "octo" };
let github: Server;
let gateway: Server;
let gatewayUrl: string;
const minted: string[] = [];
const used = new Set<string>();
const received: unknown[] = [];
const gatewaySockets = new Set<WebSocket>();
const upgradeHeaders: Record<string, unknown>[] = [];
/** GitHub tokens the fake API now rejects, as if their owner revoked them. */
const revoked = new Set<string>();
/** The conversation the fake deployment offers in attach material. */
let offeredConversation = "ahp-session:/s1";
/** How many more ticket requests and socket upgrades the fake deployment answers with `session_busy` (a move in progress). */
const busy = { tickets: 0, upgrades: 0 };
/** How many more socket upgrades the fake deployment leaves unanswered (a handshake in flight), and those sockets. */
const stall = { upgrades: 0 };
const stalled: Duplex[] = [];
/** How many more upgraded sockets go silent (a half-open link: no frames, no pongs), and pings the deployment got. */
const silent = { upgrades: 0 };
const pings = { count: 0 };
/** How many more upgraded sockets send one large message a chunk at a time (a slow link), then go silent. */
const slow = { upgrades: 0 };
const BUSY_BODY = JSON.stringify({ error: { code: "session_busy", message: "This session is moving into a sandbox. Attach again when the move finishes." } });

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Waits for `check`, polling; a loaded machine only makes it later. */
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  github = createServer((req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const user = token && revoked.has(token) ? undefined : token === "gho_owner" ? OWNER : token === "gho_other" ? { id: 7, login: "other" } : undefined;
    res.writeHead(user ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(user ?? { message: "Bad credentials" }));
  });
  process.env.MANAGED_COPILOT_GITHUB_API_URL = await listen(github);

  const wss = new WebSocketServer({ noServer: true });
  const silentWss = new WebSocketServer({ noServer: true, autoPong: false });
  gateway = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/sessions/s1/attach") {
      if (busy.tickets > 0) {
        busy.tickets--;
        res.writeHead(409, { "content-type": "application/json" }).end(BUSY_BODY);
        return;
      }
      const token = `mcat_ticket${minted.length}`;
      minted.push(token);
      const material: AttachMaterial = { transport: "ahp", url: "ws://elsewhere.example:1/v1/sessions/s1/ahp", token, expiresAt: new Date(Date.now() + 60_000).toISOString(), ahpSessionId: offeredConversation };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(material));
      return;
    }
    res.writeHead(404).end();
  });
  gateway.on("upgrade", (req, socket, head) => {
    upgradeHeaders.push({ ...req.headers });
    const ticket = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (req.url !== "/v1/sessions/s1/ahp" || !minted.includes(ticket) || used.has(ticket)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    used.add(ticket);
    if (stall.upgrades > 0) {
      stall.upgrades--;
      stalled.push(socket);
      return;
    }
    if (busy.upgrades > 0) {
      busy.upgrades--;
      socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(BUSY_BODY)}\r\nconnection: close\r\n\r\n${BUSY_BODY}`);
      return;
    }
    if (silent.upgrades > 0) {
      silent.upgrades--;
      silentWss.handleUpgrade(req, socket, head, (ws) => gatewaySockets.add(ws));
      return;
    }
    if (slow.upgrades > 0) {
      slow.upgrades--;
      silentWss.handleUpgrade(req, socket, head, (ws) => {
        gatewaySockets.add(ws);
        // One ~60 KB text frame written by hand, 800 bytes at least 20 ms apart (at least 1.5 s): nothing completes, and no
        // pong could get out, until it ends.
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "action", params: { pad: "x".repeat(60_000) } }));
        socket.write(Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]));
        let offset = 0;
        const timer = setInterval(() => {
          if (socket.destroyed) return clearInterval(timer);
          socket.write(payload.subarray(offset, offset + 800));
          offset += 800;
          if (offset >= payload.length) clearInterval(timer);
        }, 20);
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      gatewaySockets.add(ws);
      ws.on("ping", () => pings.count++);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string };
        received.push(message);
        if (message.method === "initialize") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "0.9.0" } }));
      });
    });
  });
  gatewayUrl = await listen(gateway);
});

afterAll(async () => {
  for (const socket of gatewaySockets) socket.terminate();
  github.close();
  gateway.closeAllConnections();
  gateway.close();
  delete process.env.MANAGED_COPILOT_GITHUB_API_URL;
});

describe("Copilot CLI attach relay", () => {
  const relays: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.close();
    received.length = 0;
  });

  async function startRelay(extra: { busyRetryMs?: number; keepAlive?: { intervalMs: number; timeoutMs: number } } = {}) {
    // Imported after the fake GitHub API URL is set, as the launcher reads it at load.
    const { AttachRelay } = await import("../src/features/cli.js");
    const http = new HttpClient(gatewayUrl, "user-token");
    const first = await http.post<AttachMaterial>("/v1/sessions/s1/attach");
    const relay = new AttachRelay({ sessionId: "s1", owner: OWNER, deploymentUrl: gatewayUrl, http, first, ...extra });
    relays.push(relay);
    return { relay, url: await relay.listen() };
  }

  function connect(url: string, token?: string): Promise<WebSocket> {
    const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => reject(Object.assign(new Error(body), { status: res.statusCode, body })));
      });
      ws.once("error", reject);
    });
  }

  const next = (ws: WebSocket) => new Promise<any>((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));

  it("admits the session owner's Copilot CLI and relays AHP with a ticket header", async () => {
    const { url } = await startRelay();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ahp\/[A-Za-z0-9_-]{32}$/);
    const cli = await connect(url, "gho_owner");
    cli.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(await next(cli)).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "0.9.0" } });
    const headers = upgradeHeaders.at(-1)!;
    expect(headers.authorization).toMatch(/^Bearer mcat_ticket\d+$/);
    expect(JSON.stringify(headers)).not.toContain("gho_owner");
    cli.close();
  });

  it("answers the CLI's authenticate request locally so its token never leaves the machine", async () => {
    const { url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    cli.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "authenticate", params: { token: "gho_owner" } }));
    expect((await next(cli)).error.code).toBe(-32602);
    cli.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }));
    await next(cli);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }]);
    cli.close();
  });

  it("ends only the CLI connection when a message can't be filtered, never the launcher (Astra)", async () => {
    const { url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    const closed = once(cli, "close") as Promise<[number, Buffer]>;
    // Removing `authenticate` re-serializes the rest of the batch, which this nesting makes impossible.
    cli.send(`[{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{}},{"jsonrpc":"2.0","id":2,"method":"ping","params":${"[".repeat(100_000)}${"]".repeat(100_000)}}]`);
    expect((await closed)[0]).toBe(1008);
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    again.close();
  });

  it("refuses a CLI signed in as someone else, or not signed in, with a clear reason", async () => {
    const { relay, url } = await startRelay();
    await expect(connect(url, "gho_other")).rejects.toMatchObject({ status: 403 });
    expect(relay.outcome).toEqual({ code: "forbidden", message: expect.stringContaining("signed in as @other, but this session belongs to @octo") });
    await expect(connect(url)).rejects.toMatchObject({ status: 401 });
    expect(relay.outcome?.message).toContain("Copilot CLI is not signed in");
    await expect(connect(url, "gho_bogus")).rejects.toMatchObject({ status: 401 });
    await expect(connect(url.replace(/\/ahp\/.+$/, "/ahp/wrong"), "gho_owner")).rejects.toMatchObject({ status: 404 });
  });

  it("allows one CLI at a time and mints a fresh ticket when the CLI reconnects", async () => {
    const { url } = await startRelay();
    const before = minted.length;
    const first = await connect(url, "gho_owner");
    await expect(connect(url, "gho_owner")).rejects.toMatchObject({ status: 409 });
    first.close();
    await once(first, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await connect(url, "gho_owner");
    expect(minted.length).toBe(before + 1);
    second.close();
  });

  it("admits exactly one of two CLIs that connect at the same moment", async () => {
    const { url } = await startRelay();
    const results = await Promise.allSettled([connect(url, "gho_owner"), connect(url, "gho_owner")]);
    const opened = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const refused = results.flatMap((result) => (result.status === "rejected" ? [result.reason as { status?: number }] : []));
    expect(opened).toHaveLength(1);
    expect(refused.map((reason) => reason.status)).toEqual([409]);
    opened[0]!.close();
  });

  it("refuses a malformed Sec-WebSocket-Protocol header before asking the deployment for a ticket", async () => {
    const { url } = await startRelay();
    const before = minted.length;
    expect(await rawUpgrade(url, new URL(url).pathname, { "sec-websocket-protocol": "ahp, ahp" })).toBe(400);
    expect(minted.length).toBe(before);
  });

  it("answers a malformed request target with 400 rather than failing the launcher's process", async () => {
    const { url } = await startRelay();
    expect(await rawUpgrade(url, "//[")).toBe(400);
    const cli = await connect(url, "gho_owner");
    cli.close();
  });

  it("verifies the CLI's GitHub sign-in again on every connection", async () => {
    const { url } = await startRelay();
    const first = await connect(url, "gho_owner");
    first.close();
    await once(first, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    revoked.add("gho_owner");
    try {
      await expect(connect(url, "gho_owner")).rejects.toMatchObject({ status: 401 });
    } finally {
      revoked.delete("gho_owner");
    }
  });

  /** Sends a WebSocket upgrade by hand, so the request can break rules the ws client enforces. */
  function rawUpgrade(relayUrl: string, path: string, extra: Record<string, string> = {}): Promise<number> {
    const { hostname, port } = new URL(relayUrl);
    return new Promise<number>((resolve, reject) => {
      const req = request({
        host: hostname,
        port,
        path,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          authorization: ["Bearer", "gho_owner"].join(" "),
          ...extra,
        },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => reject(new Error("The relay accepted an invalid request")));
      req.on("error", reject);
      req.end();
    });
  }

  it("passes the platform's close reason to the CLI and records it", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = once(cli, "close");
    for (const socket of gatewaySockets) socket.close(4410, "The session was deleted.");
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4410);
    expect(reason.toString()).toBe("The session was deleted.");
    expect(relay.outcome).toEqual({ code: "session_gone", message: "The session was deleted." });
  });

  /** Ends the current attachment from the platform side and returns the close code the CLI saw. */
  async function platformCloses(cli: WebSocket, code: number, reason: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closed = once(cli, "close");
    for (const socket of gatewaySockets) socket.close(code, reason);
    return ((await closed) as [number])[0];
  }

  it("has the CLI reconnect when the session moves or its attachment is renewed, with a fresh ticket", async () => {
    const { relay, url } = await startRelay();
    const before = minted.length;
    const cli = await connect(url, "gho_owner");
    // 1012 (service restart) is the close the stock CLI answers by redialing the same URL.
    expect(await platformCloses(cli, 4307, "The session moved into a sandbox. Reconnecting.")).toBe(1012);
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    expect(await platformCloses(again, 4408, "Attachment expired.")).toBe(1012);
    const renewed = await connect(url, "gho_owner");
    expect(minted.length).toBe(before + 2);
    expect(relay.outcome).toBeUndefined();
    renewed.close();
  });

  it("stops reconnecting a CLI the platform keeps interrupting", async () => {
    const { relay, url } = await startRelay();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await platformCloses(await connect(url, "gho_owner"), 4408, "Attachment expired.")).toBe(1012);
    }
    const last = await connect(url, "gho_owner");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closed = once(last, "close");
    for (const socket of gatewaySockets) socket.close(4408, "Attachment expired.");
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4408);
    expect(reason.toString()).toBe("The attachment was interrupted repeatedly. Attach again.");
    expect(relay.outcome).toEqual({ code: "expired", message: "The attachment was interrupted repeatedly. Attach again." });
  });

  it("shuts down promptly while a CLI is still closing after a reconnect request", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    await new Promise((resolve) => setTimeout(resolve, 30));
    cli.pause(); // this CLI hasn't answered the close frame yet
    for (const socket of gatewaySockets) socket.close(4307, "The session moved into a sandbox. Reconnecting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await relay.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    cli.terminate();
  });

  it("refuses to reconnect the CLI to a different conversation", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    expect(await platformCloses(cli, 4307, "The session moved into a sandbox. Reconnecting.")).toBe(1012);
    offeredConversation = "ahp-session:/someone-else";
    try {
      await expect(connect(url, "gho_owner")).rejects.toMatchObject({ status: 409 });
      expect(relay.outcome).toEqual({ code: "conflict", message: expect.stringContaining("refusing to switch") });
    } finally {
      offeredConversation = "ahp-session:/s1";
    }
  });

  it("keeps the CLI's reconnect waiting while the session moves into a sandbox", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    expect(await platformCloses(cli, 4307, "The session is moving into a sandbox. Reconnecting.")).toBe(1012);
    // The move is under way: the deployment refuses tickets, then a socket, with session_busy.
    busy.tickets = 2;
    busy.upgrades = 1;
    const before = minted.length;
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    expect(busy).toEqual({ tickets: 0, upgrades: 0 });
    // The refused socket spent its ticket; the reconnect used a fresh one.
    expect(minted.length).toBe(before + 2);
    expect(relay.outcome).toBeUndefined();
    again.close();
  });

  it("stops waiting for a move when the CLI hangs up, so its next dial gets the launcher", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    expect(await platformCloses(cli, 4307, "The session is moving into a sandbox. Reconnecting.")).toBe(1012);
    busy.tickets = 1_000;
    // The CLI redials while the move is under way, then gives up on that handshake (its own timeout).
    const abandoned = new WebSocket(url, { headers: { authorization: ["Bearer", "gho_owner"].join(" ") } });
    abandoned.on("error", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abandoned.terminate();
    busy.tickets = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The abandoned dial ended quietly: it neither took over nor recorded an outcome for the attachment.
    expect(relay.outcome).toBeUndefined();
    again.close();
  });

  it("ends a dial at once when the CLI hangs up during the deployment's handshake (Argon)", async () => {
    const { relay, url } = await startRelay();
    const cli = await connect(url, "gho_owner");
    expect(await platformCloses(cli, 4307, "The session is moving into a sandbox. Reconnecting.")).toBe(1012);
    stall.upgrades = 1;
    const abandoned = new WebSocket(url, { headers: { authorization: ["Bearer", "gho_owner"].join(" ") } });
    abandoned.on("error", () => undefined);
    const deadline = Date.now() + 2_000;
    while (stalled.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const held = stalled.shift()!;
    held.on("error", () => undefined);
    // The deployment's side is half-open (an HTTP server's socket): the relay hanging up shows as `end`.
    const dropped = Promise.race([once(held, "end"), once(held, "close")]);
    abandoned.terminate();
    // Dropped now, not at the relay's 15 s handshake timeout: the deployment never registers a responder for a dial
    // the CLI gave up on, and the CLI's next dial is the attachment.
    await dropped;
    held.destroy();
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    expect(relay.outcome).toBeUndefined();
    again.close();
  });

  it("reports that the session is still moving when the reconnect window ends (Argon)", async () => {
    const { relay, url } = await startRelay({ busyRetryMs: 300 });
    const cli = await connect(url, "gho_owner");
    expect(await platformCloses(cli, 4307, "The session is moving into a sandbox. Reconnecting.")).toBe(1012);
    busy.upgrades = 1_000;
    try {
      await expect(connect(url, "gho_owner")).rejects.toMatchObject({ status: 409 });
      expect(relay.outcome).toMatchObject({ code: "session_busy" });
    } finally {
      busy.upgrades = 0;
    }
  });

  it("pings the deployment while the CLI is idle, so an ingress keeps the link (Azure closes it after 240 s idle)", async () => {
    // A timeout that leaves room for a loaded machine's stalls, checked only after more than it has passed (each ping
    // follows the last by at least 50 ms) with nothing but pings and their pongs on the link.
    const { relay, url } = await startRelay({ keepAlive: { intervalMs: 50, timeoutMs: 1_500 } });
    const before = pings.count;
    const cli = await connect(url, "gho_owner");
    await until(() => pings.count - before >= 40, 15_000);
    expect(cli.readyState).toBe(WebSocket.OPEN);
    expect(relay.outcome).toBeUndefined();
    cli.close();
  }, 30_000);

  it("reconnects the CLI when the deployment stops responding, without waiting for the CLI to send", async () => {
    const { relay, url } = await startRelay({ keepAlive: { intervalMs: 20, timeoutMs: 100 } });
    // A half-open link: the deployment's end is gone without a close (no frames, no pongs).
    silent.upgrades = 1;
    const cli = await connect(url, "gho_owner");
    const [code, reason] = (await once(cli, "close")) as [number, Buffer];
    expect(code).toBe(1012);
    expect(reason.toString()).toBe("Managed Copilot stopped responding. Reconnecting.");
    // The stock CLI redials after 1012: attached again with a fresh ticket.
    const again = await connect(url, "gho_owner");
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} }));
    expect((await next(again)).result).toEqual({ protocolVersion: "0.9.0" });
    expect(relay.outcome).toBeUndefined();
    again.close();
  });

  it("counts a large message still arriving as life, so a slow link isn't taken for a dead one", async () => {
    // The deployment sends one ~60 KB frame for at least 1.5 s, more than the 1 s timeout. Only a stall of nearly the
    // whole timeout could end it early; a loaded machine just makes the transfer slower.
    const { url } = await startRelay({ keepAlive: { intervalMs: 50, timeoutMs: 1_000 } });
    slow.upgrades = 1;
    const cli = await connect(url, "gho_owner");
    // It arrives whole: the relay didn't end the link (which would close the CLI) while it was arriving.
    const arrived = await Promise.race([next(cli), once(cli, "close").then(() => undefined)]);
    expect(arrived?.params?.pad?.length).toBe(60_000);
    cli.close();
  }, 30_000);
});
