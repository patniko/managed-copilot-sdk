import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { ActionHandlers, VerifiedWebhookEvent } from "@managed-copilot/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertInfo } from "../src/shared/types.js";
import type { AppConfig } from "../src/server/config.js";
import { describeTool, IncidentRun, servicePath, type RunHost } from "../src/server/incident.js";
import { ServiceCatalog } from "../src/server/services.js";
import { Store, type StoredIncident } from "../src/server/store.js";
import { deployRequest, FakePlatform, settle, testConfig, worker } from "./fakes.js";

const ALERT: AlertInfo = {
  source: "simulated",
  name: "CheckoutHighErrorRate",
  summary: "Checkout 5xx error rate is 13.4% (threshold 2%)",
  service: "checkout",
  severity: "SEV2",
  labels: { alertname: "CheckoutHighErrorRate", service: "checkout" },
  startsAt: "2026-11-04T06:57:00.000Z",
  fingerprint: "abc123",
  links: [],
};

const ORIGINAL = readFileSync(join(testConfig().demoServicesDir, "checkout", "src", "discounts.js"), "utf8").replace(/\r\n/g, "\n");
/** The real file with the one-line guard the fix worker adds. */
const FIXED = ORIGINAL.replace("  const coupon = findCoupon(code, now);\n", "  const coupon = findCoupon(code, now);\n  if (!coupon) return subtotalCents;\n");
const NEW_TEST = `test("expired coupons are ignored", () => {});\n`;
const DEPLOY_ARGS = { summary: "Treat expired coupons as no discount", files: ["src/discounts.js", "checkout/test/expired.test.js"], tests: "10 passed, 0 failed" };

interface Harness {
  readonly platform: FakePlatform;
  readonly store: Store;
  readonly run: IncidentRun;
  readonly incident: () => StoredIncident;
}

function harness(options: { demo?: boolean; config?: Partial<AppConfig> } = {}): Harness {
  const config = testConfig(options.config);
  const store = new Store(mkdtempSync(join(tmpdir(), "incident-commander-")));
  const platform = new FakePlatform();
  const host: RunHost = { config, platform, store, catalog: new ServiceCatalog(config.demoServicesDir), factory: undefined, workerEnvironment: () => "incident-commander-node", changed: () => undefined };
  const created = store.create(ALERT, options.demo === false ? undefined : { seed: 7, at: "2026-11-04T07:00:00.000Z" }, "1.4.2");
  return { platform, store, run: new IncidentRun(host, created.id), incident: () => store.get(created.id)! };
}

/** Starts the incident and gives Copilot its own sandbox with the fix in it. */
async function started(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = harness(options);
  await h.run.start();
  h.platform.workerList = [worker({ id: "hands-1", name: "hands", role: "hands", state: "idle", environment: "incident-commander-triage" })];
  h.platform.files.set("hands-1:checkout/src/discounts.js", FIXED);
  h.platform.files.set("hands-1:checkout/test/expired.test.js", NEW_TEST);
  return h;
}

