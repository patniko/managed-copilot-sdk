// G5 acceptance with the stock SDK and runtime, a real model, and real Docker sandboxes: the spec's section 9 snippet.
// A promotable session starts on shared placement, answers a question there, then a prompt that needs Python makes
// the agent call request_sandbox; the same CopilotSession object and ID continue in the sandbox, the caller's
// sendAndWait returns only after the continued work finished, outputs/summary.json is published as an artifact, and
// `session.promoted` arrives with the sandbox ID. Skips cleanly without a GitHub token or a reachable Docker engine.
// Everything it creates is labelled with a unique instance and removed afterwards; what a killed run left behind is
// removed by the next run once it is clearly stale.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approveAll, CopilotSession, defineTool, type SessionEvent } from "@github/copilot-sdk";
import type { PlatformEvent } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
const require = createRequire(import.meta.url);
const built = existsSync(join(dirname(require.resolve("@managed-copilot/sdk")), "bridge.js"));
const INTRUDER = "g5-intruder-token";
const SNIPPET_MODEL = "claude-sonnet-5";
const TIMEOUT = 15 * 60_000;
const instance = `mcg5${Math.random().toString(36).slice(2, 7)}`;

function dockerReachable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const docker = token && built ? dockerReachable() : false;
if (!token) console.warn("Skipping the G5 promotion test: set GH_TOKEN to a GitHub token with Copilot access.");
else if (!docker) console.warn("Skipping the G5 promotion test: Docker is not reachable.");

function dockerCli(...args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", timeout: 60_000 }).trim();
  } catch {
    return "";
  }
}

function cleanupDocker(owner = instance): void {
  const label = `label=managed-copilot.instance=${owner}`;
  for (const name of dockerCli("ps", "-a", "--filter", label, "--format", "{{.Names}}").split("\n").filter(Boolean)) dockerCli("rm", "-f", name);
  for (const name of dockerCli("volume", "ls", "--filter", label, "--format", "{{.Name}}").split("\n").filter(Boolean)) dockerCli("volume", "rm", "-f", name);
  for (const name of dockerCli("network", "ls", "--filter", label, "--format", "{{.Name}}").split("\n").filter(Boolean)) dockerCli("network", "rm", name);
}

/**
 * A run that was killed never reaches its own cleanup. Removes what earlier runs of this test left behind: only this
 * test's instances (`mcg5` plus five characters), and only once their containers are older than any run can last.
 */
function sweepStaleRuns(maxAgeMs = 90 * 60_000): void {
  const stale = new Set<string>();
  for (const line of dockerCli("ps", "-a", "--filter", "label=managed-copilot.instance", "--format", '{{.ID}}|{{.Label "managed-copilot.instance"}}').split("\n").filter(Boolean)) {
    const [id, owner] = line.split("|");
    if (!id || !owner || owner === instance || !/^mcg5[a-z0-9]{5}$/.test(owner)) continue;
    const created = Date.parse(dockerCli("inspect", "--format", "{{.Created}}", id));
    if (Number.isFinite(created) && Date.now() - created > maxAgeMs) stale.add(owner);
  }
  for (const owner of stale) {
    console.warn(`Removing Docker resources a killed G5 run left behind (instance ${owner})`);
    cleanupDocker(owner);
  }
}

