import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertInfo, FixRoute } from "../src/shared/types.js";
import { Commander } from "../src/server/commander.js";
import { loadConfig } from "../src/server/config.js";
import { errorExcerpt, releasedFix, SoftwareFactory } from "../src/server/factory.js";
import { EventHub } from "../src/server/hub.js";
import { IncidentRun, summarize, type RunHost } from "../src/server/incident.js";
import { runbook } from "../src/server/runbook.js";
import { ServiceCatalog } from "../src/server/services.js";
import { Store, type StoredIncident } from "../src/server/store.js";
import { deployRequest, FakeFactory, FakePlatform, settle, testConfig, worker } from "./fakes.js";

const ALERT: AlertInfo = {
  source: "simulated",
  name: "CheckoutHighErrorRate",
  summary: "Checkout 5xx error rate is 13.4% (threshold 2%)",
  description: "19 of 142 checkouts failed in the last 5 minutes.",
  service: "checkout",
  severity: "SEV2",
  labels: { alertname: "CheckoutHighErrorRate", service: "checkout", env: "production" },
  startsAt: "2026-11-04T06:57:00.000Z",
  fingerprint: "abc123",
  links: [],
};

const demoDir = testConfig().demoServicesDir;
const source = (path: string): string => readFileSync(join(demoDir, "checkout", path), "utf8").replace(/\r\n/g, "\n");
const ORIGINAL = source("src/discounts.js");
const FIXED = ORIGINAL.replace("  const coupon = findCoupon(code, now);\n", "  const coupon = findCoupon(code, now);\n  if (!coupon) return subtotalCents;\n");
const TESTS = `${source("test/discounts.test.js")}\ntest("an expired coupon gives no discount", () => {});\n`;

const ROUTE = {
  summary: "Checkout crashes on expired coupon codes",
  rootCause: "v1.4.2 moved the expiry check into findCoupon, which now returns undefined for expired codes, and applyDiscount reads coupon.percent without a guard.",
  failingPath: "POST /checkout → priceCart (src/cart.js) → applyDiscount (src/discounts.js:14)",
  expected: "An expired coupon gives no discount instead of a 500.",
  files: ["src/discounts.js", "checkout/test/discounts.test.js"],
};

/** What the factory releases for the fix: the whole project, and what changed in it. */
function release(changes: { path: string; status: "added" | "modified" | "deleted" }[] = [
  { path: "src/discounts.js", status: "modified" },
  { path: "test/discounts.test.js", status: "modified" },
  { path: "package.json", status: "modified" },
  { path: "src/legacy.js", status: "deleted" },
]) {
  return {
    workOrderId: "wo_12",
    number: 12,
    projectName: "checkout",
    tests: { total: 11, passed: 11, failed: 0, skipped: 0 },
    notes: "Expired coupons give no discount again.",
    files: [
      { path: "README.md", content: source("README.md") },
      { path: "package.json", content: source("package.json").replace("1.4.2", "1.4.3") },
      { path: "src/cart.js", content: source("src/cart.js") },
      { path: "src/discounts.js", content: FIXED },
      { path: "test/discounts.test.js", content: TESTS },
    ],
    changes,
  };
}

interface Harness {
  readonly factory: FakeFactory;
  readonly platform: FakePlatform;
  readonly store: Store;
  readonly dataDir: string;
  readonly host: RunHost;
  readonly run: IncidentRun;
  readonly incident: () => StoredIncident;
  /** Calls one of the app's tools on the newest session. */
  readonly call: (name: string, args: unknown, toolCallId?: string) => Promise<unknown>;
}

const factories: FakeFactory[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(factories.splice(0).map((factory) => factory.close()));
});

async function fakeFactory(): Promise<FakeFactory> {
  const factory = await new FakeFactory().start();
  factories.push(factory);
  return factory;
}

