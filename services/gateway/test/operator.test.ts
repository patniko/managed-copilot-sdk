import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_REQUEST_HEADER, OPERATOR_ROUTES, type ConsoleTicket, type OperatorAction, type OperatorEnvironments, type OperatorInfrastructure, type OperatorOverview, type OperatorSessionDetail, type OperatorSessionSummary } from "@managed-copilot/protocol";
import { createLogger } from "../src/log.js";
import { OperatorAccess } from "../src/modules/operator/access.js";
import { FakeRuntime, RawClient, sleep, startGitHubStub, startTestGateway, TEST_DEPLOYMENT, type TestGateway } from "./harness.js";

const ALICE = "alice-operator-token";
const BOB = "bob-user-token";
const CAROL = "carol-org-token";

interface Call {
  readonly token?: string;
  readonly cookie?: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly console?: boolean;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(20);
  }
}

function customizations(): string {
  const root = mkdtempSync(join(tmpdir(), "mc-operator-bundle-"));
  mkdirSync(join(root, "agents"));
  mkdirSync(join(root, "skills", "refunds"), { recursive: true });
  mkdirSync(join(root, "instructions"));
  writeFileSync(join(root, "agents", "support.agent.md"), "---\nname: support\ndescription: Answers support questions\ntools: [ask_user]\n---\nYou are a support agent.\n");
  writeFileSync(join(root, "skills", "refunds", "SKILL.md"), "---\nname: refund-policy\ndescription: Our refund policy\n---\nRefunds take 5 days.\n");
  writeFileSync(join(root, "instructions", "tone.md"), "Be concise.\n");
  return root;
}