/** Copilot asks to deploy; the app records the request and lets go of the session. */
async function waiting(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await started(options);
  const result = await h.platform.session.permission(deployRequest(DEPLOY_ARGS));
  expect(result).toEqual({ kind: "no-result" });
  await settle();
  return h;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an incident's coordinator", () => {
  it("starts with the runbook and the alert", async () => {
    const { platform, run, incident } = harness();
    await run.start();
    const session = platform.session;
    expect(String(session.config.systemMessage?.content)).toContain('"incident-commander-node" environment');
    expect(session.sent[0]?.prompt).toContain(`Incident ${incident().id} is open`);
    expect(session.sent[0]?.prompt).toContain('Alert "CheckoutHighErrorRate" (SEV2)');
    expect(incident().sessionId).toBe(session.sessionId);
    expect(incident().prompted).toBe(true);
    expect((session.config.tools ?? []).map((tool) => tool.name)).toEqual(["open_workspace", "update_incident", "deploy_fix", "publish_postmortem"]);
    expect(String(session.config.systemMessage?.content)).not.toContain("route_fix_to_factory");
    expect(run.view()).toMatchObject({ fixRoute: "workers" });
    expect(run.view().factory).toBeUndefined();
    expect(run.view().coordinator).toMatchObject({ state: "working", attached: true });
  });

  it("copies the service into its own sandbox once that sandbox exists", async () => {
    const { platform, run } = harness();
    await run.start();
    expect(await platform.session.call("open_workspace", {})).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("Run `pwd`") });

    platform.workerList = [worker({ id: "hands-1", name: "hands", role: "hands", state: "idle" })];
    const result = await platform.session.call("open_workspace", {});
    expect(result).toContain("/workspace/checkout");
    expect(platform.files.get("hands-1:checkout/src/discounts.js")).toContain("coupon.percent");
    expect(platform.files.get("hands-1:checkout/logs/checkout.log")).toContain("TypeError: Cannot read properties of undefined (reading 'percent')");
    expect(platform.files.get("hands-1:checkout/deploys/HISTORY.md")).toContain("v1.4.2");
  });

  it("works without asking in sandboxes", async () => {
    const { platform, run } = await started();
    const bash = { kind: "custom-tool", toolName: "bash", toolCallId: "b1", toolDescription: "", args: { command: "grep -c 500 logs/checkout.log" } } as PermissionRequest;
    const worker = { kind: "custom-tool", toolName: "start_worker", toolCallId: "w1", toolDescription: "", args: { name: "repro" } } as PermissionRequest;
    expect(await platform.session.permission(bash)).toEqual({ kind: "approve-once" });
    expect(await platform.session.permission(worker)).toEqual({ kind: "approve-once" });
    expect(run.attached).toBe(true);
  });

  it("keeps the triage evidence when later notes come in", async () => {
    const { platform, incident } = await started();
    const session = platform.session;
    await session.call("update_incident", { note: "Found it", rootCause: "v1.4.2 dropped the expiry guard", evidence: ["19 of 134 checkouts failed", "discounts.js:14"] });
    await session.call("update_incident", { note: "Verified", rootCause: "v1.4.2 dropped the expiry guard", evidence: ["npm test: 10 passed"] });
    expect(incident().findings.evidence).toEqual(["19 of 134 checkouts failed", "discounts.js:14"]);
    expect(incident().milestones.triagedAt).toBeDefined();
    await session.call("update_incident", { note: "Actually", rootCause: "A different cause", evidence: ["new evidence"] });
    expect(incident().findings).toEqual({ rootCause: "A different cause", evidence: ["new evidence"] });
  });
});

