/**
 * Live acceptance for gate G2 (durable actions, webhooks, polling, schedules) against a real gateway, the stock
 * shared runtime, and real models. Not part of `pnpm test`: it needs a GitHub account with Copilot.
 *
 *   pnpm build
 *   npx tsx packages/sdk/test/acceptance/durable.live.ts            # all scenarios
 *   npx tsx packages/sdk/test/acceptance/durable.live.ts webhook    # one of: webhook, poll, schedule, agent
 *
 * The token comes from MANAGED_COPILOT_GITHUB_TOKEN / GH_TOKEN / `gh auth token`. The harness starts its own gateway
 * on a free port with temporary data, a webhook worker built on `verifyWebhook`, and cleans both up.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { approveAll, defineTool } from "@github/copilot-sdk";
import { ROUTES, type PendingAction, type ScheduleRun } from "@managed-copilot/protocol";
// The built package, as customers use it: the stock client spawns dist/bridge.js next to it.
import { ManagedCopilot, verifyWebhook } from "../../dist/index.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const SECRET = `whsec_acceptance_${Math.random().toString(36).slice(2)}`;
const only = process.argv[2];

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${message}\n`);
}

function token(): string {
  const fromEnv = process.env.MANAGED_COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 180_000, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// The application's tool. Its handler only ever runs in this process (live), the webhook worker, or a poller.
const executions: { orderId: string; via: string; idempotencyKey: string }[] = [];
function lookupOrderTool(via: string) {
  return defineTool("lookup_order", {
    description: "Look up a Contoso order by id and return its shipping status",
    parameters: { type: "object", properties: { id: { type: "string", description: "Order id, e.g. 1234" } }, required: ["id"] },
    handler: async ({ id }: { id: string }, invocation) => {
      executions.push({ orderId: id, via, idempotencyKey: `${invocation.sessionId}:${invocation.toolCallId}` });
      return { id, status: "shipped", carrier: "UPS", eta: "October 27" };
    },
  });
}

interface Harness {
  readonly url: string;
  readonly gateway: ChildProcess;
  readonly worker: Server;
  readonly workerUrl: string;
  readonly events: { type: string; sessionId?: string; data: Record<string, unknown> }[];
  /** Raw signed deliveries as received, for replaying (at-least-once redelivery). */
  readonly deliveries: { headers: Record<string, string>; body: Buffer }[];
  readonly dataDir: string;
}

