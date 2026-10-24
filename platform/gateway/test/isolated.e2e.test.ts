// G1 acceptance for isolated placement through core: genuine CopilotClient/CopilotSession objects, real Docker
// sandboxes, and a real model. Opt in with MANAGED_COPILOT_E2E=1 after `pnpm build`; needs Docker and GH_TOKEN with
// Copilot access. Everything it creates is labelled with a unique instance and removed.
//
// Covers: a deployed custom agent selected at create, a `defineTool` tool executed in the caller's process and a shell
// command inside the sandbox in one streamed turn, one client creating two isolated sessions on different sandbox
// runtimes, `client.stop()` leaving sessions running and resume continuing the conversation, and deletion removing
// the sandboxes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approveAll, CopilotClient, CopilotSession, defineTool } from "@github/copilot-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
const enabled = process.env.MANAGED_COPILOT_E2E === "1" && Boolean(token);
const require = createRequire(import.meta.url);
const built = existsSync(join(dirname(require.resolve("@managed-copilot/sdk")), "bridge.js"));
const instance = `mcg1${Math.random().toString(36).slice(2, 7)}`;
const MODEL = process.env.MANAGED_COPILOT_E2E_MODEL ?? "claude-haiku-4.5";
const TIMEOUT = 300_000;

describe.runIf(enabled && built)("G1: isolated sessions through core with the stock SDK", { timeout: TIMEOUT }, () => {
  let gateway: RunningGateway;
  let temp: string;
  let managed: import("@managed-copilot/sdk").ManagedCopilot;
  const handled: { id: string; pid: number }[] = [];
  const lookupOrder = defineTool("lookup_order", {
    description: "Look up an order by id",
    parameters: z.object({ id: z.string() }),
    handler: async ({ id }) => {
      handled.push({ id, pid: process.pid });
      return { id, status: "shipped", carrier: "Contoso Freight" };
    },
  });

  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), "mc-g1-isolated-"));
    process.env.MANAGED_COPILOT_HOME = join(temp, "home");
    const apphost = join(temp, "apphost");
    mkdirSync(join(apphost, "customizations", "agents"), { recursive: true });
    writeFileSync(
      join(apphost, "customizations", "agents", "builder.agent.md"),
      "---\nname: builder\ndescription: Builds and inspects things in the workspace\n---\nYou are the builder agent. Use tools when asked.\n",
    );
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
        MANAGED_COPILOT_DATA_DIR: join(temp, "data"),
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: instance,
        MANAGED_COPILOT_APPHOST_DIR: apphost,
        MANAGED_COPILOT_CONFIG: JSON.stringify({ name: "g1", environments: { coder: { type: "isolated", size: "small", customizations: "./customizations" } } }),
      }),
    );
    const { ManagedCopilot } = await import("@managed-copilot/sdk");
    managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token! });
  }, TIMEOUT);

  afterAll(async () => {
    for (const info of (await managed?.sessions.list().catch(() => [])) ?? []) await managed.sessions.delete(info.id).catch(() => undefined);
    await managed?.close();
    await gateway?.close();
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, TIMEOUT);

  it("runs caller-process tools and sandbox commands, isolates sessions, and survives client.stop()", async () => {
    const client = await managed.client("coder");
    expect(client).toBeInstanceOf(CopilotClient);
    const session = await client.createSession({ model: MODEL, agent: "builder", tools: [lookupOrder], streaming: true, onPermissionRequest: approveAll });
    expect(session).toBeInstanceOf(CopilotSession);
    const current = await session.rpc.agent.getCurrent();
    expect(current.agent).toMatchObject({ name: "builder", path: "/opt/managed-copilot/customizations/agents/builder.agent.md" });

    let deltas = 0;
    session.on("assistant.message_delta", () => deltas++);
    const reply = await session.sendAndWait(
      { prompt: "Use lookup_order for order 1234. Then run `uname -s && whoami && pwd` in the shell. Reply with the order status and the three command outputs." },
      TIMEOUT,
    );
    const text = reply?.data.content ?? "";
    expect(handled.some((call) => call.id === "1234" && call.pid === process.pid)).toBe(true);
    expect(text).toMatch(/shipped/i);
    expect(text).toMatch(/Linux/);
    expect(text).toMatch(/\/workspace/);
    expect(deltas).toBeGreaterThan(0);

    // One client, two isolated sessions, two sandbox runtimes.
    const second = await client.createSession({ model: MODEL, onPermissionRequest: approveAll });
    const [first, other] = await Promise.all([managed.sessions.get(session.sessionId), managed.sessions.get(second.sessionId)]);
    expect(first.sandbox?.id).toBeTruthy();
    expect(other.sandbox?.id).toBeTruthy();
    expect(first.sandbox?.id).not.toBe(other.sandbox?.id);

    // client.stop() detaches; the session keeps running and resume continues it.
    await client.stop();
    const resumed = await managed.resumeSession(session.sessionId, { tools: [lookupOrder], onPermissionRequest: approveAll });
    const again = await resumed.sendAndWait({ prompt: "What was the order status you found earlier? One short sentence." }, TIMEOUT);
    expect(again?.data.content ?? "").toMatch(/shipped/i);
    expect((await resumed.getEvents()).filter((event) => event.type === "user.message").length).toBeGreaterThanOrEqual(2);
    expect((await resumed.rpc.agent.getCurrent()).agent?.name).toBe("builder");
    await resumed.disconnect();

    // Deleting the sessions removes their sandboxes.
    for (const id of [session.sessionId, second.sessionId]) await managed.sessions.delete(id);
    const left = execFileSync("docker", ["ps", "-a", "--filter", `name=${instance}-sbx`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    expect(left).toBe("");
  });
});
