import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedCopilotError, OPERATOR_ROUTES, type ArtifactInfo, type OperatorOverview, type OperatorSessionSummary, type ScheduleInfo, type SessionInfo, type WorkerInfo } from "@managed-copilot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoLinks, downloadTarget } from "../src/commands/artifacts.js";
import { run, type CliIo, type Deployment, type ManagedApi } from "../src/cli.js";
import { createStyle, formatBytes, relativeTime, table } from "../src/output.js";

const NOW = Date.parse("2026-10-24T06:00:00Z");

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    environment: "chat",
    type: "shared",
    placement: "shared",
    state: "idle",
    owner: { id: 42, login: "octo" },
    title: "Summarize what changed in Aspire 13",
    createdAt: "2026-10-24T05:00:00Z",
    updatedAt: "2026-10-24T05:55:00Z",
    pendingActions: [],
    ...overrides,
  };
}

const SCHEDULE: ScheduleInfo = {
  id: "sch_0123456789",
  name: "weekday-triage",
  cron: "0 9 * * 1-5",
  timeZone: "America/Los_Angeles",
  environment: "chat",
  prompt: "Triage",
  state: "active",
  createdBy: "user",
  nextRunAt: "2026-10-24T09:00:00Z",
  createdAt: "2026-10-20T00:00:00Z",
};

const NEW_SESSION_ID = "9c1d2e3f-0000-4000-8000-000000000000";

class FakeManaged {
  readonly calls: string[] = [];
  readonly created: Record<string, unknown>[] = [];
  createFails: Error | undefined;
  sessionsList: SessionInfo[] = [session("37f2a0c9-041b-4b59-91bc-585def383d54"), session("8a11b2c3-0000-4000-8000-000000000000", { state: "running", environment: "coder", placement: "sandbox" })];
  artifactList: ArtifactInfo[] = [];
  readonly url = "http://localhost:7400";
  readonly info = {
    name: "copilot",
    version: "0.1.0",
    mode: "local" as const,
    capabilities: ["shared", "isolated", "attach.cli"],
    environments: [
      { name: "chat", type: "shared" as const, models: ["claude-sonnet-5", "claude-haiku-5.5"], network: { access: "enabled" as const, allowedDomains: [] }, scheduling: false, agents: [] },
      { name: "coder", type: "isolated" as const, size: "medium" as const, network: { access: "enabled" as const, allowedDomains: [] }, scheduling: false, agents: [] },
    ],
    sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
  };
  readonly account = { id: 42, login: "octo" };
  readonly sessions = {
    list: async () => this.sessionsList,
    get: async (id: string) => {
      const found = this.sessionsList.find((candidate) => candidate.id === id);
      if (!found) throw new ManagedCopilotError("not_found", "No such session");
      return found;
    },
    delete: async () => undefined,
    handleActions: async () => [],
  };
  readonly schedules = {
    list: async () => [SCHEDULE],
    get: async () => SCHEDULE,
    runs: async () => [{ id: "run_1", scheduleId: SCHEDULE.id, occurrenceId: "o1", scheduledFor: "2026-10-23T16:00:00Z", status: "completed" as const, sessionId: "37f2a0c9-041b-4b59-91bc-585def383d54" }],
    pause: async () => {
      this.calls.push("pause");
      return { ...SCHEDULE, state: "paused" as const };
    },
    resume: async () => SCHEDULE,
    delete: async (id: string) => void this.calls.push(`delete ${id}`),
    runNow: async (_id: string, options?: { invocationId?: string }) => {
      this.calls.push(`run ${options?.invocationId ? "with-invocation" : "without-invocation"}`);
      return { id: "run_2", scheduleId: SCHEDULE.id, occurrenceId: "o2", scheduledFor: "2026-10-24T06:00:00Z", status: "queued" as const };
    },
    create: async () => SCHEDULE,
  };
  artifacts(sessionId: string) {
    return {
      list: async () => this.artifactList,
      read: async () => "",
      readBytes: async () => new Uint8Array(),
      waitForPublication: async () => ({ turnId: "t", state: "published" as const, artifacts: [] }),
      download: async (path: string, local: string) => {
        this.calls.push(`download ${sessionId} ${path} -> ${local}`);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(local, `contents of ${path}`);
      },
    };
  }
  async promote(sessionId: string) {
    this.calls.push(`promote ${sessionId}`);
    return { sessionId, placement: "sandbox" as const, sandboxId: "sbx_7f3a", generation: 2 };
  }
  workerList: WorkerInfo[] = [];
  workers(sessionId: string) {
    this.calls.push(`workers ${sessionId}`);
    return { list: async () => this.workerList, get: async () => this.workerList[0]! };
  }
  async createSession(config: Record<string, unknown>) {
    this.calls.push(`create ${String(config.environment)}`);
    if (this.createFails) throw this.createFails;
    this.created.push(config);
    return { sessionId: NEW_SESSION_ID };
  }
  async close() {
    this.calls.push("close");
  }
}

