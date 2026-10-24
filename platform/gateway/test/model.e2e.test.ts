// G1 acceptance with the stock runtime and a real model. Skips cleanly without a GitHub token.
//
// Runs the spec's "idea in one snippet" and section 3 with genuine CopilotClient/CopilotSession objects through the
// bridge, verifies that client.stop() only detaches and resumeSession continues the session, and that a second
// account cannot list or resume it. The GitHub API stub forwards the real token to api.github.com and maps one
// fake token to a second account, so ownership checks run against a real identity.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approveAll, CopilotClient, CopilotSession, defineTool } from "@github/copilot-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
const require = createRequire(import.meta.url);
const built = existsSync(join(dirname(require.resolve("@managed-copilot/sdk")), "bridge.js"));
const INTRUDER = "g1-intruder-token";
const SNIPPET_MODEL = "claude-sonnet-5";
const TIMEOUT = 240_000;

if (!token) console.warn("Skipping the real-model G1 test: set GH_TOKEN to a GitHub token with Copilot access.");

/** Forwards the real token to GitHub; maps INTRUDER to a second, fake account. */
async function startGitHubProxy(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (bearer === INTRUDER) {
      res.writeHead(req.url === "/user" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/user" ? JSON.stringify({ id: 4_000_000_001, login: "g1-intruder" }) : "{}");
      return;
    }
    void fetch(`https://api.github.com${req.url}`, { headers: { authorization: req.headers.authorization ?? "", accept: "application/vnd.github+json", "user-agent": "managed-copilot-g1-test" } })
      .then(async (upstream) => {
        const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
        const expiration = upstream.headers.get("github-authentication-token-expiration");
        if (expiration) headers["github-authentication-token-expiration"] = expiration;
        res.writeHead(upstream.status, headers);
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

describe.skipIf(!token || !built)("G1: stock SDK and runtime with a real model", () => {
  let gateway: RunningGateway;
  let github: Awaited<ReturnType<typeof startGitHubProxy>>;
  let temp: string;
  let ManagedCopilot: typeof import("@managed-copilot/sdk").ManagedCopilot;
  let isManagedCopilotError: typeof import("@managed-copilot/sdk").isManagedCopilotError;
  let model = SNIPPET_MODEL;
  let createdSessionId: string;

  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), "mc-g1-"));
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
        MANAGED_COPILOT_CONFIG: JSON.stringify({ name: "g1", environments: { chat: { type: "shared" } } }),
      }),
    );
    const probe = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
    const client = await probe.client("chat");
    const models = (await client.listModels()).map((entry) => entry.id);
    if (!models.includes(SNIPPET_MODEL)) {
      model = models.find((id) => id.startsWith("claude-haiku")) ?? models[0] ?? SNIPPET_MODEL;
      console.warn(`${SNIPPET_MODEL} is not available to this account; using ${model}`);
    }
    await probe.close();
  }, TIMEOUT);

  afterAll(async () => {
    await gateway?.close();
    await github?.close();
    if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, TIMEOUT);

  it(
    "runs the idea in one snippet",
    async () => {
      const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
      const client = await managed.client("chat");
      expect(client).toBeInstanceOf(CopilotClient);

      const session = await client.createSession({ model, onPermissionRequest: approveAll });
      expect(session).toBeInstanceOf(CopilotSession);
      const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13 in one sentence." }, 180_000);
      expect(reply?.data.content.length ?? 0).toBeGreaterThan(10);
      await managed.close();
    },
    TIMEOUT,
  );

  it(
    "runs section 3: a defineTool tool in the caller's process with streaming deltas",
    async () => {
      const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: token });
      const orders = new Map([["1234", { id: "1234", status: "shipped", carrier: "Contoso Freight", eta: "Tuesday" }]]);
      const handled: string[] = [];
      const lookupOrder = defineTool("lookup_order", {
        description: "Look up an order by id",
        parameters: z.object({ id: z.string() }),
        handler: async ({ id }) => {
          handled.push(id);
          return orders.get(id);
        },
      });
      const client = await managed.client("chat");
      const session = await client.createSession({
        model,
        systemMessage: { content: "You are Contoso's order assistant. Be brief." },
        tools: [lookupOrder],
        streaming: true,
        onPermissionRequest: approveAll,
      });
      let streamed = "";
      session.on("assistant.message_delta", (event) => {
        streamed += event.data.deltaContent;
      });
      const reply = await session.sendAndWait({ prompt: "Where is order 1234?" }, 180_000);
      expect(handled).toEqual(["1234"]);
      expect(streamed.length).toBeGreaterThan(0);
      expect(reply?.data.content).toMatch(/Contoso Freight|Tuesday|shipped/i);
      createdSessionId = session.sessionId;

      // client.stop() detaches; the session keeps its history and resumes with tools passed again.
      await client.stop();
      expect((await managed.sessions.get(createdSessionId)).state).not.toBe("deleted");
      const resumed = await managed.resumeSession(createdSessionId, { tools: [lookupOrder], onPermissionRequest: approveAll });
      const followUp = await resumed.sendAndWait({ prompt: "Which carrier has it? Answer with the carrier name only." }, 180_000);
      expect(followUp?.data.content).toMatch(/Contoso/i);
      await managed.close();
    },
    TIMEOUT,
  );

  it(
    "keeps the session invisible to a second account",
    async () => {
      expect(createdSessionId).toBeDefined();
      const intruder = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: INTRUDER });
      try {
        expect(intruder.account.login).toBe("g1-intruder");
        expect((await intruder.sessions.list()).map((info) => info.id)).not.toContain(createdSessionId);
        expect(isManagedCopilotError(await intruder.sessions.get(createdSessionId).catch((error: unknown) => error), "not_found")).toBe(true);
        const client = await intruder.client("chat");
        const resumed = await client.resumeSession(createdSessionId, { onPermissionRequest: approveAll }).catch((error: unknown) => error);
        expect(String((resumed as Error).message)).toContain("not_found");
        expect((await client.listSessions()).map((entry) => entry.sessionId)).not.toContain(createdSessionId);
      } finally {
        await intruder.close();
      }
    },
    TIMEOUT,
  );
});