describe("the deploy approval", () => {
  it("is recorded with the change from Copilot's sandbox, then left to the platform", async () => {
    const { platform, run, incident } = await waiting();
    expect(platform.session.disconnected).toBe(1);
    expect(run.attached).toBe(false);
    const approval = incident().approval!;
    expect(approval).toMatchObject({ id: "deploy-call", state: "waiting", summary: DEPLOY_ARGS.summary, tests: DEPLOY_ARGS.tests });
    expect(approval.files.map((file) => [file.path, file.status, file.added])).toEqual([
      ["src/discounts.js", "modified", 1],
      ["test/expired.test.js", "added", 1],
    ]);
    expect(approval.snapshot.map((file) => file.path)).toEqual(["src/discounts.js", "test/expired.test.js"]);
    expect(incident().status).toBe("mitigating");
    const view = run.view();
    expect(view.needsYou).toBe(true);
    expect(view.coordinator.state).toBe("waiting");
    expect("snapshot" in view.approval!).toBe(false);
  });

  it("refuses a request without files instead of asking a person", async () => {
    const { platform, incident } = await started();
    const result = await platform.session.permission(deployRequest({ summary: "Fix it" }));
    expect(result).toMatchObject({ kind: "reject", feedback: expect.stringContaining("files must list") });
    expect(incident().approval).toBeUndefined();
  });

  it("is answered when the person approves: the app re-attaches and the platform delivers the request again", async () => {
    const { platform, run, incident } = await waiting();
    const answers: PermissionRequestResult[] = [];
    platform.onResume = async (session) => void answers.push(await session.permission(deployRequest(DEPLOY_ARGS)));
    await run.decide(true, undefined, "octocat");
    expect(answers).toEqual([{ kind: "approve-once", approvedInteractively: true }]);
    expect(run.attached).toBe(true);
    expect(incident().approval).toMatchObject({ state: "approved", decidedBy: "octocat" });

    const result = await platform.session.call("deploy_fix", DEPLOY_ARGS, "deploy-call");
    expect(result).toContain("v1.4.3");
    expect(incident()).toMatchObject({ status: "resolved", deploy: { ok: true, target: "demo", version: "1.4.3", previousVersion: "1.4.2" } });
    expect(incident().approval?.state).toBe("deployed");
    expect(incident().alert.resolvedAt).toBeDefined();
    expect(incident().timeline.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["person", "deploy", "resolved"]));
  });

  it("sends the reason to Copilot when the person declines", async () => {
    const { platform, run, incident } = await waiting();
    const answers: PermissionRequestResult[] = [];
    platform.onResume = async (session) => void answers.push(await session.permission(deployRequest(DEPLOY_ARGS)));
    await run.decide(false, "Wait for the release freeze to end", "octocat");
    expect(answers[0]).toMatchObject({ kind: "reject", feedback: expect.stringContaining("Wait for the release freeze to end") });
    expect(incident().approval).toMatchObject({ state: "declined", reason: "Wait for the release freeze to end" });
    await expect(run.decide(true, undefined, "octocat")).rejects.toMatchObject({ code: "not_actionable" });
  });

  it("deploys exactly what the person reviewed, once, to your pipeline", async () => {
    const posted: { body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        posted.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers) });
        return new Response(JSON.stringify({ version: "2.0.1" }), { status: 202, headers: { "content-type": "application/json" } });
      }),
    );
    const { platform, run, incident } = await waiting({ demo: false, config: { deploy: { url: "https://deploy.example.test/hooks/release", secret: "deploy-secret" } } });
    platform.onResume = async (session) => void (await session.permission(deployRequest(DEPLOY_ARGS)));
    await run.decide(true, undefined, "octocat");
    // Changed in the sandbox after the person approved: not what ships.
    platform.files.set("hands-1:checkout/src/discounts.js", "// something else\n");
    const first = await platform.session.call("deploy_fix", DEPLOY_ARGS, "deploy-call");
    const again = await platform.session.call("deploy_fix", DEPLOY_ARGS, "deploy-call");
    expect(first).toBe(again);
    expect(posted).toHaveLength(1);
    const files = posted[0]!.body.files as { path: string; content: string }[];
    expect(files.find((file) => file.path === "src/discounts.js")?.content).toBe(FIXED);
    expect(posted[0]!.body).toMatchObject({ type: "incident.deploy_approved", incident: incident().id, service: "checkout", approvedBy: "octocat" });
    expect(posted[0]!.headers.get("x-incident-commander-signature")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(posted[0]!.headers.get("idempotency-key")).toBe(`${incident().sessionId}:deploy-call`);
    expect(incident().deploy).toMatchObject({ ok: true, target: "webhook", version: "2.0.1" });
  });

  it("fails clearly for your own service when no deploy pipeline is configured", async () => {
    const { platform, run, incident } = await waiting({ demo: false });
    platform.onResume = async (session) => void (await session.permission(deployRequest(DEPLOY_ARGS)));
    await run.decide(true, undefined, "octocat");
    const result = await platform.session.call("deploy_fix", DEPLOY_ARGS, "deploy-call");
    expect(result).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("INCIDENT_DEPLOY_URL") });
    expect(incident().status).toBe("mitigating");
    expect(incident().approval?.state).toBe("failed");
  });

  it("expires when Copilot's turn ends before anyone answered, but not on a late delivery about an earlier turn", async () => {
    const { run, incident } = await waiting();
    await run.webhook({ ...webhookEvent("session.idle", {}), createdAt: "2020-01-01T00:00:00.000Z" } as VerifiedWebhookEvent);
    expect(incident().approval?.state).toBe("waiting");
    await run.webhook({ ...webhookEvent("session.idle", {}), createdAt: new Date(Date.now() + 1_000).toISOString() } as VerifiedWebhookEvent);
    expect(incident().approval?.state).toBe("expired");
    expect(run.view().needsYou).toBe(false);
  });
});

function webhookEvent(type: VerifiedWebhookEvent["type"], data: Record<string, unknown>, handleActions = vi.fn(async (_handlers: ActionHandlers) => [])): VerifiedWebhookEvent {
  return { id: `evt-${type}`, type, createdAt: "2026-11-04T07:20:00.000Z", sessionId: "coordinator-1", deployment: "copilot", data, duplicate: false, handleActions } as VerifiedWebhookEvent;
}

