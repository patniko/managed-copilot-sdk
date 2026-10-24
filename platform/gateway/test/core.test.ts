import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isManagedCopilotError, NETWORK_ENABLED, parseConfig, type PlatformEvent } from "@managed-copilot/protocol";
import { openDatabase, transaction } from "../src/db.js";
import { redact } from "../src/log.js";
import { admitOptionsUpdate, admitSession, lockSystemMessage, PROMOTABLE_ENVIRONMENT_CONTEXT, SHARED_ENVIRONMENT_CONTEXT, sharedToolFilters, type AdmissionContext } from "../src/modules/core/admission.js";
import { GitHubAuthenticator, parseExpiration } from "../src/modules/core/auth.js";
import { Environments, parseAgentFile } from "../src/modules/core/environments.js";
import { PlatformEvents } from "../src/modules/core/events.js";
import { SessionLedger } from "../src/modules/core/ledger.js";
import { processStartTime, reapStaleRuntime } from "../src/modules/core/runtime.js";
import { pathScrubber } from "../src/modules/core/sessions.js";
import { createLogger } from "../src/log.js";
import { sleep, startGitHubStub } from "./harness.js";

const log = createLogger("test", "error");

type GitHubStep = "reset" | "timeout" | number | { readonly status: number; readonly headers?: Record<string, string>; readonly delayMs?: number; readonly truncated?: boolean };

/** A scripted GitHub API: each call consumes one step (an HTTP status, a dropped connection, or a timeout). */
function scriptedGitHub(steps: GitHubStep[], user = { id: 7, login: "octo" }) {
  const state = { calls: 0 };
  const script = [...steps];
  const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) => {
    state.calls++;
    const step = script.shift() ?? 200;
    if (step === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    if (step === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { status, headers = {}, delayMs = 0, truncated = false } = typeof step === "number" ? { status: step } : step;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      });
    }
    const text = status === 200 ? JSON.stringify(user) : JSON.stringify({ message: `HTTP ${status}` });
    // A connection lost after the headers: the body stream fails partway.
    const body = truncated
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text.slice(0, 5)));
            controller.error(new TypeError("terminated"));
          },
        })
      : status === 204
        ? null
        : text;
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  };
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    script,
    get calls() {
      return state.calls;
    },
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(2);
  }
}

function environments(deployment: unknown, baseDir = tmpdir()): Environments {
  return new Environments({ deployment: parseConfig(deployment), baseDir, pinDir: mkdtempSync(join(tmpdir(), "mc-pin-")), log });
}