async function startHarness(gitHubToken: string): Promise<Harness> {
  const [gatewayPort, workerPort] = [await freePort(), await freePort()];
  const dataDir = mkdtempSync(join(tmpdir(), "mc-durable-acceptance-"));
  const events: Harness["events"] = [];
  const deliveries: Harness["deliveries"] = [];

  // The webhook worker from spec section 12: verify the raw body, then answer the event's listed actions.
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks);
          const event = await verifyWebhook({ headers: req.headers, rawBody: body }, SECRET);
          deliveries.push({ headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value)])), body });
          events.push({ type: event.type, ...(event.sessionId ? { sessionId: event.sessionId } : {}), data: event.data });
          if (event.type === "session.action_required") {
            const results = await event.handleActions({ tools: [lookupOrderTool("webhook")], onPermissionRequest: approveAll });
            log(`  webhook answered ${results.length} action(s): ${results.map((r) => `${r.actionId}=${r.state}`).join(", ") || "none pending"}`);
          }
          res.writeHead(200).end();
        } catch (error) {
          log(`  webhook rejected a delivery: ${(error as Error).message}`);
          res.writeHead(401).end();
        }
      })();
    });
  });
  await new Promise<void>((done) => worker.listen(workerPort, "127.0.0.1", () => done()));

  const config = {
    name: "acceptance",
    environments: {
      chat: { type: "shared", description: "Chat with app tools", scheduling: true },
      polled: { type: "shared", description: "No webhook: answered by polling" },
    },
    webhooks: {
      orders: {
        url: `http://127.0.0.1:${workerPort}/api/copilot-events`,
        environments: ["chat"],
        events: ["session.action_required", "session.idle", "session.failed", "schedule.run_started", "schedule.run_completed"],
        secret: { secretEnv: "ORDERS_WEBHOOK_SECRET" },
      },
    },
  };
  const gateway = spawn(process.execPath, [join(ROOT, "platform/gateway/dist/main.js")], {
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      MANAGED_COPILOT_DATA_DIR: dataDir,
      MANAGED_COPILOT_HOME: join(dataDir, "home"),
      MANAGED_COPILOT_WRITE_DISCOVERY: "0",
      MANAGED_COPILOT_CONFIG: JSON.stringify(config),
      ORDERS_WEBHOOK_SECRET: SECRET,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const gatewayLog: string[] = [];
  const capture = (chunk: Buffer) => {
    gatewayLog.push(chunk.toString());
    if (process.env.SHOW_GATEWAY_LOG) process.stdout.write(`    gw| ${chunk}`);
  };
  gateway.stdout!.on("data", capture);
  gateway.stderr!.on("data", capture);
  process.on("exit", () => gateway.kill());
  const url = `http://127.0.0.1:${gatewayPort}`;
  try {
    await waitFor("the gateway", async () => ((await fetch(`${url}/healthz`).catch(() => undefined))?.ok ? true : undefined), 60_000, 500);
    // The shared runtime starts after the HTTP listener; give it a moment to come up.
    await waitFor("the shared runtime", async () => {
      const info = (await (await fetch(`${url}${ROUTES.info}`, { headers: { authorization: `Bearer ${gitHubToken}` } })).json()) as { capabilities?: string[] };
      return info.capabilities?.includes("shared") ? true : undefined;
    }, 60_000, 500);
  } catch (error) {
    process.stderr.write(gatewayLog.join(""));
    throw error;
  }

  // `npx managed-copilot login`: authorize this deployment for background work, as this account.
  const login = await fetch(`${url}${ROUTES.backgroundCredential}`, { method: "POST", headers: { authorization: `Bearer ${gitHubToken}`, "content-type": "application/json" }, body: "{}" });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status} ${await login.text()}`);
  log(`gateway ${url} ready; background sign-in active`);
  return { url, gateway, worker, workerUrl: `http://127.0.0.1:${workerPort}/api/copilot-events`, events, deliveries, dataDir };
}

async function actionsOf(url: string, gitHubToken: string, sessionId: string): Promise<PendingAction[]> {
  const response = await fetch(`${url}${ROUTES.actions(sessionId)}`, { headers: { authorization: `Bearer ${gitHubToken}` } });
  return (await response.json()) as PendingAction[];
}

const PROMPT = "Use the lookup_order tool to check order 1234, then tell me its status in one short sentence.";

