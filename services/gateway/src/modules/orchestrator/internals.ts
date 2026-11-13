// Orchestrator workers: state and internals (lookups, launch, failure, cleanup, and worker events).
import {
  isManagedCopilotError,
  ManagedCopilotError,
  type EnvironmentConfig,
  type PlatformEventType,
  type WorkerEventData,
  type WorkerState,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Principal } from "../../http.js";
import type { Logger } from "../../log.js";
import type { PlatformToolCallContext, SessionRecord } from "../core/contracts.js";
import type { SandboxesService } from "../sandbox/contract.js";
import { occupiesSlot, type WorkerRecord, type WorkerStore } from "./store.js";
import { WORKER_INSTRUCTIONS } from "./tools.js";
import {
  WORKER_CLIENT_NAME,
  EVENT_ERROR_LIMIT,
  CLEANUP_RETRY_MS,
  CLEANUP_RETRY_MAX_MS,
  type RunState,
  type CleanupOutcome,
  type Waiter,
  type WorkerManagerOptions,
  describeError,
  clip,
} from "./support.js";

export abstract class WorkerInternals {
  // Implemented by later layers of WorkerManager.
  protected abstract cancelStoppedCheck(workerId: string): void;

  protected readonly app: GatewayApp;
  protected readonly log: Logger;
  protected readonly store: WorkerStore;
  /** Workers that are not stopped: events and prompts of these sessions are this module's to follow. */
  protected readonly workers = new Set<string>();
  protected readonly runs = new Map<string, RunState>();
  /** Runs started per worker since the gateway started: a send that failed after one started was delivered. */
  protected readonly runStarts = new Map<string, number>();
  /** Workers a coordinator message (or their task) is being sent to right now. */
  protected readonly sending = new Set<string>();
  /** Workers whose runtime connection closed, to settle shortly (`#onStopped`). */
  protected readonly stoppedChecks = new Map<string, NodeJS.Timeout>();
  protected readonly waiters = new Set<Waiter>();
  /** Coordinators whose message queue is being read (`#checkQueue`), and those to read again after it. */
  protected readonly queueChecks = new Set<string>();
  protected readonly queueRechecks = new Set<string>();
  /** Queued messages each coordinator was told about during its current turn (it is told once). */
  protected readonly reportedQueued = new Map<string, Set<string>>();
  protected readonly approving = new Set<string>();
  /** Prompts left to a person (managed policy requires one, or approving failed repeatedly): not tried again. */
  protected readonly refused = new Set<string>();
  protected readonly approvalFailures = new Map<string, number>();
  protected readonly launches = new Map<string, Promise<void>>();
  readonly #cleanups = new Map<string, Promise<CleanupOutcome>>();
  protected cleanupTimer: NodeJS.Timeout | undefined;
  #cleanupDelay = CLEANUP_RETRY_MS;
  protected readonly disposers: (() => void)[] = [];
  protected isClosed = false;
  /** Hands sandboxes being created, by record ID: concurrent calls wait for the same creation. */
  protected readonly handsLaunches = new Map<string, Promise<WorkerRecord>>();
  /** Releases of sub-agents' hands sandboxes under way, by record ID. */
  protected readonly releases = new Map<string, Promise<void>>();
  /** Tool call ID → the sub-agent that made it, from the coordinators' `tool.execution_start` events. */
  protected readonly subagentCalls = new Map<string, string>();
  /** Waits to end when the gateway starts shutting down; each removes itself when it ends first. */
  protected readonly onShutdown = new Set<() => void>();