describe("environment resolution", () => {
  const envs = environments({
    network: ["learn.microsoft.com", "*.github.com"],
    environments: { chat: { type: "shared", models: ["claude-sonnet-5"] }, coder: { type: "isolated", size: "medium", network: true } },
    inline: { types: ["shared", "isolated"], sizes: ["small"] },
  });

  it("resolves named environments and narrows network policy", () => {
    const chat = envs.resolve("chat");
    expect(chat).toMatchObject({ name: "chat", type: "shared", inline: false });
    expect(chat.network).toEqual({ access: "restricted", allowedDomains: ["*.github.com", "learn.microsoft.com"] });
    expect(envs.resolve({ name: "chat", network: ["learn.microsoft.com"] }).network).toEqual({ access: "restricted", allowedDomains: ["learn.microsoft.com"] });
    // Callers can narrow, never broaden.
    expect(envs.resolve({ name: "chat", network: true }).network.access).toBe("restricted");
    expect(envs.resolve({ name: "chat", network: false }).network.access).toBe("disabled");
    expect(envs.resolve("coder").network).toEqual(NETWORK_ENABLED);
  });

  it("resolves inline environments within the AppHost's inline rules", () => {
    expect(envs.resolve({ type: "isolated" })).toMatchObject({ name: "inline-isolated-small", inline: true, type: "isolated" });
    expect(envs.resolve({ type: "shared" })).toMatchObject({ name: "inline-shared" });
    expect(() => envs.resolve({ type: "isolated", size: "large" })).toThrowError(/size large/);
    expect(() => envs.resolve({ type: "promotable" })).toThrowError(/inline promotable/);
  });

  it("fails explicitly for unknown environments and broadened requests", () => {
    const error = (() => {
      try {
        envs.resolve("nope");
      } catch (caught) {
        return caught;
      }
    })();
    expect(isManagedCopilotError(error, "environment_not_found")).toBe(true);
    expect((error as Error).message).toContain("chat, coder");
    expect(() => envs.resolve({ name: "coder", size: "large" })).toThrowError(/cannot change/);
    expect(() => envs.resolve({ name: "chat", type: "isolated" })).toThrowError(/is shared/);
  });

  it("pins customization bundles and parses agent files", () => {
    const source = mkdtempSync(join(tmpdir(), "mc-bundle-"));
    mkdirSync(join(source, "agents"));
    mkdirSync(join(source, "skills", "refunds"), { recursive: true });
    mkdirSync(join(source, "instructions"));
    writeFileSync(join(source, "agents", "triage.agent.md"), "---\nname: triage\ndescription: Triage requests\ntools: [\"lookup_order\", \"web_fetch\"]\n---\nYou triage.");
    writeFileSync(join(source, "skills", "refunds", "SKILL.md"), "---\nname: refunds\n---\nPolicy.");
    writeFileSync(join(source, "instructions", "contoso.instructions.md"), "Be brief.");
    const bundled = environments({ environments: { chat: { type: "shared", customizations: source } } });
    const chat = bundled.resolve("chat");
    expect(chat.customizations?.agents).toEqual([{ name: "triage", description: "Triage requests", tools: ["lookup_order", "web_fetch"] }]);
    expect(chat.customizations?.skillDirectory).toBeDefined();
    expect(chat.customizations?.instructionDirectory).toBeDefined();
    expect(chat.customizations?.root).not.toBe(source);
    expect(bundled.info()[0]?.agents).toEqual(["triage"]);

    // Sandboxes see the bundle at its read-only mount, never at a gateway host path.
    const isolated = environments({ environments: { coder: { type: "isolated", customizations: source } } }).resolve("coder");
    const admitted = admitSession({ sessionId: "s3" }, { environment: isolated, placement: "sandbox", network: NETWORK_ENABLED, platformTools: [], workingDirectory: "/workspace", tokenRegistrationId: "r" }, "create");
    expect(admitted.params).toMatchObject({
      skillDirectories: ["/opt/managed-copilot/customizations/skills"],
      agentDirectories: ["/opt/managed-copilot/customizations/agents"],
      instructionDirectories: ["/opt/managed-copilot/customizations/instructions"],
      enableSkills: true,
    });

    writeFileSync(join(source, "agents", "danger.agent.md"), "---\nname: danger\nmcp-servers:\n  local:\n    command: sh\n---\n");
    const unsafe = environments({ environments: { chat: { type: "shared", customizations: source } } });
    expect(() => unsafe.resolve("chat")).toThrowError(/executable configuration/);
    rmSync(source, { recursive: true, force: true });
  });

  it("parses YAML list tools in agent frontmatter", () => {
    expect(parseAgentFile("planner.agent.md", "---\ndescription: Plans\ntools:\n  - submit_plan\n  - skill\n---\nPlan.")).toEqual({ name: "planner", description: "Plans", tools: ["submit_plan", "skill"], executableKeys: [] });
  });
});

