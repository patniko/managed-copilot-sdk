import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { interrupted, parseSource, RunManager } from "../src/server/runs.js";
import { loadSample } from "../src/server/sample.js";
import { RunStore } from "../src/server/store.js";
import { STEP_IDS, type RunView } from "../src/shared/types.js";
import { FakePlatform, PASSING_OUTPUT, testConfig, until, type FakeSession } from "./fakes.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(platform = new FakePlatform(), overrides: Parameters<typeof testConfig>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "repo-doctor-runs-"));
  const hub = new EventHub(60_000);
  const config = testConfig(dir, overrides);
  const manager = new RunManager(platform, config, new RunStore(dir), hub, loadSample(config.sampleDir));
  manager.start();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => hub.close(), () => manager.close());
  return { manager, platform, dir, config };
}

async function finished(manager: RunManager, id: string): Promise<RunView> {
  await until(() => {
    const run = manager.detail(id).run;
    return run.status !== "running" && run.sandbox.state !== "deleting";
  });
  return manager.detail(id).run;
}

const step = (run: RunView, id: string) => run.steps.find((candidate) => candidate.id === id)!;

describe("a run", () => {
  it("fixes the sample in one sandbox, verifies the fix, and deletes the sandbox", async () => {
    const { manager, platform } = setup();
    const created = manager.create({ sample: true });
    expect(created).toMatchObject({ number: 1, title: "bumpkit", status: "running", sandbox: { state: "creating", environment: "repo-doctor" } });

    const run = await finished(manager, created.id);
    expect(run.status).toBe("fixed");
    expect(run.steps.map(({ id, status, summary }) => [id, status, summary])).toEqual([
      ["checkout", "passed", "abc1234"],
      ["setup", "passed", "npm test"],
      ["reproduce", "failed", "2 failing"],
      ["fix", "passed", undefined],
      ["patch", "passed", "+1 −1"],
      ["verify", "passed", "6 passing"],
    ]);
    expect(run.before).toMatchObject({ command: "npm test", exitCode: 1, passed: 4, failed: 2, total: 6, failures: ["a feature bumps the minor version", "the biggest change wins"] });
    expect(run.after).toMatchObject({ exitCode: 0, passed: 6, failed: 0 });
    expect(run).toMatchObject({ failingBefore: 2, failingAfter: 0, additions: 1, deletions: 1, testCommand: "npm test" });
    expect(run.patch?.files).toEqual([{ path: "src/next-version.js", additions: 1, deletions: 1 }]);
    expect(run.diagnosis).toContain("`feat`");
    expect(run.sandbox).toMatchObject({ state: "deleted", id: "sbx_0123456789abcdef01234567", size: "medium" });

    // The sample went into the sandbox, and the sandbox is gone.
    expect([...platform.files.keys()].sort()).toEqual(expect.arrayContaining(["repo/package.json", "repo/src/next-version.js", "repo/test/next-version.test.js"]));
    const session = platform.sessions.get(run.sessionId!)!;
    expect(platform.deleted).toEqual([run.sessionId]);
    expect(session.disconnected).toBe(true);

    // Copilot was asked to set up, then to fix the failures Repo Doctor saw.
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("`npm test`");
    expect(session.prompts[1]).toContain("- a feature bumps the minor version");

    // The network view: the registry used by `npm install`, the other allowed hosts unused.
    const allowed = Object.fromEntries(run.network.allowed.map((entry) => [entry.host, entry]));
    expect(run.network.access).toBe("restricted");
    expect(allowed["registry.example.com"]).toMatchObject({ roles: ["npm"], used: { by: "npm install" } });
    expect(allowed["github.com"]).toMatchObject({ roles: ["github"] });
    expect(allowed["github.com"]?.used).toBeUndefined();
    expect(allowed["pypi.org"]).toMatchObject({ roles: ["pip"] });

    // Logs: Copilot's commands and words in its steps, Repo Doctor's commands in its own.
    const { logs } = manager.detail(run.id);
    expect(logs.setup.filter((line) => line.kind === "command").map((line) => line.text)).toEqual(["npm install", "npm test"]);
    expect(logs.setup.some((line) => line.kind === "note" && line.text === "Test command: npm test")).toBe(true);
    expect(logs.reproduce.map((line) => line.kind)).toEqual(["command", "output", "note"]);
    expect(logs.reproduce.at(-1)).toMatchObject({ text: "Exit code 1", exitCode: 1 });
    expect(logs.fix.some((line) => line.kind === "edit" && line.text === "Edited src/next-version.js")).toBe(true);
    const seqs = STEP_IDS.flatMap((id) => logs[id].map((line) => line.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("stops at Reproduce when the tests already pass", async () => {
    const platform = new FakePlatform();
    const commands = platform.commands;
    platform.commands = (script, fake) => (script.endsWith("&& npm test") ? { exitCode: 0, state: "completed", output: PASSING_OUTPUT } : commands(script, fake));
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ sample: true }).id);
    expect(run.status).toBe("healthy");
    expect(run.steps.map((item) => item.status)).toEqual(["passed", "passed", "passed", "skipped", "skipped", "skipped"]);
    expect(step(run, "reproduce").summary).toBe("6 passing");
    expect(platform.sessions.get(run.sessionId!)!.prompts).toHaveLength(1);
    expect(run.failingBefore).toBe(0);
  });

  it("explains a clone that fails, and skips the rest", async () => {
    const platform = new FakePlatform();
    const commands = platform.commands;
    platform.commands = (script, fake) =>
      script.includes("git clone") ? { exitCode: 128, state: "completed", output: "Cloning into 'repo'...\nremote: Repository not found.\nfatal: repository 'https://github.com/octo/missing.git/' not found\n" } : commands(script, fake);
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ repo: "https://github.com/octo/missing" }).id);
    expect(run).toMatchObject({ status: "failed", title: "octo/missing", error: { code: "clone_failed", message: "Couldn't clone octo/missing: it doesn't exist, or it isn't public." } });
    expect(run.steps.map((item) => item.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(run.sandbox.state).toBe("deleted");
    expect(platform.scripts.find((script) => script.includes("git clone"))).toContain("'https://github.com/octo/missing.git' repo");
  });

  it("marks github.com used after a clone, and passes branches to git", async () => {
    const { manager, platform } = setup();
    const run = await finished(manager, manager.create({ repo: "github.com/octo/tools/tree/release/2.x" }).id);
    expect(run.status).toBe("fixed");
    expect(run.source).toEqual({ kind: "github", owner: "octo", repo: "tools", ref: "release/2.x" });
    expect(run.network.allowed.find((entry) => entry.host === "github.com")?.used?.by).toBe("git clone --depth 1 --branch release/2.x https://github.com/octo/tools.git repo");
    expect(platform.scripts.find((script) => script.includes("git clone"))).toContain("--branch 'release/2.x'");
  });

  it("fails Set up when Copilot never reports a test command", async () => {
    const platform = new FakePlatform({ script: async () => "I couldn't find any tests." });
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ sample: true }).id);
    expect(run).toMatchObject({ status: "failed", error: { code: "no_test_command" } });
    expect(step(run, "setup").status).toBe("failed");
    expect(run.sandbox.state).toBe("deleted");
  });

  it("ends with No tests when Copilot reports a repository without any", async () => {
    const platform = new FakePlatform({
      script: async (session) => {
        await session.callTool("report_no_tests", { reason: "The repository has only a README." });
        return "There's nothing to test.";
      },
    });
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ repo: "octocat/Hello-World" }).id);
    expect(run).toMatchObject({ status: "failed", error: { code: "no_tests", message: "Copilot found no tests to run in octocat/Hello-World." } });
    expect(step(run, "setup")).toMatchObject({ status: "failed", summary: "No tests" });
    expect(manager.detail(run.id).logs.setup.some((line) => line.text === "No tests: The repository has only a README.")).toBe(true);
  });

  it("stops: aborts Copilot's turn and deletes the sandbox", async () => {
    let turn: FakeSession | undefined;
    const platform = new FakePlatform({
      script: async (session) => {
        turn = session;
        await session.hang();
        return undefined;
      },
    });
    const { manager } = setup(platform);
    const { id } = manager.create({ sample: true });
    await until(() => turn !== undefined);
    manager.stop(id);
    const run = await finished(manager, id);
    expect(run.status).toBe("stopped");
    expect(step(run, "setup")).toMatchObject({ status: "failed", summary: "Stopped" });
    expect(turn!.aborted).toBe(true);
    expect(run.sandbox.state).toBe("deleted");
    expect(() => manager.stop(id)).toThrow("already finished");
  });

  it("collects blocked requests per host, including ones reported while the sandbox started", async () => {
    const platform = new FakePlatform();
    const at = () => new Date().toISOString();
    platform.onCreate = (session) => platform.block({ sessionId: session.sessionId, host: "api.enterprise.githubcopilot.com", port: 443, reason: "host_not_allowed", at: at() });
    const script = platform.script;
    platform.script = async (session, prompt) => {
      if (prompt.startsWith("Get /workspace/repo ready")) {
        for (let i = 0; i < 2; i++) platform.block({ sessionId: session.sessionId, host: "telemetry.example.com", port: 443, reason: "host_not_allowed", at: at() });
        platform.block({ sessionId: "someone-else", host: "evil.example", reason: "host_not_allowed", at: at() });
      }
      return script(session, prompt);
    };
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ sample: true }).id);
    expect(run.network.blocked.map(({ host, count, runtime }) => ({ host, count, runtime }))).toEqual([
      { host: "api.enterprise.githubcopilot.com", count: 1, runtime: true },
      { host: "telemetry.example.com", count: 2, runtime: false },
    ]);
    const blockedLines = manager.detail(run.id).logs.setup.filter((line) => line.kind === "blocked");
    expect(blockedLines.map((line) => line.text)).toEqual(["telemetry.example.com (host not allowed)"]);
  });

  it("keeps a sandbox it couldn't delete, and deletes it once the platform is back", async () => {
    const platform = new FakePlatform();
    platform.deleteError = new Error("The platform is unreachable");
    const { manager } = setup(platform);
    const { id } = manager.create({ sample: true });
    await until(() => manager.detail(id).run.status !== "running" && manager.detail(id).run.sandbox.state === "deleting");
    platform.deleteError = undefined;
    platform.setStatus({ ...platform.status, state: "connected" });
    await until(() => manager.detail(id).run.sandbox.state === "deleted");
    expect(platform.deleted).toHaveLength(1);
  });

  it("deletes a session the platform created even though creating it failed here", async () => {
    const platform = new FakePlatform();
    platform.createError = { error: new Error("Connection is disposed."), platformHasIt: true };
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ sample: true }).id);
    expect(run).toMatchObject({ status: "failed", error: { message: "Connection is disposed." }, sandbox: { state: "deleted" } });
    expect(platform.deleted).toEqual([run.sessionId]);
  });

  it("marks the sandbox not started when the platform never created the session", async () => {
    const platform = new FakePlatform();
    platform.createError = { error: new Error("Sandboxes aren't available."), platformHasIt: false };
    const { manager } = setup(platform);
    const run = await finished(manager, manager.create({ sample: true }).id);
    expect(run).toMatchObject({ status: "failed", sandbox: { state: "failed" } });
    expect(run.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(platform.deleted).toEqual([]);
  });
});

