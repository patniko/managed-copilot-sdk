import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isManagedCopilotError, NETWORK_ENABLED, parseConfig } from "@managed-copilot/protocol";
import { openDatabase, transaction } from "../src/db.js";
import { redact } from "../src/log.js";
import { admitOptionsUpdate, admitSession, lockSystemMessage, sharedToolFilters, type AdmissionContext } from "../src/modules/core/admission.js";
import { GitHubAuthenticator, parseExpiration } from "../src/modules/core/auth.js";
import { Environments, parseAgentFile } from "../src/modules/core/environments.js";
import { createLogger } from "../src/log.js";
import { startGitHubStub } from "./harness.js";

const log = createLogger("test", "error");

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

  it("removes the host environment section from system prompts", () => {
    expect(lockSystemMessage({ content: "Be brief." })).toEqual({ mode: "customize", content: "Be brief.", sections: { environment_context: { action: "remove" } } });
    expect(lockSystemMessage({ mode: "customize", sections: { environment_context: { action: "transform" } } })).toMatchObject({ sections: { environment_context: { action: "remove" } } });
    expect(lockSystemMessage({ mode: "replace", content: "Only this." })).toEqual({ mode: "replace", content: "Only this." });
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
    expect(admitOptionsUpdate({ availableTools: ["bash", "builtin:ask_user"] }, context())).toEqual({ availableTools: ["custom:bash", "mcp:bash", "builtin:ask_user"] });
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

  it("reports GitHub outages as capability_unavailable, not as a bad token", async () => {
    const auth = new GitHubAuthenticator({ apiUrl: "http://127.0.0.1:9", log });
    await expect(auth.authenticate("member")).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("parses GitHub token expiration headers", () => {
    expect(parseExpiration("2026-11-01 08:00:00 UTC")).toBe(Date.parse("2026-11-01T08:00:00Z"));
    expect(parseExpiration("2026-11-01 08:00:00 -0700")).toBe(Date.parse("2026-11-01T15:00:00Z"));
    expect(parseExpiration("garbage")).toBeUndefined();
  });
});

describe("gateway primitives", () => {
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