describe("shared admission", () => {
  const envs = environments({ environments: { chat: { type: "shared", models: ["claude-sonnet-5", "claude-haiku-5.5"] }, coder: { type: "isolated" } } });
  const context = (name = "chat", placement: "shared" | "sandbox" = "shared"): AdmissionContext => ({
    environment: envs.resolve(name),
    placement,
    network: NETWORK_ENABLED,
    platformTools: [],
    workingDirectory: placement === "shared" ? "/data/workspaces/s1" : "/workspace",
    tokenRegistrationId: "mc-reg",
  });

  it("supplies environment defaults the SDK snippet omits", () => {
    const admitted = admitSession({ sessionId: "s1", tools: [{ name: "lookup_order" }], requestPermission: true }, context(), "create");
    expect(admitted.params).toMatchObject({
      model: "claude-sonnet-5",
      allowedModels: ["claude-sonnet-5", "claude-haiku-5.5"],
      availableTools: expect.arrayContaining(["builtin:ask_user", "custom:*"]),
      workingDirectory: "/data/workspaces/s1",
      enableConfigDiscovery: false,
      enableSkills: false,
      envValueMode: "direct",
      mcpOAuthTokenStorage: "in-memory",
      gitHubTokenProviderRegistrationId: "mc-reg",
    });
    expect(admitted.params["availableTools"]).not.toContain("builtin:web_fetch");
    expect(admitted.params["availableTools"]).not.toContain("builtin:bash");
    // Plain chat does not offer subagent orchestration it cannot use; sessions with agents do.
    expect(admitted.params["availableTools"]).not.toContain("builtin:task");
    const withAgents = admitSession({ sessionId: "s1", customAgents: [{ name: "helper", prompt: "Help." }] }, context(), "create");
    expect(withAgents.params["availableTools"]).toContain("builtin:task");
    expect(admitSession({ sessionId: "s1", availableTools: ["builtin:task"] }, context(), "create").params["availableTools"]).toEqual(["builtin:task"]);
    expect(admitted.client).toEqual({ tools: ["lookup_order"], requestPermission: true, requestUserInput: false, requestElicitation: false });
    expect(admitted.optionsPatch).toMatchObject({ skipCustomInstructions: true, installedPlugins: [], includedBuiltinSkills: [] });
  });

  it("intersects caller tool filters with the shared ceiling", () => {
    const filters = sharedToolFilters({ availableTools: ["builtin:*", "bash", "mcp:github-list_issues", "custom:lookup_order"], excludedTools: ["builtin:task"] }, envs.resolve("chat"), NETWORK_ENABLED, false);
    expect(filters.availableTools).toContain("builtin:ask_user");
    expect(filters.availableTools).not.toContain("builtin:bash");
    expect(filters.availableTools).toContain("custom:bash");
    expect(filters.availableTools).not.toContain("mcp:github-list_issues");
    expect(filters.excludedTools).toEqual(["builtin:task"]);
  });

  it("replaces the host environment section in system prompts", () => {
    const environment = { action: "replace", content: SHARED_ENVIRONMENT_CONTEXT };
    expect(lockSystemMessage({ content: "Be brief." })).toEqual({ mode: "customize", content: "Be brief.", sections: { environment_context: environment, code_change_rules: { action: "remove" } } });
    expect(lockSystemMessage({ mode: "customize", sections: { environment_context: { action: "transform" }, code_change_rules: { action: "preserve" } } })).toMatchObject({
      sections: { environment_context: environment, code_change_rules: { action: "preserve" } },
    });
    expect(lockSystemMessage({ mode: "replace", content: "Only this." })).toEqual({ mode: "replace", content: "Only this." });
    // Promotable sessions are pointed at request_sandbox for work that needs a shell or files.
    expect(lockSystemMessage(undefined, { promotable: true })).toMatchObject({ sections: { environment_context: { action: "replace", content: PROMOTABLE_ENVIRONMENT_CONTEXT } } });
    expect(PROMOTABLE_ENVIRONMENT_CONTEXT).toContain("call request_sandbox first");
  });

  it("allows workload capabilities in sandbox placement but keeps credentials and billing platform-owned", () => {
    const admitted = admitSession(
      { sessionId: "s2", mcpServers: { git: { command: "git-mcp" } }, enableFileHooks: true, workingDirectory: "repo", gitHubToken: "ghp_x" },
      context("coder", "sandbox"),
      "create",
    );
    expect(admitted.params).toMatchObject({ workingDirectory: "/workspace/repo", enableFileHooks: true, mcpServers: { git: { command: "git-mcp" } } });
    expect(admitted.params).not.toHaveProperty("gitHubToken");
    expect(admitted.callerToken).toBe("ghp_x");
    expect(() => admitSession({ workingDirectory: "/etc" }, context("coder", "sandbox"), "create")).toThrowError(/inside \/workspace/);
    expect(() => admitSession({ workingDirectory: "../../etc" }, context("coder", "sandbox"), "create")).toThrowError(/escapes|inside/);
    expect(() => admitSession({ provider: { baseUrl: "https://x" } }, context("coder", "sandbox"), "create")).toThrowError(/Custom model providers/);
  });

  it("admits option patches with the same rules", () => {
    expect(admitOptionsUpdate({ sessionId: "s", reasoningEffort: "high", customAgentsLocalOnly: true }, context())).toEqual({ reasoningEffort: "high", customAgentsLocalOnly: true });
    expect(() => admitOptionsUpdate({ customAgentsLocalOnly: false }, context())).toThrowError(/cannot be changed/);
    expect(() => admitOptionsUpdate({ eventsLogDirectory: "/tmp" }, context())).toThrowError(/cannot be changed/);
    expect(() => admitOptionsUpdate({ model: "gpt-5" }, context())).toThrowError(/not allowed/);
    expect(admitOptionsUpdate({ availableTools: ["bash", "builtin:ask_user"] }, context())).toEqual({ availableTools: ["custom:bash", "builtin:ask_user"] });
    // MCP tool names are admitted only for sessions that admitted remote MCP servers.
    expect(admitOptionsUpdate({ availableTools: ["bash"] }, { ...context(), allowMcp: true })).toEqual({ availableTools: ["custom:bash", "mcp:bash"] });
  });
});

