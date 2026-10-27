import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EventHub } from "../src/server/hub.js";
import { builderName, taskStart, WORKER_READY_TASK } from "../src/server/pipeline/coordinator.js";
import { Factory, type FactoryOptions } from "../src/server/pipeline/factory.js";
import { FactoryStore } from "../src/server/store.js";
import type { Plan, WorkOrder } from "../src/shared/types.js";
import { manifest, testReport, type FakeSession, type Script } from "./fakes.js";
import { WorkerPlatform } from "./worker-platform.js";

const PLAN: Plan = {
  summary: "Two independent commands.", projectName: "csvjson", packageDescription: "CSV and JSON conversion",
  bin: { csv2json: "bin/csv2json.js", json2csv: "bin/json2csv.js" },
  tasks: ["csv2json", "json2csv"].map((id) => ({
    id, title: id, description: `Build ${id}`, files: [`bin/${id}.js`, `test/${id}.test.js`],
    acceptance: ["Converts quoted fields correctly"], dependsOn: [],
  })),
  integration: "Test a round trip through both commands.",
};
const CREATE = { title: "CSV toolkit", brief: "Build a CSV and JSON conversion toolkit with tests and independent review." };
const hubs: EventHub[] = [];
const factories: Factory[] = [];
const stores: FactoryStore[] = [];

function setup(scripts: Partial<Record<"planner" | "builder" | "reviewer" | "release" | "coordinator", Script>> = {}, store?: FactoryStore, platform?: WorkerPlatform) {
  const db = store ?? new FactoryStore(":memory:");
  if (!store) stores.push(db);
  const hub = new EventHub(60_000);
  hubs.push(hub);
  const fake = platform ?? new WorkerPlatform({ ...scriptsFor(), ...scripts });
  const config: FactoryOptions["config"] = {
    maxSandboxes: 4, publicationTimeoutMs: 1_000,
    turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000, coordinator: 10_000 },
  };
  const factory = new Factory({ store: db, hub, platform: fake, config, pollMs: 5, readiness: () => ({ ready: true }), account: () => undefined });
  factories.push(factory);
  return { factory, platform: fake, store: db };
}

afterEach(async () => {
  await Promise.all(factories.splice(0).map((factory) => factory.stop()));
  for (const hub of hubs.splice(0)) hub.close();
  for (const store of stores.splice(0)) store.close();
});

