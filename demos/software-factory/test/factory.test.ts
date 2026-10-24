import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { Factory } from "../src/server/pipeline/factory.js";
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

const CREATE = { title: "CSV ⇄ JSON toolkit", brief: "Build two command-line tools that convert between CSV and JSON, with tests." };

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

function setup(scripts: ConstructorParameters<typeof FakePlatform>[0], existingStore?: FactoryStore) {
  store = existingStore ?? new FactoryStore(":memory:");
  hub = new EventHub(60_000);
  const platform = new FakePlatform(scripts);
  const factory = new Factory({
    store,
    hub,
    platform,
    readiness: () => ({ ready: true }),
    account: () => ({ login: "octocat" }),
    config: { maxSandboxes: 4, turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000 }, publicationTimeoutMs: 1_000 },
    pollMs: 10,
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
    const first = setup({ planner, builder: builder(), reviewer, release });
    const created = first.factory.create(CREATE);
    await settle(first.factory, created.id);
    const stored = store.getWorkOrder(created.id)!;
    const releaseSession = stored.stations.find((station) => station.id === "release")!.sessionId!;
    store.saveWorkOrder({
      ...stored,
      status: "releasing",
      release: undefined,
      stations: stored.stations.map((station) =>
        station.id === "release" ? { ...station, status: "working", turn: { kind: "work", round: 1, sentAt: new Date().toISOString() } } : station,
      ),
    } as WorkOrder);
    hub.close();
    const second = setup({ planner, builder: builder(), reviewer, release }, store);
    for (const [map, source] of [
      [second.platform.sessions, first.platform.sessions],
      [second.platform.outputs, first.platform.outputs],
      [second.platform.workspaces, first.platform.workspaces],
    ] as const) for (const [key, value] of source as Map<string, never>) (map as Map<string, never>).set(key, value);
    second.platform.lastTurnStatus.set(releaseSession, "failed");
    second.factory.resumeInterrupted();
    const wo = await settle(second.factory, created.id);
    expect(wo.status).toBe("completed");
    expect(second.platform.sessions.get(releaseSession)!.prompts[0]).toContain("Your previous turn was interrupted");
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
});
