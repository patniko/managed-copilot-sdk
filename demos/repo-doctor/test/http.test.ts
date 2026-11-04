import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { RunManager } from "../src/server/runs.js";
import { loadSample } from "../src/server/sample.js";
import { RunStore } from "../src/server/store.js";
import type { AppState, RunDetail, RunView } from "../src/shared/types.js";
import { FakePlatform, testConfig, until } from "./fakes.js";

let server: Server;
let base: string;
let dir: string;
let hub: EventHub;
let manager: RunManager;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "repo-doctor-http-"));
  hub = new EventHub(60_000);
  const config = testConfig(dir);
  manager = new RunManager(new FakePlatform(), config, new RunStore(dir), hub, loadSample(config.sampleDir));
  manager.start();
  server = createServer(createRequestHandler({ runs: manager, hub, config }));
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
  readonly headers: Record<string, string | string[] | undefined>;
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("Repo Doctor API", () => {
  it("reports health and state", async () => {
    expect(await call("GET", "/api/health")).toMatchObject({ status: 200, body: { status: "ok", platform: "connected" } });
    const state = (await call("GET", "/api/state")).body as AppState;
    expect(state).toMatchObject({ runs: [], sample: { name: "bumpkit" }, maxRuns: 3, platform: { state: "connected" } });
  });

  it("runs the sample, then serves its detail and patch, and deletes it", async () => {
    const created = await call("POST", "/api/runs", { body: { sample: true } });
    expect(created.status).toBe(201);
    const { id } = created.body as RunView;
    await until(() => manager.detail(id).run.status !== "running" && manager.detail(id).run.sandbox.state === "deleted");

    const detail = (await call("GET", `/api/runs/${id}`)).body as RunDetail;
    expect(detail.run).toMatchObject({ status: "fixed", title: "bumpkit" });
    expect(detail.logs.reproduce.length).toBeGreaterThan(0);
    expect(((await call("GET", "/api/state")).body as AppState).runs.map((run) => run.id)).toEqual([id]);

    const patch = await call("GET", `/api/runs/${id}/patch`);
    expect(patch.status).toBe(200);
    expect(patch.headers["content-type"]).toBe("text/x-diff; charset=utf-8");
    expect(patch.headers["content-disposition"]).toBe('attachment; filename="bumpkit-run-1.patch"');
    expect(String(patch.body)).toContain("diff --git a/src/next-version.js b/src/next-version.js");

    expect(await call("POST", `/api/runs/${id}/stop`)).toMatchObject({ status: 409, body: { error: { code: "not_running" } } });
    expect((await call("DELETE", `/api/runs/${id}`)).status).toBe(204);
    expect(await call("GET", `/api/runs/${id}`)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  it("rejects bad input with plain messages", async () => {
    expect(await call("POST", "/api/runs", { body: { repo: "https://gitlab.com/o/r" } })).toMatchObject({ status: 400, body: { error: { message: "Repo Doctor clones public repositories from github.com." } } });
    expect(await call("POST", "/api/runs", { body: {} })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await call("POST", "/api/runs", { body: "not json" })).toMatchObject({ status: 400, body: { error: { message: "The request body isn't valid JSON." } } });
    expect(await call("POST", "/api/runs", { body: "repo=o/r", contentType: "application/x-www-form-urlencoded" })).toMatchObject({ status: 415 });
    expect(await call("GET", "/api/runs/r-nothing00/patch")).toMatchObject({ status: 404 });
    expect(await call("GET", "/api/nothing")).toMatchObject({ status: 404 });
    expect(await call("PATCH", "/api/state")).toMatchObject({ status: 405 });
  });

  it("refuses other host names and cross-site requests", async () => {
    expect(await call("GET", "/api/state", { host: "attacker.example" })).toMatchObject({ status: 403 });
    expect(await call("POST", "/api/runs", { body: { sample: true }, origin: "https://attacker.example" })).toMatchObject({ status: 403, body: { error: { message: "Cross-site requests aren't allowed." } } });
  });

  it("explains that the UI isn't built yet", async () => {
    const page = await call("GET", "/");
    expect(page.status).toBe(503);
    expect(String(page.body)).toContain("Repo Doctor's UI isn't built yet");
  });
});

describe("hostAllowed", () => {
  it("allows loopback names and configured hosts only", () => {
    expect(hostAllowed("localhost:7435", "")).toBe(true);
    expect(hostAllowed("127.0.0.1", "")).toBe(true);
    expect(hostAllowed("[::1]:7435", "")).toBe(true);
    expect(hostAllowed("repo-doctor.dev.localhost:7435", "")).toBe(true);
    expect(hostAllowed("repo-doctor.example.com", "")).toBe(false);
    expect(hostAllowed("repo-doctor.example.com", "other.example, repo-doctor.example.com")).toBe(true);
    expect(hostAllowed(undefined, "")).toBe(false);
  });
});
