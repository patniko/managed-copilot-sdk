import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { createRequestHandler } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { Factory } from "../src/server/pipeline/factory.js";
import type { Platform } from "../src/server/platform.js";
import { FactoryStore } from "../src/server/store.js";
import type { FactoryState, PlatformStatus, WorkOrder } from "../src/shared/types.js";
import { FakePlatform, manifest, testReport } from "./fakes.js";

const PLAN = {
  summary: "One task.",
  projectName: "tiny",
  packageDescription: "Tiny",
  bin: {},
  tasks: [{ id: "core", title: "Core", description: "Do it.", files: ["src/core.js", "test/core.test.js"], acceptance: ["works"], dependsOn: [] }],
  integration: "Run it.",
};

let server: Server;
let base: string;
let hub: EventHub;
let factory: Factory;
let ready = true;

const status = (): PlatformStatus => ({
  state: ready ? "connected" : "unavailable",
  ...(ready ? {} : { message: "The Managed Copilot platform isn't running.", hint: "Start it with `aspire run`." }),
  environments: [],
  missingEnvironments: [],
  features: { runs: ready, isolated: ready, artifacts: ready, files: ready, attach: false },
  checkedAt: new Date().toISOString(),
});

beforeAll(async () => {
  const platform = new FakePlatform({
    planner: async (session) => void (await session.callTool("submit_plan", PLAN)),
    builder: async (session, _prompt, fake) =>
      fake.publish(session.sessionId, {
        "files/src/core.js": "export const answer = 42;\n",
        "test-report.json": testReport(2) + " ".repeat(session.prompts.length),
        "manifest.json": manifest(["src/core.js"]),
      }),
    reviewer: async (session) => void (await session.callTool("submit_review", { verdict: "approve", summary: "Fine.", findings: [] })),
    release: async (session, _prompt, fake) =>
      fake.publish(session.sessionId, {
        "bundle/src/core.js": "export const answer = 42;\n",
        "bundle/README.md": "# tiny\n",
        "project.patch": "diff --git a/src/core.js b/src/core.js\n",
        "test-report.json": testReport(3, 0, "release"),
        "manifest.json": manifest(["src/core.js", "README.md"], "release"),
        "RELEASE.md": "# tiny 0.1.0\n",
      }),
  });
  hub = new EventHub(60_000);
  factory = new Factory({
    store: new FactoryStore(":memory:"),
    hub,
    platform,
    readiness: () => ({ ready, reason: "The Managed Copilot platform isn't running." }),
    account: () => ({ login: "octocat" }),
    config: { maxSandboxes: 2, turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000 }, publicationTimeoutMs: 1_000 },
  });
  const config = { ...loadConfig({}), webRoot: "Z:/nonexistent-web-root" };
  const fakePlatform = { get status() { return status(); } } as unknown as Platform;
  server = createServer(createRequestHandler({ factory, platform: fakePlatform, hub, config }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  hub.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
};

const post = (path: string, body: unknown) => json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(id: string): Promise<WorkOrder> {
  for (let i = 0; i < 400; i++) {
    const { body } = await json<WorkOrder>(`/api/work-orders/${id}`);
    if (!factory.isActive(id) && ["completed", "failed", "cancelled"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("work order did not settle");
}

describe("factory HTTP API", () => {
  it("reports state, health, and templates", async () => {
    const { status: code, body } = await json<FactoryState>("/api/state");
    expect(code).toBe(200);
    expect(body.templates.some((template) => template.featured)).toBe(true);
    expect(body.attachCommand).toBe("npx managed-copilot attach {sessionId}");
    expect((await json<{ status: string }>("/api/health")).body.status).toBe("ok");
  });

  it("refuses work while the platform is unavailable, with a friendly message", async () => {
    ready = false;
    const response = await post("/api/work-orders", { title: "Tiny", brief: "Build a tiny library with tests, please." });
    ready = true;
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "platform_unavailable", message: "The Managed Copilot platform isn't running." } });
  });

  it("runs a work order and serves its activity, artifacts, and release", async () => {
    const created = await post("/api/work-orders", { title: "Tiny", brief: "Build a tiny library with tests, please." });
    expect(created.status).toBe(201);
    const wo = await waitFor((created.body as WorkOrder).id);
    expect(wo.status).toBe("completed");

    const activity = await json<unknown[]>(`/api/work-orders/${wo.id}/activity?stationId=plan`);
    expect(activity.body.length).toBeGreaterThan(0);
    const index = await json<{ files: { stationId: string; path: string }[] }>(`/api/work-orders/${wo.id}/artifacts`);
    expect(index.body.files.map((file) => `${file.stationId}:${file.path}`)).toContain("release:RELEASE.md");

    const content = await fetch(`${base}/api/work-orders/${wo.id}/artifacts/content?stationId=build:core&path=files/src/core.js`);
    expect(content.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await content.text()).toBe("export const answer = 42;\n");

    const zip = await fetch(`${base}/api/work-orders/${wo.id}/bundle.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-disposition")).toBe('attachment; filename="tiny.zip"');
    expect(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0)).toBe(0x04034b50);

    const conflict = await json(`/api/work-orders/${wo.id}/retry`, { method: "POST" });
    expect(conflict.status).toBe(409);

    const sessionId = wo.stations.find((station) => station.id === "build:core")!.sessionId!;
    const attach = await post(`/api/sessions/${sessionId}/attach`, {});
    expect(attach.status).toBe(200);
    expect(attach.body).toMatchObject({ command: `npx managed-copilot attach ${sessionId}` });

    const removed = await fetch(`${base}/api/work-orders/${wo.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect((await json(`/api/work-orders/${wo.id}`)).status).toBe(404);
  });

  it("guards against rebinding, cross-site requests, and bad input", async () => {
    // fetch() can't override Host, so these use node:http directly.
    const withHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(`${base}/api/state`);
        request({ host: url.hostname, port: url.port, path: url.pathname, headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on("error", reject)
          .end();
      });
    expect(await withHost("attacker.example")).toBe(403);
    expect(await withHost("software-factory.dev.localhost:7480")).toBe(200);
    expect(await withHost("[::1]:7480")).toBe(200);
    const crossSite = await fetch(`${base}/api/work-orders`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    const notJson = await fetch(`${base}/api/work-orders`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
    expect(notJson.status).toBe(415);
    expect((await post("/api/work-orders", { title: "x", brief: "y" })).status).toBe(400);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/work-orders`, { method: "PATCH" })).status).toBe(405);
    expect((await post("/api/sessions/not-ours/attach", {})).status).toBe(404);
    expect((await fetch(`${base}/api/work-orders/%E0%A4%A`)).status).toBe(404);
    expect((await fetch(`${base}/%`)).status).toBe(503); // no crash: the "UI isn't built" page in this test setup
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("isn't built yet");
  });
});