function consoleBuild(): string {
  const root = mkdtempSync(join(tmpdir(), "mc-operator-console-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>console</title><div id=root></div>");
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log('console');");
  return root;
}

describe("operator API and console", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];
  const temp: string[] = [];

  const call = async (path: string, options: Call = {}) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;
    if (options.cookie) headers["cookie"] = options.cookie;
    if (options.console) headers[CONSOLE_REQUEST_HEADER] = "1";
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(path, gateway.url), {
      method: options.method ?? "GET",
      headers,
      redirect: "manual",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json: json as Record<string, unknown> & { error?: { code: string; message: string } } };
  };

  const connect = async (token: string, environment = "chat") => {
    const client = await RawClient.connect(gateway.url, token, environment);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({
      [ALICE]: { id: 1001, login: "alice" },
      [BOB]: { id: 2002, login: "bob" },
      [CAROL]: { id: 3003, login: "carol", orgs: ["ops-team"] },
    });
    const bundle = customizations();
    const build = consoleBuild();
    temp.push(bundle, build);
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: {
        ...TEST_DEPLOYMENT,
        operators: { githubUsers: ["alice"], githubOrgs: ["ops-team"] },
        environments: {
          ...TEST_DEPLOYMENT.environments,
          coder: { type: "isolated", size: "small", env: { API_TOKEN: "ENV-TOKEN-VALUE", REGION: "westus" }, setupCommands: ["git clone https://x-access:SETUP-SECRET@github.com/org/repo"] },
          support: { type: "shared", customizations: bundle, description: "Support desk" },
        },
        webhooks: { audit: { url: "http://127.0.0.1:9/hook", environments: ["chat"], events: ["session.created"], secret: { secretEnv: "OPERATOR_TEST_MISSING_SECRET" } } },
      },
      env: { MANAGED_COPILOT_CONSOLE_DIR: build, LOG_LEVEL: "info" },
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
    for (const dir of temp) rmSync(dir, { recursive: true, force: true });
  });

  it("admits only named operators and members of operator organizations", async () => {
    const anonymous = (await call(OPERATOR_ROUTES.overview)).json.error as { code: string; details?: Record<string, unknown> } | undefined;
    expect(anonymous).toMatchObject({ code: "authentication_required", details: { reason: "signed_out" } });
    const bob = await call(OPERATOR_ROUTES.overview, { token: BOB });
    expect(bob.status).toBe(403);
    expect(bob.json.error?.message).toMatch(/@bob is not an operator.*@alice.*members of ops-team/);
    expect(bob.json.error).toMatchObject({ details: { login: "bob", operators: "@alice, members of ops-team" } });
    expect((await call(OPERATOR_ROUTES.me, { token: ALICE })).json).toMatchObject({ account: { id: 1001, login: "alice" }, grant: "configured", via: "token" });
    expect((await call(OPERATOR_ROUTES.me, { token: CAROL })).json).toMatchObject({ account: { login: "carol" }, grant: "configured" });
    // The operator API never answers cross-origin reads.
    const preflight = await fetch(new URL(OPERATOR_ROUTES.overview, gateway.url), { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const info = await call("/v1/info", { token: BOB });
    expect(info.json["capabilities"]).toContain("operator");
  });

  it("signs the console in with a one-time ticket and an HttpOnly, SameSite=Strict cookie", async () => {
    // Tickets come from a GitHub token only; a browser cookie cannot mint one, and non-operators get none.
    expect((await call(OPERATOR_ROUTES.consoleTickets, { token: BOB, method: "POST", body: {} })).status).toBe(403);
    const minted = await call(OPERATOR_ROUTES.consoleTickets, { token: ALICE, method: "POST", body: {} });
    const ticket = minted.json as unknown as ConsoleTicket;
    expect(ticket.ticket).toMatch(/^mcct_/);
    expect(ticket.url).toBe(`${gateway.url}/console/signin#ticket=${encodeURIComponent(ticket.ticket)}`);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);

    // Redeeming needs the console header and the console's own origin.
    expect((await call(OPERATOR_ROUTES.consoleSession, { method: "POST", body: { ticket: ticket.ticket } })).status).toBe(403);
    expect((await call(OPERATOR_ROUTES.consoleSession, { method: "POST", console: true, headers: { origin: "https://evil.example" }, body: { ticket: ticket.ticket } })).status).toBe(403);
    const redeemed = await call(OPERATOR_ROUTES.consoleSession, { method: "POST", console: true, headers: { origin: gateway.url }, body: { ticket: ticket.ticket } });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json).toMatchObject({ account: { login: "alice" }, via: "console" });
    const setCookie = redeemed.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^mc_console=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/);
    const cookie = setCookie.split(";")[0]!;
    // Single use.
    const again = await call(OPERATOR_ROUTES.consoleSession, { method: "POST", console: true, body: { ticket: ticket.ticket } });
    expect(again.json.error).toMatchObject({ code: "authentication_required", message: expect.stringMatching(/expired or was already used/) });

    // The cookie works only with the console header.
    expect((await call(OPERATOR_ROUTES.me, { cookie })).status).toBe(403);
    expect((await call(OPERATOR_ROUTES.me, { cookie, console: true })).json).toMatchObject({ account: { login: "alice" }, via: "console", sessionExpiresAt: expect.any(String) });
    // A cookie never mints tickets (the route takes GitHub tokens only).
    expect((await call(OPERATOR_ROUTES.consoleTickets, { cookie, console: true, method: "POST", body: {} })).status).toBe(401);

    const out = await call(OPERATOR_ROUTES.consoleSession, { cookie, console: true, method: "DELETE" });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/^mc_console=; .*Max-Age=0/);
    const after = await call(OPERATOR_ROUTES.me, { cookie, console: true });
    expect(after.json.error).toMatchObject({ code: "authentication_required", message: expect.stringMatching(/console session ended/), details: { reason: "session_ended" } });
    const audit = (await call(OPERATOR_ROUTES.audit, { token: ALICE })).json as unknown as { action: string; actor: { login: string } }[];
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(["console.signin", "console.signout"]));
  });

  it("shows sessions of every owner with their redacted harness, never conversation or credentials", async () => {
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    const aliceSession = crypto.randomUUID();
    const bobSession = crypto.randomUUID();
    await alice.request("session.create", {
      sessionId: aliceSession,
      model: "claude-haiku-4.5",
      systemMessage: { mode: "append", content: "You are the order desk." },
      tools: [{ name: "lookup_order", description: "Look up an order", parameters: { type: "object", properties: { token: { type: "string" } } } }],
      requestPermission: true,
      customAgents: [{ name: "refunds", description: "Handles refunds", prompt: "You process refunds." }],
      gitHubToken: ALICE,
    });
    await bob.request("session.create", { sessionId: bobSession });
    alice.answer = () => ({});
    await alice.request("session.send", { sessionId: aliceSession, prompt: 'tool:lookup_order {"query":"SECRET-ARGUMENT-VALUE"}' });
    await alice.waitForEvent("external_tool.requested");

    const list = (await call(`${OPERATOR_ROUTES.sessions}?limit=50`, { token: ALICE })).json as unknown as OperatorSessionSummary[];
    expect(list.map((session) => session.id)).toEqual(expect.arrayContaining([aliceSession, bobSession]));
    expect(list.find((session) => session.id === bobSession)).toMatchObject({ owner: { login: "bob" }, environment: "chat", placement: "shared", live: true, attached: 1 });
    const bobsOnly = (await call(`${OPERATOR_ROUTES.sessions}?owner=bob`, { token: ALICE })).json as unknown as OperatorSessionSummary[];
    expect(bobsOnly.every((session) => session.owner.login === "bob")).toBe(true);
    expect((await call(`${OPERATOR_ROUTES.sessions}?state=nope`, { token: ALICE })).status).toBe(400);

    const response = await call(OPERATOR_ROUTES.session(aliceSession), { token: CAROL });
    const detail = response.json as unknown as OperatorSessionDetail;
    expect(detail).toMatchObject({ id: aliceSession, owner: { login: "alice" }, model: "claude-haiku-4.5", incarnation: expect.stringMatching(/^inc_/) });
    const harness = detail.harness!;
    expect(harness.systemMessage).toMatchObject({ mode: "customize", content: "You are the order desk." });
    expect(harness.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lookup_order", source: "client", description: "Look up an order" }), expect.objectContaining({ name: "web_fetch", source: "platform" })]));
    // JSON schema property names stay (they are not secrets).
    expect(harness.tools.find((tool) => tool.name === "lookup_order")?.parameters).toEqual({ type: "object", properties: { token: { type: "string" } } });
    expect(harness.customAgents).toEqual([expect.objectContaining({ name: "refunds", description: "Handles refunds", prompt: "You process refunds." })]);
    expect(harness.callbacks).toMatchObject({ tools: ["lookup_order"], flags: expect.arrayContaining(["requestPermission"]) });
    expect(harness.enforced).toEqual(expect.arrayContaining(["enableConfigDiscovery = false"]));
    expect(detail.attachments).toEqual([expect.objectContaining({ kind: "sdk", account: expect.objectContaining({ login: "alice" }), tools: ["lookup_order"] })]);
    expect(detail.actions).toEqual([expect.objectContaining({ kind: "tool", tool: "lookup_order", owner: expect.objectContaining({ login: "alice" }) })]);
    for (const secret of ["SECRET-ARGUMENT-VALUE", ALICE, BOB]) expect(response.text).not.toContain(secret);

    const actions = await call(`${OPERATOR_ROUTES.actions}?state=open`, { token: ALICE });
    expect((actions.json as unknown as OperatorAction[]).some((action) => action.sessionId === aliceSession && action.tool === "lookup_order")).toBe(true);
    expect(actions.text).not.toContain("SECRET-ARGUMENT-VALUE");

    const connections = (await call(OPERATOR_ROUTES.connections, { token: ALICE })).json as unknown as { connections: { account: { login: string }; sessions: string[]; requests: number }[] };
    expect(connections.connections).toEqual(expect.arrayContaining([expect.objectContaining({ account: expect.objectContaining({ login: "bob" }), sessions: [bobSession] })]));
    expect(connections.connections.every((connection) => connection.requests >= 1)).toBe(true);

    const events = await call(`${OPERATOR_ROUTES.events}?type=session.created`, { token: ALICE });
    expect(events.json).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.created", sessionId: bobSession, owner: expect.objectContaining({ login: "bob" }) })]));

    const accounts = (await call(OPERATOR_ROUTES.accounts, { token: ALICE })).json as unknown as { account: { login: string }; operator: boolean; sessions: { total: number } }[];
    expect(accounts.find((entry) => entry.account.login === "alice")).toMatchObject({ operator: true });
    expect(accounts.find((entry) => entry.account.login === "bob")).toMatchObject({ operator: false, sessions: { total: 1 } });
  });

  it("reports health, infrastructure, traffic, and attention", async () => {
    const overview = (await call(OPERATOR_ROUTES.overview, { token: ALICE })).json as unknown as OperatorOverview;
    expect(overview.deployment).toMatchObject({ name: "copilot", mode: "local", capabilities: expect.arrayContaining(["operator", "shared"]) });
    expect(overview.health.map((component) => component.id)).toEqual(["gateway", "runtime", "sandboxes", "egress", "scheduler", "webhooks", "storage"]);
    expect(overview.health.find((component) => component.id === "runtime")).toMatchObject({ status: "healthy" });
    expect(overview.counts.sessions.total).toBeGreaterThanOrEqual(2);
    expect(overview.traffic["rpc.requests"]?.total).toBeGreaterThan(0);
    expect(overview.traffic["rpc.requests"]?.perMinute).toHaveLength(60);
    // The webhook has no signing secret: the overview says so.
    expect(overview.attention).toEqual(expect.arrayContaining([expect.objectContaining({ id: "webhook:audit:unsigned", severity: "error" })]));

    const infrastructure = (await call(OPERATOR_ROUTES.infrastructure, { token: ALICE })).json as unknown as OperatorInfrastructure;
    expect(infrastructure.gateway).toMatchObject({ mode: "local", operators: { githubUsers: ["alice"], githubOrgs: ["ops-team"], localDefault: false }, access: { open: true } });
    expect(infrastructure.gateway.modules).toEqual(["core", "foundry", "openai", "sandbox", "network", "durable", "attach", "promotion", "orchestrator", "operator"]);
    expect(infrastructure.runtime).toMatchObject({ state: "running", external: true, version: expect.any(String) });
    expect(infrastructure.sandboxes).toMatchObject({ provider: "docker", available: false, lastError: expect.stringMatching(/Docker/) });
    expect(infrastructure.egress).toMatchObject({ mode: "off", connected: false, registrations: 0 });
    expect(infrastructure.storage.databaseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(infrastructure)).not.toMatch(/platform[-_]?key|MANAGED_COPILOT_PLATFORM_KEY/i);
  });

  it("shows environments with their deployed customizations and serves their files safely", async () => {
    const { environments, defaultNetwork } = (await call(OPERATOR_ROUTES.environments, { token: ALICE })).json as unknown as OperatorEnvironments;
    expect(defaultNetwork).toEqual({ access: "enabled", allowedDomains: [] });
    const support = environments.find((environment) => environment.name === "support")!;
    expect(support).toMatchObject({ type: "shared", description: "Support desk", tools: { mcp: "remote", builtins: expect.arrayContaining(["ask_user", "skill"]) } });
    expect(support.customizations).toMatchObject({
      digest: expect.any(String),
      agents: [expect.objectContaining({ name: "support", description: "Answers support questions", file: "agents/support.agent.md" })],
      skills: [expect.objectContaining({ name: "refund-policy", file: "skills/refunds/SKILL.md" })],
      instructions: [{ file: "instructions/tone.md" }],
    });
    expect(environments.find((environment) => environment.name === "chat")!.webhooks).toEqual(["audit"]);
    const coder = environments.find((environment) => environment.name === "coder")!;
    expect(coder).toMatchObject({ size: "small", resources: { cpus: 1, memoryMiB: 2048 }, tools: { builtins: "all", mcp: "any" } });
    // Environment variables are meant to be non-secret; values that are not are masked anyway.
    expect(coder.env).toEqual({ API_TOKEN: "[redacted]", REGION: "westus" });
    expect(coder.setupCommands).toEqual(["git clone https://***@github.com/org/repo"]);
    expect(JSON.stringify(environments)).not.toMatch(/ENV-TOKEN-VALUE|SETUP-SECRET/);

    const file = await call(`${OPERATOR_ROUTES.environmentFile("support")}?path=${encodeURIComponent("agents/support.agent.md")}`, { token: ALICE });
    expect(file.json).toMatchObject({ environment: "support", path: "agents/support.agent.md", kind: "agent", truncated: false, content: expect.stringContaining("You are a support agent.") });
    for (const path of ["../secret.txt", "/etc/passwd", "agents\\support.agent.md", "agents/../../x", "C:/Windows/win.ini"]) {
      expect((await call(`${OPERATOR_ROUTES.environmentFile("support")}?path=${encodeURIComponent(path)}`, { token: ALICE })).status, path).toBe(400);
    }
    expect((await call(`${OPERATOR_ROUTES.environmentFile("support")}?path=agents/missing.md`, { token: ALICE })).status).toBe(404);
    expect((await call(`${OPERATOR_ROUTES.environmentFile("chat")}?path=agents/x.md`, { token: ALICE })).status).toBe(404);
    expect((await call(OPERATOR_ROUTES.environment("nope"), { token: ALICE })).json.error?.code).toBe("environment_not_found");
  });

  it("retries failed webhook deliveries and audits it", async () => {
    let failed: { id: string; webhook: string; state: string } | undefined;
    await waitUntil(async () => {
      const webhooks = (await call(`${OPERATOR_ROUTES.webhooks}?state=failed`, { token: ALICE })).json as unknown as { deliveries: { id: string; webhook: string; state: string; lastError?: string }[]; subscriptions: { name: string; signed: boolean; url: string }[] };
      expect(webhooks.subscriptions).toEqual([expect.objectContaining({ name: "audit", signed: false, url: "http://127.0.0.1:9/hook" })]);
      failed = webhooks.deliveries[0];
      return failed !== undefined;
    });
    const retried = await call(OPERATOR_ROUTES.webhookRetry(failed!.id), { token: ALICE, method: "POST", body: {} });
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ ok: true, message: expect.stringMatching(/queued for another attempt/), audit: { action: "webhook.retry", outcome: "succeeded", target: failed!.id } });
    // Only failed deliveries can be retried; non-operators cannot retry at all.
    const delivered = await call(OPERATOR_ROUTES.webhookRetry("whd_missing"), { token: ALICE, method: "POST", body: {} });
    expect(delivered.json.error?.code).toBe("not_found");
    expect((await call(OPERATOR_ROUTES.webhookRetry(failed!.id), { token: BOB, method: "POST", body: {} })).status).toBe(403);
    const audit = (await call(OPERATOR_ROUTES.audit, { token: ALICE })).json as unknown as { action: string; outcome: string }[];
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "webhook.retry", outcome: "failed" })]));
  });

  it("pauses and resumes another owner's schedule with a reason the owner sees", async () => {
    expect((await call("/v1/credentials/background", { token: BOB, method: "POST", body: {} })).status).toBe(200);
    const created = await call("/v1/schedules", { token: BOB, method: "POST", body: { name: "nightly-digest", cron: "0 3 * * *", environment: "chat", prompt: "Summarize SECRET-PROMPT-VALUE" } });
    expect(created.status).toBe(201);
    const scheduleId = String(created.json["id"]);

    const schedules = await call(OPERATOR_ROUTES.schedules, { token: ALICE });
    expect(schedules.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduleId, owner: expect.objectContaining({ login: "bob" }), createdBy: "user" })]));
    expect(schedules.text).not.toContain("SECRET-PROMPT-VALUE");

    const paused = await call(OPERATOR_ROUTES.schedulePause(scheduleId), { token: ALICE, method: "POST", body: { reason: "maintenance window" } });
    expect(paused.json).toMatchObject({ ok: true, audit: { action: "schedule.pause", target: scheduleId } });
    const owner = await call(`/v1/schedules/${scheduleId}`, { token: BOB });
    expect(owner.json).toMatchObject({ state: "paused", pausedReason: "Paused: an operator (@alice) paused this schedule (maintenance window)." });
    expect((await call(OPERATOR_ROUTES.schedulePause(scheduleId), { token: ALICE, method: "POST", body: {} })).json.error?.code).toBe("conflict");

    const resumed = await call(OPERATOR_ROUTES.scheduleResume(scheduleId), { token: ALICE, method: "POST", body: {} });
    expect(resumed.json).toMatchObject({ ok: true, message: expect.stringMatching(/Resumed schedule nightly-digest \(@bob\)/) });
    expect((await call(`/v1/schedules/${scheduleId}`, { token: BOB })).json).toMatchObject({ state: "active" });
    const runs = await call(OPERATOR_ROUTES.scheduleRuns(scheduleId), { token: ALICE });
    expect(runs.json).toMatchObject({ schedule: { id: scheduleId }, runs: [] });

    // The owner's own pause is theirs to lift. An operator's pause takes it over (manual runs stop too), and lifting
    // the operator's pause leaves the owner's in place.
    expect((await call(`/v1/schedules/${scheduleId}/pause`, { token: BOB, method: "POST", body: {} })).status).toBe(200);
    const ownersPause = await call(OPERATOR_ROUTES.scheduleResume(scheduleId), { token: ALICE, method: "POST", body: {} });
    expect(ownersPause.json.error).toMatchObject({ code: "conflict", message: expect.stringContaining("paused by its owner, @bob; only its owner can resume it") });
    expect((await call(OPERATOR_ROUTES.schedulePause(scheduleId), { token: ALICE, method: "POST", body: { reason: "incident 42" } })).json).toMatchObject({ ok: true });
    expect((await call(`/v1/schedules/${scheduleId}`, { token: BOB })).json).toMatchObject({ state: "paused", pausedReason: "Paused: an operator (@alice) paused this schedule (incident 42). Its owner had paused it too." });
    expect((await call(`/v1/schedules/${scheduleId}/run`, { token: BOB, method: "POST", body: {} })).json.error?.code).toBe("conflict");
    const lifted = await call(OPERATOR_ROUTES.scheduleResume(scheduleId), { token: ALICE, method: "POST", body: {} });
    expect(lifted.json).toMatchObject({ ok: true, message: expect.stringContaining("it stays paused by its owner") });
    const after = (await call(`/v1/schedules/${scheduleId}`, { token: BOB })).json;
    expect(after).toMatchObject({ state: "paused" });
    expect(after).not.toHaveProperty("pausedReason");

    // A platform pause (here, the owner's background sign-in was removed) needs the owner too.
    expect((await call("/v1/credentials/background", { token: BOB, method: "DELETE" })).status).toBeLessThan(300);
    expect((await call(`/v1/schedules/${scheduleId}`, { token: BOB })).json).toMatchObject({ state: "paused", pausedReason: expect.any(String) });
    const platformPause = await call(OPERATOR_ROUTES.scheduleResume(scheduleId), { token: ALICE, method: "POST", body: {} });
    expect(platformPause.json.error).toMatchObject({ code: "conflict", message: expect.stringContaining("only its owner can resume it") });
  });

  it("refuses guarded sandbox actions it cannot carry out, explicitly", async () => {
    const probe = await call(OPERATOR_ROUTES.sandboxesProbe, { token: ALICE, method: "POST", body: {} });
    expect(probe.json).toMatchObject({ ok: true, message: expect.stringMatching(/did not answer/) });
    const stop = await call(OPERATOR_ROUTES.sandboxStop(crypto.randomUUID()), { token: ALICE, method: "POST", body: {} });
    expect(stop.json.error?.code).toBe("not_found");
  });

  it("tells a sandbox stop when core has a call in flight to a session's runtime", async () => {
    const bob = await connect(BOB);
    const sessionId = crypto.randomUUID();
    await bob.request("session.create", { sessionId });
    const sessions = gateway.gateway.app.service("sessions") as unknown as { runtimeActivity(id: string): { busy?: string; lastRequestAt?: number } | undefined };
    expect(sessions.runtimeActivity(sessionId)?.busy).toBeUndefined();
    const hold = runtime.holdNext("session.send", sessionId);
    const sending = bob.request("session.send", { sessionId, prompt: "hello" });
    await hold.held;
    expect(sessions.runtimeActivity(sessionId)).toMatchObject({ busy: "a call to its runtime is in progress", lastRequestAt: expect.any(Number) });
    hold.release();
    await sending;
    expect(sessions.runtimeActivity(sessionId)).toEqual({ lastRequestAt: expect.any(Number) });
  });

  it("streams platform events and log lines to operators", async () => {
    const controller = new AbortController();
    const response = await fetch(new URL(OPERATOR_ROUTES.stream, gateway.url), { headers: { authorization: `Bearer ${ALICE}` }, signal: controller.signal });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();
    let received = "";
    const sessionId = crypto.randomUUID();
    const bob = await connect(BOB);
    await bob.request("session.create", { sessionId });
    try {
      await waitUntil(async () => {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
        const platform = received.split("\n\n").some((block) => block.startsWith("event: platform") && block.includes(`"sessionId":"${sessionId}"`));
        return platform && received.includes("event: log");
      });
    } finally {
      controller.abort();
    }
    expect(received).toMatch(/event: platform\ndata: \{"id":"evt_[^"]+","type":"session\.created"/);
    expect(received).not.toContain(BOB);
  });

  it("serves the console with a strict content security policy and a single-page fallback", async () => {
    const redirect = await call("/console");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/console/");
    const index = await call("/console/");
    expect(index.status).toBe(200);
    expect(index.text).toContain("<div id=root>");
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call("/console/sessions/abc")).text).toContain("<div id=root>");
    expect((await call("/console/signin")).text).toContain("<div id=root>");
    const asset = await call("/console/assets/app-abc123.js");
    expect(asset.headers.get("content-type")).toMatch(/text\/javascript/);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await call("/console/assets/missing.js")).status).toBe(404);
    expect((await call("/console/missing.ico")).status).toBe(404);
    expect((await call("/console/%2e%2e/%2e%2e/package.json")).status).toBe(404);
    // Deep links to IDs with dots are console routes, not files.
    const dotted = await call("/console/sessions/my.session.v2");
    expect(dotted.status).toBe(200);
    expect(dotted.text).toContain("<div id=root>");
  });
});

