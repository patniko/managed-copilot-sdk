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
    const { factory, platform, store } = setup();
    const save = store.saveWorkOrder.bind(store);
    store.saveWorkOrder = (order) => {
      const release = order.stations.find((station) => station.kind === "release");
      if (release?.seeded) expect(release.inputRevision).toBeTruthy();
      save(order);
    };
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
    expect(platform.sessions.get(builder.sessionId!)?.prompts.some((prompt) => prompt.includes("wasn't run in the worker's latest turn"))).toBe(true);
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

  it("re-runs an interrupted review without replaying a builder's work", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const defaults = scriptsFor();
    const first = setup({ reviewer: async (session, prompt, fake) => { await blocked; await defaults.reviewer(session, prompt, fake); } });
    const created = first.factory.create(CREATE);
    await until(() => first.factory.get(created.id)?.stations.some((station) => station.kind === "review" && station.status === "working") ?? false);
    const builderId = first.platform.workerIds[0]!;
    const messages = first.platform.sessions.get(builderId)!.prompts.length;
    await first.factory.stop();
    const second = setup({}, first.store, first.platform);
    second.factory.resumeInterrupted();
    await until(() => first.platform.sessionsFor("reviewer").length >= 2);
    expect(first.platform.sessions.get(builderId)!.prompts).toHaveLength(messages);
    finish();
    const wo = await settled(second.factory, created.id);
    expect(wo.error).toBeUndefined();
    expect(wo.status).toBe("completed");
    const review = wo.stations.find((station) => station.id === "review:csv2json")!;
    expect(review.reviews?.map((record) => record.round)).toEqual([1, 2]);
    expect(wo.stations.find((station) => station.id === "build:csv2json")?.sessionId).toBe(builderId);
  });

  it("resumes a release worker in flight without copying or sending its work twice", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const defaults = scriptsFor();
    const first = setup({ release: async (session, prompt, fake) => { await blocked; await defaults.release(session, prompt, fake); } });
    const created = first.factory.create(CREATE);
    await until(() => [...first.platform.workerRecords.values()].some((worker) => worker.name === "release" && worker.messages === 2));
    const releaseId = [...first.platform.workerRecords.values()].find((worker) => worker.name === "release")!.id;
    const copies = first.platform.copies.length;
    await first.factory.stop();
    const second = setup({}, first.store, first.platform);
    second.factory.resumeInterrupted();
    finish();
    const wo = await settled(second.factory, created.id);
    expect(wo.error).toBeUndefined();
    expect(wo.status).toBe("completed");
    expect(wo.stations.find((station) => station.id === "release")?.sessionId).toBe(releaseId);
    expect(first.platform.sessions.get(releaseId)!.prompts).toHaveLength(2);
    expect(first.platform.copies).toHaveLength(copies);
  });

  it("verifies copied bytes rather than accepting a copy tool's claimed success", async () => {
    let rejected = false;
    const defaults = scriptsFor();
    const { factory } = setup({
      coordinator: async (session, prompt, fake) => {
        const platform = fake as WorkerPlatform;
        const original = session.callTool.bind(session);
        let preparations = 0;
        session.callTool = async (name, args) => {
          if (name === "prepare_release" && ++preparations === 2) {
            const release = await platform.workers(session.sessionId).get("release");
            platform.workspaces.get(release.id)!.set(".factory/incoming/csv2json/outputs/files/bin/csv2json.js", "not the reviewed build");
            const refused = z.object({ textResultForLlm: z.string() }).parse(await original(name, args));
            const result = GateSchema.parse(JSON.parse(refused.textResultForLlm));
            expect(result.ready).toBe(false);
            rejected = true;
            for (const copy of result.copies!) await original("copy_worker_files", copy);
          }
          return original(name, args);
        };
        await defaults.coordinator(session, prompt, platform);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.status).toBe("completed");
    expect(rejected).toBe(true);
    expect(factory.releaseFiles(wo.id)?.files.some((file) => file.content.includes("not the reviewed build"))).toBe(false);
  });

  it("does not cache a review of a builder that changed while the review was running", async () => {
    let concurrentChange = false;
    const defaults = scriptsFor();
    const { factory, platform } = setup({
      reviewer: async (session, prompt, fake) => {
        const p = fake as WorkerPlatform;
        if (!concurrentChange) {
          concurrentChange = true;
          const coordinator = p.sessionsFor("coordinator")[0]!;
          await coordinator.callTool("message_worker", { worker: "builder-csv2json", message: "Another change; run npm run check again." });
          await coordinator.callTool("wait_for_workers", { workers: ["builder-csv2json"] });
        }
        await defaults.reviewer(session, prompt, fake);
      },
      coordinator: async (session, prompt, fake) => {
        const original = session.callTool.bind(session);
        session.callTool = async (name, args) => {
          const result = await original(name, args);
          if (name !== "request_review") return result;
          const value = GateSchema.parse(JSON.parse(z.object({ textResultForLlm: z.string() }).parse(result).textResultForLlm));
          if (!value.ok && !value.fatal && value.summary.includes("changed during review")) {
            const checked = GateSchema.parse(JSON.parse(z.object({ textResultForLlm: z.string() }).parse(await original("check_build", args)).textResultForLlm));
            expect(checked.ok).toBe(true);
            return original(name, args);
          }
          return result;
        };
        await defaults.coordinator(session, prompt, fake);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.error).toBeUndefined();
    expect(wo.status).toBe("completed");
    expect(concurrentChange).toBe(true);
    expect(platform.sessionsFor("reviewer").flatMap((session) => session.prompts).filter((prompt) => prompt.includes('"csv2json: csv2json" (round 1'))).toHaveLength(2);
  });

  it("validates the mode and keeps legacy work orders classic", async () => {
    const { factory } = setup();
    expect(() => factory.create({ ...CREATE, mode: "invalid" as "agent" })).toThrow(/agent.*classic/);
    const classic = await settled(factory, factory.create({ ...CREATE, mode: "classic" }).id);
    expect(classic.status).toBe("completed");
    expect(classic.stations.some((station) => station.kind === "coordinate")).toBe(false);
    expect(classic.workersStarted).toBeUndefined();
  });

  it("rejects a previous unchecked turn's test report after another worker message", async () => {
    let injected = false;
    let refused = false;
    const defaults = scriptsFor();
    const { factory } = setup({
      builder: async (session, prompt, fake) => {
        if (prompt === "Unchecked edit") {
          fake.publish(session.sessionId, { "files/bin/csv2json.js": "// changed without a check" });
          return;
        }
        await defaults.builder(session, prompt, fake);
      },
      coordinator: async (session, prompt, fake) => {
        const original = session.callTool.bind(session);
        session.callTool = async (name, args) => {
          if (name === "check_build" && !injected) {
            injected = true;
            await original("message_worker", { worker: "builder-csv2json", message: "Unchecked edit" });
            await original("wait_for_workers", { workers: ["builder-csv2json"] });
            const result = await original(name, args);
            const reply = GateSchema.parse(JSON.parse(z.object({ textResultForLlm: z.string() }).parse(result).textResultForLlm));
            expect(reply.ok).toBe(false);
            expect(reply.summary).toContain("latest turn");
            refused = true;
            return result;
          }
          return original(name, args);
        };
        await defaults.coordinator(session, prompt, fake);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(wo.error).toBeUndefined();
    expect(wo.status).toBe("completed");
    expect(refused).toBe(true);
    expect(wo.stations.find((station) => station.id === "build:csv2json")?.workerCheck?.turnId).toBeTruthy();
  });

  it("revalidates builder acceptance after release artifact collection", async () => {
    let changed = false;
    let refused = false;
    const defaults = scriptsFor();
    const { factory } = setup({
      coordinator: async (session, prompt, fake) => {
        if (refused) return;
        const originalTool = session.callTool.bind(session);
        const originalArtifacts = fake.artifacts.bind(fake);
        fake.artifacts = (id) => {
          const artifacts = originalArtifacts(id);
          if (fake.sessions.get(id)?.role !== "release") return artifacts;
          return {
            ...artifacts,
            waitForPublication: async (options) => {
              const publication = await artifacts.waitForPublication(options);
              if (!changed) {
                changed = true;
                await originalTool("message_worker", { worker: "builder-csv2json", message: "Change the build again and run its check." });
                await originalTool("wait_for_workers", { workers: ["builder-csv2json"] });
              }
              return publication;
            },
          };
        };
        session.callTool = async (name, args) => {
          const result = await originalTool(name, args);
          if (name === "check_release") {
            const reply = GateSchema.parse(JSON.parse(z.object({ textResultForLlm: z.string() }).parse(result).textResultForLlm));
            expect(reply.ok).toBe(false);
            expect(reply.accepted).not.toBe(true);
            refused = true;
            return { resultType: "failure", textResultForLlm: JSON.stringify({ ...reply, fatal: true }) };
          }
          return result;
        };
        await defaults.coordinator(session, prompt, fake);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(refused).toBe(true);
    expect(wo.release).toBeUndefined();
    expect(wo.status).not.toBe("completed");
    expect(wo.stations.find((station) => station.id === "review:csv2json")?.status).not.toBe("done");
  });

  it("cancels a persisted coordinator before resumption, without attaching to workers", async () => {
    const first = setup({ builder: async () => { await new Promise(() => {}); } });
    const created = first.factory.create(CREATE);
    await until(() => [...first.platform.workerRecords.values()].some((worker) => worker.messages === 2));
    const coordinator = first.factory.get(created.id)!.stations.find((station) => station.kind === "coordinate")!.sessionId!;
    await first.factory.stop();
    expect(first.platform.lastTurnStatus.get(coordinator)).toBe("running");
    const second = setup({}, first.store, first.platform);
    const cancelling = second.factory.cancel(created.id);
    second.factory.resumeInterrupted();
    await expect(second.factory.delete(created.id)).rejects.toThrow(/cancelling/);
    const wo = await cancelling;
    expect(wo.status).toBe("cancelled");
    expect(first.platform.sessions.get(coordinator)?.aborted).toBe(true);
    expect(first.platform.lastTurnStatus.get(coordinator)).not.toBe("running");
    expect(first.platform.resumed).toEqual([{ role: "coordinator", id: coordinator }]);
    expect([...first.platform.workerRecords.values()].every((worker) => worker.state === "stopped")).toBe(true);
  });

  it("does not reuse a partly read watcher snapshot for final release validation", async () => {
    let changed = false;
    let refused = false;
    let holdOnce = false;
    let held!: () => void;
    let releaseRead!: () => void;
    const readingB = new Promise<void>((resolve) => { held = resolve; });
    const finishB = new Promise<void>((resolve) => { releaseRead = resolve; });
    const defaults = scriptsFor();
    const { factory } = setup({
      coordinator: async (session, prompt, fake) => {
        if (refused) return;
        const platform = fake as WorkerPlatform;
        const originalTool = session.callTool.bind(session);
        const originalInfo = platform.sessionInfo.bind(platform);
        const originalArtifacts = platform.artifacts.bind(platform);
        platform.sessionInfo = async (id) => {
          const snapshot = await originalInfo(id);
          if (holdOnce && platform.workerRecords.get(id)?.name === "builder-json2csv") {
            holdOnce = false;
            held();
            await finishB;
          }
          return snapshot;
        };
        platform.artifacts = (id) => {
          const artifacts = originalArtifacts(id);
          if (platform.sessions.get(id)?.role !== "release") return artifacts;
          return {
            ...artifacts,
            waitForPublication: async (options) => {
              const publication = await artifacts.waitForPublication(options);
              if (!changed) {
                changed = true;
                holdOnce = true;
                const builder = [...platform.workerRecords.values()].find((item) => item.name === "builder-csv2json")!;
                platform.emitWorkerEvent(builder.id);
                await readingB;
                await originalTool("message_worker", { worker: builder.id, message: "A new change after the release inputs were prepared." });
                await originalTool("wait_for_workers", { workers: [builder.id] });
                // The post-collection gate joins while the watcher still holds A's old state.
                setTimeout(releaseRead, 30);
              }
              return publication;
            },
          };
        };
        session.callTool = async (name, args) => {
          const result = await originalTool(name, args);
          if (name === "check_release") {
            const reply = GateSchema.parse(JSON.parse(z.object({ textResultForLlm: z.string() }).parse(result).textResultForLlm));
            expect(reply.ok).toBe(false);
            expect(reply.accepted).not.toBe(true);
            refused = true;
            return { resultType: "failure", textResultForLlm: JSON.stringify({ ...reply, fatal: true }) };
          }
          return result;
        };
        await defaults.coordinator(session, prompt, platform);
      },
    });
    const wo = await settled(factory, factory.create(CREATE).id);
    expect(refused).toBe(true);
    expect(wo.release).toBeUndefined();
    expect(wo.status).not.toBe("completed");
  });
});