/** A started incident with Copilot's own sandbox running. */
async function harness(options: { route?: FixRoute; connected?: boolean } = {}): Promise<Harness> {
  const factory = await fakeFactory();
  const config = testConfig({ factory: factory.target });
  const dataDir = mkdtempSync(join(tmpdir(), "incident-factory-"));
  const store = new Store(dataDir);
  const platform = new FakePlatform();
  const host: RunHost = {
    config,
    platform,
    store,
    catalog: new ServiceCatalog(config.demoServicesDir),
    factory: options.connected === false ? undefined : new SoftwareFactory(factory.target),
    workerEnvironment: () => "incident-commander-node",
    changed: () => undefined,
  };
  const created = store.create(ALERT, { seed: 7, at: "2026-11-04T07:00:00.000Z" }, "1.4.2", options.route ?? "factory");
  const run = new IncidentRun(host, created.id);
  closers.push(() => run.close());
  await run.start();
  platform.workerList = [worker({ id: "hands-1", name: "hands", role: "hands", state: "idle", environment: "incident-commander-triage" })];
  return {
    factory,
    platform,
    store,
    dataDir,
    host,
    run,
    incident: () => store.get(created.id)!,
    call: (name, args, toolCallId) => platform.session.call(name, args, toolCallId),
  };
}

const sent = (platform: FakePlatform, text: string) => platform.sessions.flatMap((session) => session.sent).filter((message) => message.prompt.includes(text));
const texts = (incident: StoredIncident, kind?: string) => incident.timeline.filter((entry) => !kind || entry.kind === kind).map((entry) => entry.text);

describe("the fix route", () => {
  it("is Software Factory by default when it's connected, Copilot's workers otherwise, and a choice that's kept", async () => {
    const target = (await fakeFactory()).target;
    const make = (config = testConfig(), dir = mkdtempSync(join(tmpdir(), "incident-settings-"))) =>
      new Commander(config, new FakePlatform(), new Store(dir), new ServiceCatalog(demoDir), new EventHub());
    expect(make().settings()).toEqual({ fixRoute: "workers" });
    expect(make(testConfig({ factory: target })).settings()).toEqual({ fixRoute: "factory" });
    expect(make(testConfig({ factory: target })).integrations().factory).toEqual({ configured: true, url: "http://factory.test" });
    expect(make().integrations().factory).toEqual({ configured: false });
    expect(() => make().setFixRoute("factory")).toThrow(/Software Factory isn't connected/);

    const dir = mkdtempSync(join(tmpdir(), "incident-settings-"));
    const first = make(testConfig({ factory: target }), dir);
    expect(first.setFixRoute("workers")).toEqual({ fixRoute: "workers" });
    await first.close();
    const reopened = make(testConfig({ factory: target }), dir);
    expect(reopened.settings()).toEqual({ fixRoute: "workers" });
    reopened.setFixRoute("factory");
    await reopened.close();
    // Chosen while connected, then SOFTWARE_FACTORY_URL went away: fixes go to workers, not nowhere.
    expect(make(testConfig(), dir).settings()).toEqual({ fixRoute: "workers" });
    expect(make(testConfig({ factory: target }), dir).settings()).toEqual({ fixRoute: "factory" });
  });

  it("reads Software Factory's addresses from the environment", () => {
    expect(loadConfig({}).factory).toBeUndefined();
    expect(loadConfig({ SOFTWARE_FACTORY_URL: "http://localhost:7480/" }).factory).toEqual({ url: "http://localhost:7480", publicUrl: "http://localhost:7480" });
    expect(loadConfig({ SOFTWARE_FACTORY_URL: "http://software-factory", SOFTWARE_FACTORY_PUBLIC_URL: "https://factory.example.com/" }).factory).toEqual({
      url: "http://software-factory",
      publicUrl: "https://factory.example.com",
    });
    expect(loadConfig({}).factoryPollMs).toBe(5_000);
  });

  it("loads records from before routes and settings existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-old-"));
    const old = new Store(mkdtempSync(join(tmpdir(), "incident-new-"))).create(ALERT);
    const { fixRoute: _fixRoute, ...incident } = old;
    writeFileSync(join(dir, "incidents.json"), JSON.stringify({ version: 1, next: 1002, incidents: [incident], webhook: { seen: [] } }));
    const store = new Store(dir);
    expect(store.settings).toEqual({});
    expect(summarize(store.get(old.id)!).fixRoute).toBe("workers");
    expect(store.create(ALERT).fixRoute).toBe("workers");
  });

  it("gives a factory incident the factory runbook and its two tools; a workers incident keeps today's", async () => {
    const factory = await harness();
    const session = factory.platform.sessions[0]!;
    expect((session.config.tools ?? []).map((tool) => tool.name)).toEqual([
      "open_workspace",
      "update_incident",
      "route_fix_to_factory",
      "apply_factory_fix",
      "deploy_fix",
      "publish_postmortem",
    ]);
    const instructions = String(session.config.systemMessage?.content);
    expect(instructions).toBe(runbook("incident-commander-node", "factory"));
    expect(instructions).toContain("Call route_fix_to_factory with a one-line summary, the root cause, the failing path");
    expect(instructions).toContain('hand the repro to one worker, "repro", started in the "incident-commander-node" environment');
    expect(instructions).toContain("Then end your turn with one sentence: Software Factory's fix arrives as a message.");
    expect(instructions).toContain("call apply_factory_fix");
    expect(instructions).toContain("say that Software Factory built the fix, with its work order number");
    expect(instructions).toContain('fix it with a "fix" worker, as in the standard runbook');
    expect(factory.run.view()).toMatchObject({ fixRoute: "factory" });

    const workers = await harness({ route: "workers" });
    const plain = workers.platform.sessions[0]!;
    expect((plain.config.tools ?? []).map((tool) => tool.name)).toEqual(["open_workspace", "update_incident", "deploy_fix", "publish_postmortem"]);
    expect(String(plain.config.systemMessage?.content)).toBe(runbook("incident-commander-node"));
    expect(runbook("incident-commander-node")).not.toContain("Software Factory");
  });
});

