import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HelpDesk } from "../src/server/desk.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { sessionIdFor } from "../src/server/ticket.js";
import type { ApiErrorBody, HelpDeskState, RunInfo, SoftwareIssue } from "../src/shared/types.js";
import { FakeFactory, FakePlatform, reportBug, settle, testConfig } from "./fakes.js";

const servers: Server[] = [];
const desks: HelpDesk[] = [];
afterEach(async () => {
  for (const desk of desks.splice(0)) desk.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(platform = new FakePlatform(), factory = new FakeFactory()): Promise<string> {
  const hub = new EventHub();
  const config = testConfig();
  const desk = new HelpDesk(platform, config, (event) => hub.publish(event), factory);
  desks.push(desk);
  const server = createServer(createRequestHandler({ desk, hub, config }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function raw(url: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(init.body);
  });
}

describe("http", () => {
  it("answers only loopback host names, plus the deployment's own", () => {
    expect(hostAllowed("localhost:7440")).toBe(true);
    expect(hostAllowed("127.0.0.1")).toBe(true);
    expect(hostAllowed("[::1]:7440")).toBe(true);
    expect(hostAllowed("help-desk.localhost")).toBe(true);
    expect(hostAllowed("attacker.example")).toBe(false);
    expect(hostAllowed("help-desk.example.io", "help-desk.example.io,help-desk")).toBe(true);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("reports health and state", async () => {
    const url = await start();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    const state = (await (await fetch(`${url}/api/state`)).json()) as HelpDeskState;
    expect(state.customers).toHaveLength(25);
    expect(state.desk).toMatchObject({ environment: "help-desk", model: "claude-haiku-4.5" });
    expect(state.counters).toEqual({ sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 });
  });

  it("starts and ends a simulation", async () => {
    const platform = new FakePlatform();
    const url = await start(platform);
    const started = await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 5 }) });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ size: 5 });
    const ended = await fetch(`${url}/api/simulation`, { method: "DELETE" });
    expect(ended.status).toBe(204);
  });

  it("explains bad requests in plain words", async () => {
    const url = await start();
    const badSize = await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 3 }) });
    expect(badSize.status).toBe(400);
    expect(((await badSize.json()) as ApiErrorBody).error.message).toBe("Simulate 5, 10, 25 customers.");
    expect((await fetch(`${url}/api/simulation`, { method: "POST", body: "size=5" })).status).toBe(415);
    expect((await fetch(`${url}/api/tickets/c01`)).status).toBe(404);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/state`, { method: "PUT" })).status).toBe(405);
  });

  it("refuses other host names and cross-site requests", async () => {
    const url = await start();
    expect((await raw(url, "/api/state", { headers: { host: "attacker.example" } })).status).toBe(403);
    const crossSite = await raw(url, "/api/simulation", { method: "DELETE", headers: { origin: "https://attacker.example" } });
    expect(crossSite.status).toBe(403);
  });

  it("explains a missing UI build instead of a blank page", async () => {
    const url = await start();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Help Desk's UI isn't built yet");
  });

  it("sends a software issue to Software Factory once, linking back to the address the operator uses", async () => {
    const platform = new FakePlatform();
    const factory = new FakeFactory();
    const url = await start(platform, factory);
    const port = new URL(url).port;
    const run = (await (await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 10 }) })).json()) as RunInfo;
    const session = (customerId: string) => platform.sessions.get(sessionIdFor(run.id, customerId));
    for (let tries = 0; tries < 50 && !(session("c05")?.sent.length && session("c08")?.sent.length); tries++) await settle(5);
    await reportBug(session("c05")!, "The code TRAIL15 says 'invalid code' at checkout.", { area: "promo-codes", title: "TRAIL15 rejected", whatHappened: "Pasted TRAIL15, got 'invalid code'.", expected: "15% off." });
    await reportBug(session("c08")!, "Changed 1 to 2, charged for 3.", { area: "cart", title: "Quantity change adds", whatHappened: "Changed 1 to 2, charged for 3.", expected: "Charged for 2." });

    const route = (area: string, headers: Record<string, string> = {}) => raw(url, `/api/issues/${area}/route`, { method: "POST", headers });
    const sent = await route("promo-codes", { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    expect(sent.status).toBe(201);
    expect(JSON.parse(sent.body) as SoftwareIssue).toMatchObject({ area: "promo-codes", routed: { workOrderId: "wo_1", number: 1, status: "queued", url: "http://factory.test/#/wo/wo_1" } });
    expect(factory.created[0]?.origin).toMatchObject({ app: "help-desk", url: `http://localhost:${port}/#/c/c05`, key: `${run.id}:promo-codes` });
    // Without an Origin (not a browser), the link uses the Host.
    expect((await route("cart")).status).toBe(201);
    expect(factory.created[1]?.origin?.url).toBe(`${url}/#/c/c08`);

    const again = await route("promo-codes");
    expect(again.status).toBe(409);
    expect((JSON.parse(again.body) as ApiErrorBody).error).toEqual({ code: "conflict", message: "This issue was sent to Software Factory already, as WO-0001." });
    expect((await route("promo-codes", { origin: "https://attacker.example" })).status).toBe(403);
    expect((await route("checkout")).status).toBe(404);

    const state = (await (await fetch(`${url}/api/state`)).json()) as HelpDeskState;
    expect(state.desk.factory).toEqual({ configured: true, url: "http://factory.test" });
    expect(state.issues.map((issue) => [issue.area, issue.routed?.number])).toEqual([
      ["promo-codes", 1],
      ["cart", 2],
    ]);
  });

  it("answers 503 with the reason when Software Factory isn't connected", async () => {
    const factory = new FakeFactory();
    factory.configured = false;
    const url = await start(new FakePlatform(), factory);
    const response = await fetch(`${url}/api/issues/promo-codes/route`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "factory_unavailable", message: "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL." } });
    expect(((await (await fetch(`${url}/api/state`)).json()) as HelpDeskState).desk.factory).toEqual({ configured: false });
  });
});
