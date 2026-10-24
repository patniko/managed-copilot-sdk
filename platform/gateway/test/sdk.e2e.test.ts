// Genuine SDK objects over the bridge against a gateway with a stock-protocol fake runtime (no model needed).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approveAll, CopilotClient, CopilotSession, defineTool } from "@github/copilot-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeRuntime, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve("@managed-copilot/sdk"));
const built = existsSync(join(sdkDist, "bridge.js"));
if (!built) console.warn("Skipping SDK end-to-end tests: run `pnpm build` first so packages/sdk/dist/bridge.js exists.");

const ALICE = "alice-token";
const BOB = "bob-token";
const MALLORY = "mallory-token";

// Each test's clients spawn a bridge process (Node's startup can take seconds on a loaded machine).
describe.skipIf(!built)("SDK over the bridge (fake runtime)", { timeout: 30_000 }, () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let home: string;
  let ManagedCopilot: typeof import("@managed-copilot/sdk").ManagedCopilot;
  let isManagedCopilotError: typeof import("@managed-copilot/sdk").isManagedCopilotError;

  const lookupOrder = (calls: string[]) =>
    defineTool("lookup_order", {
      description: "Look up an order by id",
      parameters: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        calls.push(id);
        return { id, status: "shipped" };
      },
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "mc-sdk-home-"));
    process.env.MANAGED_COPILOT_HOME = home;
    ({ ManagedCopilot, isManagedCopilotError } = await import("@managed-copilot/sdk"));
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" }, [BOB]: { id: 1002, login: "bob" }, [MALLORY]: { id: 2002, login: "mallory" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
  });

  afterAll(async () => {
    await gateway?.close();
    await runtime?.close();
    await github?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns genuine SDK objects, runs tools in the caller's process, and streams deltas", async () => {
    const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
    try {
      expect(managed.account).toMatchObject({ id: 1001, login: "alice" });
      const client = await managed.client("chat");
      expect(client).toBeInstanceOf(CopilotClient);
      const calls: string[] = [];
      const session = await client.createSession({ model: "claude-haiku-4.5", tools: [lookupOrder(calls)], streaming: true, onPermissionRequest: approveAll });
      expect(session).toBeInstanceOf(CopilotSession);
      const deltas: string[] = [];
      session.on("assistant.message_delta", (event) => deltas.push(event.data.deltaContent));
      const reply = await session.sendAndWait({ prompt: "tool:lookup_order" });
      expect(reply?.data.content).toBe('tool said: {"id":"1234","status":"shipped"}');
      expect(calls).toEqual(["1234"]);
      expect(deltas.length).toBeGreaterThan(0);
      // The SDK's own list/metadata calls are scoped to the caller.
      expect((await client.listSessions()).map((entry) => entry.sessionId)).toContain(session.sessionId);
      expect(await client.getAuthStatus()).toMatchObject({ isAuthenticated: true, login: "alice" });

      // client.stop() detaches this process only: nothing is detached or shut down upstream.
      await client.stop();
      expect(runtime.calls("session.detach")).toHaveLength(0);
      expect(runtime.calls("runtime.shutdown")).toHaveLength(0);
      expect(runtime.sessions.has(session.sessionId)).toBe(true);

      const resumed = await managed.resumeSession(session.sessionId, { tools: [lookupOrder(calls)], onPermissionRequest: approveAll });
      expect(resumed).toBeInstanceOf(CopilotSession);
      expect((await resumed.sendAndWait({ prompt: "hello again" }))?.data.content).toBe("echo: hello again");
      expect((await managed.sessions.get(session.sessionId)).state).toBe("idle");
    } finally {
      await managed.close();
    }
  });

  it("fails at managed.client() with stable error codes", async () => {
    const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
    try {
      const unknown = await managed.client("nope").catch((error: unknown) => error);
      expect(isManagedCopilotError(unknown, "environment_not_found")).toBe(true);
      const inline = await managed.client({ type: "promotable" }).catch((error: unknown) => error);
      expect(isManagedCopilotError(inline, "environment_not_found")).toBe(true);
      // Isolated placement needs the sandbox module; without it, creation fails explicitly.
      const coder = await managed.client("coder");
      const isolated = await coder.createSession({ onPermissionRequest: approveAll }).catch((error: unknown) => error);
      expect(String((isolated as Error).message)).toContain("capability_unavailable");
      await coder.stop();
    } finally {
      await managed.close();
    }
    const rejected = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: "nobody" }).catch((error: unknown) => error);
    expect(isManagedCopilotError(rejected, "authentication_required")).toBe(true);
  });

  it("keeps another account's sessions invisible", async () => {
    const alice = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
    const mallory = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: MALLORY });
    try {
      const session = await alice.createSession({ environment: "chat", onPermissionRequest: approveAll });
      expect((await mallory.sessions.list()).map((info) => info.id)).not.toContain(session.sessionId);
      expect(isManagedCopilotError(await mallory.sessions.get(session.sessionId).catch((error: unknown) => error), "not_found")).toBe(true);
      expect(isManagedCopilotError(await mallory.resumeSession(session.sessionId, { onPermissionRequest: approveAll }).catch((error: unknown) => error), "not_found")).toBe(true);
      const client = await mallory.client("chat");
      const raw = await client.resumeSession(session.sessionId, { onPermissionRequest: approveAll }).catch((error: unknown) => error);
      expect(String((raw as Error).message)).toContain("not_found");
      expect((await client.listSessions()).map((entry) => entry.sessionId)).not.toContain(session.sessionId);
    } finally {
      await alice.close();
      await mallory.close();
    }
  });

  it("binds sessions to the identity of the client that created them", async () => {
    const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
    try {
      const asBob = await managed.client("chat", { gitHubToken: BOB });
      const session = await asBob.createSession({ onPermissionRequest: approveAll });
      // Session helpers act as Bob for Bob's session, without weakening owner checks for Alice.
      expect((await managed.sessions.get(session.sessionId)).owner).toMatchObject({ id: 1002, login: "bob" });
      const asAlice = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
      expect(isManagedCopilotError(await asAlice.sessions.get(session.sessionId).catch((error: unknown) => error), "not_found")).toBe(true);
      await asAlice.close();
      // managed.createSession / resumeSession with a per-user token: helpers called right away already act as that user,
      // even though the runtime's lifecycle notification follows the answer.
      runtime.lifecycleAfterAnswer = true;
      try {
        const created = await managed.createSession({ environment: "chat", gitHubToken: BOB, onPermissionRequest: approveAll });
        expect((await managed.sessions.get(created.sessionId)).owner).toMatchObject({ id: 1002, login: "bob" });
      } finally {
        runtime.lifecycleAfterAnswer = false;
      }
      const resumed = await managed.resumeSession(session.sessionId, { gitHubToken: BOB, onPermissionRequest: approveAll });
      expect((await managed.sessions.get(resumed.sessionId)).owner).toMatchObject({ id: 1002, login: "bob" });
    } finally {
      await managed.close();
    }
  });

  it("delivers platform events to managed.on()", async () => {
    const managed = await ManagedCopilot.connect({ url: gateway.url, gitHubToken: ALICE });
    try {
      const received: string[] = [];
      managed.on("*", (event) => received.push(`${event.type}:${event.sessionId}`));
      await sleep(300);
      const session = await managed.createSession({ environment: "chat", onPermissionRequest: approveAll });
      await session.sendAndWait({ prompt: "ping" });
      for (let attempt = 0; attempt < 50 && !received.includes(`session.idle:${session.sessionId}`); attempt++) await sleep(100);
      expect(received).toContain(`session.created:${session.sessionId}`);
      expect(received).toContain(`session.idle:${session.sessionId}`);
    } finally {
      await managed.close();
    }
  });
});
