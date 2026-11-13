import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertsAccepted, AppSettings, AppState, CreatedIncident, IncidentView, ServerEvent, TelemetryRecord } from "../src/shared/types.js";
import type { AppConfig } from "../src/server/config.js";
import { Commander } from "../src/server/commander.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { ServiceCatalog } from "../src/server/services.js";
import { Store } from "../src/server/store.js";
import { TelemetryFeed } from "../src/server/telemetry.js";
import { deployRequest, FakeFactory, FakePlatform, FakeRemoteService, settle, SHOP_PROMOTIONS, shopFiles, testConfig, worker } from "./fakes.js";

let server: Server;
let base: string;
let platform: FakePlatform;
let hub: EventHub;
let factory: FakeFactory | undefined;
const closers: (() => Promise<void>)[] = [];

async function serve(config: AppConfig, catalog = new ServiceCatalog(config.demoServicesDir)): Promise<void> {
  platform = new FakePlatform();
  hub = new EventHub();
  const commander = new Commander(config, platform, new Store(mkdtempSync(join(tmpdir(), "incident-http-"))), catalog, hub);
  commander.start();
  server = createServer(createRequestHandler({ commander, hub, telemetry: new TelemetryFeed(hub) }, join(tmpdir(), "no-web-root")));
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
  await Promise.all(closers.splice(0).map((close) => close()));
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
      telemetryUrl: "http://localhost:7445/api/otlp/v1/logs",
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

/** An OTLP/HTTP JSON logs export, as OpenTelemetry's JavaScript exporter sends it. */
const OTLP_EXPORT = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "downhill-shop" } }, { key: "service.version", value: { stringValue: "1.0.0" } }], droppedAttributesCount: 0 },
      scopeLogs: [
        {
          scope: { name: "downhill", version: "1.0.0" },
          logRecords: [
            {
              timeUnixNano: "1794523800123000000",
              observedTimeUnixNano: "1794523800124000000",
              severityNumber: 13,
              severityText: "WARN",
              body: { stringValue: "Checkout rejected code trail15 for Mona: Invalid code." },
              eventName: "shop.promo_rejected",
              attributes: [
                { key: "code", value: { stringValue: "trail15" } },
                { key: "subtotal_cents", value: { intValue: 499 } },
                { key: "perfect", value: { boolValue: true } },
                { key: "api_token", value: { stringValue: "abc" } },
              ],
              droppedAttributesCount: 0,
            },
            {
              timeUnixNano: "0",
              observedTimeUnixNano: "1794523801000000000",
              severityText: "error",
              body: { kvlistValue: { values: [{ key: "ok", value: { boolValue: false } }] } },
              attributes: [{ key: "event.name", value: { stringValue: "ride.crash" } }],
            },
          ],
        },
      ],
    },
  ],
};

