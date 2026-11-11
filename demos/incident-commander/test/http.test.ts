import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertsAccepted, AppSettings, AppState, CreatedIncident, IncidentView } from "../src/shared/types.js";
import type { AppConfig } from "../src/server/config.js";
import { Commander } from "../src/server/commander.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { ServiceCatalog } from "../src/server/services.js";
import { Store } from "../src/server/store.js";
import { FakeFactory, FakePlatform, settle, testConfig } from "./fakes.js";

let server: Server;
let base: string;
let platform: FakePlatform;
let hub: EventHub;
let factory: FakeFactory | undefined;

async function serve(config: AppConfig): Promise<void> {
  platform = new FakePlatform();
  hub = new EventHub();
  const commander = new Commander(config, platform, new Store(mkdtempSync(join(tmpdir(), "incident-http-"))), new ServiceCatalog(config.demoServicesDir), hub);
  commander.start();
  server = createServer(createRequestHandler({ commander, hub }, join(tmpdir(), "no-web-root")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
}

async function stop(): Promise<void> {
  hub.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

beforeEach(async () => {
  await serve(testConfig());
});

afterEach(async () => {
  await stop();
  await factory?.close();
  factory = undefined;
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const ALERT = { title: "Checkout errors", service: "checkout", severity: "major", summary: "5xx rate is 12%", id: "checkout-5xx" };

describe("the API", () => {
  it("answers only loopback names and the deployment's hosts", () => {
    expect(hostAllowed("localhost:7445")).toBe(true);
    expect(hostAllowed("incident-commander.localhost")).toBe(true);
    expect(hostAllowed("[::1]:7445")).toBe(true);
    expect(hostAllowed("evil.example")).toBe(false);
    expect(hostAllowed("incident-commander.example.io", "incident-commander.example.io,incident-commander")).toBe(true);
  });

  it("reports its health and state", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as AppState;
    expect(state.integrations).toEqual({
      alertsUrl: "http://localhost:7445/api/alerts",
      alertsConfigured: true,
      webhookConfigured: true,
      deployConfigured: false,
      factory: { configured: false },
    });
    expect(state.settings).toEqual({ fixRoute: "workers" });
    expect(state.incidents).toEqual([]);
  });

  it("refuses cross-site requests", async () => {
    const response = await post("/api/simulate", {}, { origin: "http://evil.example" });
    expect(response.status).toBe(403);
  });

  it("takes alerts only with the shared secret, and one open incident per alert", async () => {
    expect((await post("/api/alerts", ALERT)).status).toBe(401);
    expect((await post("/api/alerts", ALERT, { authorization: "Bearer wrong" })).status).toBe(401);
    const first = (await (await post("/api/alerts", ALERT, { authorization: "Bearer alert-secret" })).json()) as AlertsAccepted;
    const again = (await (await post("/api/alerts", ALERT, { authorization: "Bearer alert-secret" })).json()) as AlertsAccepted;
    expect(first.incidents).toEqual(["INC-1001"]);
    expect(again.incidents).toEqual(["INC-1001"]);
    await settle();
    expect(platform.sessions).toHaveLength(1);
    const resolved = (await (await post("/api/alerts", { ...ALERT, status: "resolved" }, { authorization: "Bearer alert-secret" })).json()) as AlertsAccepted;
    expect(resolved.incidents).toEqual(["INC-1001"]);
    const view = (await (await fetch(`${base}/api/incidents/INC-1001`)).json()) as IncidentView;
    expect(view).toMatchObject({ demo: true, service: "checkout", severity: "SEV2", alert: { source: "generic", resolvedAt: expect.any(String) } });
    expect((await post("/api/alerts", { hello: "world" }, { authorization: "Bearer alert-secret" })).status).toBe(400);
  });

  it("simulates an incident for the demo service and starts Copilot on it", async () => {
    const response = await post("/api/simulate", {});
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as CreatedIncident;
    await settle();
    const view = (await (await fetch(`${base}/api/incidents/${id}`)).json()) as IncidentView;
    expect(view).toMatchObject({ demo: true, status: "investigating", fixRoute: "workers", alert: { source: "simulated", name: "CheckoutHighErrorRate" } });
    expect(view.title).toMatch(/^Checkout 5xx error rate is \d+(\.\d)?% \(threshold 2%\)$/);
    expect(platform.session.sent[0]?.prompt).toContain(id);
  });

  it("simulates without a body, and refuses Software Factory while it isn't connected", async () => {
    const plain = await fetch(`${base}/api/simulate`, { method: "POST" });
    expect(plain.status).toBe(201);
    const { id } = (await plain.json()) as CreatedIncident;
    expect(((await (await fetch(`${base}/api/incidents/${id}`)).json()) as IncidentView).fixRoute).toBe("workers");

    const refused = await post("/api/simulate", { fixRoute: "factory" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: "factory_unavailable", message: "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL." } });
    expect((await post("/api/simulate", { fixRoute: "robots" })).status).toBe(400);
    expect((await post("/api/simulate", "not json", { "content-type": "text/plain" })).status).toBe(415);

    const setting = await put("/api/settings", { fixRoute: "factory" });
    expect(setting.status).toBe(503);
    expect(((await setting.json()) as { error: { code: string } }).error.code).toBe("factory_unavailable");
    expect((await put("/api/settings", { fixRoute: "robots" })).status).toBe(400);
    expect(await (await put("/api/settings", { fixRoute: "workers" })).json()).toEqual({ fixRoute: "workers" });
  });

  it("routes fixes to Software Factory by default once it's connected, and lets you choose per incident", async () => {
    await stop();
    factory = await new FakeFactory().start();
    await serve(testConfig({ factory: factory.target }));
    const state = (await (await fetch(`${base}/api/state`)).json()) as AppState;
    expect(state.integrations.factory).toEqual({ configured: true, url: "http://factory.test" });
    expect(state.settings).toEqual({ fixRoute: "factory" });

    const route = async (response: Response) => ((await (await fetch(`${base}/api/incidents/${((await response.json()) as CreatedIncident).id}`)).json()) as IncidentView).fixRoute;
    expect(await route(await fetch(`${base}/api/simulate`, { method: "POST" }))).toBe("factory");
    expect(await route(await post("/api/simulate", { fixRoute: "workers" }))).toBe("workers");

    const chosen = await put("/api/settings", { fixRoute: "workers" });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()) as AppSettings).toEqual({ fixRoute: "workers" });
    expect(await route(await post("/api/simulate", {}))).toBe("workers");
    expect(await route(await post("/api/simulate", { fixRoute: "factory" }))).toBe("factory");
    // Alerts from monitoring tools follow the setting too.
    expect((await put("/api/settings", { fixRoute: "factory" })).status).toBe(200);
    const accepted = (await (await post("/api/alerts", ALERT, { authorization: "Bearer alert-secret" })).json()) as AlertsAccepted;
    expect(((await (await fetch(`${base}/api/incidents/${accepted.incidents[0]}`)).json()) as IncidentView).fixRoute).toBe("factory");
    await settle();
    // A factory incident's coordinator gets the factory's tools.
    expect(platform.sessions.at(-1)?.config.tools?.map((tool) => tool.name)).toContain("route_fix_to_factory");
  });

  it("answers a decision only for a waiting request, and deletes an incident with its session", async () => {
    const { id } = (await (await post("/api/simulate", {})).json()) as CreatedIncident;
    await settle();
    const decision = await post(`/api/incidents/${id}/decision`, { approve: true });
    expect(decision.status).toBe(409);
    expect(((await decision.json()) as { error: { code: string } }).error.code).toBe("not_actionable");
    expect((await post(`/api/incidents/${id}/decision`, { approve: "yes" })).status).toBe(400);
    expect((await fetch(`${base}/api/incidents/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(platform.deleted).toEqual([platform.session.sessionId]);
    expect((await fetch(`${base}/api/incidents/${id}`)).status).toBe(404);
  });

  it("verifies the platform's webhook", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "session.idle", createdAt: new Date().toISOString(), sessionId: "someone-elses", environment: "incident-commander", data: {}, deployment: "copilot" });
    const t = Math.floor(Date.now() / 1000);
    const signed = (secret: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    expect((await post("/api/copilot-events", body, { "x-managed-copilot-signature": signed("wrong") })).status).toBe(401);
    const accepted = await post("/api/copilot-events", body, { "x-managed-copilot-signature": signed("webhook-secret"), "x-managed-copilot-event-id": "evt_1" });
    expect(accepted.status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as AppState;
    expect(state.integrations.lastWebhookAt).toBeDefined();
  });

  it("serves a clear page when the UI isn't built", async () => {
    const page = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${base}/incidents`, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.once("error", reject);
      req.end();
    });
    expect(page.status).toBe(503);
    expect(page.body).toContain("isn't built yet");
  });
});
