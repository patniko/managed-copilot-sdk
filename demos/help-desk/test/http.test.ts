import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HelpDesk } from "../src/server/desk.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import type { ApiErrorBody, HelpDeskState } from "../src/shared/types.js";
import { FakePlatform, testConfig } from "./fakes.js";

const servers: Server[] = [];
const desks: HelpDesk[] = [];
afterEach(async () => {
  for (const desk of desks.splice(0)) desk.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(platform = new FakePlatform()): Promise<string> {
  const hub = new EventHub();
  const config = testConfig();
  const desk = new HelpDesk(platform, config, (event) => hub.publish(event));
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
});
