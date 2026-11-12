import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Datasets, type DatasetsOptions } from "../src/server/datasets.js";
import { DeskError } from "../src/server/errors.js";
import type { FactoryClient } from "../src/server/factory.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { AnalysisManager } from "../src/server/manager.js";
import { downhillSales } from "../src/server/remote.js";
import { Store } from "../src/server/store.js";
import type { AnalysisView, DeskState, RowsPage, SendToFactoryResponse } from "../src/shared/types.js";
import { csvResponse, event, FakeFactory, fakeDownhill, FakePlatform, testConfig } from "./fakes.js";

const servers: Server[] = [];
const hubs: EventHub[] = [];
const managers: AnalysisManager[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve(options: { factory?: FactoryClient; datasets?: DatasetsOptions } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "desk-http-"));
  const config = testConfig(dataDir);
  mkdirSync(config.webRoot, { recursive: true });
  writeFileSync(join(config.webRoot, "index.html"), "<!doctype html><title>Data Desk</title>");
  const datasets = new Datasets(config.samplesDir, dataDir, config.maxUploadBytes, options.datasets);
  datasets.load();
  const platform = new FakePlatform();
  const hub = new EventHub();
  hubs.push(hub);
  const analyses = new AnalysisManager(platform, config, new Store(dataDir), datasets, hub, options.factory);
  managers.push(analyses);
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
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["sample-checkout-funnel", "sample-coffee-sales", "sample-bike-rides", "sample-support-tickets"]);
    expect(state.remoteSamples).toEqual([]);
    expect(state.environments.map((environment) => environment.name)).toEqual(["data-desk", "data-desk-python"]);
    expect(state.attachCommand).toBe("npx managed-copilot attach {sessionId}");
    expect(state.factory).toEqual({ configured: false });
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

  it("offers Downhill's shop sales with DOWNHILL_URL, and starts an analysis of a fresh copy", async () => {
    const downhill = fakeDownhill();
    const { url, platform } = await serve({ datasets: { remote: [downhillSales("http://downhill.test")], fetch: downhill.fetch } });
    const state = (await (await fetch(`${url}/api/state`)).json()) as DeskState;
    expect(state.remoteSamples).toEqual([{ id: "live-downhill-sales", name: "Downhill shop sales", description: "Live from Downhill's shop, since launch" }]);
    expect(downhill.calls).toEqual([]);

    const created = await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "live-downhill-sales" }) });
    expect(created.status).toBe(201);
    const view = (await created.json()) as AnalysisView;
    expect(downhill.calls).toEqual(["http://downhill.test/api/sales.csv"]);
    expect(view).toMatchObject({ title: "Downhill shop sales", placement: "shared", dataset: { name: "Downhill shop sales", fileName: "downhill-sales.csv", rows: 103 } });
    expect(view.dataset?.prompts.map((prompt) => prompt.text)).toEqual([
      "How many promo codes were rejected in the last hour? List them, newest first",
      "Chart promotional sales and rejected promo codes every 10 minutes since launch",
    ]);
    // The grid pages through the copy, whose newest row is the presenter's failed sale.
    const page = (await (await fetch(`${url}/api/datasets/${view.datasetId}/rows?offset=102`)).json()) as RowsPage;
    expect(page.rows).toEqual([["2026-11-18 10:23:41", "203", "promo_rejected", "", "Neon Mona", "outfit", "4.99", "trail15", "rejected", "", "", "presenter", "live"]]);
    const instructions = (platform.sessions.get(view.id)!.config as { systemMessage?: { content: string } }).systemMessage?.content;
    expect(instructions).toContain("count promotional sales as purchases with promo_result applied");
    expect(instructions).toContain("/workspace/data/downhill-sales.csv");
    expect(((await (await fetch(`${url}/api/state`)).json()) as DeskState).datasets.map((dataset) => dataset.id)).not.toContain(view.datasetId);
  });

  it("says why Downhill's sales couldn't be loaded", async () => {
    const downhill = fakeDownhill(() => csvResponse("", { status: 404, statusText: "Not Found" }));
    const { url, platform } = await serve({ datasets: { remote: [downhillSales("http://downhill.test")], fetch: downhill.fetch } });
    const response = await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "live-downhill-sales" }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "sample_unavailable", message: "Couldn't load Downhill's sales from http://downhill.test/api/sales.csv: it answered HTTP 404 Not Found." },
    });
    expect(platform.sessions.size).toBe(0);
  });
});

