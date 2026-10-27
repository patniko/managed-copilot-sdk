import type { ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import { ManagedCopilotError, type SessionInfo, type WorkerEventData, type WorkerInfo } from "@managed-copilot/sdk";
import { z } from "zod";
import type { StationWorkers, WorkerEventListener } from "../src/server/platform.js";
import { WORKER_READY_TASK } from "../src/server/pipeline/coordinator.js";
import { FACTORY_ENVIRONMENTS } from "../src/shared/environments.js";
import type { StationRole } from "../src/shared/types.js";
import { FakePlatform, FakeSession } from "./fakes.js";

type MutableWorker = { -readonly [K in keyof WorkerInfo]: WorkerInfo[K] };

/** Unit-test-only worker tools. A worker runs without a factory client attached to it. */
export class WorkerPlatform extends FakePlatform {
  readonly workerRecords = new Map<string, MutableWorker>();
  readonly workerRuns = new Map<string, Promise<void>>();
  readonly resumed: { role: StationRole; id: string }[] = [];
  readonly copies: { from: string; to: string; paths: string[]; destination?: string }[] = [];
  readonly #listeners = new Set<WorkerEventListener>();
  get workerIds(): string[] { return [...this.workerRecords.keys()]; }

  override async script(session: FakeSession, prompt: string): Promise<void> {
    if (this.workerRecords.has(session.sessionId) && prompt === WORKER_READY_TASK) {
      session.say("READY");
      return;
    }
    return super.script(session, prompt);
  }

  override turnStarted(session: FakeSession): void { this.lastTurnStatus.set(session.sessionId, "running"); }
  override turnEnded(session: FakeSession, error?: unknown): void { this.lastTurnStatus.set(session.sessionId, error ? "failed" : "completed"); }
  override turnStopped(session: FakeSession): void { this.lastTurnStatus.set(session.sessionId, "cancelled"); }

  override async resumeSession(role: StationRole, id: string, config: ResumeSessionConfig) {
    this.resumed.push({ role, id });
    if (this.workerRecords.has(id)) throw new Error("The factory must not attach to workers");
    return super.resumeSession(role, id, config);
  }

  override async sessionInfo(id: string): Promise<SessionInfo> {
    const base = await super.sessionInfo(id);
    const worker = this.workerRecords.get(id);
    const role = this.sessions.get(id)!.role;
    return { ...base, environment: FACTORY_ENVIRONMENTS[role], ...(role === "coordinator" ? { type: "orchestrator" as const } : {}), ...(worker ? { parentSessionId: worker.coordinatorId } : {}) };
  }

  onWorkerEvent(listener: WorkerEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  override workers(coordinatorId: string): StationWorkers {
    return {
      list: async () => structuredClone([...this.workerRecords.values()].filter((worker) => worker.coordinatorId === coordinatorId)),
      get: async (ref) => structuredClone(this.#find(coordinatorId, ref)),
    };
  }

  #find(coordinatorId: string, ref: string): MutableWorker {
    const worker = [...this.workerRecords.values()].reverse().find((item) => item.coordinatorId === coordinatorId && (item.id === ref || item.name === ref));
    if (!worker) throw new ManagedCopilotError("not_found", `Worker ${ref} was not found`);
    return worker;
  }

  #changed(worker: MutableWorker): void {
    const data: WorkerEventData = { workerId: worker.id, name: worker.name, environment: worker.environment, state: worker.state, ...(worker.error ? { error: worker.error } : {}) };
    for (const listener of this.#listeners) listener(worker.coordinatorId, data);
  }

  #send(worker: MutableWorker, prompt: string): void {
    worker.state = "working";
    worker.messages++;
    worker.updatedAt = new Date().toISOString();
    delete worker.error;
    this.#changed(worker);
    const session = this.sessions.get(worker.id)!;
    const run = session.sendAndWait({ prompt }).then(() => {
      if (worker.state !== "stopped") worker.state = "idle";
      worker.result = `Finished message ${worker.messages}`;
    }, (error: unknown) => {
      if (worker.state !== "stopped") worker.state = "failed";
      worker.error = (error as Error).message;
    }).finally(() => {
      worker.updatedAt = new Date().toISOString();
      this.#changed(worker);
    });
    this.workerRuns.set(worker.id, run);
  }

  override async deleteSession(id: string): Promise<void> {
    const worker = this.workerRecords.get(id);
    if (worker) {
      worker.state = "stopped";
      await this.sessions.get(id)?.abort();
      this.#changed(worker);
    }
    for (const child of this.workerRecords.values()) if (child.coordinatorId === id && child.state !== "stopped") await this.deleteSession(child.id);
    this.lost.add(id);
    await super.deleteSession(id);
  }

  override async workerTool(session: FakeSession, name: string, raw: unknown): Promise<unknown> {
    if (session.role !== "coordinator") throw new Error("Only a coordinator gets worker tools");
    switch (name) {
      case "start_worker": {
        const args = z.object({ name: z.string(), task: z.string(), environment: z.string(), agent: z.string(), model: z.string().optional() }).parse(raw);
        const decision = await session.config.onPermissionRequest?.({
          kind: "custom-tool", toolName: name, toolDescription: "Start a worker", args,
        }, { sessionId: session.sessionId });
        const result = decision?.kind === "attributed" ? decision.result : decision;
        if (result?.kind !== "approve-once") throw new ManagedCopilotError("forbidden", result && "feedback" in result ? String(result.feedback) : "Worker not approved");
        const role = args.agent === "release" ? "release" : "builder";
        const workerSession = await this.createSession(role, { agent: args.agent, model: args.model } as SessionConfig);
        const at = new Date().toISOString();
        const worker: MutableWorker = {
          id: workerSession.sessionId, name: args.name, coordinatorId: session.sessionId, environment: args.environment, state: "starting",
          agent: args.agent, model: args.model, task: args.task, messages: 0, createdAt: at, updatedAt: at,
        };
        this.workerRecords.set(worker.id, worker);
        this.#send(worker, args.task);
        return { name: worker.name, id: worker.id };
      }
      case "list_workers":
        return this.workers(session.sessionId).list();
      case "message_worker": {
        const args = z.object({ worker: z.string(), message: z.string() }).parse(raw);
        const worker = this.#find(session.sessionId, args.worker);
        if (worker.state !== "idle" && worker.state !== "failed") throw new ManagedCopilotError("session_busy", "Worker is busy");
        this.#send(worker, args.message);
        return "Sent";
      }
      case "wait_for_workers": {
        const args = z.object({ workers: z.array(z.string()).optional() }).parse(raw);
        const workers = args.workers?.map((ref) => this.#find(session.sessionId, ref)) ?? [...this.workerRecords.values()].filter((worker) => worker.coordinatorId === session.sessionId);
        await Promise.all(workers.map((worker) => this.workerRuns.get(worker.id)));
        return structuredClone(workers);
      }
      case "copy_worker_files": {
        const args = z.object({ from: z.string(), to: z.string(), paths: z.array(z.string()), destination: z.string().optional() }).parse(raw);
        const source = this.#find(session.sessionId, args.from);
        const target = this.#find(session.sessionId, args.to);
        this.copies.push(args);
        for (const [path, file] of this.outputs.get(source.id)!) {
          const full = `outputs/${path}`;
          if (args.paths.some((prefix) => full === prefix || full.startsWith(`${prefix}/`))) {
            this.workspaces.get(target.id)!.set(args.destination ? `${args.destination}/${full}` : full, file.content);
          }
        }
        return "Copied";
      }
      case "stop_worker": {
        const args = z.object({ worker: z.string() }).parse(raw);
        await this.deleteSession(this.#find(session.sessionId, args.worker).id);
        return "Stopped";
      }
      default:
        return super.workerTool(session, name, raw);
    }
  }
}
