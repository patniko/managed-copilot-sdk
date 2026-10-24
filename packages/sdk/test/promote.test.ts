import { createServer, type IncomingMessage, type Server } from "node:http";
import { isManagedCopilotError, type DeploymentInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promoteSession } from "../src/features/promote.js";
import { HttpClient } from "../src/http.js";
import type { ManagedContext } from "../src/types.js";

describe("managed.promote", () => {
  const seen: { method: string; url: string; authorization: string | undefined }[] = [];
  let server: Server;
  let ctx: ManagedContext;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      for await (const _chunk of req) {
        // drain
      }
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
      if (req.method === "POST" && req.url === "/v1/sessions/s-1/promote") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s-1", placement: "sandbox", sandboxId: "sbx_1", generation: 1 }));
      } else if (req.method === "POST" && req.url === "/v1/sessions/busy/promote") {
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "session_busy", message: "Session busy is working on a turn; promote it once the turn completes" } }));
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "Session x was not found" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const http = new HttpClient(url, "connection-token");
    const owner = new HttpClient(url, "session-owner-token");
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
      httpFor: (sessionId: string) => (sessionId === "s-1" ? owner : http),
    } as unknown as ManagedContext;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("posts to the promote route as the identity that owns the session", async () => {
    expect(await promoteSession(ctx, "s-1")).toEqual({ sessionId: "s-1", placement: "sandbox", sandboxId: "sbx_1", generation: 1 });
    expect(seen.at(-1)).toEqual({ method: "POST", url: "/v1/sessions/s-1/promote", authorization: ["Bearer", "session-owner-token"].join(" ") });
  });

  it("surfaces stable error codes", async () => {
    expect(isManagedCopilotError(await promoteSession(ctx, "busy").catch((error: unknown) => error), "session_busy")).toBe(true);
    expect(isManagedCopilotError(await promoteSession(ctx, "missing").catch((error: unknown) => error), "not_found")).toBe(true);
  });
});