/** Forwards the real token to GitHub; maps INTRUDER to a second, fake account. */
async function startGitHubProxy(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (bearer === INTRUDER) {
      res.writeHead(req.url === "/user" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/user" ? JSON.stringify({ id: 4_000_000_005, login: "g5-intruder" }) : "{}");
      return;
    }
    void fetch(`https://api.github.com${req.url}`, { headers: { authorization: req.headers.authorization ?? "", accept: "application/vnd.github+json", "user-agent": "managed-copilot-g5-test" } })
      .then(async (upstream) => {
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(502);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe.skipIf(!token || !built || !docker)("G5: promotion with the stock SDK, a real model, and a real sandbox", () => {
  let gateway: RunningGateway;
  let github: Awaited<ReturnType<typeof startGitHubProxy>>;
  let temp: string;
  let ManagedCopilot: typeof import("@managed-copilot/sdk").ManagedCopilot;
  let isManagedCopilotError: typeof import("@managed-copilot/sdk").isManagedCopilotError;
  let model = SNIPPET_MODEL;

  beforeAll(async () => {
    sweepStaleRuns();
    temp = mkdtempSync(join(tmpdir(), "mc-g5-"));
    process.env.MANAGED_COPILOT_HOME = join(temp, "home");
    ({ ManagedCopilot, isManagedCopilotError } = await import("@managed-copilot/sdk"));
    github = await startGitHubProxy();
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
        MANAGED_COPILOT_DATA_DIR: join(temp, "data"),
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_GITHUB_API_URL: github.url,
        MANAGED_COPILOT_INSTANCE: instance,
        // Lets any gateway remove what this run leaves behind if it dies before its own cleanup.
        MANAGED_COPILOT_INSTANCE_TTL_SECONDS: "21600",
        MANAGED_COPILOT_EGRESS: "off",
        // `network: false` on the promotable environment must stay false in the sandbox.
        MANAGED_COPILOT_CONFIG: JSON.stringify({
          name: "g5",
          environments: {
            coder: { type: "isolated", size: "small", network: false },
            helper: { type: "promotable", promoteTo: "coder", network: false },
          },
        }),
      }),
    );
    const probe = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
    try {
      expect(probe.info.capabilities).toContain("promotion");
      const client = await probe.client("helper");
      const models = (await client.listModels()).map((entry) => entry.id);
      if (!models.includes(SNIPPET_MODEL)) {
        model = models.find((id) => id.startsWith("claude-sonnet")) ?? models.find((id) => id.startsWith("claude")) ?? models[0] ?? SNIPPET_MODEL;
        console.warn(`${SNIPPET_MODEL} is not available to this account; using ${model}`);
      }
    } finally {
      await probe.close();
    }
  }, TIMEOUT);

  afterAll(async () => {
    await gateway?.close().catch(() => undefined);
    await github?.close();
    cleanupDocker();
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, TIMEOUT);

  it(
    "runs the section 9 snippet: same session object and ID, shared then sandbox, one sendAndWait across the move",
    async () => {
      const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
      try {
        const promoted: PlatformEvent[] = [];
        managed.on("session.promoted", (event) => promoted.push(event));

        const client = await managed.client("helper");
        const session = await client.createSession({ model, onPermissionRequest: approveAll });
        expect(session).toBeInstanceOf(CopilotSession);
        const sessionId = session.sessionId;
        const events: SessionEvent[] = [];
        session.on((event) => events.push(event));

        // Starts on shared placement.
        expect((await managed.sessions.get(sessionId)).placement).toBe("shared");
        const first = await session.sendAndWait({ prompt: "What does a CSV header row usually contain?" }, 180_000);
        expect(first?.data.content ?? "").toMatch(/column|field|name/i);
        expect((await managed.sessions.get(sessionId)).placement).toBe("shared");

        // A second SDK client attaches to the same session with a tool of its own; both follow the move.
        const companion = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
        const secretCalls: string[] = [];
        const secretWord = defineTool("secret_word", {
          description: "Returns today's secret word.",
          parameters: { type: "object", properties: {} },
          handler: async () => {
            secretCalls.push(new Date().toISOString());
            return "PELICAN-7";
          },
        });
        const companionClient = await companion.client("helper");
        const attached = await companionClient.resumeSession(sessionId, { onPermissionRequest: approveAll, tools: [secretWord] });
        const companionEvents: SessionEvent[] = [];
        attached.on((event) => companionEvents.push(event));

        // Needs a shell: promotion goes through the session's permission policy before allocation.
        const second = await session.sendAndWait({ prompt: "Use Python to calculate the sum of 10, 20, and 30 and save outputs/summary.json" }, 12 * 60_000);

        // The same object and ID continue in the sandbox; the reply is the continued work's, not a checkpoint's.
        expect(session.sessionId).toBe(sessionId);
        const info = await managed.sessions.get(sessionId);
        expect(info).toMatchObject({ id: sessionId, environment: "helper", type: "promotable", placement: "sandbox" });
        expect(info.sandbox?.network.access).toBe("disabled");
        expect(second?.data.content ?? "").toMatch(/summary\.json|60/i);

        // The agent's request went through the permission policy and the platform tool, then ran Python in the sandbox.
        const types = events.map((event) => event.type);
        expect(events.some((event) => event.type === "permission.requested")).toBe(true);
        expect(events.some((event) => event.type === "tool.execution_start" && (event.data as { toolName?: string }).toolName === "request_sandbox")).toBe(true);
        // No handoff artifacts reached the client: the source's interruption is invisible.
        expect(events.some((event) => event.type === "session.idle" && (event.data as { aborted?: boolean }).aborted === true)).toBe(false);
        expect(types).not.toContain("session.shutdown");

        // session.promoted, with top-level sessionId and sandboxId.
        const deadline = Date.now() + 30_000;
        while (promoted.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
        expect(promoted).toHaveLength(1);
        expect(promoted[0]).toMatchObject({ type: "session.promoted", sessionId, sandboxId: info.sandbox!.id, data: { generation: 1, placement: "sandbox", trigger: "tool" } });

        // The file written in the sandbox is published as an artifact of the completed turn.
        const artifacts = managed.artifacts(session);
        const publication = await artifacts.waitForPublication({ timeoutMs: 120_000 });
        expect(publication.state).toBe("published");
        expect(publication.artifacts.map((artifact) => artifact.path)).toContain("summary.json");
        expect(await artifacts.read("summary.json")).toContain("60");

        // History moved too: the same session remembers the shared turn.
        const third = await session.sendAndWait({ prompt: "In a few words: what was my first question about?" }, 180_000);
        expect(third?.data.content ?? "").toMatch(/csv|header/i);

        // The attached companion followed: it saw the sandbox turn, and its tool is registered on the new runtime.
        expect(companionEvents.some((event) => event.type === "assistant.message")).toBe(true);
        const fourth = await session.sendAndWait({ prompt: "Call the secret_word tool and reply with exactly the word it returns." }, 180_000);
        expect(secretCalls.length).toBeGreaterThanOrEqual(1);
        expect(fourth?.data.content ?? "").toContain("PELICAN-7");
        await companion.close();

        // Promoting again is idempotent, and another account cannot promote or even see the session.
        expect(await managed.promote(session)).toEqual({ sessionId, placement: "sandbox", sandboxId: info.sandbox!.id, generation: 1 });
        const intruder = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: INTRUDER });
        try {
          expect(isManagedCopilotError(await intruder.promote(sessionId).catch((error: unknown) => error), "not_found")).toBe(true);
        } finally {
          await intruder.close();
        }
      } finally {
        await managed.close();
      }
    },
    TIMEOUT,
  );

  it(
    "promotes an idle session with managed.promote() and keeps the conversation",
    async () => {
      const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
      try {
        const client = await managed.client("helper");
        const session = await client.createSession({ model, onPermissionRequest: approveAll });
        await session.sendAndWait({ prompt: "Remember the code word PELICAN-7. Reply with just OK." }, 180_000);
        const result = await managed.promote(session);
        expect(result).toMatchObject({ sessionId: session.sessionId, placement: "sandbox", generation: 1 });
        expect(result.sandboxId).toMatch(/^sbx_/);
        const reply = await session.sendAndWait({ prompt: "Run `python3 -c \"print(6*7)\"` in the shell, then tell me the code word and the number it printed." }, 300_000);
        expect(reply?.data.content ?? "").toMatch(/PELICAN-7/);
        expect(reply?.data.content ?? "").toMatch(/42/);
      } finally {
        await managed.close();
      }
    },
    TIMEOUT,
  );
});
