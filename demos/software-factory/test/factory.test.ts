import { ManagedCopilotError } from "@managed-copilot/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { Factory, type FactoryOptions } from "../src/server/pipeline/factory.js";
import { PlatformUnavailableError } from "../src/server/pipeline/errors.js";
import { FactoryStore } from "../src/server/store.js";
import type { ServerEvent, WorkOrder } from "../src/shared/types.js";
import { FakePlatform, manifest, testReport, type FakeSession, type Script } from "./fakes.js";

const PLAN = {
  summary: "Two independent commands, one per builder.",
  projectName: "csvjson",
  packageDescription: "Convert between CSV and JSON",
  bin: { csv2json: "bin/csv2json.js", json2csv: "bin/json2csv.js" },
  tasks: [
    {
      id: "csv2json",
      title: "CSV to JSON",
      description: "Parser and CLI.",
      files: ["bin/csv2json.js", "src/csv.js", "test/csv2json.test.js"],
      interface: "csv2json [file] [--pretty]",
      acceptance: ["Parses quoted fields", "--pretty indents"],
      dependsOn: [],
    },
    {
      id: "json2csv",
      title: "JSON to CSV",
      description: "Serializer and CLI.",
      files: ["bin/json2csv.js", "test/json2csv.test.js"],
      acceptance: ["Quotes fields with commas"],
      dependsOn: [],
    },
  ],
  integration: "Round trip csv2json and json2csv.",
};

const CREATE = { title: "CSV ⇄ JSON toolkit", brief: "Build two command-line tools that convert between CSV and JSON, with tests.", mode: "classic" as const };

function taskOf(platform: FakePlatform, session: FakeSession): { id: string; files: string[] } {
  return JSON.parse(platform.workspaces.get(session.sessionId)!.get(".factory/task.json")!) as { id: string; files: string[] };
}

const planner: Script = async (session, prompt) => {
  if (prompt.includes("Plan this work order")) {
    const rejected = await session.callTool("submit_plan", { ...PLAN, tasks: [] });
    expect(String(rejected)).toMatch(/^Rejected/);
  }
  await session.callTool("submit_plan", PLAN);
  session.say("Split the toolkit into two independent commands.");
};

function builder(options: { failing?: boolean; skipRerun?: boolean } = {}): Script {
  return async (session, prompt, platform) => {
    const task = taskOf(platform, session);
    const fix = prompt.includes("requested changes");
    if (fix && options.skipRerun && session.prompts.filter((p) => p.includes("requested changes")).length === 1) {
      platform.publish(session.sessionId, { [`files/${task.files[0]}`]: `// ${task.id} fixed but not re-checked` });
      session.say("Fixed it (but forgot the check).");
      return;
    }
    const files = Object.fromEntries(task.files.map((file) => [`files/${file}`, `// ${task.id} ${file}${fix ? " (fixed)" : ""}`]));
    const failing = options.failing ? 1 : 0;
    session.shell("npm run check", `ok\nFACTORY_TEST_SUMMARY {"total":${3 + failing},"passed":3,"failed":${failing},"skipped":0,"durationMs":40}`, failing ? 1 : 0);
    platform.publish(session.sessionId, {
      ...files,
      // Every real check run writes a fresh report (new timestamps), so each turn publishes a new version.
      "test-report.json": testReport(3, failing) + " ".repeat(session.prompts.length),
      "manifest.json": manifest(task.files),
    });
    session.say(`Built ${task.id}.`);
  };
}

const reviewer: Script = async (session, prompt) => {
  const wantsChanges = prompt.includes('"csv2json: CSV to JSON" (round 1');
  await session.callTool(
    "submit_review",
    wantsChanges
      ? { verdict: "request_changes", summary: "Quoted newlines break the parser.", findings: [{ severity: "major", file: "src/csv.js", line: 12, message: "Handle newlines inside quotes." }] }
      : { verdict: "approve", summary: "Looks good.", findings: [{ severity: "minor", message: "Consider a usage example." }] },
  );
};

const release: Script = async (session, _prompt, platform) => {
  const workspace = platform.workspaces.get(session.sessionId)!;
  const projectFiles = [...workspace.keys()].filter((path) => !path.startsWith(".factory/"));
  platform.publish(session.sessionId, {
    ...Object.fromEntries(projectFiles.map((path) => [`bundle/${path}`, workspace.get(path)!])),
    "bundle/README.md": "# csvjson",
    "project.patch": "diff --git a/README.md b/README.md\n",
    "test-report.json": testReport(7, 0, "release"),
    "manifest.json": manifest([...projectFiles, "README.md"], "release"),
    "RELEASE.md": "# csvjson 0.1.0\n\nShipped.",
  });
  session.say("Released csvjson.");
};

let store: FactoryStore;
let hub: EventHub;

function setup(scripts: ConstructorParameters<typeof FakePlatform>[0], existingStore?: FactoryStore, overrides: Partial<FactoryOptions> = {}) {
  store = existingStore ?? new FactoryStore(":memory:");
  hub = new EventHub(60_000);
  const platform = new FakePlatform(scripts);
  const factory = new Factory({
    store,
    hub,
    platform,
    readiness: () => ({ ready: true }),
    account: () => ({ login: "octocat" }),
    config: { maxSandboxes: 4, turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000, coordinator: 5_000, developer: 5_000 }, publicationTimeoutMs: 1_000 },
    pollMs: 10,
    ...overrides,
  });
  return { platform, factory };
}

