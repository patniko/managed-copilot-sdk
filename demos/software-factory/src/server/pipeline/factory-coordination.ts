import { defineTool, type PermissionHandler, type SessionConfig, type SessionEvent, type Tool } from "@github/copilot-sdk";
import { isManagedCopilotError, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import { z } from "zod";
import { FACTORY_ENVIRONMENTS } from "../../shared/environments.js";
import type { PlanTask } from "../../shared/types.js";
import { log } from "../log.js";
import type { StationSession } from "../platform.js";
import { StationActivityMapper } from "./activity.js";
import {
  builderName,
  coordinatorPrompt,
  coordinatorReminder,
  NoArgsSchema,
  ReleaseWorkerSchema,
  TaskSchema,
  TaskWorkerSchema,
  taskStart,
  toolDecision,
  WORKER_READY_TASK,
} from "./coordinator.js";
import { CancelledError, StationError, toFactoryError } from "./errors.js";
import { factoryPermissions } from "./permissions.js";
import { buildPrompt, checkFailedPrompt, continuePrompt, fixPrompt, releasePrompt } from "./prompts.js";
import { builderSeed, releaseSeed, sha256, type SeedFile, type TaskOutcome } from "./seed.js";
import {
  ABORT_TIMEOUT_MS,
  type ActiveSession,
  DETACH_TIMEOUT_MS,
  MAX_NUDGES,
  MAX_READ_FAILURES,
  type MStation,
  type MWorkOrder,
  now,
  parseJson,
  type Run,
} from "./factory-shared.js";
import { FactoryState } from "./factory-state.js";

/** Agent-led work orders: the coordinator session and the worker sessions it starts. */
export abstract class FactoryCoordination extends FactoryState {
  // ─── Agent-led coordination ────────────────────────────────────────────────────────────────────────────────

  protected ensureCoordinatorRun(run: Run): void {
    if (this.stopping || run.closed || this.runs.get(run.wo.id) !== run) throw new CancelledError();
    this.throwIfCancelled(run);
  }

  protected async coordinate(run: Run): Promise<void> {
    const station = this.station(run, "coordinator");
    if (run.wo.release && this.station(run, "release").status === "done") {
      this.updateStation(run, station, { status: "done", detail: "Release accepted", finishedAt: now() });
      return;
    }
    let active: ActiveSession | undefined;
    let unwatch = () => {};
    let failure: unknown;
    const failed = new Promise<never>((_, reject) => {
      run.stopCoordinator = (error) => { failure ??= error; reject(error); };
    });
    // A gate can fail during the resume RPC, before a completion wait has been installed.
    void failed.catch(() => undefined);
    const cancelled = () => run.stopCoordinator?.(new CancelledError());
    run.abort.signal.addEventListener("abort", cancelled, { once: true });
    try {
      const resuming = Boolean(station.sessionId);
      const mapper = this.newMapper(run, station);
      const config = this.sessionConfig(run, station, mapper, {
        tools: this.coordinatorTools(run),
        onPermissionRequest: this.coordinatorPermissions(run, mapper),
        onEvent: (event) => {
          mapper.handle(event);
          this.coordinatorEvent(run, event);
        },
      });
      this.updateStation(run, station, {
        status: "starting", detail: resuming ? "Reattaching to the coordinator" : "Opening the coordinator",
        model: station.model ?? this.platform.models.coordinator, startedAt: station.startedAt ?? now(),
      });
      const session = station.sessionId
        ? await this.platform.resumeSession("coordinator", station.sessionId, config)
        : await this.platform.createSession("coordinator", { ...config, model: station.model });
      active = { session, mapper, capture: {} };
      run.sessions.set(station.id, active);
      this.ensureCoordinatorRun(run);
      this.updateStation(run, station, { sessionId: session.sessionId });
      if (resuming) {
        // App tools interrupted by a restart may need reconciliation. Their effects are checkpointed and idempotent:
        // end only the coordinator's old turn, then let a fresh turn read those checkpoints. Workers keep running.
        await this.endCoordinatorTurn(run, active);
        this.addActivity(run.wo, station.id, "Resumed the same coordinator session; reconciling its workers before continuing", "info");
      }
      await this.syncWorkers(run, true);
      unwatch = this.watchWorkers(run);
      for (let attempt = 0; attempt <= MAX_NUDGES; attempt++) {
        const prompt = attempt === 0 ? coordinatorPrompt(run.wo, this.platform.models, resuming) : coordinatorReminder();
        await Promise.race([this.turn(run, station, active, prompt, resuming ? "continue" : "work", 1), failed]);
        if (failure) throw failure;
        await this.syncWorkers(run, true);
        if (run.wo.release && this.station(run, "release").status === "done") {
          this.updateStation(run, station, { status: "done", detail: "Release accepted by the factory", finishedAt: now() });
          return;
        }
        this.addActivity(run.wo, station.id, "The coordinator stopped before the release passed; asking it to continue from the factory checkpoints", "warning");
      }
      throw new StationError("release_incomplete", "The coordinator stopped without getting the release accepted by the factory.");
    } catch (error) {
      if (!this.stopping) {
        if (active) await this.abortCoordinator(active.session);
        if (!(error instanceof CancelledError) && !run.abort.signal.aborted) await this.failStation(run, station, failure ?? error);
        if (run.abort.signal.aborted || run.failed) await this.deleteWorkerSessions(run.wo);
      }
      throw failure ?? error;
    } finally {
      unwatch();
      run.abort.signal.removeEventListener("abort", cancelled);
      delete run.stopCoordinator;
    }
  }

  protected async abortCoordinator(session: StationSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StationError("timeout", "The coordinator didn't acknowledge the stop.")), ABORT_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      log.warn("Couldn't stop the coordinator turn", { sessionId: session.sessionId, error: toFactoryError(error).message });
    } finally {
      clearTimeout(timer);
    }
  }

  protected async endCoordinatorTurn(run: Run, active: ActiveSession): Promise<void> {
    await this.stopCoordinatorTurn(active.session, () => this.ensureCoordinatorRun(run));
  }

  protected async stopCoordinatorTurn(session: StationSession, ensureActive: () => void): Promise<void> {
    let info = await this.platform.sessionInfo(session.sessionId);
    if (!info.lastTurn || info.lastTurn.completedAt) return;
    await this.abortCoordinator(session);
    const deadline = Date.now() + ABORT_TIMEOUT_MS;
    while (info.lastTurn && !info.lastTurn.completedAt) {
      ensureActive();
      if (Date.now() >= deadline) throw new StationError("timeout", "The coordinator's interrupted turn has not stopped yet. Retry once the platform has ended it.");
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 250));
      info = await this.platform.sessionInfo(session.sessionId);
    }
  }

  protected async stopPersistedCoordinator(wo: MWorkOrder): Promise<void> {
    const station = wo.stations.find((item) => item.kind === "coordinate");
    if (!station?.sessionId) return;
    let info: SessionInfo;
    try {
      info = await this.platform.sessionInfo(station.sessionId);
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return;
      throw error;
    }
    if (!info.lastTurn || info.lastTurn.completedAt) return;
    const session = await this.platform.resumeSession("coordinator", station.sessionId, {
      agent: station.agent,
      tools: [],
      onPermissionRequest: () => ({ kind: "reject", feedback: "This work order is being cancelled." }),
    });
    try {
      await this.stopCoordinatorTurn(session, () => {});
      this.addActivity(wo, station.id, "Stopped the persisted coordinator turn before cancelling its workers", "info");
    } finally {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Coordinator detach timed out")), DETACH_TIMEOUT_MS); }),
        ]);
      } catch (error) {
        log.warn("Couldn't detach the cancelled coordinator", { sessionId: station.sessionId, error: toFactoryError(error).message });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  protected watchWorkers(run: Run): () => void {
    let stopped = false;
    let failures = 0;
    const refresh = () => {
      if (stopped || this.stopping || run.closed) return;
      void this.syncWorkers(run).then(() => { failures = 0; }, (error: unknown) => {
        if (stopped || this.stopping || run.closed) return;
        log.warn("Couldn't reconcile the coordinator's workers", { id: run.wo.id, error: toFactoryError(error).message });
        if (++failures >= MAX_READ_FAILURES || !this.options.readiness().ready) run.stopCoordinator?.(error);
      });
    };
    const unlisten = this.platform.onWorkerEvent?.((id) => {
      if (id === this.station(run, "coordinator").sessionId) {
        run.workerRevision++;
        refresh();
      }
    });
    const timer = setInterval(refresh, this.options.pollMs ?? 3_000);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); unlisten?.(); };
  }

  protected async syncWorkers(run: Run, fresh = false): Promise<WorkerInfo[]> {
    // A gate needs a pass that began after its preceding I/O, not a watcher pass already partway through its reads.
    if (fresh && run.workerSync) await run.workerSync;
    if (run.workerSync) return run.workerSync;
    const read = async (): Promise<WorkerInfo[]> => {
      this.ensureCoordinatorRun(run);
      const coordinator = this.station(run, "coordinator");
      if (!coordinator.sessionId) return [];
      const workers = await this.platform.workers(coordinator.sessionId).list();
      this.ensureCoordinatorRun(run);
      for (const station of run.wo.stations.filter((item) => item.kind === "build" || item.kind === "release")) {
        const name = station.taskId ? builderName(station.taskId) : "release";
        const worker = [...workers].reverse().find((item) => item.name === name);
        if (!worker) continue;
        const prior = station.worker;
        const replaced = prior !== undefined && prior.id !== worker.id;
        if (replaced) {
          this.store.deleteStationArtifacts(run.wo.id, station.id);
          if (station.taskId) {
            const review = this.station(run, `review:${station.taskId}`);
            this.updateStation(run, review, { status: "waiting", round: 0, reviews: undefined, acceptedWithFindings: undefined, finishedAt: undefined });
          }
          this.updateStation(run, station, {
            previousSessionIds: [...(station.previousSessionIds ?? []), prior.id],
            round: 0, turn: undefined, seeded: undefined, workerCheck: undefined, passedRound: undefined,
            reviewedMessages: undefined, reviewedTurnId: undefined, reportVersion: undefined, staleReportVersion: undefined, awaitingFix: undefined,
            failedChecks: undefined, inputRevision: undefined, sandbox: undefined, tests: undefined, finishedAt: undefined,
          });
          this.options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
        }
        const newMessage = !replaced && prior !== undefined && worker.messages > prior.messages && station.seeded;
        if (newMessage) {
          const reviewed = station.taskId && this.station(run, `review:${station.taskId}`).reviews?.some((review) => review.round === station.round);
          const nextRound = Boolean(reviewed) || station.awaitingFix;
          const round = nextRound ? station.round + 1 : Math.max(1, station.round);
          this.updateStation(run, station, {
            round, passedRound: undefined, workerCheck: undefined, reviewedMessages: undefined, reviewedTurnId: undefined,
            staleReportVersion: station.reportVersion, awaitingFix: undefined, finishedAt: undefined,
            ...(nextRound ? { failedChecks: 0 } : {}),
            turn: { kind: nextRound ? "fix" : station.round === 0 ? "work" : "nudge", round, sentAt: worker.updatedAt },
          });
          if (station.taskId) this.updateStation(run, this.station(run, `review:${station.taskId}`), { status: "waiting", detail: "Waits for the updated build", finishedAt: undefined });
        }
        this.updateStation(run, station, {
          sessionId: worker.id, model: worker.model ?? station.model, startedAt: station.startedAt ?? worker.createdAt,
          worker: {
            id: worker.id, name: worker.name, state: worker.state, messages: worker.messages,
            ...(!replaced && prior?.turnId ? { turnId: prior.turnId } : {}),
            createdRound: replaced ? 1 : prior?.createdRound ?? 1, ...(worker.error ? { error: worker.error } : {}),
          },
        });
        if (worker.state !== "starting" && worker.state !== "stopped") await this.refreshSandbox(run, station, worker.state === "idle" || worker.state === "working");
        this.ensureCoordinatorRun(run);
        if (worker.state === "starting" || worker.state === "working") {
          this.updateStation(run, station, {
            status: worker.state === "starting" ? "starting" : "working",
            detail: !station.seeded ? "Waiting for workspace preparation" : station.round > 1 ? `Fixing review findings (round ${station.round})` : "Working in its own sandbox",
          });
        } else if (station.turn && !station.turn.completedAt) {
          this.updateStation(run, station, {
            turn: { ...station.turn, completedAt: worker.updatedAt }, status: "waiting",
            detail: worker.state === "idle" ? "Work finished; awaits the factory check" : worker.error ?? `Worker ${worker.state}`,
          });
        }
        if (worker.state === "idle" && (prior?.state !== "idle" || prior.messages !== worker.messages) && worker.result) {
          this.emitItem(run.wo, { id: `worker:${worker.id}:${worker.messages}`, stationId: station.id, kind: "message", text: worker.result });
        }
      }
      if (run.wo.workersStarted !== workers.length) this.setWorkOrder(run, { workersStarted: workers.length });
      return workers;
    };
    const sync = async (): Promise<WorkerInfo[]> => {
      for (;;) {
        const revision = run.workerRevision;
        const workers = await read();
        // Worker events and coordinator mutation tools invalidate even a partially read snapshot.
        if (revision === run.workerRevision) {
          run.workerSnapshotRevision = revision;
          return workers;
        }
      }
    };
    run.workerSync = sync().finally(() => { delete run.workerSync; });
    return run.workerSync;
  }

  protected requireWorkerSnapshot(run: Run): void {
    const changing = [...run.decisions.values()].some(({ start }) => start.data.toolName === "message_worker" || start.data.toolName === "stop_worker");
    if (run.workerSync || run.workerSnapshotRevision !== run.workerRevision || changing) {
      throw new StationError("conflict", "Worker instructions changed while the factory was checking them. Wait for pending worker tools to finish, then call the factory gate again.");
    }
  }

  protected coordinatorPermissions(run: Run, mapper: StationActivityMapper): PermissionHandler {
    const ordinary = factoryPermissions("shared", (kind) => mapper.status(`Denied a "${kind}" request`, "warning"));
    return async (request, invocation) => {
      if (request.managedApprovalRequired) return { kind: "no-result" };
      if (request.kind !== "custom-tool" || request.toolName !== "start_worker") return ordinary(request, invocation);
      try {
        this.ensureCoordinatorRun(run);
        const args = z.object({ name: z.string(), task: z.string(), environment: z.string(), agent: z.string(), model: z.string().optional() }).parse(request.args);
        const task = run.wo.plan!.tasks.find((candidate) => builderName(candidate.id) === args.name);
        const role = task ? "builder" : args.name === "release" ? "release" : undefined;
        if (!role) throw new StationError("invalid_request", "Start only a named builder from the accepted plan, or the release worker.");
        if (args.environment !== FACTORY_ENVIRONMENTS[role] || args.agent !== role) {
          throw new StationError("invalid_request", `Use environment ${FACTORY_ENVIRONMENTS[role]} and agent ${role}.`);
        }
        const inherited = this.station(run, "coordinator").model;
        if ((args.model ?? inherited) !== this.platform.models[role]) throw new StationError("invalid_request", `Use model ${this.platform.models[role]} for the ${role}.`);
        if (args.task !== WORKER_READY_TASK) throw new StationError("invalid_request", `Use the factory's readiness task exactly: ${JSON.stringify(WORKER_READY_TASK)}`);
        const workers = await this.syncWorkers(run, true);
        if (workers.some((worker) => worker.name === args.name && worker.state !== "stopped")) {
          throw new StationError("conflict", `Worker ${args.name} already exists. Reuse it with message_worker, or wait_for_workers while it is busy.`);
        }
        if (task) this.requireDependencies(run, task);
        else this.requireAcceptedTasks(run);
        this.ensureCoordinatorRun(run);
        return { kind: "approve-once" };
      } catch (error) {
        const message = error instanceof z.ZodError ? "Pass a worker name, readiness task, environment, agent, and model from the factory instructions." : toFactoryError(error).message;
        this.emitItem(run.wo, { stationId: "coordinator", kind: "decision", decision: { action: "declined", status: "failed" }, text: `Worker start declined: ${message}`, level: "warning" });
        if (!(error instanceof StationError) && !(error instanceof z.ZodError) && !(error instanceof CancelledError)) run.stopCoordinator?.(error);
        return { kind: "reject", feedback: message };
      }
    };
  }

  protected coordinatorTools(run: Run): NonNullable<SessionConfig["tools"]> {
    const tool = <T>(name: string, description: string, parameters: z.ZodType<T>, handler: (args: T) => Promise<Record<string, unknown>>): Tool<T> =>
      defineTool(name, {
        description, parameters, skipPermission: true,
        handler: async (args) => {
          const parsed = parameters.safeParse(args);
          if (!parsed.success) return { resultType: "failure", textResultForLlm: JSON.stringify({ ok: false, summary: "Invalid tool arguments. Use the parameters in this tool's schema." }) };
          const release = await run.gates.acquire(run.abort.signal);
          try {
            this.ensureCoordinatorRun(run);
            const result = await handler(parsed.data);
            this.ensureCoordinatorRun(run);
            return { resultType: result.ok === false ? "failure" : "success", textResultForLlm: JSON.stringify(result) };
          } catch (error) {
            const refusal = error instanceof StationError && ["invalid_request", "conflict", "session_busy"].includes(error.code);
            if (!refusal && !this.stopping && !run.closed) run.stopCoordinator?.(error);
            return { resultType: "failure", textResultForLlm: JSON.stringify({ ok: false, fatal: !refusal, summary: toFactoryError(error).message, error: toFactoryError(error) }) };
          } finally {
            release();
          }
        },
      });
    return [
      tool("prepare_workspace", "Prepare a builder's inputs after its readiness turn, then return the task to send with message_worker. Idempotent; never creates a worker.", TaskWorkerSchema,
        ({ taskId, worker }) => this.prepareBuilder(run, taskId, worker)),
      tool("check_build", "Check the builder's latest published files and fresh test report. Returns a fix message when they fail. Never starts or messages a worker.", TaskSchema,
        ({ taskId }) => this.checkWorker(run, this.taskStation(run, taskId), false)),
      tool("request_review", "Review a checked build in factory-reviewer on a second model. Returns acceptance or findings to send to the SAME builder. Review rounds are bounded.", TaskSchema,
        ({ taskId }) => this.reviewWorker(run, taskId)),
      tool("prepare_release", "After all tasks are accepted, list the copy_worker_files operations needed for the release. Call again after copying: verifies copied bytes, seeds the release, and returns its task.", ReleaseWorkerSchema,
        ({ worker }) => this.prepareAgentRelease(run, worker)),
      tool("check_release", "Check the release worker's fresh full test suite, bundle, patch, and release notes; only this tool can accept the deliverable.", NoArgsSchema,
        () => this.checkWorker(run, this.station(run, "release"), true)),
      tool("factory_status", "Read the factory's persisted checkpoints and the coordinator's current workers, including which factory gate each task needs next.", NoArgsSchema,
        () => this.coordinatorStatus(run)),
    ];
  }

  protected taskStation(run: Run, taskId: string): MStation {
    if (!run.wo.plan!.tasks.some((task) => task.id === taskId)) throw new StationError("invalid_request", `There is no task "${taskId}" in the accepted plan.`);
    return this.station(run, `build:${taskId}`);
  }

  protected taskAccepted(run: Run, taskId: string): boolean {
    const build = this.station(run, `build:${taskId}`);
    return this.station(run, `review:${taskId}`).status === "done"
      && build.workerCheck?.passed === true && build.workerCheck.messages === build.worker?.messages
      && build.workerCheck.turnId === build.worker?.turnId
      && build.reviewedMessages === build.worker?.messages && build.reviewedTurnId === build.worker?.turnId
      && build.worker?.state === "idle" && !build.sessionGone;
  }

  protected requireDependencies(run: Run, task: PlanTask): void {
    const waiting = task.dependsOn.filter((id) => !this.taskAccepted(run, id));
    if (waiting.length) throw new StationError("conflict", `Wait for these dependencies to pass the factory's review: ${waiting.join(", ")}.`);
  }

  protected requireAcceptedTasks(run: Run): void {
    this.requireWorkerSnapshot(run);
    const waiting = run.wo.plan!.tasks.filter((task) => !this.taskAccepted(run, task.id));
    if (waiting.length) throw new StationError("conflict", `The release must wait for these tasks to pass checks and review: ${waiting.map((task) => task.id).join(", ")}.`);
  }

  protected async workerFor(run: Run, station: MStation, ref?: string, bootstrap = false): Promise<WorkerInfo> {
    const deadline = Date.now() + Math.min(this.options.config.turnTimeoutMs.builder, 180_000);
    for (;;) {
      const workers = await this.syncWorkers(run, true);
      const worker = workers.find((item) => item.id === station.worker?.id);
      if (!worker || (ref && worker.name !== ref && worker.id !== ref)) throw new StationError("invalid_request", `Start the ${station.taskId ? builderName(station.taskId) : "release"} worker first.`);
      if (worker.coordinatorId !== this.station(run, "coordinator").sessionId || worker.environment !== station.environment || worker.agent !== station.agent) {
        throw new StationError("invalid_request", "This worker doesn't belong to the factory station's coordinator, environment, and agent.");
      }
      if (worker.state === "stopped") throw new StationError("conflict", `Worker ${worker.name} was stopped. Start its replacement with the same name.`);
      if (worker.state !== "working" && worker.state !== "starting") {
        const info = await this.platform.sessionInfo(worker.id);
        this.ensureCoordinatorRun(run);
        if (info.parentSessionId !== worker.coordinatorId || info.placement !== "sandbox" || !info.sandbox) {
          throw new StationError("conflict", `Worker ${worker.name} doesn't have the expected sandbox.`);
        }
        if (info.lastTurn && !info.lastTurn.completedAt) throw new StationError("session_busy", `Worker ${worker.name} still has an unfinished turn. Use wait_for_workers.`);
        if (station.worker) this.updateStation(run, station, { worker: { ...station.worker, turnId: info.lastTurn?.turnId } });
        return worker;
      }
      if (!bootstrap || worker.messages > 1) throw new StationError("session_busy", `Worker ${worker.name} is still working. Use wait_for_workers, then call this tool again.`);
      if (Date.now() >= deadline) throw new StationError("timeout", `Worker ${worker.name} didn't finish preparing its sandbox in time.`);
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 1_000));
    }
  }

  protected async seedWorker(run: Run, station: MStation, files: readonly SeedFile[], inputRevision?: string): Promise<void> {
    const writer = this.platform.files(station.sessionId!);
    for (const file of files) {
      this.ensureCoordinatorRun(run);
      await writer.write(file.path, file.content);
    }
    this.ensureCoordinatorRun(run);
    this.updateStation(run, station, {
      seeded: true, status: "waiting", detail: "Workspace ready; waiting for the coordinator's instructions",
      ...(inputRevision ? { inputRevision } : {}),
    });
    this.addActivity(run.wo, station.id, `Factory prepared ${files.length} input files in ${station.worker!.name}`, "info");
  }

  protected async prepareBuilder(run: Run, taskId: string, ref: string): Promise<Record<string, unknown>> {
    const station = this.taskStation(run, taskId);
    const task = run.wo.plan!.tasks.find((candidate) => candidate.id === taskId)!;
    this.requireDependencies(run, task);
    const worker = await this.workerFor(run, station, ref, true);
    this.requireWorkerSnapshot(run);
    this.requireDependencies(run, task);
    const dependencyFiles = this.dependencyFiles(run, task);
    if (!station.seeded) {
      if (worker.messages > 1) throw new StationError("conflict", "This builder started work before its inputs were prepared. Stop it and start a fresh builder with the readiness task.");
      await this.seedWorker(run, station, builderSeed(run.wo, run.wo.plan!, task, dependencyFiles, this.skillsRoot, this.inputs(run)));
    }
    return {
      ok: true, ready: true, summary: `Prepared **${worker.name}** for ${task.title}`,
      worker: worker.name, alreadyWorking: worker.messages > 1,
      message: buildPrompt(run.wo, task, [...dependencyFiles.keys()], this.notes(run)),
    };
  }

  protected async checkWorker(run: Run, station: MStation, release: boolean): Promise<Record<string, unknown>> {
    const worker = await this.workerFor(run, station);
    this.requireWorkerSnapshot(run);
    if (!station.seeded || worker.messages < 2) throw new StationError("conflict", "Prepare the workspace and send its real task with message_worker before checking it.");
    if (release) {
      this.requireAcceptedTasks(run);
      if (station.inputRevision !== this.inputRevision(run)) throw new StationError("conflict", "A builder changed after the release inputs were prepared. Review that build, then prepare a new release worker.");
    }
    const turnId = station.worker?.turnId;
    if (!turnId) throw new StationError("conflict", "The worker has not completed a runtime turn to check.");
    const previous = station.workerCheck;
    if (previous?.messages === worker.messages && previous.turnId === turnId) return this.checkReply(station, release);
    if (worker.state !== "idle") {
      return { ok: false, summary: `Worker **${worker.name}** failed: ${worker.error ?? "its turn did not finish"}`, message: continuePrompt(release), worker: worker.name };
    }
    const outcome = await this.collect(run, station, release, { version: station.staleReportVersion, turnId });
    await this.syncWorkers(run, true);
    this.ensureCoordinatorRun(run);
    this.requireWorkerSnapshot(run);
    if (station.worker?.id !== worker.id || station.worker.messages !== worker.messages || station.worker.state !== "idle" || station.worker.turnId !== turnId) {
      throw new StationError("conflict", "The worker changed while the factory was checking it. Wait for the new work to finish, then check again.");
    }
    if (release) {
      this.requireAcceptedTasks(run);
      if (station.inputRevision !== this.inputRevision(run)) throw new StationError("conflict", "A builder changed while the release was being checked. Review its new output and prepare a new release worker.");
    }
    let problem = outcome.problem;
    let code = outcome.code;
    if (outcome.passed && release) {
      const latest = this.store.latestArtifacts(run.wo.id, station.id);
      if (!latest.some((item) => item.path === "RELEASE.md" && item.content?.trim()) || !latest.some((item) => item.path === "project.patch" && item.content?.trim())) {
        problem = "The release must publish outputs/RELEASE.md and outputs/project.patch.";
        code = "release_incomplete";
      }
    }
    const passed = outcome.passed && !problem;
    this.updateStation(run, station, {
      workerCheck: { messages: worker.messages, turnId, passed, code, problem },
      status: passed ? "done" : "waiting", detail: passed ? `${outcome.report!.summary.passed} tests passed${release ? "" : " · ready for review"}` : `Check failed: ${problem}`,
      ...(passed ? { passedRound: station.round, finishedAt: now() } : { failedChecks: (station.failedChecks ?? 0) + 1 }),
    });
    if (!passed && station.failedChecks! > MAX_NUDGES) {
      const error = new StationError(code, `The ${release ? "release" : "builder"} couldn't get the factory check to pass: ${problem}`);
      await this.failStation(run, station, error);
      throw error;
    }
    if (passed && release) this.acceptRelease(run, station, outcome);
    return this.checkReply(station, release);
  }

  protected checkReply(station: MStation, release: boolean): Record<string, unknown> {
    const check = station.workerCheck!;
    return {
      ok: check.passed, accepted: release && check.passed, worker: station.worker!.name,
      summary: check.passed
        ? `${release ? "Release accepted" : `Factory check for **${station.worker!.name}**`}: **${station.tests?.passed ?? 0} tests pass**`
        : `Factory check for **${station.worker!.name}** failed: ${check.problem}`,
      tests: station.tests,
      ...(check.passed ? { next: release ? "The deliverable is ready. Stop workers you no longer need and report the result." : "Call request_review." }
        : { message: checkFailedPrompt(check.problem, undefined, release), error: { code: check.code, message: check.problem } }),
    };
  }

  protected async reviewWorker(run: Run, taskId: string): Promise<Record<string, unknown>> {
    const build = this.taskStation(run, taskId);
    const worker = await this.workerFor(run, build);
    this.requireWorkerSnapshot(run);
    const turnId = build.worker?.turnId;
    if (!build.workerCheck?.passed || build.workerCheck.messages !== worker.messages || build.workerCheck.turnId !== turnId) throw new StationError("conflict", "Call check_build on the latest worker output and get a passing report before requesting review.");
    const review = this.station(run, `review:${taskId}`);
    const task = run.wo.plan!.tasks.find((candidate) => candidate.id === taskId)!;
    const verdict = await this.reviewRound(run, task, build, this.latestReport(run, build.id), worker.result, build.reviewedMessages === worker.messages && build.reviewedTurnId === turnId);
    await this.syncWorkers(run, true);
    this.ensureCoordinatorRun(run);
    this.requireWorkerSnapshot(run);
    if (build.worker?.id !== worker.id || build.worker.messages !== worker.messages || build.worker.state !== "idle" || build.worker.turnId !== turnId) {
      this.updateStation(run, review, { status: "waiting", detail: "The builder changed during review; check and review its new output" });
      throw new StationError("conflict", "The builder changed during review. Check its new output and request review again.");
    }
    const accepted = verdict.verdict === "approve" || build.round >= run.wo.maxReviewRounds;
    this.updateStation(run, build, { reviewedMessages: worker.messages, reviewedTurnId: turnId, awaitingFix: !accepted });
    if (accepted) {
      this.updateStation(run, build, { detail: `${build.tests?.passed ?? 0} tests passed` });
      this.updateStation(run, review, {
        status: "done", finishedAt: now(), acceptedWithFindings: verdict.verdict !== "approve",
        detail: verdict.verdict === "approve" ? `Approved in round ${build.round}` : `Accepted after ${build.round} rounds with findings open`,
      });
      await this.closeSession(run, review.id);
    }
    return {
      ok: true, accepted, worker: worker.name, round: build.round, verdict: verdict.verdict, findings: verdict.findings,
      summary: accepted
        ? `Factory review: **${worker.name}** ${verdict.verdict === "approve" ? "approved" : "accepted with open findings"} in round ${build.round}`
        : `Factory review: **${verdict.findings.length} ${verdict.findings.length === 1 ? "finding" : "findings"}** for **${worker.name}**; reuse this builder for round ${build.round + 1}`,
      ...(accepted ? {} : { message: fixPrompt(build.round + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary) }),
    };
  }

  protected inputRevision(run: Run): string {
    return sha256(JSON.stringify(run.wo.plan!.tasks.map((task) => {
      const build = this.station(run, `build:${task.id}`);
      return [task.id, build.worker?.id, build.workerCheck?.messages, build.workerCheck?.turnId, build.reportVersion];
    })));
  }

  protected async prepareAgentRelease(run: Run, ref: string): Promise<Record<string, unknown>> {
    await this.syncWorkers(run, true);
    this.requireAcceptedTasks(run);
    const station = this.station(run, "release");
    const worker = await this.workerFor(run, station, ref, true);
    const revision = this.inputRevision(run);
    const outcomes = this.outcomes(run);
    const inputs = this.inputs(run);
    const seed = releaseSeed(run.wo, run.wo.plan!, outcomes, this.skillsRoot, inputs);
    if (station.seeded && station.inputRevision !== revision) throw new StationError("conflict", "The accepted builder outputs changed. Stop the release worker and start a fresh one.");
    if (!station.seeded) {
      if (worker.messages > 1) throw new StationError("conflict", "The release started before its inputs were prepared. Stop it and start a fresh release worker.");
      const copies = outcomes.map(({ task }) => ({
        from: this.station(run, `build:${task.id}`).worker!.name,
        to: worker.name, paths: ["outputs/files"], destination: `.factory/incoming/${task.id}`,
      }));
      const copied: TaskOutcome[] = [];
      const missing: string[] = [];
      const reader = this.platform.files(worker.id);
      for (const outcome of outcomes) {
        const files = new Map<string, string>();
        for (const [path, expected] of outcome.files) {
          this.ensureCoordinatorRun(run);
          const source = `.factory/incoming/${outcome.task.id}/outputs/files/${path}`;
          try {
            const content = await reader.read(source);
            if (sha256(content) !== sha256(expected)) missing.push(source);
            else files.set(path, content);
          } catch (error) {
            if (isManagedCopilotError(error, "not_found")) missing.push(source);
            else throw error;
          }
        }
        copied.push({ ...outcome, files });
      }
      if (missing.length) {
        return { ok: true, ready: false, summary: "Release needs the accepted builders' files copied in", copies, next: "Run these copy_worker_files operations, then call prepare_release again. Do not send the release its task yet." };
      }
      await this.syncWorkers(run, true);
      this.requireAcceptedTasks(run);
      if (this.inputRevision(run) !== revision) throw new StationError("conflict", "A builder changed while the factory prepared the release. Check and review it again.");
      await this.seedWorker(run, station, releaseSeed(run.wo, run.wo.plan!, copied, this.skillsRoot, inputs).files, revision);
      this.setWorkOrder(run, { status: "releasing" });
    }
    return {
      ok: true, ready: true, worker: worker.name, summary: "Verified copied outputs and prepared the **release** sandbox",
      message: releasePrompt(run.wo, run.wo.plan!, seed.conflicts, this.notes(run)),
    };
  }

  protected async coordinatorStatus(run: Run): Promise<Record<string, unknown>> {
    const workers = await this.syncWorkers(run, true);
    return {
      ok: true, summary: run.wo.release ? "The release is accepted." : "Factory checkpoints",
      releaseAccepted: Boolean(run.wo.release),
      tasks: run.wo.plan!.tasks.map((task) => {
        const build = this.station(run, `build:${task.id}`);
        const review = this.station(run, `review:${task.id}`);
        return {
          taskId: task.id, dependsOn: task.dependsOn, worker: build.worker, seeded: Boolean(build.seeded), round: build.round,
          check: build.workerCheck, accepted: this.taskAccepted(run, task.id), latestReview: review.reviews?.at(-1),
          start: taskStart(task, this.platform.models.builder),
        };
      }),
      release: this.station(run, "release"),
      workers: workers.map(({ id, name, environment, state, messages, error }) => ({ id, name, environment, state, messages, error })),
    };
  }

  protected coordinatorEvent(run: Run, event: SessionEvent): void {
    if (this.stopping || run.closed || event.agentId) return;
    if (event.type === "tool.execution_start") {
      if (["start_worker", "message_worker", "copy_worker_files", "stop_worker"].includes(event.data.toolName)) run.workerRevision++;
      const args = event.data.arguments;
      const ref = args && typeof args === "object" && "worker" in args ? args.worker : undefined;
      const firstMessage = event.data.toolName === "message_worker"
        && run.wo.stations.some((station) => station.worker?.messages === 1 && (station.worker.name === ref || station.worker.id === ref));
      run.decisions.set(event.data.toolCallId, { start: event, firstMessage });
      const decision = toolDecision(event.data.toolName, args, "running", firstMessage);
      if (decision) {
        this.emitItem(run.wo, { id: `decision:${event.data.toolCallId}`, stationId: "coordinator", kind: "decision", ...decision });
        this.updateStation(run, this.station(run, "coordinator"), { detail: decision.text.replace(/\*\*/g, "") });
      }
    } else if (event.type === "tool.execution_complete") {
      const running = run.decisions.get(event.data.toolCallId);
      if (!running) return;
      run.decisions.delete(event.data.toolCallId);
      const { start, firstMessage } = running;
      if (["start_worker", "message_worker", "copy_worker_files", "stop_worker"].includes(start.data.toolName)) run.workerRevision++;
      const decision = toolDecision(start.data.toolName, start.data.arguments, event.data.success ? "done" : "failed", firstMessage);
      if (!decision) return;
      const result = parseJson<{ summary?: unknown }>(event.data.result?.content);
      this.emitItem(run.wo, {
        id: `decision:${event.data.toolCallId}`, stationId: "coordinator", kind: "decision", ...decision,
        text: typeof result?.summary === "string" ? result.summary : decision.text,
        level: event.data.success ? "info" : "warning",
      });
    }
  }

  /** Cancelling a work order must stop its workers without attaching a client that would take over their prompts. */
  protected async deleteWorkerSessions(wo: MWorkOrder): Promise<void> {
    const id = wo.stations.find((station) => station.kind === "coordinate")?.sessionId;
    if (!id) return;
    try {
      const workers = await this.platform.workers(id).list();
      await Promise.all(workers.filter((worker) => worker.state !== "stopped").map(async (worker) => {
        try {
          await this.platform.deleteSession(worker.id);
        } catch (error) {
          if (!isManagedCopilotError(error, "not_found")) throw error;
        }
      }));
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return;
      const message = `Couldn't stop every worker: ${toFactoryError(error).message}. Delete the work order to retry cleanup.`;
      wo.error = { code: "cleanup_failed", message };
      this.addActivity(wo, "coordinator", message, "error");
      log.warn("Worker cleanup failed", { id: wo.id, error: message });
    }
  }
}