describe("route_fix_to_factory", () => {
  it("sends the service's code as the project and the incident as context, and records the work order", async () => {
    const h = await harness();
    await h.call("update_incident", { note: "Found it", rootCause: ROUTE.rootCause, evidence: ["19 of 142 checkouts failed", "src/discounts.js:14 reads coupon.percent"] });
    const result = await h.call("route_fix_to_factory", ROUTE, "route-call");
    expect(result).toContain("Software Factory took the fix as WO-0012 (http://factory.test/#/wo/wo_12)");
    expect(result).toContain('"repro" worker');

    expect(h.factory.created).toHaveLength(1);
    const body = h.factory.created[0] as {
      title: string;
      brief: string;
      project: { name: string; files: { path: string; content: string }[] };
      context: { path: string; content: string }[];
    };
    const id = h.incident().id;
    expect(body).toMatchObject({
      title: "Fix checkout: Checkout crashes on expired coupon codes",
      mode: "classic",
      maxReviewRounds: 2,
      origin: { app: "incident-commander", name: "Incident Commander", label: `${id} · checkout`, url: `http://localhost:7445/#/incidents/${id}`, key: id },
    });
    expect(body.project.name).toBe("checkout");
    const paths = body.project.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(["README.md", "package.json", "src/cart.js", "src/coupons.js", "src/discounts.js", "src/server.js", "test/cart.test.js", "test/discounts.test.js"]));
    expect(paths.filter((path) => path.startsWith("logs/") || path.startsWith("deploys/"))).toEqual([]);
    expect(body.project.files.find((file) => file.path === "src/discounts.js")?.content).toBe(ORIGINAL);

    expect(body.context.map((file) => file.path)).toEqual(["INCIDENT.md"]);
    const context = body.context[0]!.content;
    for (const expected of [
      `# ${id}: ${ALERT.summary}`,
      "- Name: CheckoutHighErrorRate",
      "- Severity: SEV2",
      "- Service: checkout (v1.4.2 in production)",
      "- Labels: alertname=CheckoutHighErrorRate, service=checkout, env=production",
      ROUTE.rootCause,
      "- 19 of 142 checkouts failed",
      ROUTE.failingPath,
      ROUTE.expected,
      "## The deploy that caused it (deploys/v1.4.2.diff)",
      "+++ b/src/discounts.js",
      "TypeError: Cannot read properties of undefined (reading 'percent')",
      "    at applyDiscount (file:///srv/checkout/src/discounts.js:",
    ]) {
      expect(context).toContain(expected);
    }
    expect(context).not.toContain("payment provider error");
    expect(body.brief).toContain(`**Root cause:** ${ROUTE.rootCause}`);
    expect(body.brief).toContain("Add a regression test under test/");
    expect(body.brief).toContain("Keep every existing test passing (`npm test`).");
    expect(body.brief).toContain("Don't change package.json or README.md.");
    expect(body.brief).toContain("The fix likely touches `src/discounts.js`, `test/discounts.test.js`.");

    expect(h.incident()).toMatchObject({
      status: "mitigating",
      factory: { workOrderId: "wo_12", number: 12, status: "queued", title: body.title, url: "http://factory.test/#/wo/wo_12" },
    });
    expect(h.incident().timeline.at(-1)).toMatchObject({ kind: "factory", text: "Routed the fix to Software Factory as WO-0012" });
    expect(h.run.view().factory).toMatchObject({ number: 12, status: "queued", url: "http://factory.test/#/wo/wo_12" });
  });

  it("is one work order per incident, even when the call is repeated or replayed after a restart", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE, "route-call");
    expect(await h.call("route_fix_to_factory", ROUTE, "route-call")).toContain("WO-0012");
    const replayed = new IncidentRun(h.host, h.incident().id);
    closers.push(() => replayed.close());
    expect(await replayed.routeFix(ROUTE)).toContain("WO-0012");
    expect(h.factory.created).toHaveLength(1);
  });

  it("keeps a work order the factory created before the app recorded it, but not another incident's", async () => {
    const h = await harness();
    const id = h.incident().id;
    // The same incident ID from an older set of records: not this incident's.
    h.factory.add({ createdAt: "2020-01-01T00:00:00.000Z", origin: { app: "incident-commander", name: "Incident Commander", key: id } });
    const recorded = h.factory.add({ title: "Fix checkout: expired coupons", origin: { app: "incident-commander", name: "Incident Commander", key: id } });
    expect(await h.call("route_fix_to_factory", ROUTE)).toContain("WO-0013");
    expect(h.factory.created).toEqual([]);
    expect(h.incident().factory).toMatchObject({ workOrderId: recorded.id, title: "Fix checkout: expired coupons" });
  });

  it("falls back to a fix worker, visibly, when Software Factory refuses or can't be reached", async () => {
    const h = await harness();
    h.factory.refuse = { status: 503, code: "platform_unavailable", message: "Software Factory can't reach Managed Copilot right now." };
    const refused = (await h.call("route_fix_to_factory", ROUTE)) as { resultType: string; textResultForLlm: string };
    expect(refused.resultType).toBe("failure");
    expect(refused.textResultForLlm).toContain("Software Factory couldn't take the work order: Software Factory can't reach Managed Copilot right now.");
    expect(refused.textResultForLlm).toContain('fix it with a "fix" worker, as in the standard runbook');
    expect(refused.textResultForLlm).toContain("/workspace/checkout");
    expect(h.incident().factory).toBeUndefined();
    expect(h.incident().timeline.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("Couldn't route the fix to Software Factory") });

    await h.factory.close();
    const down = (await h.call("route_fix_to_factory", ROUTE)) as { resultType: string; textResultForLlm: string };
    expect(down).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining(`Software Factory isn't reachable at ${h.factory.url}`) });
    expect(h.incident().factory).toBeUndefined();
  });

  it("says so when Software Factory isn't connected, and refuses paths outside the service", async () => {
    const h = await harness({ connected: false });
    expect(await h.call("route_fix_to_factory", ROUTE)).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("SOFTWARE_FACTORY_URL isn't set") });
    const other = await harness();
    expect(await other.call("route_fix_to_factory", { ...ROUTE, files: ["../etc/passwd"] })).toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("isn't inside the service's folder"),
    });
    expect(other.factory.created).toEqual([]);
  });
});