function harness(managed = new FakeManaged(), extra: Partial<CliIo> = {}) {
  let stdout = "";
  let stderr = "";
  const deployment: Deployment = {
    url: managed.url,
    http: {
      get: async () => ({ account: managed.account, active: true, createdAt: "2026-10-24T04:00:00Z" }),
      post: async () => ({ account: managed.account, active: true }),
      delete: async () => ({ account: managed.account, active: false, reason: "Signed out" }),
    } as unknown as Deployment["http"],
    managed: async () => managed as unknown as ManagedApi,
    requireCopilot: () => undefined,
    attach: async (sessionId) => {
      managed.calls.push(`attach ${sessionId}`);
      return { exitCode: 0 };
    },
  };
  const io: CliIo = {
    stdout: { write: (text: string) => (stdout += text), isTTY: false },
    stderr: { write: (text: string) => (stderr += text), isTTY: false },
    env: {},
    now: () => NOW,
    connect: async () => deployment,
    ...extra,
  };
  return { io, managed, out: () => stdout, err: () => stderr };
}

describe("managed-copilot", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("prints help without touching the network", async () => {
    const { io, out } = harness(undefined, { connect: async () => Promise.reject(new Error("should not connect")) });
    expect(await run(["--help"], io)).toBe(0);
    expect(out()).toContain("attach <session>");
    expect(out()).toContain("new <environment>");
    expect(out()).toContain("schedules");
    expect(await run(["sessions", "--help"], io)).toBe(0);
    expect(out()).toContain("npx managed-copilot sessions [--environment <name>]");
  });

  it("lists sessions as an aligned table with relative times", async () => {
    const { io, out } = harness();
    expect(await run(["sessions"], io)).toBe(0);
    const lines = out().split("\n");
    expect(lines[0]).toMatch(/^ID\s+ENVIRONMENT\s+PLACEMENT\s+STATE\s+TITLE\s+UPDATED$/);
    expect(lines[1]).toMatch(/^37f2a0c9\s+chat\s+shared\s+idle\s+Summarize what changed in Aspire 13\s+5 minutes ago$/);
    expect(lines[2]).toContain("8a11b2c3");
    expect(out()).toContain("2 sessions");
    expect(out()).not.toContain("\u001b[");
  });

  it("prints JSON for scripts", async () => {
    const { io, out } = harness();
    expect(await run(["sessions", "--json"], io)).toBe(0);
    expect(JSON.parse(out())).toHaveLength(2);
  });

  it("runs a command in a session's sandbox, streams its output, and exits with its code", async () => {
    const managed = new FakeManaged();
    const runs: { session: string; command: string; options: Record<string, unknown> }[] = [];
    const result = (exitCode: number, output: string) => ({ id: "ex_1", sessionId: "8a11b2c3-0000-4000-8000-000000000000", command: "", state: "completed" as const, exitCode, background: true, startedAt: "", outputBytes: output.length, output, offset: output.length });
    (managed as unknown as { exec: unknown }).exec = async (session: string, command: string, options: Record<string, unknown>) => {
      runs.push({ session, command, options });
      if (!options.background) return result(0, "json\n");
      return {
        id: "ex_1",
        output: (async function* () {
          yield "line 1\n";
          yield "line 2\n";
        })(),
        result: Promise.resolve(result(3, "line 1\nline 2\n")),
        stop: async () => ({}),
      };
    };
    const { io, out, err } = harness(managed);
    expect(await run(["exec", "8a11b2c3", "--", "ls", "-la", "|", "wc"], io)).toBe(3);
    expect(out()).toBe("line 1\nline 2\n");
    expect(runs[0]).toMatchObject({ session: "8a11b2c3-0000-4000-8000-000000000000", command: "ls -la | wc", options: { background: true, stdin: "closed" } });
    expect(await run(["exec", "8a11b2c3", "--timeout", "5", "--json", "--", "echo json"], io)).toBe(0);
    expect(runs[1]).toMatchObject({ command: "echo json", options: { timeoutMs: 5000 } });
    expect(await run(["exec", "8a11b2c3"], io)).toBe(2);
    expect(err()).toContain("Pass the command after `--`");
  });

  it("lists an orchestrator session's workers, and marks workers in the session list", async () => {
    const managed = new FakeManaged();
    const coordinator = session("c0ffee00-0000-4000-8000-000000000000", { environment: "team", type: "orchestrator" });
    const workerSession = session("b0b0b0b0-0000-4000-8000-000000000000", { environment: "coder", type: "isolated", placement: "sandbox", parentSessionId: coordinator.id });
    managed.sessionsList = [coordinator, workerSession];
    managed.workerList = [
      { id: workerSession.id, name: "counter", coordinatorId: coordinator.id, environment: "coder", state: "idle", task: "Count", result: "42 *.cs files\nacross 7 folders", messages: 1, createdAt: "2026-10-24T05:50:00Z", updatedAt: "2026-10-24T05:58:00Z" },
      { id: "d0d0d0d0-0000-4000-8000-000000000000", name: "broken", coordinatorId: coordinator.id, environment: "coder", state: "failed", task: "Fail", error: "Couldn't start: setup failed", messages: 0, createdAt: "2026-10-24T05:50:00Z", updatedAt: "2026-10-24T05:59:00Z" },
    ];
    const { io, out, err } = harness(managed);
    expect(await run(["sessions"], io)).toBe(0);
    expect(out()).toMatch(/b0b0b0b0\s+coder \(worker of c0ffee00\)/);
    expect(await run(["workers", "c0ffee00"], io)).toBe(0);
    expect(out()).toMatch(/NAME\s+ID\s+ENVIRONMENT\s+STATE\s+LATEST\s+UPDATED/);
    expect(out()).toMatch(/counter\s+b0b0b0b0\s+coder\s+idle\s+42 \*\.cs files across 7 folders\s+2 minutes ago/);
    expect(out()).toMatch(/broken\s+d0d0d0d0\s+coder\s+failed\s+Couldn't start: setup failed/);
    expect(out()).toContain("2 workers");
    expect(await run(["workers", "b0b0b0b0"], io)).toBe(2);
    expect(err()).toContain("only orchestrator sessions have workers");
  });

  it("reports usage errors with exit code 2 and a hint", async () => {
    const { io, err } = harness();
    expect(await run(["sessions", "--download", "x"], io)).toBe(2);
    expect(err()).toContain("sessions does not take --download");
    expect(await run(["frob"], io)).toBe(2);
    expect(err()).toContain('Unknown command "frob"');
    expect(await run(["sessions", "--state", "sleepy"], io)).toBe(2);
    expect(err()).toContain('Unknown state "sleepy"');
  });

  it("reports platform errors with their stable code and an actionable hint", async () => {
    const { io, err } = harness(undefined, { connect: async () => Promise.reject(new ManagedCopilotError("authentication_required", "Sign in with GitHub first")) });
    expect(await run(["sessions"], io)).toBe(1);
    expect(err()).toContain("Sign in with GitHub first (authentication_required)");
    expect(err()).toContain("gh auth login");
  });

  it("explains a missing gateway route as a feature that has not landed", async () => {
    const managed = new FakeManaged();
    managed.sessions.list = async () => Promise.reject(new ManagedCopilotError("not_found", "No route for /v1/sessions"));
    const { io, err } = harness(managed);
    expect(await run(["sessions"], io)).toBe(1);
    expect(err()).toContain("This deployment does not offer that yet (/v1/sessions is missing). (capability_unavailable)");
  });

  it("resolves session prefixes and refuses ambiguous or short ones", async () => {
    const managed = new FakeManaged();
    const { io, out, err } = harness(managed);
    expect(await run(["promote", "37f2"], io)).toBe(0);
    expect(managed.calls).toContain("promote 37f2a0c9-041b-4b59-91bc-585def383d54");
    expect(out()).toContain("now runs in its own sandbox sbx_7f3a");
    expect(await run(["promote", "ab"], io)).toBe(2);
    expect(err()).toContain("too short");
    managed.sessionsList.push(session("37f2ffff-0000-4000-8000-000000000000"));
    expect(await run(["promote", "37f2"], io)).toBe(2);
    expect(err()).toContain('"37f2" matches 2 sessions');
    expect(await run(["promote", "zzzz"], io)).toBe(2);
    expect(err()).toContain('No session matches "zzzz"');
  });

  it("refuses to attach without an interactive terminal", async () => {
    const { io, err } = harness();
    expect(await run(["attach", "37f2"], io)).toBe(2);
    expect(err()).toContain("Copilot CLI needs an interactive terminal");
  });

  it("attaches interactively and tells you how to come back", async () => {
    const { io, err } = harness(undefined, { stdin: { isTTY: true }, stdout: { write: () => true, isTTY: true } });
    expect(await run(["attach", "37f2"], io)).toBe(0);
    expect(err()).toContain("Attaching Copilot CLI to 37f2a0c9");
    expect(err()).toContain("Detached from 37f2a0c9");
    expect(err()).toContain("Attach again: npx managed-copilot attach 37f2a0c9");
  });

  it("explains when the platform ends or refuses an attachment", async () => {
    const tty = { stdin: { isTTY: true }, stdout: { write: () => true, isTTY: true } };
    const gone = harness(undefined, tty);
    const goneDeployment = await gone.io.connect!({});
    (goneDeployment as { attach: Deployment["attach"] }).attach = async () => ({ exitCode: 0, outcome: { code: "session_gone", message: "The session was deleted." } });
    gone.io = { ...gone.io, connect: async () => goneDeployment } as CliIo;
    expect(await run(["attach", "37f2"], gone.io)).toBe(0);
    expect(gone.err()).toContain("The session was deleted.");
    expect(gone.err()).not.toContain("Attach again");

    const refused = harness(undefined, tty);
    const refusedDeployment = await refused.io.connect!({});
    (refusedDeployment as { attach: Deployment["attach"] }).attach = async () => ({
      exitCode: 1,
      outcome: { code: "forbidden", message: "Copilot CLI is signed in as @other, but this session belongs to @octo." },
    });
    refused.io = { ...refused.io, connect: async () => refusedDeployment } as CliIo;
    expect(await run(["attach", "37f2"], refused.io)).toBe(1);
    expect(refused.err()).toContain("signed in as @other");
  });

  const TTY = { stdin: { isTTY: true }, stdout: { write: () => true, isTTY: true } };

  it("starts a new session and opens it in Copilot CLI", async () => {
    const managed = new FakeManaged();
    const { io, err } = harness(managed, TTY);
    expect(await run(["new", "chat", "--model", "claude-haiku-5.5"], io)).toBe(0);
    // The creating client leaves before Copilot CLI attaches, so the CLI answers the session's prompts.
    expect(managed.calls).toEqual(["create chat", "close", `attach ${NEW_SESSION_ID}`]);
    const config = managed.created[0]!;
    expect(config).toMatchObject({ environment: "chat", model: "claude-haiku-5.5" });
    expect(await (config.onPermissionRequest as () => unknown)()).toEqual({ kind: "no-result" });
    expect(err()).toContain("Starting a new chat session · shared · claude-haiku-5.5");
    expect(err()).toMatch(/Session 9c1d2e3f is ready\. Opening Copilot CLI/);
    expect(err()).toContain("Detached from 9c1d2e3f. The session keeps running.");
    expect(err()).toContain("Attach again: npx managed-copilot attach 9c1d2e3f");
  });

  it("uses the environment's first model by default and says when a sandbox is being set up", async () => {
    const shared = new FakeManaged();
    const chat = harness(shared, TTY);
    expect(await run(["new", "chat"], chat.io)).toBe(0);
    expect(shared.created[0]).not.toHaveProperty("model");
    expect(chat.err()).toContain("Starting a new chat session · shared · claude-sonnet-5");
    expect(chat.err()).not.toContain("sandbox");

    const isolated = new FakeManaged();
    const coder = harness(isolated, TTY);
    expect(await run(["new", "coder"], coder.io)).toBe(0);
    expect(isolated.created[0]).toMatchObject({ environment: "coder" });
    expect(coder.err()).toContain("Starting a new coder session · its own sandbox");
    expect(coder.err()).toContain("Setting up its sandbox");
  });

  it("checks the terminal, environment, and model before creating anything", async () => {
    const managed = new FakeManaged();
    const plain = harness(managed);
    expect(await run(["new", "chat"], plain.io)).toBe(2);
    expect(plain.err()).toContain("Copilot CLI needs an interactive terminal");

    const { io, err } = harness(managed, TTY);
    expect(await run(["new"], io)).toBe(2);
    expect(err()).toContain("Name the environment for the new session.");
    expect(err()).toContain("This deployment offers: chat (shared), coder (isolated). For example: npx managed-copilot new chat");
    expect(await run(["new", "chatt"], io)).toBe(2);
    expect(err()).toContain('No environment is named "chatt".');
    expect(await run(["new", "chat", "--model", "gpt-4"], io)).toBe(2);
    expect(err()).toContain('chat does not allow the model "gpt-4".');
    expect(err()).toContain("Use one of: claude-sonnet-5, claude-haiku-5.5.");
    expect(await run(["new", "chat", "--model", " "], io)).toBe(2);
    expect(err()).toContain("--model needs a model ID.");
    expect(await run(["new", "chat", "coder"], io)).toBe(2);
    expect(err()).toContain('Name one environment ("coder" is extra).');
    expect(await run(["sessions", "--model", "x"], io)).toBe(2);
    expect(err()).toContain("sessions does not take --model");
    expect(managed.calls).toEqual([]);
  });

  it("fails before creating a session when Copilot CLI or attach is unavailable", async () => {
    const managed = new FakeManaged();
    const missing = harness(managed, TTY);
    const deployment = await missing.io.connect!({});
    (deployment as { requireCopilot: Deployment["requireCopilot"] }).requireCopilot = () => {
      throw new ManagedCopilotError("capability_unavailable", "Copilot CLI is not installed.");
    };
    expect(await run(["new", "chat"], missing.io)).toBe(1);
    expect(missing.err()).toContain("Copilot CLI is not installed. (capability_unavailable)");
    expect(missing.err()).toContain("Install it with `winget install GitHub.Copilot` or `npm install -g @github/copilot`, then run `npx managed-copilot new chat` again.");
    expect(await run(["attach", "37f2"], missing.io)).toBe(1);
    expect(missing.err()).toContain("then run `npx managed-copilot attach` again.");
    expect(missing.err()).not.toContain("does not offer that yet");

    const older = new FakeManaged();
    older.info.capabilities = ["shared"];
    const noAttach = harness(older, TTY);
    expect(await run(["new", "chat"], noAttach.io)).toBe(1);
    expect(noAttach.err()).toContain("This deployment does not offer Copilot CLI attach, so a new session could not be opened in it.");
    expect([...managed.calls, ...older.calls]).toEqual([]);
  });

  it("closes its client and reports the error when the session can't be created", async () => {
    const managed = new FakeManaged();
    managed.createFails = new ManagedCopilotError("setup_failed", "Setup command exited with 1.");
    const { io, err } = harness(managed, TTY);
    expect(await run(["new", "coder"], io)).toBe(1);
    expect(managed.calls).toEqual(["create coder", "close"]);
    expect(err()).toContain("Setup command exited with 1. (setup_failed)");
  });

  it("says where the new session is when Copilot CLI cannot start on it", async () => {
    const managed = new FakeManaged();
    const failing = harness(managed, TTY);
    const deployment = await failing.io.connect!({});
    (deployment as { attach: Deployment["attach"] }).attach = async () => {
      throw new ManagedCopilotError("capability_unavailable", "Could not start Copilot CLI: spawn EPERM");
    };
    expect(await run(["new", "chat"], failing.io)).toBe(1);
    expect(failing.err()).toContain("Could not start Copilot CLI: spawn EPERM (capability_unavailable)");
    expect(failing.err()).toContain("Session 9c1d2e3f was created and keeps running: npx managed-copilot attach 9c1d2e3f");
    expect(failing.err()).not.toContain("does not offer that yet");
  });

  it("downloads the newest published version of each artifact, inside the target folder", async () => {
    const managed = new FakeManaged();
    managed.artifactList = [
      { id: "a1", path: "report.md", size: 2100, digest: "d", turnId: "t1", version: 1, state: "published", publishedAt: "2026-10-24T05:50:00Z" },
      { id: "a2", path: "report.md", size: 2300, digest: "d", turnId: "t2", version: 2, state: "published", publishedAt: "2026-10-24T05:58:00Z" },
      { id: "a3", path: "charts/revenue.png", size: 48213, digest: "d", turnId: "t2", version: 1, state: "published", publishedAt: "2026-10-24T05:58:00Z" },
      { id: "a4", path: "draft.txt", size: 10, digest: "d", turnId: "t3", version: 1, state: "pending" },
    ];
    const { io, out } = harness(managed);
    const directory = mkdtempSync(join(tmpdir(), "mc-cli-"));
    cleanup.push(directory);
    expect(await run(["artifacts", "37f2", "--all", "--download", directory], io)).toBe(0);
    expect(out()).toMatch(/report\.md\s+2\.1 KB\s+v1\s+published/);
    expect(out()).toContain("Saved 2 files");
    expect(readFileSync(join(directory, "charts", "revenue.png"), "utf8")).toBe("contents of charts/revenue.png");
    expect(managed.calls.filter((call) => call.startsWith("download"))).toHaveLength(2);
  });

  it("refuses artifact names that could escape or clobber files in the download folder", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-cli-"));
    cleanup.push(directory);
    expect(() => downloadTarget(directory, "../escape.txt")).toThrow(/'\.\.' segment/);
    expect(() => downloadTarget(directory, "a//b.txt")).toThrow(/empty/);
    expect(() => downloadTarget(directory, "sub\\..\\..\\other.txt")).toThrow(/backslash/);
    expect(() => downloadTarget(directory, "C:/outside.txt", "win32")).toThrow(/valid Windows file name/);
    expect(() => downloadTarget(directory, "logs/NUL.txt", "win32")).toThrow(/valid Windows file name/);
    expect(() => downloadTarget(directory, "notes. ", "win32")).toThrow(/valid Windows file name/);
    expect(downloadTarget(directory, "logs/nul.txt", "linux")).toBe(join(directory, "logs", "nul.txt"));

    const managed = new FakeManaged();
    managed.artifactList = [
      { id: "a1", path: "Report.md", size: 1, digest: "d", turnId: "t1", version: 1, state: "published", publishedAt: "2026-10-24T05:50:00Z" },
      { id: "a2", path: "report.md", size: 1, digest: "d", turnId: "t1", version: 1, state: "published", publishedAt: "2026-10-24T05:50:00Z" },
    ];
    const { io, err } = harness(managed);
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
    expect(await run(["artifacts", "37f2", "--download", directory], io)).toBe(caseInsensitive ? 2 : 0);
    if (caseInsensitive) {
      expect(err()).toContain('"Report.md" and "report.md" would be saved to the same file');
      expect(managed.calls.filter((call) => call.startsWith("download"))).toHaveLength(0);
    }
  });

  it("never saves an artifact through a link or junction inside the download folder", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-cli-"));
    const outside = mkdtempSync(join(tmpdir(), "mc-cli-outside-"));
    cleanup.push(directory, outside);
    symlinkSync(outside, join(directory, "charts"), "junction");
    const target = downloadTarget(directory, "charts/revenue.png");
    await expect(assertNoLinks(directory, target)).rejects.toThrow(/through the link/);
    await expect(assertNoLinks(directory, downloadTarget(directory, "notes/report.md"))).resolves.toBeUndefined();
  });

  it("refuses to guess a session from a prefix when the list may be incomplete", async () => {
    const managed = new FakeManaged();
    managed.sessionsList = Array.from({ length: 1000 }, (_, index) => session(`${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`));
    const { io, err } = harness(managed);
    expect(await run(["artifacts", "000003e7"], io)).toBe(2);
    expect(err()).toContain("more than 1000 sessions");
    expect(await run(["artifacts", "0000000"], io)).toBe(2);
    expect(err()).toMatch(/matches \d+ sessions/);
  });

  it("manages schedules by name, with confirmation for deletes and a retry-safe run", async () => {
    const managed = new FakeManaged();
    const { io, out, err } = harness(managed);
    expect(await run(["schedules"], io)).toBe(0);
    expect(out()).toMatch(/weekday-triage\s+active\s+0 9 \* \* 1-5 America\/Los_Angeles\s+in 3 hours\s+never/);
    expect(await run(["schedules", "pause", "weekday-triage"], io)).toBe(0);
    expect(managed.calls).toContain("pause");
    expect(await run(["schedules", "run", "sch_0123"], io)).toBe(0);
    expect(managed.calls).toContain("run with-invocation");
    expect(await run(["schedules", "delete", "weekday-triage"], io)).toBe(2);
    expect(err()).toContain("Pass --yes");
    expect(await run(["schedules", "delete", "weekday-triage", "--yes"], io)).toBe(0);
    expect(managed.calls).toContain("delete sch_0123456789");
    expect(await run(["schedules", "runs", "weekday-triage"], io)).toBe(0);
    expect(out()).toMatch(/completed\s+37f2a0c9/);
  });

  it("shows deployment status and toggles background sign-in", async () => {
    const { io, out } = harness();
    expect(await run(["status"], io)).toBe(0);
    expect(out()).toMatch(/Deployment\s+copilot · local · v0\.1\.0 · http:\/\/localhost:7400/);
    expect(out()).toMatch(/Background\s+on since 2 hours ago/);
    expect(await run(["login"], io)).toBe(0);
    expect(out()).toContain("Background sign-in is on for @octo");
    expect(await run(["logout"], io)).toBe(0);
    expect(out()).toContain("Background sign-in is off for @octo");
  });
});