describe("operator access without named operators", () => {
  it("treats every account as an operator on a loopback gateway, and stays off elsewhere", async () => {
    const runtime = new FakeRuntime();
    await runtime.start();
    const github = await startGitHubStub({ [BOB]: { id: 2002, login: "bob" } });
    const local = await startTestGateway({ runtime, githubUrl: github.url });
    const azure = await startTestGateway({ runtime, githubUrl: github.url, env: { MANAGED_COPILOT_MODE: "azure", HOST: "127.0.0.1" } });
    try {
      const me = await fetch(new URL(OPERATOR_ROUTES.me, local.url), { headers: { authorization: `Bearer ${BOB}` } });
      expect(await me.json()).toMatchObject({ account: { login: "bob" }, grant: "local" });
      const deployed = await fetch(new URL(OPERATOR_ROUTES.me, azure.url), { headers: { authorization: `Bearer ${BOB}` } });
      expect(deployed.status).toBe(403);
      expect(((await deployed.json()) as { error: { message: string } }).error.message).toMatch(/names no operators.*operator-users/);
      const info = (await (await fetch(new URL("/v1/info", azure.url), { headers: { authorization: `Bearer ${BOB}` } })).json()) as { capabilities: string[] };
      expect(info.capabilities).not.toContain("operator");
    } finally {
      await local.close();
      await azure.close();
      await runtime.close();
      await github.close();
    }
  });

  it("keeps the console off on a local gateway that listens beyond this machine", async () => {
    const app = {
      config: { mode: "local", host: "0.0.0.0", publicUrl: "http://localhost:7400", deployment: { name: "copilot", environments: {} } },
      service: () => ({ authenticate: async () => undefined, satisfies: async () => false }),
    };
    const access = new OperatorAccess({ app: app as never, log: createLogger("test", "error") });
    expect(access.localDefault).toBe(false);
    expect(access.enabled).toBe(false);
    await expect(access.authorize({ accountId: 1, login: "bob", token: "t" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/listens on 0\.0\.0\.0, beyond this machine/) });
    const loopback = new OperatorAccess({ app: { ...app, config: { ...app.config, host: "127.0.0.1" } } as never, log: createLogger("test", "error") });
    expect(await loopback.authorize({ accountId: 1, login: "bob", token: "t" })).toBe("local");
  });

  it("expires tickets and console sessions, and redeems a ticket once", () => {
    let now = 1_000_000;
    const app = { config: { mode: "local", host: "127.0.0.1", publicUrl: "https://copilot.example", deployment: { name: "copilot", environments: {} } } };
    const access = new OperatorAccess({ app: app as never, log: createLogger("test", "error"), now: () => now });
    const principal = { accountId: 1, login: "alice", token: "t" };
    const { ticket } = access.mintTicket(principal, "local");
    now += 61_000;
    expect(() => access.redeemTicket(ticket)).toThrow(/expired or was already used/);
    const fresh = access.mintTicket(principal, "local").ticket;
    expect(access.redeemTicket(fresh).principal.login).toBe("alice");
    expect(() => access.redeemTicket(fresh)).toThrow(/already used/);
    expect(() => access.redeemTicket("not-a-ticket")).toThrow(/expired or was already used/);

    const { cookie } = access.createSession(principal, "local");
    expect(access.session(cookie)?.principal.login).toBe("alice");
    // HTTPS deployments get a Secure, __Host- cookie.
    expect(access.setCookie(cookie, 60)).toMatch(/^__Host-mc_console=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=60; Secure$/);
    now += 61 * 60_000;
    expect(access.session(cookie)).toBeUndefined();
    const second = access.createSession(principal, "local");
    for (let hour = 0; hour < 9; hour++) {
      now += 55 * 60_000;
      if (access.session(second.cookie)) access.touch(second.session);
    }
    expect(access.session(second.cookie)).toBeUndefined();
  });
});