describe("following the work order", () => {
  it("records each step, keeps the released fix, and tells Copilot exactly once", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    // Copilot wrote the repro and ended its turn: the app lets go of the session.
    h.platform.session.emit({ type: "session.idle" });
    await settle();
    expect(h.run.attached).toBe(false);

    h.factory.set("wo_12", { status: "planning" });
    await h.run.checkFactory();
    h.factory.set("wo_12", { status: "building", taskCount: 3 });
    await h.run.checkFactory();
    await h.run.checkFactory();
    h.factory.set("wo_12", { status: "releasing" });
    await h.run.checkFactory();
    expect(texts(h.incident(), "factory")).toEqual([
      "Routed the fix to Software Factory as WO-0012",
      "Software Factory is planning WO-0012",
      "Software Factory is building WO-0012 (3 tasks)",
      "Software Factory is releasing WO-0012",
    ]);
    expect(h.platform.sessions).toHaveLength(1);

    h.factory.releases.set("wo_12", release());
    h.factory.set("wo_12", { status: "completed", tests: { total: 11, passed: 11, failed: 0, skipped: 0 } });
    await h.run.checkFactory();
    const work = h.incident().factory!;
    expect(work.files?.map((file) => [file.path, file.status])).toEqual([
      ["src/discounts.js", "modified"],
      ["test/discounts.test.js", "modified"],
    ]);
    expect(work.files?.[0]?.content).toBe(FIXED);
    expect(work).toMatchObject({ status: "completed", tests: { passed: 11 }, deliveredAt: expect.any(String) });
    expect(texts(h.incident(), "factory")).toContain("Software Factory released WO-0012: src/discounts.js, test/discounts.test.js; 11 tests passed");

    // The app re-attached to tell Copilot; the platform queues it behind a running turn.
    expect(h.platform.sessions).toHaveLength(2);
    const [message] = sent(h.platform, "Software Factory released the fix as WO-0012");
    expect(message?.prompt).toContain("src/discounts.js (modified), test/discounts.test.js (modified)");
    expect(message?.prompt).toContain("Call apply_factory_fix");
    expect(message?.prompt).toContain("deploy_fix");
    expect(message?.mode).toBeUndefined();
    expect(h.run.view().coordinator.state).toBe("working");

    await h.run.checkFactory();
    await h.run.checkFactory();
    expect(sent(h.platform, "Software Factory released")).toHaveLength(1);
    const view = h.run.view().factory!;
    expect(view.files).toEqual([
      { path: "src/discounts.js", status: "modified" },
      { path: "test/discounts.test.js", status: "modified" },
    ]);
  });

  it("tells Copilot to fall back to a fix worker when the factory couldn't build the fix", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    h.factory.set("wo_12", { status: "failed", error: { code: "build_failed", message: "The builder's tests kept failing." } });
    await h.run.checkFactory();
    await h.run.checkFactory();
    expect(h.incident().timeline.map((entry) => [entry.kind, entry.text]).slice(-2)).toEqual([
      ["error", "Software Factory couldn't build WO-0012: The builder's tests kept failing."],
      ["factory", 'Falling back: Copilot fixes it with a "fix" worker'],
    ]);
    const messages = sent(h.platform, "Software Factory couldn't build the fix");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.prompt).toContain("(WO-0012): The builder's tests kept failing.");
    expect(messages[0]?.prompt).toContain('Now fix it with a "fix" worker');
    expect(await h.call("apply_factory_fix", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining('"fix" worker') });
    expect(await h.call("route_fix_to_factory", ROUTE)).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining('"fix" worker') });
    expect(h.factory.created).toHaveLength(1);
  });

  it("treats a release that doesn't change the service's code as a failure", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    h.factory.releases.set("wo_12", release([{ path: "README.md", status: "modified" }, { path: "package.json", status: "modified" }]));
    h.factory.set("wo_12", { status: "completed" });
    await h.run.checkFactory();
    expect(h.incident().factory).toMatchObject({ status: "completed", error: "Software Factory released WO-0012 without changing the service's code." });
    expect(h.incident().factory?.files).toBeUndefined();
    expect(sent(h.platform, 'Now fix it with a "fix" worker')).toHaveLength(1);
  });

  it("keeps the last status and says so while Software Factory can't be reached", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    h.factory.set("wo_12", { status: "building" });
    await h.run.checkFactory();
    const entries = h.incident().timeline.length;

    h.factory.refuse = { status: 502, code: "bad_gateway", message: "The factory's proxy couldn't reach it." };
    await h.run.checkFactory();
    await h.run.checkFactory();
    expect(h.incident().factory).toMatchObject({ status: "building", problem: "Can't reach Software Factory to follow WO-0012: The factory's proxy couldn't reach it. Incident Commander keeps trying." });
    expect(h.run.view().factory?.problem).toContain("Can't reach Software Factory to follow WO-0012");
    expect(h.incident().timeline).toHaveLength(entries);

    h.factory.refuse = undefined;
    await h.run.checkFactory();
    expect(h.incident().factory?.problem).toBeUndefined();

    await h.factory.close();
    await h.run.checkFactory();
    expect(h.incident().factory?.problem).toContain(`isn't reachable at ${h.factory.url}`);
    expect(h.incident().factory?.status).toBe("building");
  });

  it("says a work order can't be followed when Software Factory is no longer configured", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    const unconfigured = new IncidentRun({ ...h.host, factory: undefined }, h.incident().id);
    expect(unconfigured.view().factory?.problem).toBe("Software Factory isn't connected anymore (SOFTWARE_FACTORY_URL isn't set), so WO-0012 can't be followed.");
  });

  it("resumes following after a restart, and hands the fix over", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    const id = h.incident().id;
    await h.run.close();
    h.store.flush();
    // The factory finishes while Incident Commander is down.
    h.factory.releases.set("wo_12", release());
    h.factory.set("wo_12", { status: "completed" });

    const platform = new FakePlatform();
    const store = new Store(h.dataDir);
    const hub = new EventHub();
    const config = testConfig({ factory: h.factory.target, factoryPollMs: 20 });
    const commander = new Commander(config, platform, store, new ServiceCatalog(config.demoServicesDir), hub);
    closers.push(async () => {
      await commander.close();
      hub.close();
    });
    commander.start();
    await vi.waitFor(() => expect(sent(platform, "Software Factory released the fix as WO-0012")).toHaveLength(1), { timeout: 5_000, interval: 20 });
    expect(store.get(id)?.factory?.files?.map((file) => file.path)).toEqual(["src/discounts.js", "test/discounts.test.js"]);
    expect(h.factory.requests).toContain("GET /api/work-orders/wo_12/release");
  });
});