describe("the run manager", () => {
  it("refuses new runs while the platform is unavailable, or when enough are going", async () => {
    const hanging = new FakePlatform({ script: (session) => session.hang().then(() => undefined) });
    const { manager } = setup(hanging, { maxRuns: 1 });
    const { id } = manager.create({ sample: true });
    expect(() => manager.create({ sample: true })).toThrow("A run is already going");
    manager.stop(id);
    await finished(manager, id);

    const offline = new FakePlatform();
    offline.status = { state: "unavailable", message: "Managed Copilot isn't reachable yet." };
    const second = setup(offline).manager;
    expect(() => second.create({ sample: true })).toThrow("Managed Copilot isn't reachable yet.");
  });

  it("reads repository input and rejects anything else", () => {
    expect(parseSource({ sample: true })).toEqual({ kind: "sample" });
    expect(parseSource({ repo: "octo/tools" })).toEqual({ kind: "github", owner: "octo", repo: "tools" });
    expect(() => parseSource({ repo: "https://gitlab.com/octo/tools" })).toThrow("github.com");
    expect(() => parseSource({})).toThrow("Paste a GitHub repository");
  });

  it("deletes finished runs with their records, serves patches, and keeps numbering", async () => {
    const { manager, dir } = setup();
    const { id } = manager.create({ sample: true });
    await expect(manager.delete(id)).rejects.toThrow("Stop the run before deleting it.");
    await finished(manager, id);
    expect(manager.patch(id)).toMatchObject({ filename: "bumpkit-run-1.patch", text: expect.stringContaining('+  if (type === "feat") return "minor";') });
    await manager.delete(id);
    expect(() => manager.detail(id)).toThrow("no such run");
    expect(readdirSync(join(dir, "runs"))).toEqual([]);
    const next = manager.create({ sample: true });
    expect(next.number).toBe(2);
    await finished(manager, next.id);
  });

  it("marks runs that were going when the server stopped as interrupted, and deletes their sandboxes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-doctor-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const view: RunView = {
      id: "r-0123456789ab",
      number: 7,
      revision: 3,
      source: { kind: "sample" },
      title: "bumpkit",
      status: "running",
      createdAt: new Date().toISOString(),
      model: "claude-sonnet-5",
      sessionId: "session-old",
      sandbox: { state: "ready", environment: "repo-doctor" },
      steps: STEP_IDS.map((id) => ({ id, status: id === "checkout" ? "passed" : id === "setup" ? "running" : "pending", ...(id === "setup" ? { activity: "npm install" } : {}) })),
      network: { access: "restricted", allowed: [], blocked: [] },
    };
    new RunStore(dir).save({ run: view, logs: { checkout: [], setup: [], reproduce: [], fix: [], patch: [], verify: [] } });
    const platform = new FakePlatform();
    platform.created.add("session-old");
    const hub = new EventHub(60_000);
    const manager = new RunManager(platform, testConfig(dir), new RunStore(dir), hub, loadSample(testConfig(dir).sampleDir));
    const restartedAt = Date.now();
    manager.start();
    cleanups.push(() => hub.close());
    await until(() => manager.detail(view.id).run.sandbox.state === "deleted");
    const run = manager.detail(view.id).run;
    expect(run).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    // Newer than anything the server sent before it stopped, so open tabs take it.
    expect(run.revision).toBeGreaterThanOrEqual(restartedAt);
    expect(run.steps.map((item) => item.status)).toEqual(["passed", "failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(step(run, "setup").activity).toBeUndefined();
    expect(platform.deleted).toEqual(["session-old"]);
    expect(manager.create({ sample: true }).number).toBe(8);
  });

  it("skips a record it can't read", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-doctor-bad-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new RunStore(dir);
    writeFileSync(join(dir, "runs", "r-abcdef123456.json"), "{not json");
    expect(store.load()).toEqual([]);
  });

  it("leaves finished runs alone when marking interruptions", () => {
    const view = { status: "fixed" } as RunView;
    expect(interrupted(view)).toBe(view);
  });
});