describe("GitHub authentication", () => {
  let github: Awaited<ReturnType<typeof startGitHubStub>>;

  beforeAll(async () => {
    github = await startGitHubStub({
      member: { id: 1, login: "Member", orgs: ["contoso"] },
      outsider: { id: 2, login: "outsider" },
      listed: { id: 3, login: "listed-user" },
    });
  });
  afterAll(() => github.close());

  it("verifies tokens, caches results, and binds to the account ID", async () => {
    const auth = new GitHubAuthenticator({ apiUrl: github.url, log });
    const before = github.calls;
    const principal = await auth.authenticate("member");
    expect(principal).toMatchObject({ accountId: 1, login: "Member", token: "member" });
    await auth.authenticate("member");
    expect(github.calls - before).toBe(1);
    expect(auth.liveCredential(1)?.token).toBe("member");
    await expect(auth.authenticate("bogus")).rejects.toMatchObject({ code: "authentication_required" });
    await expect(auth.authenticate("mcc_capability")).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("applies AppHost access rules", async () => {
    const auth = new GitHubAuthenticator({ apiUrl: github.url, log, access: { githubOrgs: ["contoso"], githubUsers: ["LISTED-USER"] } });
    await expect(auth.authenticate("member")).resolves.toMatchObject({ login: "Member" });
    await expect(auth.authenticate("listed")).resolves.toMatchObject({ login: "listed-user" });
    await expect(auth.authenticate("outsider")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reports persistent GitHub outages as retryable upstream_unavailable, not as a bad token", async () => {
    const auth = new GitHubAuthenticator({ apiUrl: "http://127.0.0.1:9", log, retryDelaysMs: [1, 1] });
    const error = await auth.authenticate("member").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "upstream_unavailable", details: { upstream: "github", retryAfterSeconds: 5 } });
    expect((error as { status: number }).status).toBe(503);
    expect((error as Error).message).toMatch(/GitHub is unreachable/);
  });

  it("retries transport errors and 5xx answers before giving up", async () => {
    const github = scriptedGitHub(["reset", 502, 200]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1, 1, 1] });
    await expect(auth.authenticate("token-a")).resolves.toMatchObject({ accountId: 7, login: "octo" });
    expect(github.calls).toBe(3);

    const failing = scriptedGitHub(["reset", "timeout", 503, "reset"]);
    const strict = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: failing.fetch, retryDelaysMs: [1, 1, 1] });
    await expect(strict.authenticate("token-b")).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(failing.calls).toBe(4);
  });

  it("accepts a recent verification while GitHub is unreachable, and never after GitHub rejected the token", async () => {
    const github = scriptedGitHub([200]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], cacheTtlMs: 1, negativeTtlMs: 200, outageRecheckMs: 1, staleGraceMs: 60_000 });
    const principal = await auth.authenticate("token-c");
    await sleep(5);
    // GitHub drops connections: the verification from moments ago stands in.
    github.script.push("reset", "reset");
    await expect(auth.authenticate("token-c")).resolves.toEqual(principal);
    expect(github.calls).toBe(3);
    await sleep(5);
    // Still in the outage: callers get the standing principal at once while the re-check runs, which now gets a 401.
    github.script.push(401);
    await expect(auth.authenticate("token-c")).resolves.toEqual(principal);
    await waitUntil(() => github.calls === 4);
    await sleep(5);
    await expect(auth.authenticate("token-c")).rejects.toMatchObject({ code: "authentication_required" });
    expect(auth.liveCredential(7)).toBeUndefined();
    // The rejection replaced the earlier verification: a later outage cannot revive it.
    await sleep(250);
    github.script.push("reset", "reset");
    await expect(auth.authenticate("token-c")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("stops accepting a stale verification once its grace period ends", async () => {
    const github = scriptedGitHub([200]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], cacheTtlMs: 1, staleGraceMs: 20 });
    await auth.authenticate("token-d");
    await sleep(40);
    github.script.push("reset", "reset");
    await expect(auth.authenticate("token-d")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("treats rate limits as an outage without retrying, and other 403s as a token problem", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    const limited = scriptedGitHub([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: limited.fetch, retryDelaysMs: [1, 1] });
    const error = (await auth.authenticate("token-e").catch((caught: unknown) => caught)) as { code: string; details: { retryAfterSeconds: number } };
    expect(error.code).toBe("upstream_unavailable");
    expect(error.details.retryAfterSeconds).toBeGreaterThan(100);
    expect(limited.calls).toBe(1);

    const secondary = scriptedGitHub([{ status: 429, headers: { "retry-after": "7" } }]);
    const other = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: secondary.fetch, retryDelaysMs: [1] });
    await expect(other.authenticate("token-f")).rejects.toMatchObject({ code: "upstream_unavailable", details: { retryAfterSeconds: 7 } });

    const refused = scriptedGitHub([403]);
    const integration = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: refused.fetch, retryDelaysMs: [1] });
    await expect(integration.authenticate("token-g")).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("never reads an organization-membership outage as 'not a member'", async () => {
    const github = scriptedGitHub([200, "reset", "reset"]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], access: { githubOrgs: ["contoso"] } });
    await expect(auth.authenticate("token-h")).rejects.toMatchObject({ code: "upstream_unavailable" });
    github.script.push(200, 404);
    await expect(auth.authenticate("token-h")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stops serving an account's credential to runtimes once the account loses access", async () => {
    const github = scriptedGitHub([200, 204]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], cacheTtlMs: 1, access: { githubOrgs: ["contoso"] } });
    await auth.authenticate("token-i");
    expect(auth.liveCredential(7)?.token).toBe("token-i");
    await sleep(5);
    github.script.push(200, 404);
    await expect(auth.authenticate("token-i")).rejects.toMatchObject({ code: "forbidden" });
    expect(auth.liveCredential(7)).toBeUndefined();
  });

  it("treats a membership 401 as a rejected token, even when another organization's check then fails", async () => {
    const github = scriptedGitHub([200, 204]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], cacheTtlMs: 1, staleGraceMs: 60_000, access: { githubOrgs: ["first", "second"] } });
    await auth.authenticate("token-j");
    await sleep(5);
    github.script.push(200, 401, "reset", "reset");
    await expect(auth.authenticate("token-j")).rejects.toMatchObject({ code: "authentication_required" });
    expect(auth.liveCredential(7)).toBeUndefined();
  });

  it("treats a connection lost while reading the answer as an outage", async () => {
    const github = scriptedGitHub([{ status: 200, truncated: true }, { status: 200, truncated: true }]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1], cacheTtlMs: 1, staleGraceMs: 60_000 });
    await expect(auth.authenticate("token-k")).rejects.toMatchObject({ code: "upstream_unavailable" });
    github.script.push({ status: 200, truncated: true }, 200);
    await expect(auth.authenticate("token-k")).resolves.toMatchObject({ login: "octo" });
    expect(github.calls).toBe(4);
    // A recent verification stands in when the body keeps failing.
    await sleep(5);
    github.script.push({ status: 200, truncated: true }, { status: 200, truncated: true });
    await expect(auth.authenticate("token-k")).resolves.toMatchObject({ login: "octo" });
  });

  it("lets an invalidation during a verification win", async () => {
    const github = scriptedGitHub([{ status: 200, delayMs: 50 }]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1] });
    const verifying = auth.authenticate("token-l");
    await sleep(10);
    auth.invalidate("token-l");
    await expect(verifying).rejects.toMatchObject({ code: "authentication_required" });
    expect(auth.liveCredential(7)).toBeUndefined();
    // Nothing was cached: the next call asks GitHub again.
    await expect(auth.authenticate("token-l")).resolves.toMatchObject({ login: "octo" });
    expect(github.calls).toBe(2);
  });

  it("bounds a whole verification, membership checks included, by one deadline", async () => {
    const github = scriptedGitHub([{ status: 200, delayMs: 150 }, { status: 204, delayMs: 400 }, { status: 204, delayMs: 400 }]);
    const auth = new GitHubAuthenticator({ apiUrl: "https://github.test", log, fetch: github.fetch, retryDelaysMs: [1, 1, 1], deadlineMs: 300, access: { githubOrgs: ["contoso"] } });
    const started = Date.now();
    await expect(auth.authenticate("token-m")).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("parses GitHub token expiration headers", () => {
    expect(parseExpiration("2026-11-01 08:00:00 UTC")).toBe(Date.parse("2026-11-01T08:00:00Z"));
    expect(parseExpiration("2026-11-01 08:00:00 -0700")).toBe(Date.parse("2026-11-01T15:00:00Z"));
    expect(parseExpiration("garbage")).toBeUndefined();
  });
});

