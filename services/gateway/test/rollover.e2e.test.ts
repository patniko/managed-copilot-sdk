// Gateway replacement mid-turn (the Azure rollover hang): the turn the old gateway was running ends visibly (the
// ledger's lastTurn is `failed`) and the session takes new turns. Covers a crashed gateway whose sandbox runtime keeps
// running (the runtime still holds its inference provider for the dead connection, so it is restarted), a graceful
// shutdown that stopped the sandbox, and a shared session whose runtime dies with the gateway. Needs core's lost-turn
// accounting and runtime reopen (7eb2e18) alongside the sandbox side.
// Opt in with MANAGED_COPILOT_E2E=1 after `pnpm build`; needs Docker and GH_TOKEN with Copilot access.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll, type CopilotSession } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
const enabled = process.env.MANAGED_COPILOT_E2E === "1" && Boolean(token);
const require = createRequire(import.meta.url);
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const built = existsSync(join(dirname(require.resolve("@managed-copilot/sdk")), "bridge.js")) && existsSync(MAIN);
const MODEL = process.env.MANAGED_COPILOT_E2E_MODEL ?? "claude-haiku-4.5";
const TIMEOUT = 420_000;
const ESSAY = "Write a detailed essay of about 1500 words on the history of programming language compilers, in plain prose with no headings. Do not use any tools.";

type ManagedCopilot = import("@managed-copilot/sdk").ManagedCopilot;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function healthy(port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((res) => res.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The gateway did not become healthy");
}

/** Sends a long prompt and resolves once its answer is streaming (the turn is mid-inference). */
async function midTurn(session: CopilotSession): Promise<void> {
  let deltas = 0;
  session.on("assistant.message_delta", () => void deltas++);
  void session.send({ prompt: ESSAY }).catch(() => undefined);
  const deadline = Date.now() + 120_000;
  while (deltas < 20) {
    if (Date.now() > deadline) throw new Error("The answer never started streaming");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.runIf(enabled && built)("gateway replacement mid-turn", { timeout: TIMEOUT }, () => {
  let temp: string;
  let instance: string;
  let port: number;
  const gateways: RunningGateway[] = [];
  const children: ChildProcess[] = [];
  const clients: ManagedCopilot[] = [];

  function settings(config: object, sharedRuntime: boolean): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    delete env["MANAGED_COPILOT_SHARED_RUNTIME"];
    return {
      ...env,
      PORT: String(port),
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      MANAGED_COPILOT_HOME: join(temp, "home"),
      MANAGED_COPILOT_DATA_DIR: join(temp, "data"),
      MANAGED_COPILOT_WRITE_DISCOVERY: "0",
      ...(sharedRuntime ? {} : { MANAGED_COPILOT_SHARED_RUNTIME: "0" }),
      MANAGED_COPILOT_INSTANCE: instance,
      MANAGED_COPILOT_APPHOST_DIR: join(temp, "apphost"),
      MANAGED_COPILOT_CONFIG: JSON.stringify(config),
    };
  }

  async function connect(): Promise<ManagedCopilot> {
    const { ManagedCopilot } = await import("@managed-copilot/sdk");
    const managed = await ManagedCopilot.connect({ url: `http://127.0.0.1:${port}`, gitHubToken: token! });
    clients.push(managed);
    return managed;
  }

  async function begin(): Promise<void> {
    temp = mkdtempSync(join(tmpdir(), "mc-rollover-"));
    mkdirSync(join(temp, "apphost"), { recursive: true });
    instance = `mcro${Math.random().toString(36).slice(2, 7)}`;
    port = await freePort();
    process.env.MANAGED_COPILOT_HOME = join(temp, "home");
  }

  /** The new gateway resumes the session: the cut turn has ended as failed, and a new turn completes. */
  async function expectRecovered(managed: ManagedCopilot, sessionId: string): Promise<void> {
    const resumed = await managed.resumeSession(sessionId, { onPermissionRequest: approveAll });
    const info = await managed.sessions.get(sessionId);
    expect(info.lastTurn?.status).toBe("failed");
    expect(info.state).toBe("idle");
    const reply = await resumed.sendAndWait({ prompt: "Reply with the single word: ready" }, TIMEOUT);
    expect(reply?.data.content ?? "").toMatch(/ready/i);
    expect((await managed.sessions.get(sessionId)).lastTurn?.status).toBe("completed");
    await resumed.disconnect();
  }

  afterEach(async () => {
    for (const managed of clients.splice(0)) {
      for (const info of (await managed.sessions.list().catch(() => [])) ?? []) await managed.sessions.delete(info.id).catch(() => undefined);
      await managed.close().catch(() => undefined);
    }
    for (const gateway of gateways.splice(0)) await gateway.close().catch(() => undefined);
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
    // What a killed gateway started and nothing else owns (its relay and networks).
    const names = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).split(/\r?\n/).filter((name) => name.startsWith(`${instance}-`));
    for (const name of names(["ps", "-a", "--format", "{{.Names}}"])) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const name of names(["network", "ls", "--format", "{{.Name}}"])) execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
    for (const name of names(["volume", "ls", "--format", "{{.Name}}"])) execFileSync("docker", ["volume", "rm", "-f", name], { stdio: "ignore" });
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, TIMEOUT);

  it("recovers an isolated session whose sandbox runtime outlived a crashed gateway", async () => {
    await begin();
    const config = { name: "rollover", environments: { coder: { type: "isolated", size: "small" } } };
    const first = spawn(process.execPath, [MAIN], { env: settings(config, false), stdio: ["ignore", "ignore", "ignore"] });
    children.push(first);
    await healthy(port);
    const before = await connect();
    const session = await (await before.client("coder")).createSession({ model: MODEL, streaming: true, onPermissionRequest: approveAll });
    const sandboxId = (await before.sessions.get(session.sessionId)).sandbox?.id;
    expect(sandboxId).toBeTruthy();
    await midTurn(session);
    // The gateway dies without shutting down: the sandbox keeps running, its runtime holding the dead connection.
    first.kill("SIGKILL");
    await new Promise((resolve) => first.once("exit", resolve));
    const container = `${instance}-${sandboxId!.replace("_", "-")}`;
    expect(execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).trim()).toBe("true");

    gateways.push(await startGateway(loadConfig(settings(config, false))));
    await expectRecovered(await connect(), session.sessionId);
    // The same sandbox, its runtime replaced rather than the sandbox recreated.
    expect(execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toMatch(/Copilot runtime restarted on request/);
  });

  it("recovers an isolated session whose sandbox a graceful gateway shutdown stopped", async () => {
    await begin();
    const config = { name: "rollover", environments: { coder: { type: "isolated", size: "small" } } };
    const first = await startGateway(loadConfig(settings(config, false)));
    const before = await connect();
    const session = await (await before.client("coder")).createSession({ model: MODEL, streaming: true, onPermissionRequest: approveAll });
    await midTurn(session);
    await first.close();
    gateways.push(await startGateway(loadConfig(settings(config, false))));
    await expectRecovered(await connect(), session.sessionId);
  });

  it("recovers a shared session whose runtime died with the gateway", async () => {
    await begin();
    const config = { name: "rollover", environments: { chat: { type: "shared" } } };
    const first = await startGateway(loadConfig(settings(config, true)));
    const before = await connect();
    const session = await (await before.client("chat")).createSession({ model: MODEL, streaming: true, onPermissionRequest: approveAll });
    await midTurn(session);
    await first.close();
    gateways.push(await startGateway(loadConfig(settings(config, true))));
    await expectRecovered(await connect(), session.sessionId);
  });
});