describe("apply_factory_fix", () => {
  it("waits for the release, then copies the fix into Copilot's sandbox, and the deploy says who built it", async () => {
    const h = await harness();
    expect(await h.call("apply_factory_fix", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("Call route_fix_to_factory first") });
    await h.call("route_fix_to_factory", ROUTE);
    expect(await h.call("apply_factory_fix", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("Software Factory hasn't finished WO-0012 yet") });

    h.factory.releases.set("wo_12", release());
    h.factory.set("wo_12", { status: "completed" });
    await h.run.checkFactory();
    const result = await h.call("apply_factory_fix", {});
    expect(result).toContain("Copied Software Factory's fix (WO-0012) into /workspace/checkout: src/discounts.js (modified), test/discounts.test.js (modified).");
    expect(result).toContain("11 tests passed");
    expect(h.platform.files.get("hands-1:checkout/src/discounts.js")).toBe(FIXED);
    expect(h.platform.files.get("hands-1:checkout/test/discounts.test.js")).toBe(TESTS);
    expect(h.platform.files.has("hands-1:checkout/package.json")).toBe(false);
    expect(h.incident().factory?.appliedAt).toBeDefined();
    expect(texts(h.incident(), "factory")).toContain("Copied WO-0012's fix into Copilot's sandbox (2 files)");

    const answer = await h.platform.session.permission(deployRequest({ summary: "Treat expired coupons as no discount", files: ["src/discounts.js", "test/discounts.test.js"], tests: "11 passed" }));
    expect(answer).toEqual({ kind: "no-result" });
    expect(h.incident().approval).toMatchObject({ state: "waiting", factory: { number: 12, url: "http://factory.test/#/wo/wo_12" } });
    expect(h.incident().approval?.files.map((file) => file.path)).toEqual(["src/discounts.js", "test/discounts.test.js"]);
  });

  it("needs Copilot's own sandbox", async () => {
    const h = await harness();
    await h.call("route_fix_to_factory", ROUTE);
    h.factory.releases.set("wo_12", release());
    h.factory.set("wo_12", { status: "completed" });
    await h.run.checkFactory();
    h.platform.workerList = [];
    expect(await h.call("apply_factory_fix", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("Your own sandbox isn't running") });
  });
});