describe("OpenTelemetry logs", () => {
  const otlp = (body: string | Buffer, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/otlp/v1/logs`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body });

  it("takes OTLP/HTTP JSON exports with the alert secret, and streams the records to browsers", async () => {
    const published: ServerEvent[] = [];
    hub.publish = (event) => void published.push(event);
    expect((await otlp(JSON.stringify(OTLP_EXPORT), { authorization: "Bearer wrong" })).status).toBe(401);
    const response = await otlp(JSON.stringify(OTLP_EXPORT));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    const expected: TelemetryRecord[] = [
      {
        id: "t1",
        at: "2026-11-12T22:50:00.123Z",
        service: "downhill-shop",
        severity: "warn",
        event: "shop.promo_rejected",
        body: "Checkout rejected code trail15 for Mona: Invalid code.",
        attributes: { code: "trail15", subtotal_cents: "499", perfect: "true", api_token: "***" },
      },
      { id: "t2", at: "2026-11-12T22:50:01.000Z", service: "downhill-shop", severity: "error", event: "ride.crash", body: "{ok: false}", attributes: {} },
    ];
    expect(published).toEqual([{ type: "telemetry", records: expected }]);
    expect(await (await fetch(`${base}/api/telemetry?service=downhill-shop`)).json()).toEqual({ records: expected });
    expect(await (await fetch(`${base}/api/telemetry?service=checkout`)).json()).toEqual({ records: [] });

    // gzip, as the OpenTelemetry Collector sends by default.
    expect((await otlp(gzipSync(JSON.stringify(OTLP_EXPORT)), { "content-encoding": "gzip" })).status).toBe(200);
    expect(((await (await fetch(`${base}/api/telemetry`)).json()) as { records: TelemetryRecord[] }).records.map((record) => record.id)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("says what to send instead of protobuf or anything that isn't an export", async () => {
    const protobuf = await otlp(Buffer.from([1, 2, 3]), { "content-type": "application/x-protobuf" });
    expect(protobuf.status).toBe(415);
    expect(((await protobuf.json()) as { error: { message: string } }).error.message).toContain("set encoding: json");
    const wrong = await otlp(JSON.stringify({ logs: [] }));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toContain("resourceLogs");
    expect((await otlp("{", { "content-encoding": "gzip" })).status).toBe(400);
  });

  it("is off without the alert secret", async () => {
    await stop();
    await serve(testConfig({ alertSecret: undefined }));
    const response = await otlp(JSON.stringify(OTLP_EXPORT));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("telemetry_not_configured");
  });
});

/** Downhill's shop pages Incident Commander with the generic JSON shape and a stable ID. */
const SHOP_ALERT = {
  id: "downhill-promo-rejected",
  title: "Launch code rejected at checkout",
  summary: 'Checkout rejected the launch-week code trail15 with "Invalid code."',
  description: '3 players were told "Invalid code." for trail15 in the last 5 minutes.',
  service: "downhill-shop",
  severity: "major",
  status: "firing",
  labels: { product: "downhill" },
};
const AUTH = { authorization: "Bearer alert-secret" };

/** A deploy pipeline on a local port (as Downhill's /api/deploys): it records what it gets and accepts it. */
async function deployPipeline(answer: { readonly version: string; readonly message: string }) {
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const pipeline = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => pipeline.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        pipeline.closeAllConnections();
        pipeline.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(pipeline.address() as AddressInfo).port}/api/deploys`, received };
}

const incident = async (id: string): Promise<IncidentView> => (await (await fetch(`${base}/api/incidents/${id}`)).json()) as IncidentView;

describe("Downhill's shop, a service over HTTP", () => {
  it("pages an incident, gives Copilot the shop's files, deploys the fix back, and takes the resolved alert", async () => {
    const shop = new FakeRemoteService();
    const pipeline = await deployPipeline({ version: "1.0.1", message: "The shop runs v1.0.1." });
    await stop();
    await serve(testConfig({ deploy: { url: pipeline.url, secret: "deploy-secret" } }), shop.catalog());

    const accepted = await post("/api/alerts", SHOP_ALERT, AUTH);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ incidents: ["INC-1001"] });
    await settle();
    expect(await incident("INC-1001")).toMatchObject({
      service: "downhill-shop",
      demo: false,
      severity: "SEV2",
      serviceVersion: "1.0.0",
      alert: { source: "generic", fingerprint: "downhill-promo-rejected" },
    });
    expect(platform.session.sent[0]?.prompt).toContain('firing for the "downhill-shop" service');

    // Triage: the shop's code, tests, logs, and deploy history, in Copilot's own sandbox.
    platform.workerList = [worker({ id: "hands-1", name: "hands", role: "hands", state: "idle", environment: "incident-commander-triage" })];
    expect(await platform.session.call("open_workspace", {})).toBe(
      "Copied 6 files into /workspace/downhill-shop: README.md, deploys/, logs/, package.json, src/, test/. Start with /workspace/downhill-shop/README.md.",
    );
    expect(platform.files.get("hands-1:downhill-shop/logs/shop.log")).toContain("code=trail15");
    expect(platform.files.get("hands-1:downhill-shop/deploys/HISTORY.md")).toContain("Launch-week banner");

    // The verified fix, in its sandbox. It also lists package.json, which it didn't change: that doesn't ship.
    const fixed = SHOP_PROMOTIONS.replace("Object.hasOwn(PROMOTIONS, code) ? PROMOTIONS[code]", "Object.hasOwn(PROMOTIONS, code.trim().toUpperCase()) ? PROMOTIONS[code.trim().toUpperCase()]");
    const test = `${shopFiles()["test/promotions.test.js"]}\ntest("the banner's lowercase trail15 works", () => {});\n`;
    platform.files.set("hands-1:downhill-shop/src/promotions.js", fixed);
    platform.files.set("hands-1:downhill-shop/test/promotions.test.js", test);
    const args = { summary: "Match promo codes whatever their case", files: ["src/promotions.js", "/workspace/downhill-shop/test/promotions.test.js", "package.json"], tests: "2 passed, 0 failed" };
    expect(await platform.session.permission(deployRequest(args))).toEqual({ kind: "no-result" });
    await settle();
    expect((await incident("INC-1001")).approval?.files.map((file) => [file.path, file.status])).toEqual([
      ["src/promotions.js", "modified"],
      ["test/promotions.test.js", "modified"],
    ]);

    // A person approves: the platform delivers the request again, and the fix goes to the shop's deploy pipeline.
    platform.onResume = async (session) => void (await session.permission(deployRequest(args)));
    expect((await post("/api/incidents/INC-1001/decision", { approve: true })).status).toBe(204);
    expect(await platform.session.call("deploy_fix", args, "deploy-call")).toBe("Your deploy pipeline accepted downhill-shop v1.0.1. The shop runs v1.0.1.");
    expect(pipeline.received).toHaveLength(1);
    const [{ headers, body }] = pipeline.received as [(typeof pipeline.received)[number]];
    expect(JSON.parse(body)).toEqual({
      type: "incident.deploy_approved",
      incident: "INC-1001",
      service: "downhill-shop",
      version: "1.0.1",
      previousVersion: "1.0.0",
      summary: args.summary,
      tests: args.tests,
      approvedBy: "octocat",
      approvedAt: expect.any(String),
      files: [
        { path: "src/promotions.js", content: fixed },
        { path: "test/promotions.test.js", content: test },
      ],
    });
    const [t, v1] = String(headers["x-incident-commander-signature"]).split(",").map((part) => part.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "deploy-secret").update(`${t}.${body}`).digest("hex"));
    expect(await incident("INC-1001")).toMatchObject({ status: "resolved", deploy: { ok: true, target: "webhook", version: "1.0.1", previousVersion: "1.0.0" } });

    // The shop says its alert resolved: recorded on the incident, once, and nothing new opens.
    const resolved = await post("/api/alerts", { ...SHOP_ALERT, status: "resolved" }, AUTH);
    expect(resolved.status).toBe(202);
    expect(await resolved.json()).toEqual({ incidents: ["INC-1001"] });
    const after = await incident("INC-1001");
    expect(after.alert.resolvedAt).toBeDefined();
    expect(after.timeline.filter((entry) => entry.kind === "resolved").map((entry) => entry.text)).toEqual(["Launch code rejected at checkout resolved in webhook"]);
    expect(await (await post("/api/alerts", { id: "downhill-promo-rejected", status: "resolved" }, AUTH)).json()).toEqual({ incidents: [] });
    expect(((await (await fetch(`${base}/api/state`)).json()) as AppState).incidents.map((summary) => summary.id)).toEqual(["INC-1001"]);
  });

  it("opens the incident while the shop can't be loaded, says why, and picks the files up once it can", async () => {
    const shop = new FakeRemoteService();
    shop.answer = () => new Response("Service Unavailable", { status: 503 });
    await stop();
    await serve(testConfig(), shop.catalog());
    expect(await (await post("/api/alerts", SHOP_ALERT, AUTH)).json()).toEqual({ incidents: ["INC-1001"] });
    await settle();
    const opened = await incident("INC-1001");
    expect(opened.serviceVersion).toBeUndefined();
    expect(opened.timeline.find((entry) => entry.kind === "error")?.text).toBe(`Couldn't load downhill-shop from ${shop.url}: it answered HTTP 503.`);

    platform.workerList = [worker({ id: "hands-1", name: "hands", role: "hands", state: "idle" })];
    expect(await platform.session.call("open_workspace", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("it answered HTTP 503. Wait half a minute") });
    shop.answer = undefined;
    expect(await platform.session.call("open_workspace", {})).toContain("Copied 6 files into /workspace/downhill-shop");
    expect((await incident("INC-1001")).serviceVersion).toBe("1.0.0");

    // Down again when Copilot asks to deploy: the request says the change can't be shown, and what would ship.
    shop.answer = new TypeError("fetch failed");
    expect(await platform.session.permission(deployRequest({ summary: "Fix it", files: ["src/promotions.js"] }))).toEqual({ kind: "no-result" });
    await settle();
    expect((await incident("INC-1001")).approval).toMatchObject({
      state: "waiting",
      files: [],
      problem: `Couldn't load downhill-shop from ${shop.url}: it isn't reachable (fetch failed). So the change can't be shown here; what ships is Copilot's copy of src/promotions.js.`,
    });
  });
});