async function until(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the factory checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settled(factory: Factory, id: string): Promise<WorkOrder> {
  await until(() => !factory.isActive(id) && ["completed", "failed", "cancelled"].includes(factory.get(id)!.status));
  return factory.get(id)!;
}

const GateSchema = z.object({
  ok: z.boolean(), fatal: z.boolean().optional(), ready: z.boolean().optional(), accepted: z.boolean().optional(),
  message: z.string().optional(), summary: z.string(),
  copies: z.array(z.object({ from: z.string(), to: z.string(), paths: z.array(z.string()), destination: z.string() })).optional(),
}).passthrough();
type Gate = z.infer<typeof GateSchema>;

async function gate(session: FakeSession, name: string, args: unknown = {}): Promise<Gate> {
  const result = z.object({ textResultForLlm: z.string() }).parse(await session.callTool(name, args));
  return GateSchema.parse(JSON.parse(result.textResultForLlm));
}

function scriptsFor(): Record<"planner" | "builder" | "reviewer" | "release" | "coordinator", Script> {
  return {
    planner: async (session) => { await session.callTool("submit_plan", PLAN); },
    builder: async (session, prompt, platform) => {
      const task = z.object({ id: z.string(), files: z.array(z.string()) }).parse(JSON.parse(platform.workspaces.get(session.sessionId)!.get(".factory/task.json")!));
      platform.publish(session.sessionId, {
        ...Object.fromEntries(task.files.map((path) => [`files/${path}`, `// ${path} ${prompt.includes("requested changes") ? "fixed" : "initial"}`])),
        "test-report.json": testReport(3) + " ".repeat(session.prompts.length),
        "manifest.json": manifest(task.files),
      });
    },
    reviewer: async (session, prompt) => {
      const changes = prompt.includes('"csv2json: csv2json" (round 1');
      await session.callTool("submit_review", {
        verdict: changes ? "request_changes" : "approve", summary: changes ? "Handle quoted newlines." : "Looks good.",
        findings: changes ? [{ severity: "major", file: "bin/csv2json.js", message: "Handle newlines inside quotes." }] : [],
      });
    },
    release: async (session, _prompt, platform) => {
      const files = [...platform.workspaces.get(session.sessionId)!].filter(([path]) => !path.startsWith(".factory/"));
      platform.publish(session.sessionId, {
        ...Object.fromEntries(files.map(([path, content]) => [`bundle/${path}`, content])),
        "test-report.json": testReport(7, 0, "release") + " ".repeat(session.prompts.length),
        "manifest.json": manifest(files.map(([path]) => path), "release"),
        "project.patch": "diff --git a/bin/csv2json.js b/bin/csv2json.js\n",
        "RELEASE.md": "# Released\n\nReviewed and tested.",
      });
    },
    coordinator: async (session, _prompt, platform) => coordinate(session, platform as WorkerPlatform),
  };
}

async function coordinate(session: FakeSession, platform: WorkerPlatform): Promise<void> {
  for (const task of PLAN.tasks) {
    const ref = builderName(task.id);
    let worker = (await platform.workers(session.sessionId).list()).filter((item) => item.name === ref).at(-1);
    if (!worker || worker.state === "stopped") {
      await session.callTool("start_worker", taskStart(task, platform.models.builder));
      worker = await platform.workers(session.sessionId).get(ref);
    }
    if (worker.messages === 1) {
      const prepared = await gate(session, "prepare_workspace", { taskId: task.id, worker: ref });
      if (prepared.fatal) return;
      expect(prepared.ready).toBe(true);
      await session.callTool("message_worker", { worker: ref, message: prepared.message! });
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      await session.callTool("wait_for_workers", { workers: [ref] });
      const check = await gate(session, "check_build", { taskId: task.id });
      if (check.fatal) return;
      if (!check.ok) {
        await session.callTool("message_worker", { worker: ref, message: check.message! });
        continue;
      }
      const review = await gate(session, "request_review", { taskId: task.id });
      if (review.fatal) return;
      if (review.accepted) break;
      await session.callTool("message_worker", { worker: ref, message: review.message! });
    }
  }
  let release = (await platform.workers(session.sessionId).list()).filter((item) => item.name === "release").at(-1);
  if (!release || release.state === "stopped") {
    await session.callTool("start_worker", { name: "release", environment: "factory-release", agent: "release", model: platform.models.release, task: WORKER_READY_TASK });
    release = await platform.workers(session.sessionId).get("release");
  }
  if (release.messages === 1) {
    let prepared = await gate(session, "prepare_release", { worker: "release" });
    if (prepared.fatal) return;
    if (!prepared.ready) {
      for (const copy of prepared.copies!) await session.callTool("copy_worker_files", copy);
      prepared = await gate(session, "prepare_release", { worker: "release" });
    }
    expect(prepared.ready).toBe(true);
    await session.callTool("message_worker", { worker: "release", message: prepared.message! });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await session.callTool("wait_for_workers", { workers: ["release"] });
    const check = await gate(session, "check_release");
    if (check.fatal || check.accepted) return;
    await session.callTool("message_worker", { worker: "release", message: check.message! });
  }
}

describe("agent-led factory", () => {
  it("defaults to agent-led, creates workers, reuses a builder for review fixes, and verifies copied release inputs", async () => {
    const { factory, platform } = setup();
    const work = factory.create(CREATE);
    const wo = await settled(factory, work.id);
    expect(wo.error).toBeUndefined();
    expect(wo.mode).toBe("agent");
    expect(wo.status).toBe("completed");
    expect(wo.release?.tests).toMatchObject({ passed: 7, failed: 0 });
    expect(platform.workerRecords.size).toBe(3);
    const builder = wo.stations.find((station) => station.id === "build:csv2json")!;
    expect(builder.round).toBe(2);
    expect(builder.worker?.messages).toBe(3); // readiness, build, review fixes
    expect(builder.previousSessionIds).toBeUndefined();
    expect(wo.stations.find((station) => station.id === "coordinator")).toMatchObject({ status: "done", placement: "shared", environment: "factory-coordinator" });
    expect(platform.resumed.filter((item) => platform.workerIds.includes(item.id))).toHaveLength(0);
    expect(platform.copies).toHaveLength(2);
    expect(platform.copies.every((copy) => copy.paths[0] === "outputs/files")).toBe(true);
    expect(factory.releaseFiles(wo.id)?.files.some((file) => file.path === "csvjson/bin/csv2json.js" && file.content.includes("fixed"))).toBe(true);
    const decisions = factory.activity(wo.id, "coordinator").filter((item) => item.kind === "decision");
    expect(decisions.filter((item) => item.decision?.tag === "new")).toHaveLength(3);
    expect(decisions.some((item) => item.decision?.tag === "reused" && item.text?.includes("builder-csv2json"))).toBe(true);
    expect(decisions.some((item) => item.text?.includes("7 tests pass"))).toBe(true);
  });

  it("refuses early release, wrong environments, missing preparation, and review before a passing check", async () => {
    let refusals = 0;
    const { factory } = setup({
      coordinator: async (session, _prompt, platform) => {
        for (const args of [
          { name: "release", environment: "factory-release", agent: "release", model: platform.models.release, task: WORKER_READY_TASK },
          { ...taskStart(PLAN.tasks[0]!, platform.models.builder), environment: "factory-reviewer" },
          { ...taskStart(PLAN.tasks[0]!, platform.models.builder), task: "Start building without seeded inputs" },
        ]) {
          await expect(session.callTool("start_worker", args)).rejects.toThrow();
          refusals++;
        }
        await session.callTool("start_worker", taskStart(PLAN.tasks[0]!, platform.models.builder));
        expect((await gate(session, "check_build", { taskId: "csv2json" })).ok).toBe(false);
        expect((await gate(session, "request_review", { taskId: "csv2json" })).ok).toBe(false);
        await coordinate(session, platform as WorkerPlatform);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    expect(refusals).toBe(3);
  });

  it("requires a fresh test report after fixes and makes repeated checks idempotent", async () => {
    const defaults = scriptsFor();
    const { factory, platform } = setup({
      builder: async (session, prompt, fake) => {
        if (prompt.includes("requested changes")) {
          fake.publish(session.sessionId, { "files/bin/csv2json.js": "// changed without re-running checks" });
          return;
        }
        await defaults.builder(session, prompt, fake);
      },
      coordinator: async (session, prompt, fake) => {
        const original = session.callTool.bind(session);
        session.callTool = async (name, args) => {
          const first = await original(name, args);
          if (name === "check_build") expect(await original(name, args)).toEqual(first);
          return first;
        };
        await defaults.coordinator(session, prompt, fake);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    const builder = wo.stations.find((station) => station.id === "build:csv2json")!;
    expect(builder.round).toBe(2);
    expect(platform.sessions.get(builder.sessionId!)?.prompts.some((prompt) => prompt.includes("wasn't run after the latest changes"))).toBe(true);
  });

  it("bounds review rounds and passes open findings to release metadata", async () => {
    const { factory, platform } = setup();
    const wo = await settled(factory, factory.create({ ...CREATE, maxReviewRounds: 1 }).id);
    expect(wo.status).toBe("completed");
    expect(wo.stations.find((station) => station.id === "review:csv2json")?.acceptedWithFindings).toBe(true);
    const release = wo.stations.find((station) => station.id === "release")!;
    expect(platform.workspaces.get(release.sessionId!)?.get(".factory/REVIEWS.md")).toContain("findings from the last round are still open");
    expect(wo.stations.find((station) => station.id === "build:csv2json")?.worker?.messages).toBe(2);
  });

  it("fails after the bounded check nudges and does not create a release for failing builds", async () => {
    const { factory, platform } = setup({
      builder: async (session, _prompt, fake) => fake.publish(session.sessionId, {
        "test-report.json": testReport(0, 1) + " ".repeat(session.prompts.length),
        "manifest.json": manifest(["bin/csv2json.js"]),
        "files/bin/csv2json.js": "// broken",
      }),
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("failed");
    expect(wo.error?.code).toBe("tests_failed");
    expect(platform.sessionsFor("builder")[0]?.prompts).toHaveLength(4); // readiness, work, two nudges
    expect(platform.sessionsFor("release")).toHaveLength(0);
    expect([...platform.workerRecords.values()].every((worker) => worker.state === "stopped")).toBe(true);
  });

  it("does not accept a coordinator's claim without factory gates", async () => {
    const { factory } = setup({ coordinator: async (session) => { session.say("Everything is done, all tests passed."); } });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("failed");
    expect(wo.release).toBeUndefined();
    expect(wo.error?.code).toBe("release_incomplete");
  });

  it("rejects a release without notes or a patch, despite passing tests", async () => {
    const defaults = scriptsFor();
    const { factory } = setup({
      release: async (session, prompt, fake) => {
        await defaults.release(session, prompt, fake);
        fake.outputs.get(session.sessionId)!.delete("RELEASE.md");
        fake.outputs.get(session.sessionId)!.delete("project.patch");
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("failed");
    expect(wo.error?.code).toBe("release_incomplete");
    expect(wo.release).toBeUndefined();
  });

  it("resumes the same coordinator and worker mapping after a factory restart during a build", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const defaults = scriptsFor();
    const first = setup({
      builder: async (session, prompt, fake) => { await blocked; await defaults.builder(session, prompt, fake); },
    });
    const created = first.factory.create(CREATE);
    await until(() => [...first.platform.workerRecords.values()].some((worker) => worker.messages === 2));
    const before = first.factory.get(created.id)!;
    const coordinatorId = before.stations.find((station) => station.id === "coordinator")!.sessionId!;
    const builderId = first.platform.workerIds[0]!;
    await first.factory.stop();
    expect(first.store.getWorkOrder(created.id)?.status).toBe("building");
    const second = setup({}, first.store, first.platform);
    second.factory.resumeInterrupted();
    await until(() => first.platform.resumed.some((item) => item.id === coordinatorId));
    finish();
    const wo = await settled(second.factory, created.id);
    expect(wo.error).toBeUndefined();
    expect(wo.status).toBe("completed");
    expect(wo.stations.find((station) => station.id === "coordinator")?.sessionId).toBe(coordinatorId);
    expect(wo.stations.find((station) => station.id === "build:csv2json")?.sessionId).toBe(builderId);
    expect(first.platform.sessionsFor("builder")).toHaveLength(2);
    expect(first.platform.resumed.every((item) => item.role === "coordinator" || item.role === "reviewer")).toBe(true);
  });

  it("cancels workers without attaching to them and retries from the saved plan", async () => {
    let blocked = true;
    const defaults = scriptsFor();
    const { factory, platform } = setup({
      builder: async (session, prompt, fake) => {
        if (blocked) await new Promise(() => {});
        await defaults.builder(session, prompt, fake);
      },
    });
    const created = factory.create(CREATE);
    await until(() => [...platform.workerRecords.values()].some((worker) => worker.messages === 2));
    await factory.cancel(created.id);
    const cancelled = await settled(factory, created.id);
    expect(cancelled.status).toBe("cancelled");
    expect([...platform.workerRecords.values()].every((worker) => worker.state === "stopped")).toBe(true);
    blocked = false;
    factory.retry(created.id);
    const retried = await settled(factory, created.id);
    expect(retried.error).toBeUndefined();
    expect(retried.status).toBe("completed");
    expect(platform.sessionsFor("planner")).toHaveLength(1);
    expect(platform.resumed.some((item) => platform.workerIds.includes(item.id))).toBe(false);
  });

  it("validates the mode and keeps legacy work orders classic", async () => {
    const { factory } = setup();
    expect(() => factory.create({ ...CREATE, mode: "invalid" as "agent" })).toThrow(/agent.*classic/);
    const classic = await settled(factory, factory.create({ ...CREATE, mode: "classic" }).id);
    expect(classic.status).toBe("completed");
    expect(classic.stations.some((station) => station.kind === "coordinate")).toBe(false);
    expect(classic.workersStarted).toBeUndefined();
  });
});