describe("releases and logs", () => {
  it("takes only the service files a release added or changed", () => {
    const originals = new Map([
      ["src/a.js", "a"],
      ["src/b.js", "b"],
      ["package.json", "{}"],
    ]);
    const files = [
      { path: "src/a.js", content: "A" },
      { path: "src/b.js", content: "b" },
      { path: "./test/new.test.js", content: "test" },
      { path: "package.json", content: '{"x":1}' },
      { path: "../outside.js", content: "no" },
      { path: ".factory/context/INCIDENT.md", content: "context" },
    ];
    // An older factory without `changes`: what differs from the project it was given.
    expect(releasedFix({ files }, originals).map((file) => [file.path, file.status])).toEqual([
      ["src/a.js", "modified"],
      ["test/new.test.js", "added"],
    ]);
    expect(
      releasedFix(
        {
          files,
          changes: [
            { path: "src/a.js", status: "modified" },
            { path: "src/gone.js", status: "deleted" },
            { path: "README.md", status: "modified" },
          ],
        },
        originals,
      ).map((file) => file.path),
    ).toEqual(["src/a.js"]);
  });

  it("excerpts the newest errors in the logs, each with its stack", () => {
    const logs = new Map([
      [
        "logs/app.log",
        [
          "t1 level=error msg=old",
          "t2 level=info msg=fine error=none",
          "t3 level=error msg=boom",
          "    at one (a.js:1:1)",
          "    at two (b.js:2:2)",
          "t4 level=warn msg=rejected error=\"CheckoutError: Unknown coupon\"",
          "t5 ERROR something broke",
        ].join("\n"),
      ],
      ["src/a.js", "level=error is not a log line"],
    ]);
    expect(errorExcerpt(logs, 2)).toEqual({ text: "t3 level=error msg=boom\n    at one (a.js:1:1)\n    at two (b.js:2:2)\nt5 ERROR something broke", shown: 2, total: 3 });
    expect(errorExcerpt(new Map([["src/a.js", "x"]]))).toBeUndefined();
  });
});
