import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedCopilotError, type ArtifactInfo, type ScheduleInfo, type SessionInfo } from "@managed-copilot/protocol";
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

class FakeManaged {
  readonly calls: string[] = [];
  sessionsList: SessionInfo[] = [session("37f2a0c9-041b-4b59-91bc-585def383d54"), session("8a11b2c3-0000-4000-8000-000000000000", { state: "running", environment: "coder", placement: "sandbox" })];
  artifactList: ArtifactInfo[] = [];
  readonly url = "http://localhost:7400";
  readonly info = {
    name: "copilot",
    version: "0.1.0",
    mode: "local" as const,
    capabilities: ["shared", "attach.cli"],
    environments: [{ name: "chat", type: "shared" as const, network: { access: "enabled" as const, allowedDomains: [] }, scheduling: false, agents: [] }],
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
    attach: async () => ({ exitCode: 0 }),
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
    expect(fancy.ok).toBe("✔");
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
