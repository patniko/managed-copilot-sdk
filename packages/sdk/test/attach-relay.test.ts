import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  github = createServer((req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const user = token === "gho_owner" ? OWNER : token === "gho_other" ? { id: 7, login: "other" } : undefined;
    res.writeHead(user ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(user ?? { message: "Bad credentials" }));
  });
  process.env.MANAGED_COPILOT_GITHUB_API_URL = await listen(github);

  const wss = new WebSocketServer({ noServer: true });
  gateway = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/sessions/s1/attach") {
      const token = `mcat_ticket${minted.length}`;
      minted.push(token);
      const material: AttachMaterial = { transport: "ahp", url: "ws://elsewhere.example:1/v1/sessions/s1/ahp", token, expiresAt: new Date(Date.now() + 60_000).toISOString(), ahpSessionId: "ahp-session:/s1" };
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      gatewaySockets.add(ws);
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

  async function startRelay() {
    // Imported after the fake GitHub API URL is set, as the launcher reads it at load.
    const { AttachRelay } = await import("../src/features/cli.js");
    const http = new HttpClient(gatewayUrl, "user-token");
    const first = await http.post<AttachMaterial>("/v1/sessions/s1/attach");
    const relay = new AttachRelay({ sessionId: "s1", owner: OWNER, deploymentUrl: gatewayUrl, http, first });
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
});