describe("Send to Software Factory", () => {
  const NOTE = "Build a free-shipping progress bar experiment for mobile carts under $50, and the metrics to watch.";
  const RESULT = {
    title: "Funnel by device and cart value",
    matched: 2,
    columns: ["device", "cart_value", "sum(reached_shipping)", "sum(reached_payment)"],
    rows: [
      ["desktop", "$40–$49", "3434", "2754"],
      ["mobile", "$40–$49", "4790", "2246"],
    ],
  };

  /** An analysis of the checkout funnel in which Copilot answered with a table. */
  async function analyzed(url: string, platform: FakePlatform): Promise<string> {
    const view = (await (await json(`${url}/api/analyses`, { method: "POST", body: JSON.stringify({ datasetId: "sample-checkout-funnel" }) })).json()) as AnalysisView;
    const session = platform.sessions.get(view.id)!;
    session.emit(event("user.message", { content: "Where do mobile shoppers drop out of checkout, by cart value?" }));
    session.emit(event("tool.execution_start", { toolCallId: "call-1", toolName: "aggregate", arguments: { title: RESULT.title, groupBy: ["device", "cart_value"] } }));
    session.emit(event("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: JSON.stringify(RESULT) } }));
    session.emit(event("assistant.message", { messageId: "m1", content: "Mobile shoppers with $40–$49 carts drop out at the shipping step." }));
    session.emit(event("session.idle", {}, { ephemeral: true }));
    return view.id;
  }

  const send = (url: string, id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/analyses/${encodeURIComponent(id)}/factory`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;

  it("is off, and says why, when Software Factory isn't connected", async () => {
    const { url, platform } = await serve();
    const id = await analyzed(url, platform);
    const response = await send(url, id, { title: "A title", note: NOTE });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toEqual({ code: "factory_unavailable", message: "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL." });
  });

  it("sends the view, the selected rows, the dataset, and the insight, with a link back", async () => {
    const factory = new FakeFactory();
    const { url, platform } = await serve({ factory });
    expect(((await (await fetch(`${url}/api/state`)).json()) as DeskState).factory).toEqual({ configured: true, url: "http://factory.test" });
    const id = await analyzed(url, platform);

    const invalid = await send(url, id, { title: "Hi", note: NOTE });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe("Give it a title of 3 to 120 characters.");
    expect((await send(url, "missing", { title: "A title", note: NOTE })).status).toBe(404);

    const response = await send(
      url,
      id,
      {
        title: "Free-shipping progress bar for mobile carts",
        note: NOTE,
        include: { view: { kind: "result", resultId: "call-1" }, selections: [{ table: { kind: "result", resultId: "call-1" }, rows: [1] }], dataset: true, answer: true },
      },
      { origin: url },
    );
    expect(response.status).toBe(201);
    const sent = (await response.json()) as SendToFactoryResponse;
    expect(sent.routing).toMatchObject({ workOrderId: "wo_12", number: 12, status: "queued", url: "http://factory.test/#/wo/wo_12" });
    expect(sent.analysis.items.at(-1)).toMatchObject({ kind: "factory", routing: { number: 12 } });

    const body = factory.created[0]!;
    expect(body).toMatchObject({
      title: "Free-shipping progress bar for mobile carts",
      maxReviewRounds: 2,
      origin: { app: "data-desk", name: "Data Desk", label: "Storefront checkout funnel", url: `${url}/#/a/${encodeURIComponent(id)}`, key: `${id}:1` },
    });
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("project");
    expect(body.context.map((file) => file.path)).toEqual(["INSIGHT.md", "data/funnel-by-device-and-cart-value.csv", "data/funnel-by-device-and-cart-value-selection.csv", "data/checkout-funnel.csv"]);
    expect(body.context[2]!.content).toBe("device,cart_value,sum(reached_shipping),sum(reached_payment)\nmobile,$40–$49,4790,2246\n");
    expect(body.brief.startsWith(NOTE)).toBe(true);
    expect(body.brief).toContain("> Mobile shoppers with $40–$49 carts drop out at the shipping step.");

    // Without an Origin header, the link uses the Host.
    await send(url, id, { title: "Again", note: NOTE });
    expect(factory.created[1]!.origin).toMatchObject({ url: `${url}/#/a/${encodeURIComponent(id)}`, key: `${id}:2` });
    expect(((await (await fetch(`${url}/api/analyses/${id}`)).json()) as AnalysisView).factory?.map((routing) => routing.number)).toEqual([12, 13]);
  });

  it("passes on what the factory says when it refuses or doesn't answer", async () => {
    const factory = new FakeFactory();
    const { url, platform } = await serve({ factory });
    const id = await analyzed(url, platform);
    factory.failure = new DeskError("payload_too_large", "The context is larger than 512 KB.", 413);
    const refused = await send(url, id, { title: "A title", note: NOTE });
    expect(refused.status).toBe(413);
    expect(await errorOf(refused)).toEqual({ code: "payload_too_large", message: "The context is larger than 512 KB." });
    factory.failure = new DeskError("factory_unreachable", "Software Factory didn't answer at http://factory.test.", 502);
    const down = await send(url, id, { title: "A title", note: NOTE });
    expect(down.status).toBe(502);
    expect((await errorOf(down)).message).toBe("Software Factory didn't answer at http://factory.test.");
    expect(((await (await fetch(`${url}/api/analyses/${id}`)).json()) as AnalysisView).factory).toBeUndefined();
  });
});