  constructor(options: WorkerManagerOptions) {
    this.app = options.app;
    this.log = options.log;
    this.store = options.store;
    for (const worker of this.store.unstopped()) this.workers.add(worker.id);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  protected coordinator(context: PlatformToolCallContext): { readonly record: SessionRecord; readonly config: EnvironmentConfig } {
    const record = this.app.service("sessions").get(context.sessionId);
    if (!record || record.ownerId !== context.ownerId) throw new ManagedCopilotError("not_found", `Session ${context.sessionId} was not found`);
    if (record.type !== "orchestrator") throw new ManagedCopilotError("invalid_request", "Only orchestrator sessions have workers");
    const config = this.app.config.deployment.environments[record.environment];
    if (!config || config.type !== "orchestrator") {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${record.environment}" is no longer an orchestrator environment of this deployment`);
    }
    return { record, config };
  }

  protected owned(principal: Principal, coordinatorId: string): SessionRecord {
    const coordinator = this.app.service("sessions").getOwned(principal.accountId, coordinatorId);
    if (coordinator.type !== "orchestrator") {
      throw new ManagedCopilotError("invalid_request", `Session ${coordinatorId} is ${coordinator.type}; only orchestrator sessions have workers`, { sessionId: coordinatorId });
    }
    return coordinator;
  }

  /** A worker of this coordinator incarnation by ID, or by name (the active one, else the newest). */
  protected find(coordinator: SessionRecord, ref: unknown): WorkerRecord {
    if (typeof ref !== "string" || !ref.trim()) throw new ManagedCopilotError("invalid_request", "Name a worker by its name or ID");
    const wanted = ref.trim();
    const workers = this.store.forCoordinator(coordinator.id, coordinator.incarnation);
    const byId = workers.find((worker) => worker.id === wanted);
    if (byId) return byId;
    const named = workers.filter((worker) => worker.name === wanted.toLowerCase());
    const found = named.find(occupiesSlot) ?? named.at(-1);
    if (found) return found;
    throw new ManagedCopilotError(
      "not_found",
      `This session has no worker "${wanted}".${workers.length > 0 ? ` Its workers: ${[...new Set(workers.map((worker) => worker.name))].join(", ")}.` : ""}`,
    );
  }

  /** A worker of this coordinator incarnation by its recorded ID. */
  protected own(coordinator: SessionRecord, id: string): WorkerRecord {
    const worker = this.store.get(id);
    if (!worker || worker.coordinatorId !== coordinator.id || worker.coordinatorIncarnation !== coordinator.incarnation) {
      throw new ManagedCopilotError("not_found", "This session no longer has the worker this call was for.");
    }
    return worker;
  }

  protected withSandbox(worker: WorkerRecord): WorkerRecord {
    if (worker.state === "stopped") throw new ManagedCopilotError("conflict", `Worker "${worker.name}" was stopped; its files are gone.`);
    if (worker.state === "starting" || !worker.incarnation) {
      throw new ManagedCopilotError("session_busy", worker.state === "starting" ? `Worker "${worker.name}" is still starting.` : `Worker "${worker.name}" has no sandbox: ${worker.error ?? "it never started"}.`);
    }
    return worker;
  }

  /**
   * The worker's sandbox ID, read while the session is still the worker's own: file calls made with it never reach a
   * newer session that reuses the ID.
   */
  protected async pin(worker: WorkerRecord): Promise<string> {
    const info = await this.sandboxes().get(worker.id);
    if (!info || info.state === "deleting" || info.state === "deleted" || this.app.service("sessions").get(worker.id)?.incarnation !== worker.incarnation) {
      throw new ManagedCopilotError("conflict", `Worker "${worker.name}" no longer has a sandbox. Start a new worker instead.`);
    }
    return info.id;
  }

  protected sandboxes(): SandboxesService {
    return this.app.service("sandboxes");
  }

  protected agents(environment: string): readonly { readonly name: string; readonly description?: string }[] {
    try {
      return this.app.service("environments").resolve(environment).customizations?.agents ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The verified owner principal whose credential serves a session right now (for a worker: its coordinator's
   * connected client, or the owner's background sign-in), for one call made at once.
   */
  protected async principal(sessionId: string): Promise<Principal> {
    const sessions = this.app.service("sessions");
    if (!sessions.ownerPrincipal) throw new ManagedCopilotError("capability_unavailable", "This gateway cannot act for a session's owner, so it cannot start workers");
    try {
      return await sessions.ownerPrincipal(sessionId);
    } catch (error) {
      if (isManagedCopilotError(error, "authentication_required")) {
        throw new ManagedCopilotError(
          "authentication_required",
          "Workers run as this session's owner, who has no connected client right now and no background sign-in. Reconnect, or run `npx managed-copilot login` so work continues while you're away.",
        );
      }
      throw error;
    }
  }

  protected coordinatorCurrent(worker: WorkerRecord): boolean {
    return this.app.service("sessions").get(worker.coordinatorId)?.incarnation === worker.coordinatorIncarnation;
  }

  /** Whether a session is the worker's: its recorded incarnation or, before one was recorded, the one its start created. */
  protected isWorkerSession(session: SessionRecord, worker: WorkerRecord): boolean {
    if (worker.incarnation !== undefined) return session.incarnation === worker.incarnation;
    return session.ownerId === worker.ownerId && session.parentSessionId === worker.coordinatorId && session.parentIncarnation === worker.coordinatorIncarnation;
  }

  protected launch(worker: WorkerRecord, principal: Principal, coordinator: SessionRecord): void {
    const run = this.#runLaunch(worker, principal, coordinator).finally(() => {
      this.launches.delete(worker.id);
      // Stopped while it started: what the start created goes now (after a shutdown, recovery does it).
      if (this.isClosed) return;
      const latest = this.store.get(worker.id);
      if (latest?.cleanup) void this.cleanup(latest);
    });
    this.launches.set(worker.id, run.catch((error: unknown) => this.log.warn("A worker start ended unexpectedly", { workerId: worker.id, error: (error as Error).message })));
  }

  async #runLaunch(worker: WorkerRecord, principal: Principal, coordinator: SessionRecord): Promise<void> {
    const sessions = this.app.service("sessions");
    let created = false;
    try {
      // The coordinator's caller narrowed its network: the same narrowing applies to what it starts.
      const network = coordinator.environmentRequest.network;
      const result = await sessions.create(principal, {
        sessionId: worker.id,
        environment: { name: worker.environment, ...(network !== undefined ? { network } : {}) },
        ...(worker.model ? { model: worker.model } : {}),
        ...(worker.agent ? { agent: worker.agent } : {}),
        systemMessage: { mode: "append", content: WORKER_INSTRUCTIONS },
        parentSessionId: worker.coordinatorId,
        clientName: WORKER_CLIENT_NAME,
      });
      created = true;
      // A gateway shutting down leaves the rest to recovery, which finds the session by its parent.
      if (this.isClosed) return;
      const incarnation = result.incarnation ?? sessions.get(worker.id)?.incarnation;
      if (!incarnation) throw new ManagedCopilotError("not_found", "The worker's session was deleted while it started");
      this.store.setIncarnation(worker.id, incarnation);
      if (!this.#stillStarting(worker.id)) return;
      // Fails now when nothing can act for the owner; the send itself lends no credential to the worker.
      const sender = await this.principal(worker.id);
      if (this.isClosed || !this.#stillStarting(worker.id)) return;
      const working = this.store.messaged(worker.id, ["starting"]);
      if (!working) return;
      const runs = this.runStarts.get(worker.id) ?? 0;
      this.emit("worker.started", working);
      this.changed(working);
      this.sending.add(worker.id);
      try {
        await sessions.send(sender, worker.id, { prompt: worker.task }, { incarnation, lendCredential: false });
      } catch (error) {
        // A gateway shutting down leaves it to recovery; a run that started got the task.
        if (this.isClosed || (this.runStarts.get(worker.id) ?? 0) !== runs) return;
        const failed = this.store.undelivered(worker.id, "failed", `Couldn't give it its task: ${describeError(error)}. Message it with the task to try again, or stop it.`);
        if (failed) {
          this.emit("worker.failed", failed);
          this.changed(failed);
        }
        this.log.warn("A worker did not get its task", { coordinatorId: worker.coordinatorId, workerId: worker.id, error: (error as Error).message });
        return;
      } finally {
        // As in `message`: the send's outcome settles what a close during it left.
        this.sending.delete(worker.id);
        this.cancelStoppedCheck(worker.id);
      }
      this.log.info("Worker started", { coordinatorId: worker.coordinatorId, workerId: worker.id, environment: worker.environment });
    } catch (error) {
      if (this.isClosed) return;
      const reason = created ? `Couldn't give it its task: ${describeError(error)}. Message it with the task to try again, or stop it.` : `Couldn't start: ${describeError(error)}`;
      this.fail(worker, reason, ["starting"]);
      if (!created) this.workers.delete(worker.id);
      this.log.warn("A worker failed to start", { coordinatorId: worker.coordinatorId, workerId: worker.id, environment: worker.environment, error: (error as Error).message });
    }
  }

  /** Whether a start may go on: the worker is still starting and its coordinator still exists (else it is stopped now). */
  #stillStarting(workerId: string): boolean {
    const current = this.store.get(workerId);
    if (current?.state !== "starting") return false;
    if (this.coordinatorCurrent(current)) return true;
    this.markStopped(current, "Its coordinator session was deleted.");
    return false;
  }

  protected fail(worker: WorkerRecord, message: string, from: readonly WorkerState[]): void {
    const failed = this.store.update(worker.id, { state: "failed", error: message }, from);
    if (!failed) return;
    this.emit("worker.failed", failed);
    this.changed(failed);
  }

  /** Marks the worker stopped; unless its session is known to be gone, deleting that is outstanding (`#cleanup`). */
  protected markStopped(worker: WorkerRecord, reason: string, options: { readonly sessionGone?: boolean } = {}): WorkerRecord | undefined {
    this.workers.delete(worker.id);
    this.runs.delete(worker.id);
    this.runStarts.delete(worker.id);
    const stopped = this.store.update(worker.id, { state: "stopped", error: reason, cleanup: options.sessionGone !== true }, ["starting", "working", "idle", "failed"]);
    if (!stopped) return undefined;
    this.emit("worker.stopped", stopped);
    this.changed(stopped);
    return stopped;
  }

  /**
   * Deletes a stopped worker's session, only while it is still the worker's own, and records that nothing is left
   * only once it is gone. Unfinished cleanups stay outstanding and are retried. A start in flight cleans up when it
   * ends.
   */
  protected cleanup(worker: WorkerRecord): Promise<CleanupOutcome> {
    if (this.launches.has(worker.id) || this.handsLaunches.has(worker.id)) return Promise.resolve({ state: "deleting" });
    const running = this.#cleanups.get(worker.id);
    if (running) return running;
    const done = this.#runCleanup(worker)
      .catch((error: unknown): CleanupOutcome => {
        this.log.warn("A worker cleanup failed", { workerId: worker.id, error: (error as Error).message });
        return { state: "failed", reason: describeError(error) };
      })
      .finally(() => this.#cleanups.delete(worker.id));
    this.#cleanups.set(worker.id, done);
    return done;
  }

  async #runCleanup(worker: WorkerRecord): Promise<CleanupOutcome> {
    const sessions = this.app.service("sessions");
    const session = sessions.get(worker.id);
    if (session && this.isWorkerSession(session, worker)) {
      try {
        // Called in the same step as the check above: core deletes this incarnation only.
        await sessions.delete(worker.ownerId, worker.id);
      } catch (error) {
        // A gateway shutting down records nothing more: recovery checks again.
        if (this.isClosed) return { state: "deleting" };
        if (isManagedCopilotError(error, "conflict")) {
          // Another deletion of it is under way. When it finishes, `#onDeleted` records that; if it fails, this retries.
          this.#retryCleanups();
          return { state: "deleting" };
        }
        if (!isManagedCopilotError(error, "not_found")) {
          this.log.warn("Could not delete a stopped worker's session; will retry", { workerId: worker.id, error: (error as Error).message });
          this.#retryCleanups();
          return { state: "failed", reason: describeError(error) };
        }
      }
    }
    if (this.isClosed) return { state: "deleted" };
    // Gone, or the ID names another session now: nothing of the worker's is left.
    this.store.update(worker.id, { cleanup: false });
    this.#cleanupDelay = CLEANUP_RETRY_MS;
    return { state: "deleted" };
  }

  #retryCleanups(): void {
    if (this.cleanupTimer || this.isClosed) return;
    const delay = this.#cleanupDelay;
    this.#cleanupDelay = Math.min(delay * 2, CLEANUP_RETRY_MAX_MS);
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      for (const worker of this.store.pendingCleanup()) void this.cleanup(worker);
    }, delay);
    this.cleanupTimer.unref?.();
  }

  protected emit(type: Extract<PlatformEventType, `worker.${string}`>, worker: WorkerRecord): void {
    const coordinator = this.app.service("sessions").get(worker.coordinatorId);
    const data: WorkerEventData = {
      workerId: worker.id,
      name: worker.name,
      environment: worker.environment,
      state: worker.state,
      ...(worker.error ? { error: clip(worker.error, EVENT_ERROR_LIMIT) } : {}),
      ...(worker.role === "hands" ? { role: "hands" as const, ...(worker.agentId ? { agentId: worker.agentId } : {}) } : {}),
    };
    try {
      this.app.service("events").emit(type, {
        ownerId: worker.ownerId,
        sessionId: worker.coordinatorId,
        ...(coordinator?.incarnation === worker.coordinatorIncarnation ? { environment: coordinator.environment } : {}),
        data: data as unknown as Record<string, unknown>,
      });
    } catch (error) {
      this.log.warn("Could not publish a worker event", { type, workerId: worker.id, error: (error as Error).message });
    }
  }

  /** Wakes the waits of the worker's coordinator. */
  protected changed(worker: WorkerRecord): void {
    for (const waiter of this.waiters) if (waiter.coordinatorId === worker.coordinatorId) waiter.check();
  }

  protected run(workerId: string): RunState {
    let run = this.runs.get(workerId);
    if (!run) {
      run = {};
      this.runs.set(workerId, run);
    }
    return run;
  }
}
