import { createServer, type IncomingMessage, type Server } from "node:http";
import { isManagedCopilotError, type DeploymentInfo, type WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManagedState } from "../src/connection.js";
import { createWorkersApi } from "../src/features/workers.js";
import { HttpClient } from "../src/http.js";

const WORKER: WorkerInfo = {
  id: "w-1",
  name: "counter",
  coordinatorId: "team-1",
  environment: "coder",
  state: "idle",
  task: "Count the files",
  result: "42 files",
  messages: 1,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:01:00.000Z",
};

describe("managed.workers", () => {
  const seen: { url: string; authorization: string | undefined }[] = [];
  let server: Server;
  let ctx: ManagedState;
  let url: string;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      for await (const _chunk of req) {
        // drain
      }
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/v1/sessions/team-1/workers") json(200, [WORKER]);
      else if (req.url === "/v1/sessions/team-1/workers/counter") json(200, WORKER);
      else if (req.url === "/v1/sessions/chat-1/workers") json(400, { error: { code: "invalid_request", message: "Session chat-1 is shared; only orchestrator sessions have workers" } });
      else json(404, { error: { code: "not_found", message: "Not found" } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const http = new HttpClient(url, "connection-token");
    const identities = new Map<string, string>([["team-1", "coordinator-owner-token"]]);
    const httpClients = new Map<string, HttpClient>([["connection-token", http]]);
    ctx = {
      url,
      token: "connection-token",
      clientName: undefined,
      info: {} as DeploymentInfo,
      account: { id: 1, login: "alice" },
      http,
      clients: new Set(),
      listeners: new Map(),
      disposables: new Set(),
      identities,
      cachedClients: new Map(),
      httpClients,
      httpFor(sessionId: string) {
        const identity = identities.get(sessionId);
        if (!identity) return http;
        let client = httpClients.get(identity);
        if (!client) httpClients.set(identity, (client = new HttpClient(url, identity)));
        return client;
      },
    };
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("lists and gets workers as the identity that owns the coordinator", async () => {
    const workers = createWorkersApi(ctx, "team-1");
    expect(await workers.list()).toEqual([WORKER]);
    expect(seen.at(-1)).toEqual({ url: "/v1/sessions/team-1/workers", authorization: ["Bearer", "coordinator-owner-token"].join(" ") });
    expect(await workers.get("counter")).toEqual(WORKER);
    expect(seen.at(-1)?.url).toBe("/v1/sessions/team-1/workers/counter");
  });

  it("lets helpers for a listed worker act as the coordinator's identity", async () => {
    await createWorkersApi(ctx, "team-1").list();
    expect(ctx.identities.get("w-1")).toBe("coordinator-owner-token");
    expect(ctx.httpFor("w-1")).toBe(ctx.httpFor("team-1"));
  });

  it("surfaces stable error codes for sessions without workers", async () => {
    expect(isManagedCopilotError(await createWorkersApi(ctx, "chat-1").list().catch((error: unknown) => error), "invalid_request")).toBe(true);
    expect(isManagedCopilotError(await createWorkersApi(ctx, "team-1").get("missing").catch((error: unknown) => error), "not_found")).toBe(true);
  });
});