async function settle(factory: Factory, id: string, timeoutMs = 5_000): Promise<WorkOrder> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wo = factory.get(id)!;
    if (!factory.isActive(id) && ["completed", "failed", "cancelled"].includes(wo.status)) return wo;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Work order ${id} did not settle: ${factory.get(id)?.status}`);
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A finished work order rewound to its release turn in flight (sent a minute ago), handed to a second factory as after
 * a restart. The second platform has the first one's sessions, workspaces, and outputs.
 */
async function releaseInFlight(overrides: Partial<FactoryOptions> = {}) {
  const first = setup({ planner, builder: builder(), reviewer, release });
  const created = first.factory.create(CREATE);
  await settle(first.factory, created.id);
  const stored = store.getWorkOrder(created.id)!;
  const releaseSession = stored.stations.find((station) => station.id === "release")!.sessionId!;
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  store.saveWorkOrder({
    ...stored,
    status: "releasing",
    release: undefined,
    stations: stored.stations.map((station) => (station.id === "release" ? { ...station, status: "working", turn: { kind: "work", round: 1, sentAt } } : station)),
  } as WorkOrder);
  hub.close();
  const second = setup({ planner, builder: builder(), reviewer, release }, store, overrides);
  for (const [map, source] of [
    [second.platform.sessions, first.platform.sessions],
    [second.platform.outputs, first.platform.outputs],
    [second.platform.workspaces, first.platform.workspaces],
  ] as const) for (const [key, value] of source as Map<string, never>) (map as Map<string, never>).set(key, value);
  return { ...second, id: created.id, releaseSession };
}

afterEach(() => {
  hub?.close();
});

describe("Factory pipeline", () => {
  it("plans, builds in parallel, sends work back on review, and releases", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    const events: ServerEvent[] = [];
    hub.subscribe((event) => events.push(event));
    const created = factory.create({ ...CREATE, templateId: "csv-json-toolkit" });
    expect(created.status).toBe("queued");
    expect(created.source).toEqual({ kind: "template", templateId: "csv-json-toolkit" });
    const wo = await settle(factory, created.id);

    expect(wo.status).toBe("completed");
    expect(wo.error).toBeUndefined();
    expect(wo.plan?.tasks.map((task) => task.id)).toEqual(["csv2json", "json2csv"]);
    expect(wo.stations.map((station) => `${station.id}:${station.status}`)).toEqual([
      "plan:done",
      "build:csv2json:done",
      "review:csv2json:done",
      "build:json2csv:done",
      "review:json2csv:done",
      "release:done",
    ]);
    const csvReview = wo.stations.find((station) => station.id === "review:csv2json")!;
    expect(csvReview.reviews?.map((review) => review.verdict)).toEqual(["request_changes", "approve"]);
    expect(wo.stations.find((station) => station.id === "build:csv2json")!.round).toBe(2);
    expect(wo.stations.find((station) => station.id === "build:json2csv")!.round).toBe(1);
    expect(wo.release).toMatchObject({ files: 7, tests: { passed: 7, failed: 0 }, notes: "# csvjson 0.1.0\n\nShipped." });
    expect(wo.tests?.passed).toBe(7);

    // Each builder got its own sandbox seeded with its task; the release got everyone's files.
    const builders = platform.sessionsFor("builder");
    expect(builders).toHaveLength(2);
    const seeded = platform.workspaces.get(builders[0]!.sessionId)!;
    expect([...seeded.keys()]).toEqual(expect.arrayContaining(["package.json", ".factory/task.json", ".factory/PLAN.md", ".factory/WORK_ORDER.md", ".factory/seed.json"]));
    expect(JSON.parse(seeded.get("package.json")!)).toMatchObject({ name: "csvjson", type: "module", bin: PLAN.bin });
    const releaseWorkspace = platform.workspaces.get(platform.sessionsFor("release")[0]!.sessionId)!;
    expect(releaseWorkspace.get("src/csv.js")).toBe("// csv2json src/csv.js (fixed)");
    expect(releaseWorkspace.get("bin/json2csv.js")).toBe("// json2csv bin/json2csv.js");
    expect(releaseWorkspace.get(".factory/REVIEWS.md")).toContain("approved in round 2");

    // The builder was asked to fix the reviewer's finding in its own sandbox.
    const csvBuilder = builders.find((session) => taskOf(platform, session).id === "csv2json")!;
    expect(csvBuilder.prompts.at(-1)).toContain("Handle newlines inside quotes.");

    // Activity and artifacts are captured for the UI and survive in the store.
    const activity = factory.activity(wo.id);
    expect(activity.some((item) => item.kind === "message")).toBe(true);
    expect(activity.some((item) => item.kind === "test" && item.tests?.passed === 3)).toBe(true);
    expect(activity.some((item) => item.kind === "review" && item.review?.verdict === "request_changes")).toBe(true);
    const index = factory.artifactIndex(wo.id);
    const csvSource = index.files.find((file) => file.stationId === "build:csv2json" && file.path === "files/src/csv.js")!;
    expect(csvSource.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(factory.artifact(wo.id, "build:csv2json", "files/src/csv.js", 1)?.content).toBe("// csv2json src/csv.js");
    const zip = factory.releaseFiles(wo.id)!;
    expect(zip.files.map((file) => file.path)).toEqual(expect.arrayContaining(["csvjson/README.md", "csvjson/src/csv.js", "RELEASE.md", "project.patch"]));

    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.filter((event) => event.type === "workOrder").at(-1)).toMatchObject({ workOrder: { status: "completed" } });
    expect(store.getWorkOrder(wo.id)?.status).toBe("completed");
  });

  it("fails a station whose tests never pass, then retries in the same sandbox", async () => {
    const failing = builder({ failing: true });
    const scripts = { planner, builder: failing, reviewer, release };
    const { platform, factory } = setup(scripts);
    const created = factory.create(CREATE);
    const failed = await settle(factory, created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("tests_failed");
    const failedBuilds = failed.stations.filter((station) => station.kind === "build" && station.status === "failed");
    expect(failedBuilds).toHaveLength(2);
    expect(failed.stations.find((station) => station.id === "release")!.status).toBe("skipped");
    // Two nudges after the first attempt.
    expect(platform.sessionsFor("builder")[0]!.prompts).toHaveLength(3);

    platform.scripts.builder = builder();
    const builderSessions = platform.sessionsFor("builder").map((session) => session.sessionId).sort();
    const createsBefore = platform.createCount;
    factory.retry(created.id);
    const retried = await settle(factory, created.id);
    expect(retried.status).toBe("completed");
    // The retry reattached to the existing builder sandboxes instead of provisioning new ones.
    expect(platform.sessionsFor("builder").map((session) => session.sessionId).sort()).toEqual(builderSessions);
    expect(platform.createCount - createsBefore).toBe(3); // two reviewers and one release
  });

  it("cancels a running work order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowBuilder: Script = async (session) => {
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (session.aborted) throw new Error("aborted");
    };
    const { factory } = setup({ planner, builder: slowBuilder, reviewer, release: async () => undefined });
    const created = factory.create(CREATE);
    while (factory.get(created.id)?.status !== "building") await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await factory.cancel(created.id);
    release();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stations.filter((station) => station.kind === "build").every((station) => station.status === "cancelled")).toBe(true);
    expect(cancelled.stations.find((station) => station.id === "plan")!.status).toBe("done");
  });

  it("fails clearly when the planner never submits a plan", async () => {
    const silentPlanner: Script = async (session) => session.say("I think it should be two tasks.");
    const { platform, factory } = setup({ planner: silentPlanner });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("failed");
    expect(wo.error).toEqual({ code: "plan_missing", message: "The planner didn't submit a plan." });
    expect(platform.sessionsFor("planner")[0]!.prompts[1]).toContain("submit_plan");
  });

  it("builds dependent tasks after their dependencies, seeded with their files", async () => {
    const chained = {
      ...PLAN,
      tasks: [PLAN.tasks[0]!, { ...PLAN.tasks[1]!, id: "json2csv", dependsOn: ["csv2json"] }],
    };
    const chainPlanner: Script = async (session) => {
      await session.callTool("submit_plan", chained);
    };
    const { platform, factory } = setup({ planner: chainPlanner, builder: builder(), reviewer, release });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    const dependent = platform.sessionsFor("builder").find((session) => taskOf(platform, session).id === "json2csv")!;
    const workspace = platform.workspaces.get(dependent.sessionId)!;
    expect(workspace.get("src/csv.js")).toBe("// csv2json src/csv.js (fixed)");
    expect(JSON.parse(workspace.get(".factory/seed.json")!).files).toHaveProperty("src/csv.js");
  });

  it("asks the builder to re-run the check when it skips it after a fix", async () => {
    const { platform, factory } = setup({ planner, builder: builder({ skipRerun: true }), reviewer, release });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    const csvBuilder = platform.sessionsFor("builder").find((session) => taskOf(platform, session).id === "csv2json")!;
    expect(csvBuilder.prompts.some((prompt) => prompt.includes("wasn't run after the latest changes"))).toBe(true);
  });

  it("resumes an interrupted work order after a restart, reattaching to its sandboxes", async () => {
    const first = setup({ planner, builder: builder(), reviewer, release });
    const created = first.factory.create(CREATE);
    await settle(first.factory, created.id);
    // Rewind the stored record to "building" with the release station mid-turn, as if the process died.
    const stored = store.getWorkOrder(created.id)!;
    const releaseStation = stored.stations.find((station) => station.id === "release")!;
    const rewound = {
      ...stored,
      status: "releasing",
      release: undefined,
      completedAt: undefined,
      stations: stored.stations.map((station) =>
        station.id === "release"
          ? { ...station, status: "working", turn: { kind: "work", round: 1, sentAt: new Date().toISOString() }, reportVersion: undefined, passedRound: undefined }
          : station,
      ),
    } as WorkOrder;
    store.saveWorkOrder(rewound);
    hub.close();

    const second = setup({ planner, builder: builder(), reviewer, release }, store);
    for (const [sessionId, session] of first.platform.sessions) second.platform.sessions.set(sessionId, session);
    for (const [sessionId, files] of first.platform.outputs) second.platform.outputs.set(sessionId, files);
    for (const [sessionId, files] of first.platform.workspaces) second.platform.workspaces.set(sessionId, files);
    second.factory.resumeInterrupted();
    const resumed = await settle(second.factory, created.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("completed");
    expect(second.platform.createCount).toBe(0);
    expect(resumed.stations.find((station) => station.id === "release")!.sessionId).toBe(releaseStation.sessionId);
    expect(second.factory.activity(created.id).some((item) => item.text?.includes("Reattached to session"))).toBe(true);
  });

  it("rejects invalid work orders with friendly messages", () => {
    const { factory } = setup({});
    expect(() => factory.create({ title: "x", brief: CREATE.brief })).toThrow(/title of 3 to 120/);
    expect(() => factory.create({ title: "Valid", brief: "too short" })).toThrow(/20 to 8,000/);
    expect(() => factory.create({ ...CREATE, maxReviewRounds: 5 })).toThrow(/1, 2, or 3/);
  });

  it("retries a cancelled build in its sandbox, telling the builder why it stopped", async () => {
    let hang = true;
    const flaky: Script = async (session, prompt, platform) => {
      if (hang) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return;
      }
      await builder()(session, prompt, platform);
    };
    const { platform, factory } = setup({ planner, builder: flaky, reviewer, release });
    const created = factory.create(CREATE);
    while (factory.get(created.id)?.stations.find((station) => station.kind === "build")?.status !== "working") await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await factory.cancel(created.id)).status).toBe("cancelled");
    hang = false;
    factory.retry(created.id);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    const prompts = platform.sessionsFor("builder").flatMap((session) => session.prompts);
    expect(prompts.some((prompt) => prompt.startsWith("The factory is retrying this station. The previous attempt stopped: The work order was stopped"))).toBe(true);
    expect(wo.stations.every((station) => station.retryNote === undefined)).toBe(true);
  });

  it("asks the agent to continue when the platform reports the interrupted turn failed", async () => {
    const second = await releaseInFlight();
    second.platform.lastTurnStatus.set(second.releaseSession, "failed");
    second.factory.resumeInterrupted();
    const wo = await settle(second.factory, second.id);
    expect(wo.status).toBe("completed");
    const prompt = second.platform.sessions.get(second.releaseSession)!.prompts[0]!;
    expect(prompt).toContain("Your previous turn was interrupted");
    // Nothing from the killed turn is taken as done: the agent re-checks the workspace, and the check must run again.
    expect(prompt).toContain("may have been stopped partway. Check the workspace's current state");
    expect(second.factory.activity(second.id).some((item) => item.text === "The interrupted turn failed; asking the agent to check its workspace and continue")).toBe(true);
  });

  it("continues a turn whose sandbox restarted under it, without stopping anything", async () => {
    // The gateway's ledger still says "running": the recreated runtime never ran the turn, so it never ends.
    const second = await releaseInFlight({ restartGraceMs: 50, stallMs: 60_000 });
    second.platform.lastTurnStatus.set(second.releaseSession, "running");
    second.platform.sandboxStartedAt.set(second.releaseSession, new Date().toISOString());
    second.factory.resumeInterrupted();
    const wo = await settle(second.factory, second.id);
    expect(wo.status).toBe("completed");
    const session = second.platform.sessions.get(second.releaseSession)!;
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("Your previous turn was interrupted");
    expect(session.aborted).toBe(false);
    expect(second.factory.activity(second.id).some((item) => item.text?.startsWith("The sandbox restarted while this turn was running"))).toBe(true);
  });

  it("stops an in-flight turn that shows no activity, then asks the agent to continue", async () => {
    const second = await releaseInFlight({ stallMs: 100, restartGraceMs: 60_000 });
    second.platform.lastTurnStatus.set(second.releaseSession, "running");
    // Started before the turn was sent: the runtime that has the turn is still there, but the turn is stuck.
    second.platform.sandboxStartedAt.set(second.releaseSession, new Date(Date.now() - 10 * 60_000).toISOString());
    second.factory.resumeInterrupted();
    const wo = await settle(second.factory, second.id);
    expect(wo.status).toBe("completed");
    const session = second.platform.sessions.get(second.releaseSession)!;
    expect(session.aborted).toBe(true);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("Your previous turn was interrupted");
    expect(second.factory.activity(second.id).some((item) => item.text?.startsWith("The in-flight turn showed no activity"))).toBe(true);
  });

  it("keeps waiting for an in-flight turn that shows activity, through a failed status read", async () => {
    const second = await releaseInFlight({ stallMs: 800, restartGraceMs: 50 });
    second.platform.lastTurnStatus.set(second.releaseSession, "running");
    second.factory.resumeInterrupted();
    const releaseStation = () => second.factory.get(second.id)!.stations.find((station) => station.id === "release")!;
    await until(() => releaseStation().detail === "Resuming the in-flight turn");
    const session = second.platform.sessions.get(second.releaseSession)!;
    second.platform.sessionInfoErrors.push(new PlatformUnavailableError("Reading the session's status took longer than 10 s."));
    // The turn keeps working past the stall limit, then finishes on its own.
    for (const started = Date.now(); Date.now() - started < 1_100; ) {
      session.emit("assistant.message_delta", { messageId: "m", deltaContent: "." });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(second.platform.sessionInfoErrors).toHaveLength(0);
    await release(session, "", second.platform);
    second.platform.lastTurnStatus.set(second.releaseSession, "completed");
    const wo = await settle(second.factory, second.id);
    expect(wo.status).toBe("completed");
    expect(session.prompts).toHaveLength(0);
    expect(session.aborted).toBe(false);
    expect(second.factory.activity(second.id).some((item) => /^Paused|showed no activity|sandbox restarted/.test(item.text ?? ""))).toBe(false);
  });

  it("pauses, rather than failing the station, when the in-flight turn's status keeps failing to load", async () => {
    const second = await releaseInFlight({ stallMs: 60_000, restartGraceMs: 60_000, resumeBackoffMs: 100 });
    second.platform.lastTurnStatus.set(second.releaseSession, "running");
    second.factory.resumeInterrupted();
    const releaseStation = () => second.factory.get(second.id)!.stations.find((station) => station.id === "release")!;
    await until(() => releaseStation().detail === "Resuming the in-flight turn");
    const unreadable = new PlatformUnavailableError("Reading the session's status took longer than 10 s.");
    second.platform.sessionInfoErrors.push(...Array.from({ length: 5 }, () => unreadable));
    await until(() => second.factory.activity(second.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (Reading the session's status")));
    // Readable again, and the platform reports the turn failed: the work order resumes and the agent continues.
    second.platform.lastTurnStatus.set(second.releaseSession, "failed");
    const wo = await settle(second.factory, second.id);
    expect(wo.status).toBe("completed");
    expect(second.platform.sessions.get(second.releaseSession)!.prompts[0]).toContain("Your previous turn was interrupted");
  });

  it("detaches on shutdown without failing work, and resumes it on the next start", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const gated: Script = async (session, prompt, platform) => {
      await opened;
      await builder()(session, prompt, platform);
    };
    const first = setup({ planner, builder: gated, reviewer, release });
    const created = first.factory.create(CREATE);
    while (first.factory.get(created.id)?.status !== "building" || first.platform.sessionsFor("builder").length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = first.factory.stop();
    gate();
    await stopping;
    expect(store.getWorkOrder(created.id)?.status).toBe("building");

    hub.close();
    const second = setup({ planner, builder: builder(), reviewer, release }, store);
    for (const [map, source] of [
      [second.platform.sessions, first.platform.sessions],
      [second.platform.outputs, first.platform.outputs],
      [second.platform.workspaces, first.platform.workspaces],
    ] as const) for (const [key, value] of source as Map<string, never>) (map as Map<string, never>).set(key, value);
    second.factory.resumeInterrupted();
    const wo = await settle(second.factory, created.id);
    expect(wo.status).toBe("completed");
    // The builders reattached to their original sandboxes instead of provisioning new ones.
    const original = first.platform.sessionsFor("builder").map((session) => session.sessionId).sort();
    expect(wo.stations.filter((station) => station.kind === "build").map((station) => station.sessionId).sort()).toEqual(original);
    expect(wo.stations.filter((station) => station.kind === "build").every((station) => !station.previousSessionIds)).toBe(true);
  });

  it("starts a fresh sandbox when the old one is gone, and reviews the new build", async () => {
    const failing = builder({ failing: true });
    const { platform, factory } = setup({ planner, builder: failing, reviewer, release });
    const created = factory.create(CREATE);
    expect((await settle(factory, created.id)).status).toBe("failed");
    for (const session of platform.sessionsFor("builder")) platform.lost.add(session.sessionId);
    platform.scripts.builder = builder();
    factory.retry(created.id);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    const builds = wo.stations.filter((station) => station.kind === "build");
    expect(builds.every((station) => station.previousSessionIds?.length === 1)).toBe(true);
    const index = factory.artifactIndex(created.id);
    const report = index.files.find((file) => file.stationId === "build:json2csv" && file.path === "test-report.json")!;
    expect(report.versions.map((version) => version.version)).toEqual([1]);
    expect(factory.activity(created.id).some((item) => item.text?.includes("starting a fresh sandbox"))).toBe(true);
  });

  it("reconciles finished work orders with the platform's session list", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    const created = factory.create(CREATE);
    await settle(factory, created.id);
    const releaseSession = factory.get(created.id)!.stations.find((station) => station.id === "release")!.sessionId!;
    platform.lost.add(releaseSession);
    await factory.reconcileSessions();
    const wo = factory.get(created.id)!;
    expect(wo.stations.find((station) => station.id === "release")!.sessionState).toBe("deleted");
    expect(wo.stations.find((station) => station.id === "build:csv2json")!.sessionState).toBe("idle");
  });

  it("only marks a session deleted when the platform says it's gone, not when the list is capped", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    const created = factory.create(CREATE);
    await settle(factory, created.id);
    const releaseSession = factory.get(created.id)!.stations.find((station) => station.id === "release")!.sessionId!;
    platform.lost.add(releaseSession);
    platform.listLimit = 1;
    await factory.reconcileSessions();
    const wo = factory.get(created.id)!;
    expect(wo.stations.find((station) => station.id === "release")!.sessionState).toBe("deleted");
    for (const station of wo.stations.filter((candidate) => candidate.id !== "release")) expect(station.sessionState, station.id).toBe("idle");
  });

  it("gives a retried station's new session its own state instead of the old session's", async () => {
    const { platform, factory } = setup({ planner, builder: builder({ failing: true }), reviewer, release });
    const created = factory.create(CREATE);
    expect((await settle(factory, created.id)).status).toBe("failed");
    for (const session of platform.sessionsFor("builder")) platform.lost.add(session.sessionId);
    await factory.reconcileSessions();
    expect(factory.get(created.id)!.stations.filter((station) => station.kind === "build").every((station) => station.sessionState === "deleted")).toBe(true);

    platform.scripts.builder = builder();
    factory.retry(created.id);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    for (const station of wo.stations.filter((candidate) => candidate.kind === "build")) {
      expect(station.previousSessionIds).toHaveLength(1);
      expect(station.sessionState, station.id).toBe("idle");
      expect(station.sessionGone, station.id).toBeUndefined();
    }
  });

  it("rechecks deletion markers it didn't confirm, and stops looking up confirmed ones", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    const created = factory.create(CREATE);
    await settle(factory, created.id);
    await factory.reconcileSessions();
    // As an earlier reconciler persisted it for a session that was merely missing from a capped list.
    const stored = store.getWorkOrder(created.id)!;
    const releaseSession = stored.stations.find((station) => station.id === "release")!.sessionId!;
    Object.assign(stored.stations.find((station) => station.id === "release")!, { sessionState: "deleted" });
    store.saveWorkOrder(stored);
    platform.listLimit = 0;
    const lookups = vi.spyOn(platform, "sessionInfo");

    await factory.reconcileSessions();
    expect(factory.get(created.id)!.stations.find((station) => station.id === "release")!.sessionState).toBe("idle");

    platform.lost.add(releaseSession);
    await factory.reconcileSessions();
    expect(factory.get(created.id)!.stations.find((station) => station.id === "release")).toMatchObject({ sessionState: "deleted", sessionGone: true });

    lookups.mockClear();
    await factory.reconcileSessions();
    expect(lookups.mock.calls.map(([sessionId]) => sessionId)).not.toContain(releaseSession);
    expect(factory.get(created.id)!.stations.find((station) => station.id === "release")!.sessionState).toBe("deleted");
  });

  it("tells each artifact version apart: kept text or not stored", async () => {
    const growing: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      const fix = prompt.includes("requested changes");
      platform.publish(session.sessionId, { "data.txt": fix ? "x".repeat(1024 * 1024 + 1) : "small" });
    };
    const { factory } = setup({ planner, builder: growing, reviewer, release });
    const created = factory.create(CREATE);
    expect((await settle(factory, created.id)).status).toBe("completed");
    const file = factory.artifactIndex(created.id).files.find((candidate) => candidate.stationId === "build:csv2json" && candidate.path === "data.txt")!;
    expect(file.versions.map((version) => [version.version, version.viewable])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(file.viewable).toBe(false);
    expect(factory.artifact(created.id, "build:csv2json", "data.txt", 1)?.content).toBe("small");
  });

  it("pauses a work order whose platform connection drops, then resumes it from its checkpoint", async () => {
    let ready = true;
    let dropped = false;
    // The turn runs to completion on the platform, but the factory loses the connection before it hears back.
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "csv2json") {
        dropped = true;
        ready = false;
        throw new Error("Session disconnected while waiting for a response");
      }
    };
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { readiness: () => ({ ready }), resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    await until(() => dropped && !factory.isActive(created.id));

    const paused = factory.get(created.id)!;
    expect(paused.status).toBe("building");
    const build = paused.stations.find((station) => station.id === "build:csv2json")!;
    expect(build).toMatchObject({ status: "waiting", detail: "Paused until Managed Copilot is back" });
    expect(paused.stations.filter((station) => station.status === "failed")).toEqual([]);

    // The platform is back: main.ts resumes interrupted work orders when it reports ready again.
    ready = true;
    factory.resumeInterrupted();
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    const resumed = wo.stations.find((station) => station.id === "build:csv2json")!;
    expect(resumed.sessionId).toBe(build.sessionId);
    expect(resumed.previousSessionIds).toBeUndefined();
    const texts = factory.activity(created.id).map((item) => item.text ?? "");
    expect(texts.some((text) => text.startsWith("Paused: lost the connection to Managed Copilot (Session disconnected"))).toBe(true);
    expect(texts).toContain("Managed Copilot is back; resuming from the last checkpoint");
  });

  it("resumes a paused work order by itself when only its transport dropped", async () => {
    let dropped = false;
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "json2csv") {
        dropped = true;
        throw new Error("CLI server exited with code 1\n[managed-copilot] Managed Copilot closed the connection: gateway shutting down (close code 1001)");
      }
    };
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(dropped).toBe(true);
    expect(wo.stations.find((station) => station.id === "build:json2csv")!.previousSessionIds).toBeUndefined();
    expect(factory.activity(created.id).some((item) => item.text?.includes("(Managed Copilot closed the connection: gateway shutting down (close code 1001))"))).toBe(true);
  });

  it("fails a work order that keeps losing its connection instead of pausing forever", async () => {
    const dropping: Script = async (session, prompt, platform) => {
      if (taskOf(platform, session).id === "csv2json") throw new Error("Session disconnected while waiting for a response");
      await builder()(session, prompt, platform);
    };
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { resumeBackoffMs: 1 });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id, 10_000);
    expect(wo.status).toBe("failed");
    expect(wo.error?.code).toBe("interrupted");
    expect(wo.stations.find((station) => station.id === "build:csv2json")!.status).toBe("failed");
    expect(factory.activity(created.id).filter((item) => item.text?.startsWith("Paused:")).length).toBe(5);
  });

  it("fails with its sandbox intact when it runs out of pauses while reattaching", async () => {
    const lostAgain = () => new Error("Session disconnected while waiting for a response");
    let dropped = false;
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "csv2json") {
        dropped = true;
        // Every reattach that follows loses the connection again.
        platform.resumeErrors.push(...Array.from({ length: 5 }, lostAgain));
        throw lostAgain();
      }
    };
    const { platform, factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { resumeBackoffMs: 1 });
    const created = factory.create(CREATE);
    await until(() => dropped);
    const original = factory.get(created.id)!.stations.find((station) => station.id === "build:csv2json")!.sessionId;
    const wo = await settle(factory, created.id, 10_000);
    expect(wo.status).toBe("failed");
    const build = wo.stations.find((station) => station.id === "build:csv2json")!;
    expect(build.sessionId).toBe(original);
    expect(build.previousSessionIds).toBeUndefined();
    expect(platform.sessionsFor("builder")).toHaveLength(2);
    expect(factory.activity(created.id).some((item) => item.text?.includes("starting a fresh sandbox"))).toBe(false);
  });

  it("ignores late events from a session it let go of", async () => {
    let dropped: FakeSession | undefined;
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "csv2json") {
        dropped = session;
        throw new Error("Session disconnected while waiting for a response");
      }
    };
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    expect((await settle(factory, created.id)).status).toBe("completed");
    // The detach was never answered, so the old session can still deliver events.
    dropped!.emit("assistant.usage", { model: "fake", inputTokens: 5, outputTokens: 5, duration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const stored = store.getWorkOrder(created.id)!;
    expect(stored.status).toBe("completed");
    expect(stored.release).toBeDefined();
  });

  it("pauses, rather than fails, when the platform cancels a review's completion wait", async () => {
    let cancelled = false;
    const flaky: Script = async (session, prompt, platform) => {
      if (!cancelled && prompt.includes('"csv2json: CSV to JSON" (round 1')) {
        cancelled = true;
        // What the runtime answers when its gateway shuts down mid-turn.
        throw new Error("Completion wait cancelled");
      }
      await reviewer(session, prompt, platform);
    };
    const { factory } = setup({ planner, builder: builder(), reviewer: flaky, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id);
    expect(cancelled).toBe(true);
    expect(wo.status).toBe("completed");
    expect(factory.activity(created.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (Completion wait cancelled)"))).toBe(true);
  });

  it("pauses, rather than fails, when the gateway ends a turn whose runtime connection it lost", async () => {
    let lost = false;
    const cut: Script = async (session, prompt, platform) => {
      if (!lost && taskOf(platform, session).id === "csv2json") {
        lost = true;
        // The turn's `session.error`, as its completion wait sees it: a message and no platform code.
        throw Object.assign(
          new Error("Managed Copilot lost the connection to the session's runtime before this message's answer arrived. Check the session before sending again."),
          { code: -32603, data: { completionEventId: "evt_1" } },
        );
      }
      await builder()(session, prompt, platform);
    };
    const { factory } = setup({ planner, builder: cut, reviewer, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id);
    expect(lost).toBe(true);
    expect(wo.status).toBe("completed");
    expect(wo.stations.find((station) => station.id === "build:csv2json")!.previousSessionIds).toBeUndefined();
    expect(factory.activity(created.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (Managed Copilot lost the connection"))).toBe(true);
  });

  it("pauses, rather than fails, when a turn runs into the gateway's registration deadline", async () => {
    let timedOut = false;
    const stalled: Script = async (session, prompt, platform) => {
      if (!timedOut && taskOf(platform, session).id === "json2csv") {
        timedOut = true;
        // The runtime never answered a step that readies the session for this turn: not the agent's own timeout.
        throw Object.assign(
          new Error(`The runtime of session ${session.sessionId} did not answer session.resume within 1 minute and its connection stopped responding, so the gateway closed it. Try again; the session reconnects. [timeout]`),
          { code: -32001, data: { code: "timeout", details: { sessionId: session.sessionId, step: "session.resume" } } },
        );
      }
      await builder()(session, prompt, platform);
    };
    const { factory } = setup({ planner, builder: stalled, reviewer, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id);
    expect(timedOut).toBe(true);
    expect(wo.status).toBe("completed");
    expect(factory.activity(created.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (The runtime of session"))).toBe(true);
  });

  it("pauses, keeping the sandbox, when reattaching runs into the gateway's or the SDK's deadline", async () => {
    let dropped = false;
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "csv2json") {
        dropped = true;
        // The next two reattaches run out of time: a registration step the runtime never answered, then a request the
        // SDK gave up on in transit.
        platform.resumeErrors.push(
          Object.assign(
            new Error(`The runtime of session ${session.sessionId} did not answer session.resume within 1 minute and its connection stopped responding, so the gateway closed it. Try again; the session reconnects. [timeout]`),
            { code: -32001, data: { code: "timeout", details: { sessionId: session.sessionId, step: "session.resume" } } },
          ),
          new ManagedCopilotError("timeout", "The Managed Copilot deployment did not answer POST /v1/connect within 30 s. It may be restarting or unreachable; try again shortly.", {
            method: "POST",
            path: "/v1/connect",
            timeoutMs: 30_000,
            stage: "answer",
          }),
        );
        throw new Error("Session disconnected while waiting for a response");
      }
    };
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    await until(() => dropped);
    const original = factory.get(created.id)!.stations.find((station) => station.id === "build:csv2json")!.sessionId;
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    const build = wo.stations.find((station) => station.id === "build:csv2json")!;
    expect(build.sessionId).toBe(original);
    expect(build.previousSessionIds).toBeUndefined();
    const activity = factory.activity(created.id);
    expect(activity.some((item) => item.text?.includes("starting a fresh sandbox"))).toBe(false);
    expect(activity.filter((item) => item.text?.startsWith("Paused:")).map((item) => item.text)).toEqual([
      expect.stringContaining("(Session disconnected while waiting for a response)"),
      expect.stringContaining("did not answer session.resume within 1 minute"),
      expect.stringContaining("did not answer POST /v1/connect within 30 s"),
    ]);
  });

  it("keeps a user's cancel a cancel, even when the turn reports a cancelled completion wait", async () => {
    let reviewing = false;
    const waiting: Script = async (session, prompt, platform) => {
      if (!prompt.includes('"csv2json: CSV to JSON"')) return reviewer(session, prompt, platform);
      session.abortError = new Error("Completion wait cancelled");
      reviewing = true;
      await new Promise(() => undefined);
    };
    const { factory } = setup({ planner, builder: builder(), reviewer: waiting, release }, undefined, { resumeBackoffMs: 10 });
    const created = factory.create(CREATE);
    await until(() => reviewing);
    await factory.cancel(created.id);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("cancelled");
    expect(factory.activity(created.id).some((item) => item.text?.startsWith("Paused:"))).toBe(false);
  });

  it("pauses on an error it doesn't recognize while the platform doesn't answer, and fails on it when the platform does", async () => {
    const strange: (count: number) => Script = (count) => {
      let thrown = 0;
      return async (session, prompt, platform) => {
        if (thrown < count && taskOf(platform, session).id === "csv2json") {
          thrown++;
          throw new Error("The runtime went away");
        }
        await builder()(session, prompt, platform);
      };
    };
    // The platform doesn't answer when the error happens (it starts reconnecting), then answers again.
    let answers = false;
    const outage = setup({ planner, builder: strange(1), reviewer, release }, undefined, {
      resumeBackoffMs: 10,
      checkPlatform: async () => {
        const result = answers;
        answers = true;
        return result;
      },
    });
    const paused = outage.factory.create(CREATE);
    expect((await settle(outage.factory, paused.id)).status).toBe("completed");
    expect(outage.factory.activity(paused.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (The runtime went away)"))).toBe(true);

    const healthy = setup({ planner, builder: strange(1), reviewer, release }, undefined, { checkPlatform: async () => true });
    const failed = healthy.factory.create(CREATE);
    const wo = await settle(healthy.factory, failed.id);
    expect(wo.status).toBe("failed");
    expect(wo.stations.find((station) => station.id === "build:csv2json")!.error?.message).toBe("The runtime went away");
  });

  it("doesn't replace a sandbox when the work order is cancelled while the platform is being checked", async () => {
    const probes: ((answer: boolean) => void)[] = [];
    let deferProbes = false;
    const { platform, factory } = setup({ planner, builder: builder({ failing: true }), reviewer, release }, undefined, {
      checkPlatform: () => (deferProbes ? new Promise<boolean>((resolve) => probes.push(resolve)) : Promise.resolve(true)),
    });
    const created = factory.create(CREATE);
    expect((await settle(factory, created.id)).status).toBe("failed");
    const builds = () => factory.get(created.id)!.stations.filter((station) => station.kind === "build");
    const sessions = builds().map((station) => station.sessionId);
    const artifacts = factory.artifactIndex(created.id).files.length;
    for (const session of platform.sessionsFor("builder")) platform.lost.add(session.sessionId);
    platform.scripts.builder = builder();
    deferProbes = true;
    factory.retry(created.id);
    // Both reattaches failed, and the factory is checking the platform before starting over.
    await until(() => probes.length === 2);
    const cancelling = factory.cancel(created.id);
    for (const resolve of probes) resolve(true);
    await cancelling;
    expect((await settle(factory, created.id)).status).toBe("cancelled");
    expect(builds().map((station) => station.sessionId)).toEqual(sessions);
    expect(builds().every((station) => !station.previousSessionIds)).toBe(true);
    expect(factory.artifactIndex(created.id).files.length).toBe(artifacts);
    expect(platform.sessionsFor("builder")).toHaveLength(2);
  });

  it("keeps a failed platform check's verdict, even when the platform is back before the station gives up", async () => {
    let dropped = false;
    const dropping: Script = async (session, prompt, platform) => {
      await builder()(session, prompt, platform);
      if (!dropped && taskOf(platform, session).id === "csv2json") {
        dropped = true;
        platform.resumeErrors.push(new Error("The runtime went away"));
        throw new Error("Session disconnected while waiting for a response");
      }
    };
    // Resuming finds the platform answering; the failed reattach finds it down; after that it's back for good.
    const answers = [true, false];
    const { factory } = setup({ planner, builder: dropping, reviewer, release }, undefined, {
      resumeBackoffMs: 10,
      checkPlatform: async () => answers.shift() ?? true,
    });
    const created = factory.create(CREATE);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(answers).toEqual([]);
    expect(factory.activity(created.id).some((item) => item.text?.startsWith("Paused: lost the connection to Managed Copilot (The runtime went away)"))).toBe(true);
  });

  it("leaves files a builder deleted in a later round out of the release", async () => {
    const shrinking: Script = async (session, prompt, platform) => {
      const task = taskOf(platform, session);
      const fix = prompt.includes("requested changes");
      const files = fix ? task.files.filter((file) => file !== "src/csv.js") : task.files;
      platform.publish(session.sessionId, {
        ...Object.fromEntries(files.map((file) => [`files/${file}`, `// ${task.id} ${file}${fix ? " (fixed)" : ""}`])),
        "test-report.json": testReport(3) + " ".repeat(session.prompts.length),
        "manifest.json": manifest(files),
      });
    };
    const { platform, factory } = setup({ planner, builder: shrinking, reviewer, release });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    const releaseWorkspace = platform.workspaces.get(platform.sessionsFor("release")[0]!.sessionId)!;
    expect(releaseWorkspace.has("src/csv.js")).toBe(false);
    expect(releaseWorkspace.get("bin/csv2json.js")).toBe("// csv2json bin/csv2json.js (fixed)");
  });

  it("retries transient artifact downloads instead of dropping the file", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    platform.readFailures.set("files/src/csv.js", 2);
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    expect(factory.artifact(wo.id, "build:csv2json", "files/src/csv.js", 1)?.content).toBe("// csv2json src/csv.js");
  });

  it("repairs an interrupted seed on retry before the first prompt", async () => {
    const { platform, factory } = setup({ planner, builder: builder(), reviewer, release });
    platform.writeFailures.set(".factory/task.json", 1);
    const created = factory.create(CREATE);
    const failed = await settle(factory, created.id);
    expect(failed.status).toBe("failed");
    const unseeded = failed.stations.find((station) => station.kind === "build" && station.seeded === false)!;
    factory.retry(created.id);
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(platform.workspaces.get(unseeded.sessionId!)!.has(".factory/task.json")).toBe(true);
    expect(wo.stations.find((station) => station.id === unseeded.id)!.sessionId).toBe(unseeded.sessionId);
  });

  it("seeds a dependency chain's ancestors into the last task", async () => {
    const chain = {
      ...PLAN,
      bin: {},
      tasks: [
        { id: "a", title: "A", description: "A", files: ["src/a.js", "test/a.test.js"], acceptance: ["a"], dependsOn: [] },
        { id: "b", title: "B", description: "B", files: ["src/b.js", "test/b.test.js"], acceptance: ["b"], dependsOn: ["a"] },
        { id: "c", title: "C", description: "C", files: ["src/c.js", "test/c.test.js"], acceptance: ["c"], dependsOn: ["b"] },
      ],
    };
    const { platform, factory } = setup({ planner: async (session) => void (await session.callTool("submit_plan", chain)), builder: builder(), reviewer, release });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    const last = platform.sessionsFor("builder").find((session) => taskOf(platform, session).id === "c")!;
    const workspace = platform.workspaces.get(last.sessionId)!;
    expect(workspace.has("src/a.js")).toBe(true);
    expect(workspace.has("src/b.js")).toBe(true);
  });

  it("doesn't accept a test report where every test was skipped", async () => {
    const skipping: Script = async (session, prompt, platform) => {
      if (prompt.includes("check did not pass")) return builder()(session, prompt, platform);
      const task = taskOf(platform, session);
      const report = JSON.parse(testReport(0));
      report.summary = { total: 2, passed: 0, failed: 0, skipped: 2 };
      platform.publish(session.sessionId, {
        ...Object.fromEntries(task.files.map((file) => [`files/${file}`, `// ${task.id}`])),
        "test-report.json": JSON.stringify(report) + " ".repeat(session.prompts.length),
        "manifest.json": manifest(task.files),
      });
    };
    const { platform, factory } = setup({ planner, builder: skipping, reviewer, release });
    const wo = await settle(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    expect(platform.sessionsFor("builder")[0]!.prompts.some((prompt) => prompt.includes("every test was skipped"))).toBe(true);
  });
});
