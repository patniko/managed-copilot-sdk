import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Datasets } from "../src/server/datasets.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { AnalysisManager } from "../src/server/manager.js";
import { Store } from "../src/server/store.js";
import type { AnalysisView, DeskState } from "../src/shared/types.js";
import { FakePlatform, testConfig } from "./fakes.js";

const servers: Server[] = [];
const hubs: EventHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "desk-http-"));
  const config = testConfig(dataDir);
  mkdirSync(config.webRoot, { recursive: true });
  writeFileSync(join(config.webRoot, "index.html"), "<!doctype html><title>Data Desk</title>");
  const datasets = new Datasets(config.samplesDir, dataDir, config.maxUploadBytes);
  datasets.load();
  const platform = new FakePlatform();
  const hub = new EventHub();
  hubs.push(hub);
  const analyses = new AnalysisManager(platform, config, new Store(dataDir), datasets, hub);
  analyses.start();
  const server = createServer(createRequestHandler({ analyses, hub, config }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, platform };
}

const json = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });

describe("the API", () => {
  it("answers health, state, and the UI", async () => {
    const { url } = await serve();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    const state = (await (await fetch(`${url}/api/state`)).json()) as DeskState;
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["sample-coffee-sales", "sample-bike-rides", "sample-support-tickets"]);
    expect(state.environments.map((environment) => environment.name)).toEqual(["data-desk", "data-desk-python"]);
    expect(state.attachCommand).toBe("npx managed-copilot attach {sessionId}");
    expect(await (await fetch(`${url}/a/route`)).text()).toContain("Data Desk");
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });

  it("pages through a dataset's rows", async () => {
    const { url } = await serve();
    const page = (await (await fetch(`${url}/api/datasets/sample-coffee-sales/rows?offset=140&limit=10`)).json()) as { offset: number; total: number; rows: string[][] };
    expect(page).toMatchObject({ offset: 140, total: 144 });
    expect(page.rows).toHaveLength(4);
    expect((await fetch(`${url}/api/datasets/missing/rows`)).status).toBe(404);
  });

  it("adds an uploaded CSV, and refuses other files", async () => {
    const { url } = await serve();
    const upload = (name: string, body: string) => fetch(`${url}/api/datasets`, { method: "POST", headers: { "content-type": "text/csv", "x-file-name": encodeURIComponent(name) }, body });
    const added = await upload("Team scores.csv", "team,score\nRed,3\nBlue,5\n");
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ name: "Team scores", fileName: "team-scores.csv", rows: 2 });
    expect((await upload("notes.docx", "x")).status).toBe(400);
    expect((await upload("big.csv", `a\n${"1\n".repeat(40_000)}`)).status).toBe(413);
  });

  it("starts an analysis, takes messages, and answers a move request", async () => {
    const { url, platform } = await serve();
    const created = await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "sample-bike-rides" }) });
    expect(created.status).toBe(201);
    const view = (await created.json()) as AnalysisView;
    expect(view).toMatchObject({ title: "City bike rides", placement: "shared" });
    expect((await json(`${url}/api/analyses/${view.id}/messages`, { method: "POST", body: JSON.stringify({ prompt: "Hi" }) })).status).toBe(202);
    expect(platform.sessions.get(view.id)?.sent).toEqual([{ prompt: "Hi" }]);
    const move = await json(`${url}/api/analyses/${view.id}/move`, { method: "POST", body: JSON.stringify({ approve: true }) });
    expect(move.status).toBe(409);
    expect(((await move.json()) as { error: { code: string } }).error.code).toBe("not_actionable");
    expect((await json(`${url}/api/analyses/${view.id}/move`, { method: "POST", body: JSON.stringify({ approve: "yes" }) })).status).toBe(400);
    expect((await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "nope" }) })).status).toBe(404);
  });

  it("serves published charts as images that can't run as pages", async () => {
    const { url, platform } = await serve();
    const view = (await (await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "sample-coffee-sales" }) })).json()) as AnalysisView;
    platform.promote(view.id, "sbx_1");
    platform.artifacts.set(view.id, [{ id: "a1", path: "chart.svg", size: 10, digest: "d", turnId: "t", version: 1, state: "published", publishedAt: "2026-11-04T10:00:00.000Z" }]);
    platform.publish({ type: "artifact.published", sessionId: view.id, data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chart = await fetch(`${url}/api/analyses/${view.id}/output?path=chart.svg`);
    expect(chart.status).toBe(200);
    expect(chart.headers.get("content-type")).toBe("image/svg+xml");
    expect(chart.headers.get("content-security-policy")).toContain("sandbox");
    expect(chart.headers.get("x-content-type-options")).toBe("nosniff");
    expect(chart.headers.get("content-disposition")).toBe('inline; filename="chart.svg"');
    expect((await fetch(`${url}/api/analyses/${view.id}/output?path=chart.svg&download=1`)).headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await fetch(`${url}/api/analyses/${view.id}/output?path=other.svg`)).status).toBe(404);
  });

  it("refuses other host names and cross-site requests", async () => {
    const { url } = await serve();
    const status = (headers: Record<string, string>, method = "GET", path = "/api/health") =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${url}${path}`, { method, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once("error", reject);
        req.end(method === "POST" ? "{}" : undefined);
      });
    expect(await status({ host: "attacker.example" })).toBe(403);
    expect(await status({ origin: "https://attacker.example", "content-type": "application/json" }, "POST", "/api/analyses")).toBe(403);
    expect(hostAllowed("data-desk.localhost:7430")).toBe(true);
    expect(hostAllowed("desk.example.com", "desk.example.com")).toBe(true);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("only attaches Copilot CLI to its own analyses", async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/api/analyses/someone-else/attach`, { method: "POST" })).status).toBe(404);
    const view = (await (await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "sample-coffee-sales" }) })).json()) as AnalysisView;
    const attach = (await (await fetch(`${url}/api/analyses/${view.id}/attach`, { method: "POST" })).json()) as { command: string; launched: boolean };
    expect(attach).toMatchObject({ command: `npx managed-copilot attach ${view.id}`, launched: false });
  });
});