describe("output helpers", () => {
  it("degrades colors and symbols", () => {
    const plain = createStyle({ isTTY: true, env: { NO_COLOR: "1" }, platform: "win32" });
    expect(plain.green("ok")).toBe("ok");
    expect(plain.ok).toBe("√");
    const fancy = createStyle({ isTTY: true, env: { WT_SESSION: "1" }, platform: "win32" });
    expect(fancy.green("ok")).toBe("\u001b[32mok\u001b[39m");
    expect(fancy.ok).toBe("✓");
    expect(fancy.fail).toBe("X");
    expect(fancy.warn).toBe("!");
    expect(createStyle({ isTTY: false, env: {}, platform: "linux" }).red("x")).toBe("x");
  });

  it("aligns tables by visible width", () => {
    const style = createStyle({ isTTY: true, env: { FORCE_COLOR: "1" }, platform: "linux" });
    const text = table(["A", "B"], [[style.green("ok"), "x"], ["longer", "y"]], style).replace(/\u001b\[[0-9;]*m/g, "");
    expect(text.split("\n")).toEqual(["A       B", "ok      x", "longer  y"]);
  });

  it("formats sizes and times", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(48213)).toBe("47 KB");
    expect(formatBytes(2100)).toBe("2.1 KB");
    expect(relativeTime("2026-10-24T05:59:50Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-24T03:00:00Z", NOW)).toBe("3 hours ago");
    expect(relativeTime("2026-10-25T06:00:00Z", NOW)).toBe("tomorrow");
  });
});