/** Section 12: send, close the app, and a webhook handler answers the tool. */
async function webhookScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO webhook: send, close the app, the webhook worker answers lookup_order");
  const before = executions.length;
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const client = await managed.client("chat");
  const session = await client.createSession({ tools: [lookupOrderTool("live")], onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  await session.send({ prompt: PROMPT });
  await managed.close(); // detach; accepted work belongs to the service
  log(`  sent and detached from session ${sessionId}`);

  await waitFor("the webhook to answer the tool and the turn to finish", () =>
    harness.events.some((event) => event.type === "session.idle" && event.sessionId === sessionId) && executions.slice(before).some((e) => e.via === "webhook")
      ? true
      : undefined,
  );
  const actions = await actionsOf(harness.url, gitHubToken, sessionId);
  const tool = actions.find((action) => action.kind === "tool");
  assert(tool?.state === "completed" && tool.claimedBy?.startsWith("webhook:orders"), `tool action completed by the webhook (got ${JSON.stringify(tool)})`);
  const mine = executions.slice(before);
  assert(mine.every((e) => e.via !== "live"), "the detached app never executed the tool");
  assert(mine.filter((e) => e.via === "webhook").length === 1, "the tool ran exactly once");
  assert(mine[0]!.idempotencyKey === tool.idempotencyKey, "the handler saw the action's idempotency identity");

  // At-least-once delivery: replaying every signed delivery for this session executes nothing again.
  const replays = harness.deliveries.filter((delivery) => delivery.body.toString("utf8").includes(sessionId));
  for (const delivery of replays) {
    const response = await fetch(harness.workerUrl, { method: "POST", headers: delivery.headers, body: delivery.body });
    assert(response.ok, `a redelivered event is accepted (HTTP ${response.status})`);
  }
  assert(executions.slice(before).length === 1, `redelivering ${replays.length} events never re-executed the tool`);

  const reader = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const resumed = await reader.resumeSession(sessionId, { tools: [lookupOrderTool("live")], onPermissionRequest: approveAll });
  const reply = (await resumed.getEvents())
    .filter((event) => event.type === "assistant.message")
    .map((event) => String((event.data as { content?: string }).content ?? ""))
    .join(" ");
  await reader.close();
  assert(/shipped/i.test(reply), `the agent used the tool result (reply: ${reply.slice(0, 200)})`);
  log(`  PASS: answered once by ${tool.claimedBy} (${tool.idempotencyKey}); agent: ${reply.trim().slice(0, 120)}`);
}

/** Section 12 polling: the same contract, answered by `managed.sessions.handleActions`. */
async function pollScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO poll: no webhook covers this environment; a poller claims and answers");
  const before = executions.length;
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const client = await managed.client("polled");
  const session = await client.createSession({ tools: [lookupOrderTool("live")], onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  await session.send({ prompt: PROMPT });
  await managed.close();
  log(`  sent and detached from session ${sessionId}`);

  const poller = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const handled: string[] = [];
  await waitFor("the poller to answer the tool", async () => {
    const { pendingActions } = await poller.sessions.get(sessionId);
    if (pendingActions.length === 0) return undefined;
    const results = await poller.sessions.handleActions(sessionId, { tools: [lookupOrderTool("poll")], onPermissionRequest: approveAll });
    handled.push(...results.map((result) => `${result.actionId}=${result.state}`));
    return executions.slice(before).some((e) => e.via === "poll") ? true : undefined;
  });
  await waitFor("the turn to finish", async () => ((await poller.sessions.get(sessionId)).lastTurn?.status === "completed" ? true : undefined));
  // A second poll after the fact never re-executes: the ledger has the recorded outcome.
  await poller.sessions.handleActions(sessionId, { tools: [lookupOrderTool("poll")], onPermissionRequest: approveAll });
  await poller.close();
  assert(executions.slice(before).length === 1, `the tool ran exactly once (ran ${executions.slice(before).length} times)`);
  log(`  PASS: ${handled.join(", ")}`);
}

/** Section 13: a cron schedule with stored tool declarations, run now, answered by the webhook route. */
async function scheduleScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO schedule: cron schedule with stored tool declarations, runNow, the webhook answers");
  const before = executions.length;
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const schedule = await managed.schedules.create({
    name: "weekday-triage",
    cron: "0 9 * * 1-5",
    timeZone: "America/Los_Angeles",
    environment: "chat",
    session: { tools: [lookupOrderTool("live")] },
    webhook: "orders",
    prompt: "Use the lookup_order tool to check order 1234 and summarize its status in one sentence.",
  });
  log(`  created ${schedule.id}, next run ${schedule.nextRunAt}`);
  const run = await managed.schedules.runNow(schedule.id);
  const finished = await waitFor<ScheduleRun>("the scheduled run to finish", async () => {
    const latest = (await managed.schedules.runs(schedule.id)).find((candidate) => candidate.id === run.id);
    return latest && ["completed", "failed", "needs_reconciliation", "skipped"].includes(latest.status) ? latest : undefined;
  });
  assert(finished.status === "completed", `run completed (got ${finished.status}: ${finished.reason ?? ""})`);
  assert(executions.slice(before).filter((e) => e.via === "webhook").length === 1, "the webhook answered the scheduled session's tool once");
  assert(harness.events.some((event) => event.type === "schedule.run_started" && event.data.runId === run.id), "schedule.run_started was delivered");
  const again = await managed.schedules.runNow(schedule.id, { invocationId: "acceptance-1" });
  const repeat = await managed.schedules.runNow(schedule.id, { invocationId: "acceptance-1" });
  assert(again.id === repeat.id, "runNow is idempotent per invocation ID");
  await managed.schedules.delete(schedule.id);
  await managed.close();
  log(`  PASS: run ${finished.id} completed in session ${finished.sessionId}`);
}

/** Section 13: the agent calls schedule_task for a one-shot reminder that fires later and continues its session. */
async function agentScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO agent: schedule_task for a one-shot reminder that continues the session");
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const client = await managed.client("chat");
  const session = await client.createSession({ onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  const reminders: string[] = [];
  session.on("user.message", (event) => {
    const data = event.data as { source?: string; content?: string };
    if (data.source === "system") reminders.push(String(data.content));
  });
  const reply = await session.sendAndWait(
    { prompt: "Use the schedule_task tool with delaySeconds 20 to remind me to stretch; the reminder prompt should say 'Reminder: time to stretch'. Then confirm in one sentence." },
    120_000,
  );
  log(`  agent: ${String(reply?.data.content ?? "").trim().slice(0, 140)}`);
  const [created] = (await managed.schedules.list()).filter((schedule) => schedule.target?.sessionId === sessionId);
  assert(created && created.createdBy === "agent", "the agent created a schedule targeting its own session");
  log(`  ${created.id} runs at ${created.nextRunAt}`);
  await waitFor("the reminder run to complete", async () => {
    const runs = await managed.schedules.runs(created.id);
    return runs[0]?.status === "completed" ? runs[0] : undefined;
  });
  assert(reminders.length === 1, `the reminder arrived in the session once (got ${reminders.length})`);
  await managed.close();
  log(`  PASS: reminder delivered into ${sessionId}: "${reminders[0]}"`);
}

/** Section 11: actions that waited while the app was away replay to the app when it resumes with its handlers. */
async function resumeScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO resume: the call waits while the app is away, then runs in the app when it resumes");
  const before = executions.length;
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const client = await managed.client("polled");
  const session = await client.createSession({ tools: [lookupOrderTool("first-process")], onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  await session.send({ prompt: PROMPT });
  await managed.close();
  const waiting = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  await waitFor("the session's call to wait durably", async () => ((await waiting.sessions.get(sessionId)).pendingActions.some((action) => action.state === "pending") ? true : undefined));
  log(`  waiting with no responder attached: ${(await waiting.sessions.get(sessionId)).pendingActions.map((action) => `${action.kind}:${action.tool ?? action.requestId}`).join(", ")}`);

  const resumed = await waiting.resumeSession(sessionId, { tools: [lookupOrderTool("resumed-process")], onPermissionRequest: approveAll });
  await waitFor("the resumed app to answer and the turn to finish", async () => ((await waiting.sessions.get(sessionId)).lastTurn?.status === "completed" ? true : undefined));
  const reply = (await resumed.getEvents()).filter((event) => event.type === "assistant.message").map((event) => String((event.data as { content?: string }).content ?? "")).join(" ");
  await waiting.close();
  const mine = executions.slice(before);
  assert(mine.length === 1 && mine[0]!.via === "resumed-process", `the resumed app ran the tool once (got ${JSON.stringify(mine)})`);
  assert(/shipped/i.test(reply), "the agent used the result");
  log(`  PASS: replayed to the resumed client; agent: ${reply.trim().slice(0, 100)}`);
}

/** G2: a disconnect while a tool runs is uncertain: never re-run automatically; the owner reconciles explicitly. */
async function reconcileScenario(harness: Harness, gitHubToken: string): Promise<void> {
  log("SCENARIO reconcile: the app disconnects mid-tool; the outcome is uncertain until the owner reconciles");
  const before = executions.length;
  let started!: () => void;
  const handlerStarted = new Promise<void>((done) => (started = done));
  const slowTool = defineTool("lookup_order", {
    description: "Look up a Contoso order by id and return its shipping status",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }: { id: string }, invocation) => {
      executions.push({ orderId: id, via: "disconnected-app", idempotencyKey: `${invocation.sessionId}:${invocation.toolCallId}` });
      started();
      await new Promise((done) => setTimeout(done, 4_000));
      return { id, status: "shipped" };
    },
  });
  const managed = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const client = await managed.client("polled");
  const session = await client.createSession({ tools: [slowTool], onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  await session.send({ prompt: PROMPT });
  await handlerStarted;
  await managed.close(); // the process loses its connection while the handler is running
  log("  disconnected while lookup_order was running");

  const owner = await ManagedCopilot.connect({ url: harness.url, gitHubToken });
  const uncertain = await waitFor("the action to need reconciliation", async () =>
    (await owner.sessions.get(sessionId)).pendingActions.find((action) => action.kind === "tool" && action.state === "needs_reconciliation"),
  );
  log(`  ${uncertain.id}: ${uncertain.state} (${uncertain.reason})`);
  // A resumed client and a poller must not run it again.
  const resumed = await owner.resumeSession(sessionId, { tools: [lookupOrderTool("resumed-process")], onPermissionRequest: approveAll });
  const polled = await owner.sessions.handleActions(sessionId, { tools: [lookupOrderTool("poll")], onPermissionRequest: approveAll });
  await new Promise((done) => setTimeout(done, 2_000));
  assert(executions.slice(before).length === 1, `nothing re-ran the uncertain tool (polled: ${JSON.stringify(polled)})`);

  // The owner checks the downstream effect by its idempotency key, then records the reconciled outcome.
  const headers = { authorization: `Bearer ${gitHubToken}`, "content-type": "application/json" };
  const claim = (await (await fetch(`${harness.url}${ROUTES.actionClaim(sessionId, uncertain.id)}`, { method: "POST", headers, body: JSON.stringify({ reconcile: true, responder: "operator" }) })).json()) as {
    claimToken: string;
  };
  const answer = await fetch(`${harness.url}${ROUTES.actionResult(sessionId, uncertain.id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ claimToken: claim.claimToken, result: JSON.stringify({ id: "1234", status: "shipped", note: `reconciled via ${uncertain.idempotencyKey}` }) }),
  });
  assert(answer.ok, `the reconciled result was accepted (HTTP ${answer.status})`);
  await waitFor("the turn to finish", async () => ((await owner.sessions.get(sessionId)).lastTurn?.status === "completed" ? true : undefined));
  void resumed;
  await owner.close();
  assert(executions.slice(before).length === 1, "the tool ran exactly once overall");
  log("  PASS: no automatic re-run; the reconciled answer completed the turn");
}

const scenarios = {
  webhook: webhookScenario,
  poll: pollScenario,
  resume: resumeScenario,
  reconcile: reconcileScenario,
  schedule: scheduleScenario,
  agent: agentScenario,
} as const;

async function main(): Promise<void> {
  const gitHubToken = token();
  const harness = await startHarness(gitHubToken);
  let failed = false;
  try {
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (only && only !== name) continue;
      try {
        await scenario(harness, gitHubToken);
      } catch (error) {
        failed = true;
        log(`  FAIL ${name}: ${(error as Error).stack ?? String(error)}`);
      }
    }
  } finally {
    harness.gateway.kill();
    await new Promise<void>((done) => harness.worker.close(() => done()));
    await new Promise((done) => setTimeout(done, 1_000));
    try {
      rmSync(harness.dataDir, { recursive: true, force: true });
    } catch {
      // The runtime may still hold files briefly on Windows.
    }
  }
  log(failed ? "Some scenarios FAILED" : "All scenarios passed");
  process.exit(failed ? 1 : 0);
}

await main();
