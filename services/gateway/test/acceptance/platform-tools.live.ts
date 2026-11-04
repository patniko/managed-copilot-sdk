/**
 * Live check of the platform-tool plumbing direct execution needs, against the stock shared runtime and a real model.
 * Not part of `pnpm test`: it needs a GitHub account with Copilot.
 *
 *   pnpm build
 *   npx tsx services/gateway/test/acceptance/platform-tools.live.ts
 *
 * The gateway runs in this process (so the script can register platform tools), with the actions ledger. It checks:
 * - attribution: a stock `task` sub-agent's call to a platform tool reaches the handler with its `agentId`, and the
 *   root agent's with none, matching the `agentId` on the session's `tool.execution_start` events;
 * - cancellation: aborting the turn while a platform tool runs aborts the handler's signal.
 * The token comes from MANAGED_COPILOT_GITHUB_TOKEN / GH_TOKEN / `gh auth token`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "../../../../libraries/sdk/dist/index.js";
import { loadConfig } from "../../dist/config.js";
import { startGateway } from "../../dist/server.js";
import type { PlatformToolCallContext } from "../../src/modules/core/contracts.js";

const MODEL = process.env.MODEL ?? "claude-sonnet-5";

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${message}\n`);
}

function token(): string {
  const fromEnv = process.env.MANAGED_COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "mc-platform-tools-live-"));
const gateway = await startGateway(
  loadConfig({
    ...process.env,
    PORT: "0",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    MANAGED_COPILOT_DATA_DIR: dataDir,
    MANAGED_COPILOT_HOME: join(dataDir, "home"),
    MANAGED_COPILOT_WRITE_DISCOVERY: "0",
    MANAGED_COPILOT_EGRESS: "off",
    MANAGED_COPILOT_CONFIG: JSON.stringify({ name: "acceptance", environments: { chat: { type: "shared", description: "Platform tool checks" } } }),
  }),
);

const notes: { note: string; context: PlatformToolCallContext }[] = [];
const waits: { context: PlatformToolCallContext; reason?: unknown }[] = [];
const tools = gateway.app.service("platformTools");
tools.register({
  name: "record_note",
  description: "Records a short note in the operator's log and returns a receipt. Call it when asked to record a note.",
  parameters: { type: "object", properties: { note: { type: "string", description: "The note" } }, required: ["note"] },
  handler: (args, context) => {
    const note = String((args as { note?: unknown }).note ?? "");
    notes.push({ note, context });
    return `Recorded "${note}" (receipt ${notes.length}).`;
  },
});
tools.register({
  name: "wait_for_signal",
  description: "Waits for an external signal. Call it when asked to wait for the signal.",
  parameters: { type: "object", properties: {} },
  replay: "never",
  handler: (_args, context) =>
    new Promise((resolve, reject) => {
      const entry: (typeof waits)[number] = { context };
      waits.push(entry);
      const timer = setTimeout(() => resolve("the signal arrived"), 5 * 60_000);
      context.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          entry.reason = context.signal!.reason;
          reject(context.signal!.reason);
        },
        { once: true },
      );
    }),
});

let failed = false;
let managed: ManagedCopilot | undefined;
try {
  const gitHubToken = token();
  for (let deadline = Date.now() + 60_000; ; ) {
    const info = (await (await fetch(`${gateway.url}/v1/info`, { headers: { authorization: `Bearer ${gitHubToken}` } })).json().catch(() => ({}))) as { capabilities?: string[] };
    if (info.capabilities?.includes("shared")) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the shared runtime");
    await new Promise((done) => setTimeout(done, 500));
  }
  managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken });
  const client = await managed.client("chat");

  log("SCENARIO attribution: a task sub-agent and the root agent both call record_note");
  const session = await client.createSession({
    model: MODEL,
    onPermissionRequest: approveAll,
    // Opt in to the sub-agent built-ins (shared sessions without agents leave them off by default).
    availableTools: ["builtin:task", "builtin:read_agent", "builtin:list_agents", "custom:*"],
  });
  const starts: { toolName: string; agentId?: string; toolCallId?: string }[] = [];
  session.on("tool.execution_start", (event) => {
    const data = event.data as { toolName?: string; toolCallId?: string };
    starts.push({ toolName: String(data.toolName), ...(event.agentId ? { agentId: event.agentId } : {}), ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}) });
  });
  const reply = await session.sendAndWait(
    {
      prompt:
        'Do exactly two things. First, use the task tool to start one general-purpose sub-agent whose only job is to call the record_note tool with the note "from the sub-agent" and report the receipt. ' +
        'After it finishes, call record_note yourself with the note "from the root agent". Then reply with both receipts.',
    },
    5 * 60_000,
  );
  log(`  reply: ${String(reply?.data.content ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  for (const { note, context } of notes) log(`  handler saw "${note}" from agent ${context.agentId ?? "(root)"} (action ${context.actionId})`);
  const sub = notes.find((entry) => /sub-agent/.test(entry.note));
  const root = notes.find((entry) => /root/.test(entry.note));
  assert(sub, "the sub-agent called record_note");
  assert(root, "the root agent called record_note");
  assert(typeof sub.context.agentId === "string" && sub.context.agentId.length > 0, "the sub-agent's call carries its agentId");
  assert(root.context.agentId === undefined, "the root agent's call carries no agentId");
  assert(sub.context.actionId && root.context.actionId, "both calls ran through the actions ledger");
  const subStart = starts.find((start) => start.toolName === "record_note" && start.toolCallId === sub.context.toolCallId);
  assert(subStart?.agentId === sub.context.agentId, `the handler's agentId matches the event's (${subStart?.agentId} vs ${sub.context.agentId})`);
  const task = starts.find((start) => start.toolName === "task");
  assert(task && task.agentId === undefined, "the root agent started the sub-agent");
  log(`  PASS: sub-agent ${sub.context.agentId} attributed; root call unattributed`);

  log("SCENARIO cancellation: abort the turn while wait_for_signal runs");
  const second = await client.createSession({ model: MODEL, onPermissionRequest: approveAll });
  await second.send({ prompt: "Call the wait_for_signal tool now, then tell me what it returned." });
  const waiting = await waitFor("the platform tool to start", () => waits.find((entry) => entry.context.sessionId === second.sessionId));
  await second.abort();
  const reason = await waitFor("the handler's signal to abort", () => waiting.reason, 30_000);
  log(`  handler aborted: ${(reason as { code?: string }).code}: ${(reason as Error).message}`);
  assert((reason as { code?: string }).code === "conflict", "the abort reason says the runtime stopped waiting");
  log("  PASS: aborting the turn aborted the platform tool");
} catch (error) {
  failed = true;
  log(`FAIL: ${(error as Error).stack ?? String(error)}`);
} finally {
  await managed?.close().catch(() => undefined);
  await gateway.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