describe("shared runtime lifetime", () => {
  it("reaps the runtime a dead gateway left behind, never a reused pid or a live gateway's runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-reap-"));
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => orphan.once("spawn", resolve));
      const startTime = await processStartTime(orphan.pid!);
      expect(startTime).toBeTruthy();
      const deadGateway = spawnSync(process.execPath, ["-e", "0"]).pid;
      const record = join(root, "runtime.json");
      const write = (value: object) => writeFileSync(record, JSON.stringify(value));
      // The pid now belongs to a different process (another start time): left alone.
      write({ pid: orphan.pid, startTime: "1999-01-01T00:00:00.0000000Z", gatewayPid: deadGateway });
      await reapStaleRuntime(root, log);
      expect(orphan.exitCode).toBeNull();
      // The gateway that recorded it is still running: left alone, record kept.
      write({ pid: orphan.pid, startTime, gatewayPid: process.ppid });
      await reapStaleRuntime(root, log);
      expect(orphan.exitCode).toBeNull();
      expect(existsSync(record)).toBe(true);
      // The recorded runtime of a gateway that is gone: stopped.
      write({ pid: orphan.pid, startTime, gatewayPid: deadGateway });
      const exited = new Promise((resolve) => orphan.once("exit", resolve));
      await reapStaleRuntime(root, log);
      await exited;
      expect(existsSync(record)).toBe(false);
    } finally {
      if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("gateway primitives", () => {
  it("scrubs host paths under the data directory without eating the punctuation around them", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mc-scrub-"));
    try {
      const scrub = pathScrubber(dataDir) as (value: unknown) => unknown;
      const workspace = join(dataDir, "runtime", "shared", "workspaces", "0b1c2d3e-aaaa-bbbb-cccc-000000000001");
      const bundle = join(dataDir, "customizations", "chat", "3303eed202f7e4a6");
      expect(scrub(`(${workspace})`)).toBe("(/workspace)");
      expect(scrub(`Working in ${workspace}.`)).toBe("Working in /workspace.");
      expect(scrub(join(workspace, "src", "app.ts"))).toBe("/workspace/src/app.ts");
      expect(scrub({ agent: { path: join(bundle, "agents", "builder.agent.md") } })).toEqual({ agent: { path: "/opt/managed-copilot/customizations/agents/builder.agent.md" } });
      expect(scrub([join(dataDir, "runtime", "shared", "copilot-home", "logs")])).toEqual(["/platform/copilot-home/logs"]);
      expect(scrub(`key at ${join(dataDir, "network", "vault.key")}, see logs`)).toBe("key at /platform/network/vault.key, see logs");
      // The runtime may report the directory's resolved form (8.3 names on Windows, symlinks elsewhere).
      expect(scrub(join(realpathSync.native(dataDir), "runtime", "shared", "workspaces", "abc"))).toBe("/workspace");
      expect(scrub("unrelated /etc/hosts and C:\\Windows")).toBe("unrelated /etc/hosts and C:\\Windows");
      // Only the directory itself: not a sibling that shares its name as a prefix, nor a path that merely ends with it.
      expect(scrub(`${dataDir}base${sep}x`)).toBe(`${dataDir}base${sep}x`);
      expect(scrub(`${dataDir}.bak${sep}x`)).toBe(`${dataDir}.bak${sep}x`);
      expect(scrub(`mnt${dataDir}${sep}x`)).toBe(`mnt${dataDir}${sep}x`);
      expect(scrub(`The data is in ${dataDir}.`)).toBe("The data is in /platform.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("redacts credentials without masking identifiers", () => {
    const circular: Record<string, unknown> = { idempotencyKey: "k1", value: "secret", headers: { authorization: "x" }, nested: { placeholder: "mcrt_1", token: "t" }, big: 10n };
    circular["self"] = circular;
    expect(redact(circular)).toEqual({ idempotencyKey: "k1", value: "[redacted]", headers: "[redacted]", nested: { placeholder: "[redacted]", token: "[redacted]" }, big: "10", self: "[circular]" });
  });

  it("nests transactions and rejects async callbacks", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    transaction(db, () => {
      db.prepare("INSERT INTO t VALUES (1)").run();
      expect(() =>
        transaction(db, () => {
          db.prepare("INSERT INTO t VALUES (2)").run();
          throw new Error("inner");
        }),
      ).toThrowError("inner");
    });
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: 1 }]);
    expect(() => transaction(db, () => Promise.resolve(1))).toThrowError(/synchronous/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("platform events", () => {
  const event = (id: string, type: PlatformEvent["type"] = "session.promoted"): PlatformEvent => ({ id, type, createdAt: new Date().toISOString(), sessionId: "s1", data: {} });

  it("reports whether an event is stored, idempotently for a stable ID, while notifying listeners every time", () => {
    const db = openDatabase(":memory:");
    const ledger = new SessionLedger(db);
    const events = new PlatformEvents(ledger, log);
    const heard: string[] = [];
    events.subscribe((published, meta) => heard.push(`${published.id}@${meta.ownerId}`));

    expect(events.publish(event("evt_anchor"), { ownerId: 7 })).toBe(true);
    expect(events.publish(event("evt_promoted_op1"), { ownerId: 7 })).toBe(true);
    // A publisher retrying with the same ID (after a crash or an unknown outcome) is told it is stored, without a duplicate.
    expect(events.publish(event("evt_promoted_op1"), { ownerId: 7 })).toBe(true);
    expect(ledger.eventsAfter(7, "evt_anchor").map(({ event: stored }) => stored.id)).toEqual(["evt_promoted_op1"]);
    // Another owner can't claim (or replay) an existing ID.
    expect(events.publish(event("evt_promoted_op1"), { ownerId: 8 })).toBe(false);
    expect(ledger.eventsAfter(8, "evt_promoted_op1")).toEqual([]);
    expect(heard).toEqual(["evt_anchor@7", "evt_promoted_op1@7", "evt_promoted_op1@7", "evt_promoted_op1@8"]);

    // When the ledger can't store it, live listeners still hear it and the publisher learns it isn't replayable.
    db.close();
    expect(events.publish(event("evt_promoted_op2"), { ownerId: 7 })).toBe(false);
    expect(heard.at(-1)).toBe("evt_promoted_op2@7");
  });
});