describe("managed-copilot console and operator", () => {
  const OVERVIEW: OperatorOverview = {
    deployment: { name: "copilot", version: "0.1.0", mode: "local", publicUrl: "http://localhost:7400", startedAt: "2026-10-24T05:00:00Z", capabilities: ["operator", "shared"], sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" } },
    health: [
      { id: "gateway", name: "Gateway", status: "healthy", summary: "v0.1.0 · local · up 1 h 0 min" },
      { id: "sandboxes", name: "Sandbox backend", status: "unavailable", summary: "docker · not reachable", detail: "Docker is not reachable." },
    ],
    counts: {
      sessions: { total: 3, live: 1, byState: { idle: 2, failed: 1 }, byPlacement: { shared: 3 }, byEnvironment: { chat: 3 } },
      connections: { sdk: 2, cli: 1 },
      sandboxes: { total: 0, byState: {} },
      schedules: { active: 1, paused: 0 },
      actions: { open: 2, needsReconciliation: 1 },
      webhooks: { pending: 0, failed: 2 },
      accounts: 2,
    },
    traffic: {},
    attention: [{ id: "health:sandboxes", severity: "error", title: "Sandbox backend is unavailable", detail: "Docker is not reachable." }],
    generatedAt: "2026-10-24T06:00:00Z",
  };
  const SESSIONS: OperatorSessionSummary[] = [
    { id: "37f2a0c9-041b-4b59-91bc-585def383d54", owner: { id: 42, login: "octo" }, environment: "chat", type: "shared", placement: "shared", state: "idle", generation: 0, createdAt: "2026-10-24T05:00:00Z", updatedAt: "2026-10-24T05:55:00Z", live: true, attached: 2 },
  ];

  function operatorHarness(options: { forbid?: boolean; missing?: boolean; interactive?: boolean; openFails?: boolean } = {}) {
    let stdout = "";
    let stderr = "";
    const opened: string[] = [];
    const requests: string[] = [];
    const fail = () => {
      if (options.missing) throw new ManagedCopilotError("not_found", "No route for /v1/operator/me");
      if (options.forbid) throw new ManagedCopilotError("forbidden", "@octo is not an operator of this deployment (operators: @admin).");
    };
    const deployment: Deployment = {
      url: "http://localhost:7400",
      http: {
        get: async (path: string) => {
          requests.push(`GET ${path}`);
          fail();
          if (path === OPERATOR_ROUTES.me) return { account: { id: 42, login: "octo" }, grant: "local", via: "token" };
          if (path === OPERATOR_ROUTES.overview) return OVERVIEW;
          if (path.startsWith(OPERATOR_ROUTES.sessions)) return SESSIONS;
          throw new ManagedCopilotError("not_found", `No route for ${path}`);
        },
        post: async (path: string) => {
          requests.push(`POST ${path}`);
          fail();
          return { ticket: "mcct_abc+/=", expiresAt: "2026-10-24T06:01:00Z", url: "http://ignored/console/signin#ticket=x" };
        },
        delete: async () => undefined,
      } as unknown as Deployment["http"],
      managed: async () => Promise.reject(new Error("not used")),
      requireCopilot: () => undefined,
      attach: async () => ({ exitCode: 0 }),
    };
    const io: CliIo = {
      stdout: { write: (text: string) => (stdout += text), isTTY: options.interactive ?? false },
      stderr: { write: (text: string) => (stderr += text), isTTY: false },
      stdin: { isTTY: options.interactive ?? false },
      env: {},
      now: () => NOW,
      connect: async () => deployment,
      openUrl: async (url) => {
        if (options.openFails) throw new Error("no browser");
        opened.push(url);
      },
    };
    return { io, opened, requests, out: () => stdout, err: () => stderr };
  }

  it("opens the console with a one-time sign-in link whose ticket stays in the fragment", async () => {
    const { io, opened, out, requests } = operatorHarness({ interactive: true });
    expect(await run(["console"], io)).toBe(0);
    expect(requests).toEqual([`GET ${OPERATOR_ROUTES.me}`, `POST ${OPERATOR_ROUTES.consoleTickets}`]);
    expect(opened).toEqual([`http://localhost:7400/console/signin#ticket=${encodeURIComponent("mcct_abc+/=")}`]);
    expect(out().replace(/\u001b\[[0-9;]*m/g, "")).toContain("Opened the operator console for @octo (local operator)");
    expect(out()).not.toContain("mcct_abc");
  });

  it("prints the link when it should not or cannot open a browser", async () => {
    const quiet = operatorHarness({ interactive: true });
    expect(await run(["console", "--no-open"], quiet.io)).toBe(0);
    expect(quiet.opened).toEqual([]);
    expect(quiet.out()).toContain("http://localhost:7400/console/signin#ticket=");
    const broken = operatorHarness({ interactive: true, openFails: true });
    expect(await run(["console"], broken.io)).toBe(0);
    expect(broken.out()).toContain("Open this link to sign in");
    const scripted = operatorHarness();
    expect(await run(["console", "--json"], scripted.io)).toBe(0);
    expect(JSON.parse(scripted.out())).toMatchObject({ console: "http://localhost:7400/console/", grant: "local", expiresAt: "2026-10-24T06:01:00Z" });
  });

  it("explains who may operate, and deployments without a console", async () => {
    const forbidden = operatorHarness({ forbid: true });
    expect(await run(["console"], forbidden.io)).toBe(1);
    expect(forbidden.err()).toContain("@octo is not an operator of this deployment (operators: @admin). (forbidden)");
    expect(forbidden.err()).toContain("operators: { githubUsers:");
    const older = operatorHarness({ missing: true });
    expect(await run(["operator"], older.io)).toBe(1);
    expect(older.err()).toContain("This deployment has no operator console yet. (capability_unavailable)");
  });

  it("shows the operator overview and every owner's sessions", async () => {
    const { io, out, requests } = operatorHarness();
    expect(await run(["operator"], io)).toBe(0);
    expect(out()).toMatch(/Gateway\s+healthy/);
    expect(out()).toMatch(/Sandbox backend\s+unavailable/);
    expect(out()).toContain("Sandbox backend is unavailable");
    expect(out()).toContain("2 open · 1 need reconciliation");
    expect(out()).toContain("Open the console: npx managed-copilot console");
    expect(await run(["operator", "--url", "https://copilot.contoso.com"], io)).toBe(0);
    expect(out()).toContain("Open the console: npx managed-copilot console --url https://copilot.contoso.com");
    expect(await run(["operator", "sessions", "--owner", "octo", "--state", "idle"], io)).toBe(0);
    expect(requests.at(-1)).toBe(`GET ${OPERATOR_ROUTES.sessions}?state=idle&owner=octo`);
    expect(out()).toMatch(/37f2a0c9\s+@octo\s+chat\s+shared\s+idle\s+live · 2 attached\s+5 minutes ago/);
    expect(await run(["operator", "sessions", "--json"], io)).toBe(0);
    expect(await run(["operator", "nope"], io)).toBe(2);
  });
});