describe("the platform's webhook", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await waiting();
  });

  it("announces the waiting request and answers only what needs no person", async () => {
    const handleActions = vi.fn(async (_handlers: ActionHandlers) => []);
    await h.run.webhook(webhookEvent("session.action_required", { actions: [{ kind: "permission", tool: "deploy_fix", state: "pending" }] }, handleActions));
    expect(h.incident().approval?.announcedAt).toBe("2026-11-04T07:20:00.000Z");
    expect(h.incident().timeline.some((entry) => entry.text.includes("waits on the platform"))).toBe(true);
    const handlers = handleActions.mock.calls[0]![0];
    expect((handlers.tools ?? []).map((tool) => tool.name)).toContain("publish_postmortem");
    const bash = { kind: "custom-tool", toolName: "bash", toolCallId: "b2", toolDescription: "", args: {} } as PermissionRequest;
    expect(await handlers.onPermissionRequest!(bash, { sessionId: "coordinator-1" })).toEqual({ kind: "approve-once" });
    expect(await handlers.onPermissionRequest!(deployRequest(DEPLOY_ARGS), { sessionId: "coordinator-1" })).toEqual({ kind: "no-result" });
  });

  it("answers a decided request without attesting a person while the app can't attach", async () => {
    h.platform.status = { ...h.platform.status, state: "unavailable" };
    await h.run.decide(true, undefined, "octocat");
    expect(h.run.attached).toBe(false);
    expect(h.incident().problem).toContain("Couldn't reach Copilot's session");
    const handleActions = vi.fn(async (_handlers: ActionHandlers) => []);
    await h.run.webhook(webhookEvent("session.action_required", { actions: [{ kind: "permission", tool: "deploy_fix" }] }, handleActions));
    const handlers = handleActions.mock.calls[0]![0];
    expect(await handlers.onPermissionRequest!(deployRequest(DEPLOY_ARGS), { sessionId: "coordinator-1" })).toEqual({ kind: "approve-once" });
  });

  it("records a failed session", async () => {
    await h.run.webhook({ ...webhookEvent("session.failed", { error: "The runtime stopped" }), createdAt: new Date(Date.now() + 1_000).toISOString() } as VerifiedWebhookEvent);
    expect(h.run.view().coordinator.state).toBe("failed");
    expect(h.incident().timeline.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("The runtime stopped") });
  });
});

describe("sandboxes", () => {
  it("turn worker progress into the timeline, and the first worker means mitigating", async () => {
    const { platform, run, incident } = await started();
    platform.execList = [
      { id: "e1", sessionId: "hands-1", command: "pwd", state: "completed", background: false, startedAt: "", outputBytes: 0, caller: { kind: "platform", name: "bash" } },
      { id: "e2", sessionId: "hands-1", command: "grep -c status=500 logs/checkout.log", state: "completed", background: false, startedAt: "", outputBytes: 0, caller: { kind: "platform", name: "bash" } },
      { id: "e3", sessionId: "hands-1", command: "rg --files", state: "completed", background: false, startedAt: "", outputBytes: 0, caller: { kind: "platform", name: "glob" } },
    ];
    platform.workerList = [...platform.workerList, worker({ id: "repro-1", name: "repro", state: "working", task: "Write a failing test" })];
    await run.refresh();
    expect(incident().status).toBe("mitigating");
    const own = run.view().sandboxes.find((sandbox) => sandbox.role === "own");
    expect(own).toMatchObject({ name: "Triage", commands: 3, lastCommand: "grep -c status=500 logs/checkout.log" });
    expect(own?.task).toBeUndefined();
    expect(incident().timeline.map((entry) => entry.text)).toEqual(expect.arrayContaining(['Handed "repro" to a worker in its own sandbox', "Copilot started its own sandbox for triage"]));

    platform.workerList = platform.workerList.map((entry) => (entry.id === "repro-1" ? { ...entry, state: "idle" as const, result: "The new test fails: TypeError" } : entry));
    await run.refresh();
    expect(run.view().sandboxes.find((sandbox) => sandbox.name === "repro")).toMatchObject({ done: true, report: "The new test fails: TypeError" });
    expect(incident().timeline.at(-1)).toMatchObject({ text: '"repro" reported back', detail: "The new test fails: TypeError" });

    platform.workerList = platform.workerList.map((entry) => (entry.id === "repro-1" ? { ...entry, state: "stopped" as const } : entry));
    await run.refresh();
    expect(run.view().sandboxes.find((sandbox) => sandbox.name === "repro")).toMatchObject({ state: "stopped", done: true });
  });
});

describe("helpers", () => {
  it("normalizes the paths the model gives", () => {
    expect(servicePath("checkout", "src/discounts.js")).toBe("src/discounts.js");
    expect(servicePath("checkout", "checkout/src/discounts.js")).toBe("src/discounts.js");
    expect(servicePath("checkout", "/workspace/checkout/test/a.test.js")).toBe("test/a.test.js");
    expect(servicePath("checkout", "./src/cart.js")).toBe("src/cart.js");
    expect(servicePath("checkout", "../etc/passwd")).toBeUndefined();
    expect(servicePath("checkout", "/etc/passwd")).toBeUndefined();
  });

  it("describes tool calls in a few words", () => {
    expect(describeTool("bash", { command: "grep -c 500 logs/checkout.log\necho done" })).toBe("$ grep -c 500 logs/checkout.log");
    expect(describeTool("start_worker", { name: "repro" })).toBe("Starting repro");
    expect(describeTool("view", { path: "/workspace/checkout/src/discounts.js" })).toBe("Reading discounts.js");
    expect(describeTool("deploy_fix", {})).toBe("Asking to deploy");
    expect(describeTool("route_fix_to_factory", {})).toBe("Routing the fix to Software Factory");
  });
});
