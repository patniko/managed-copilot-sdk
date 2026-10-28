import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { ConversationManager } from "../src/server/manager.js";
import { Store } from "../src/server/store.js";
import type { ConversationView, DispatchState } from "../src/shared/types.js";
import { FakePlatform, testConfig } from "./fakes.js";

let server: Server;
let base: string;
let dir: string;
let hub: EventHub;
let manager: ConversationManager;
let platform: FakePlatform;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-http-"));
  platform = new FakePlatform();
  hub = new EventHub(60_000);
  const config = testConfig(dir);
  manager = new ConversationManager(platform, config, new Store(dir), hub);
  manager.start();
  server = createServer(createRequestHandler({ conversations: manager, hub, config }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await manager.close();
  hub.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** A request with explicit Host and Origin headers (fetch can't set Host). */
function call(method: string, path: string, options: { body?: unknown; host?: string; origin?: string; contentType?: string } = {}): Promise<Reply> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          host: options.host ?? `localhost:${url.port}`,
          ...(options.origin ? { origin: options.origin } : {}),
          ...(payload !== undefined ? { "content-type": options.contentType ?? "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("Dispatch API", () => {
  it("reports health and the deployment's coordinator and blueprints", async () => {
    expect(await call("GET", "/api/health")).toEqual({ status: 200, body: { status: "ok", platform: "connected" } });
    const state = (await call("GET", "/api/state")).body as DispatchState;
    expect(state.coordinator).toMatchObject({ environment: "dispatch", maxWorkers: 6 });
    expect(state.blueprints.map((blueprint) => blueprint.name)).toEqual(["dispatch-python", "dispatch-node"]);
    expect(state.templates.length).toBeGreaterThan(0);
    expect(state.attachCommand).toBe("npx managed-copilot attach {sessionId}");
  });

  it("starts a conversation, takes messages, and answers sandbox requests", async () => {
    const created = await call("POST", "/api/conversations", { body: { prompt: "Estimate pi three ways", approvals: "ask" } });
    expect(created.status).toBe(201);
    const view = created.body as ConversationView;
    expect(view).toMatchObject({ title: "Estimate pi three ways", settings: { approvals: "ask" } });
    expect((await call("GET", `/api/conversations/${view.id}`)).status).toBe(200);
    expect((await call("POST", `/api/conversations/${view.id}/messages`, { body: { prompt: "And chart it" } })).status).toBe(202);
    expect(platform.sessions.get(view.id)?.sent.map((sent) => sent.prompt)).toEqual(["Estimate pi three ways", "And chart it"]);
    expect(await call("POST", `/api/conversations/${view.id}/approvals/nope`, { body: { approve: true } })).toMatchObject({ status: 409, body: { error: { code: "not_actionable" } } });
    expect(await call("POST", `/api/conversations/${view.id}/approvals/nope`, { body: { approve: "yes" } })).toMatchObject({ status: 400 });
    expect(await call("PUT", `/api/conversations/${view.id}/settings`, { body: { approvals: "auto" } })).toMatchObject({ status: 200, body: { settings: { approvals: "auto" } } });
    expect(await call("PUT", `/api/conversations/${view.id}/settings`, { body: { approvals: "sometimes" } })).toMatchObject({ status: 400 });
    expect((await call("DELETE", `/api/conversations/${view.id}`)).status).toBe(204);
    expect(await call("GET", `/api/conversations/${view.id}`)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  it("rejects bad input with plain messages", async () => {
    expect(await call("POST", "/api/conversations", { body: { prompt: "" } })).toMatchObject({ status: 400, body: { error: { message: "Write a message first." } } });
    expect(await call("POST", "/api/conversations", { body: { prompt: "x", approvals: "never" } })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/conversations", { body: "not json" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await call("POST", "/api/conversations", { body: "[]" })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/conversations", { body: "prompt=x", contentType: "application/x-www-form-urlencoded" })).toMatchObject({ status: 415 });
    expect(await call("GET", "/api/nothing")).toMatchObject({ status: 404 });
    expect(await call("PATCH", "/api/state")).toMatchObject({ status: 405 });
  });

  it("only attaches Copilot CLI to Dispatch's own sessions", async () => {
    expect(await call("POST", "/api/sessions/someone-else/attach")).toMatchObject({ status: 404 });
    const view = (await call("POST", "/api/conversations", { body: { prompt: "go" } })).body as ConversationView;
    const attached = await call("POST", `/api/sessions/${view.id}/attach`);
    // Tests never open console windows (DISPATCH_DISABLE_TERMINAL): the command comes back to run by hand.
    expect(attached).toMatchObject({ status: 200, body: { launched: false, command: `npx managed-copilot attach ${view.id}` } });
  });

  it("refuses other host names and cross-site requests", async () => {
    expect(await call("GET", "/api/state", { host: "attacker.example" })).toMatchObject({ status: 403 });
    expect(await call("POST", "/api/conversations", { body: { prompt: "go" }, origin: "https://attacker.example" })).toMatchObject({ status: 403, body: { error: { message: "Cross-site requests aren't allowed." } } });
  });

  it("explains that the UI isn't built yet", async () => {
    const page = await call("GET", "/");
    expect(page.status).toBe(503);
    expect(String(page.body)).toContain("Dispatch's UI isn't built yet");
  });
});

describe("hostAllowed", () => {
  it("allows loopback names and configured hosts only", () => {
    expect(hostAllowed("localhost:7470", "")).toBe(true);
    expect(hostAllowed("127.0.0.1", "")).toBe(true);
    expect(hostAllowed("[::1]:7470", "")).toBe(true);
    expect(hostAllowed("dispatch.dev.localhost:7470", "")).toBe(true);
    expect(hostAllowed("dispatch.example.com", "")).toBe(false);
    expect(hostAllowed("dispatch.example.com", "other.example, dispatch.example.com")).toBe(true);
    expect(hostAllowed(undefined, "")).toBe(false);
  });
});
