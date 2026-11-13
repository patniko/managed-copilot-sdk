// Orchestrator workers: hands sandboxes (direct and mixed execution).
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_WORKERS,
  isManagedCopilotError,
  ManagedCopilotError,
  OUTPUTS_DIR,
  type EnvironmentConfig,
  type FileEntry,
} from "@managed-copilot/protocol";
import type { PlatformToolCallContext, SessionRecord } from "../core/contracts.js";
import type { RuntimeSessionEvent } from "../durable/contract.js";
import type { WorkerRecord } from "./store.js";
import {
  HANDS_CLIENT_NAME,
  type HandsSandbox,
  SELF_REF,
  COPY_FILES,
  COPY_BYTES,
  unanswered,
  executionOf,
  describeError,
} from "./support.js";
import { WorkerInternals } from "./internals.js";

export abstract class WorkerHandsSandboxes extends WorkerInternals {
  // ---------------------------------------------------------------------------------------------------------------
  // Hands sandboxes (direct and mixed)

  /**
   * The calling agent's hands sandbox, created the first time an agent needs one: with `subagents: "own"` each
   * sub-agent (`context.agentId`) gets its own, otherwise the coordinator incarnation has one. Creation is atomic and
   * counts against `maxWorkers`; concurrent calls wait for the same creation.
   */
  async hands(context: PlatformToolCallContext): Promise<HandsSandbox> {
    const { record: coordinator, config } = this.coordinator(context);
    if (executionOf(config) === "delegate") {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${coordinator.environment}" delegates work to workers; it has no sandbox of its own.`);
    }
    let agentId: string | undefined;
    if (config.subagents === "own") {
      agentId = context.agentId;
      // The runtime reported this call as a sub-agent's, but its attribution did not arrive: never share the root's.
      if (agentId === undefined && this.subagentCalls.has(context.toolCallId)) {
        throw new ManagedCopilotError("capability_unavailable", "The platform could not tell which sub-agent made this call, so it could not choose its sandbox. Try again.");
      }
    }
    const record = await this.#ensureHands(coordinator, config, agentId);
    return { record, sandboxId: await this.pin(record) };
  }

  /**
   * The hands sandbox for a tool call that runs a command: bound to the call (by its key) before the command starts,
   * so a replay or recovery of the call only ever reattaches in that sandbox. If that sandbox is gone, the call fails
   * as "may have run" (`needs_reconciliation`); nothing is created or started in another one.
   */
  async handsForCall(context: PlatformToolCallContext): Promise<HandsSandbox> {
    const bound = this.store.handsCallFor(context.idempotencyKey);
    if (bound === undefined) {
      const hands = await this.hands(context);
      const chosen = this.store.bindHandsCall(context.idempotencyKey, hands.record.id);
      if (chosen === hands.record.id) return hands;
      return this.#boundHands(chosen, context);
    }
    return this.#boundHands(bound, context);
  }

  async #boundHands(id: string, context: PlatformToolCallContext): Promise<HandsSandbox> {
    const { record: coordinator } = this.coordinator(context);
    const record = this.store.get(id);
    const gone = () =>
      new ManagedCopilotError("needs_reconciliation", "The sandbox this command was started in no longer exists, so it may or may not have run. It was not run again: check its effect before retrying.");
    if (!record || record.coordinatorId !== coordinator.id || record.coordinatorIncarnation !== coordinator.incarnation || record.state !== "idle" || !record.incarnation) throw gone();
    try {
      return { record, sandboxId: await this.pin(record) };
    } catch (error) {
      if (isManagedCopilotError(error, "conflict")) throw gone();
      throw error;
    }
  }

  async #ensureHands(coordinator: SessionRecord, config: EnvironmentConfig, agentId: string | undefined): Promise<WorkerRecord> {
    const startKey = `hands:${coordinator.id}:${coordinator.incarnation}:${agentId ?? ""}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = this.store.byStartKey(startKey);
      if (existing) {
        const launch = this.handsLaunches.get(existing.id);
        if (launch) return launch;
        if (existing.state === "idle" && existing.incarnation) return existing;
        if (existing.state === "starting") {
          // A restart cut its creation: recovery settles it; until then, settle it here.
          this.settleHands(existing);
          continue;
        }
        // Stopped or failed while keeping its key: a new one replaces it.
        this.store.retireStartKey(existing.id);
        continue;
      }
      const environment = config.workers?.[0];
      if (!environment) throw new ManagedCopilotError("capability_unavailable", `Environment "${coordinator.environment}" names no worker environment for its sandbox.`);
      const max = config.maxWorkers ?? DEFAULT_MAX_WORKERS;
      const { record: admitted, created } = this.store.admit(
        {
          id: randomUUID(),
          coordinatorId: coordinator.id,
          coordinatorIncarnation: coordinator.incarnation,
          ownerId: coordinator.ownerId,
          name: agentId ? `hands-${agentId.replace(/[^a-z0-9_-]/gi, "").slice(0, 8).toLowerCase() || "agent"}` : "hands",
          environment,
          task: agentId ? `Sandbox sub-agent ${agentId} works in directly.` : "Sandbox the coordinator works in directly.",
          startKey,
          role: "hands",
          ...(agentId ? { agentId } : {}),
        },
        max,
        {
          hint: `This session already has ${max} sandboxes and workers, the most it can have at once. ${
            agentId ? "Wait for a sub-agent to finish (its sandbox is released then) or stop a worker you no longer need" : "Stop a worker you no longer need"
          }, then try again.`,
        },
      );
      if (!created) continue;
      this.workers.add(admitted.id);
      const launch = this.#launchHands(admitted, coordinator).finally(() => {
        this.handsLaunches.delete(admitted.id);
        // Stopped while it started (its coordinator was deleted, or it failed after its session existed): what the
        // start created goes now (after a shutdown, recovery does it).
        if (this.isClosed) return;
        const latest = this.store.get(admitted.id);
        if (latest?.cleanup) void this.cleanup(latest);
      });
      this.handsLaunches.set(admitted.id, launch);
      return launch;
    }
    throw new ManagedCopilotError("conflict", "This session's sandbox changed while it was being prepared. Try again.");
  }

  async #launchHands(hands: WorkerRecord, coordinator: SessionRecord): Promise<WorkerRecord> {
    const sessions = this.app.service("sessions");
    try {
      if (!sessions.createWorkspace) throw new ManagedCopilotError("capability_unavailable", "This gateway cannot create workspace-only sandboxes.");
      const principal = await this.principal(coordinator.id);
      if (this.isClosed) return unanswered();
      const network = coordinator.environmentRequest.network;
      const result = await sessions.createWorkspace(principal, {
        sessionId: hands.id,
        environment: { name: hands.environment, ...(network !== undefined ? { network } : {}) },
        parentSessionId: coordinator.id,
        clientName: HANDS_CLIENT_NAME,
      });
      if (this.isClosed) return unanswered();
      const incarnation = result.incarnation ?? sessions.get(hands.id)?.incarnation;
      if (!incarnation) throw new ManagedCopilotError("not_found", "The sandbox was deleted while it started");
      this.store.setIncarnation(hands.id, incarnation);
      const ready = this.store.update(hands.id, { state: "idle", error: null }, ["starting"]);
      // Stopped meanwhile (its coordinator was deleted): what was created goes when the start ends.
      if (!ready) throw new ManagedCopilotError("conflict", "This session's sandbox was stopped while it started.");
      this.emit("worker.started", ready);
      this.log.info("Hands sandbox ready", { coordinatorId: coordinator.id, sandboxSessionId: hands.id, environment: hands.environment, agentId: hands.agentId });
      if (!this.coordinatorCurrent(ready)) {
        const stopped = this.markStopped(ready, "Its coordinator session was deleted.");
        if (stopped) void this.cleanup(stopped);
        throw new ManagedCopilotError("not_found", `Session ${coordinator.id} was not found`);
      }
      return ready;
    } catch (error) {
      if (this.isClosed) return unanswered();
      const reason = `Couldn't prepare the sandbox: ${describeError(error)}`;
      const failed = this.store.update(hands.id, { state: "failed", error: reason }, ["starting"]);
      if (failed) {
        this.emit("worker.failed", failed);
        this.store.retireStartKey(hands.id);
        if (failed.incarnation === undefined) this.workers.delete(hands.id);
        else this.markStopped(failed, reason);
      }
      this.log.warn("A hands sandbox failed to start", { coordinatorId: coordinator.id, sandboxSessionId: hands.id, error: (error as Error).message });
      throw isManagedCopilotError(error) ? new ManagedCopilotError(error.code, reason, error.details) : new ManagedCopilotError("internal", reason);
    }
  }

  /** A hands sandbox a stopped gateway left `starting`: ready if its workspace session exists, else failed (no slot). */
  protected settleHands(hands: WorkerRecord): void {
    const session = this.app.service("sessions").get(hands.id);
    if (session && this.isWorkerSession(session, hands) && session.kind === "workspace") {
      this.store.setIncarnation(hands.id, session.incarnation);
      this.store.update(hands.id, { state: "idle", error: null }, ["starting"]);
      return;
    }
    this.store.update(hands.id, { state: "failed", error: "The platform restarted before this sandbox was ready." }, ["starting"]);
    this.store.retireStartKey(hands.id);
    this.workers.delete(hands.id);
  }

  /**
   * Releases a sub-agent's hands sandbox (`subagents: "own"`) when the sub-agent finished: its `/workspace/outputs` is
   * copied into the root agent's sandbox under `outputs/<agent>/`, then it is deleted. A sandbox whose outputs could not
   * be copied is kept (it goes with the coordinator).
   */
  protected releaseHands(coordinatorId: string, agentId: string): void {
    const coordinator = this.app.service("sessions").get(coordinatorId);
    if (!coordinator) return;
    const hands = this.store.byStartKey(`hands:${coordinator.id}:${coordinator.incarnation}:${agentId}`);
    if (!hands || hands.state === "stopped" || this.releases.has(hands.id)) return;
    const run = (async () => {
      const launch = this.handsLaunches.get(hands.id);
      const ready = launch ? await launch.catch(() => undefined) : this.store.get(hands.id);
      if (!ready || ready.state !== "idle" || !ready.incarnation || this.isClosed) return;
      const config = this.app.config.deployment.environments[coordinator.environment];
      try {
        await this.#copyOutputs(ready, coordinator, config, agentId);
      } catch (error) {
        if (this.isClosed) return;
        this.log.warn("Could not copy a sub-agent's outputs; its sandbox is kept", { coordinatorId, sandboxSessionId: hands.id, error: (error as Error).message });
        this.store.update(hands.id, { error: `Its outputs could not be copied into the main sandbox (${describeError(error)}); it is kept until the session is deleted.` });
        return;
      }
      if (this.isClosed) return;
      const stopped = this.markStopped(ready, "Its sub-agent finished.");
      if (stopped) await this.cleanup(stopped);
    })()
      .catch((error: unknown) => this.log.warn("Releasing a sub-agent's sandbox failed", { coordinatorId, sandboxSessionId: hands.id, error: (error as Error).message }))
      .finally(() => this.releases.delete(hands.id));
    this.releases.set(hands.id, run);
  }

  async #copyOutputs(from: WorkerRecord, coordinator: SessionRecord, config: EnvironmentConfig | undefined, agentId: string): Promise<void> {
    const sandboxes = this.sandboxes();
    const source = await this.pin(from);
    const outputs = OUTPUTS_DIR.replace(/^\/workspace\//, "");
    let entries: FileEntry[];
    try {
      entries = await sandboxes.listFiles(from.id, outputs, { recursive: true, sandboxId: source });
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return;
      throw error;
    }
    const files = entries.filter((entry) => entry.type === "file");
    if (files.length === 0) return;
    if (!config || config.type !== "orchestrator") throw new ManagedCopilotError("capability_unavailable", "The session's environment is no longer an orchestrator.");
    // Kept rather than lose files: the copy is bounded like copy_worker_files.
    if (files.length > COPY_FILES) throw new ManagedCopilotError("invalid_request", `it saved more than ${COPY_FILES} files under outputs`);
    if (files.reduce((sum, file) => sum + file.size, 0) > COPY_BYTES) throw new ManagedCopilotError("invalid_request", `its outputs are larger than ${COPY_BYTES / (1024 * 1024)} MiB`);
    // The root agent's sandbox, within maxWorkers (it may not exist yet; at the bound, this sandbox is kept).
    const root = await this.#ensureHands(coordinator, config, undefined);
    const target = await this.pin(root);
    const label = agentId.replace(/[^A-Za-z0-9_-]/g, "") || "agent";
    for (const file of files) {
      const download = await sandboxes.readFile(from.id, file.path, { sandboxId: source });
      try {
        const rest = file.path.slice(outputs.length + 1);
        await sandboxes.writeFile(root.id, `${outputs}/${label}/${rest}`, download.body, { size: download.entry.size, sandboxId: target });
      } finally {
        download.body.destroy();
      }
    }
  }

  /** Publishes the coordinator's hands sandboxes' `/workspace/outputs` at the end of its turn (they have no turns). */
  protected publishHands(coordinatorId: string, event: RuntimeSessionEvent): void {
    const coordinator = this.app.service("sessions").get(coordinatorId);
    if (!coordinator || coordinator.type !== "orchestrator") return;
    const hands = this.store.forCoordinator(coordinator.id, coordinator.incarnation).filter((record) => record.role === "hands" && record.state === "idle" && record.incarnation);
    if (hands.length === 0) return;
    const turnId = coordinator.lastTurn?.turnId ?? String(event.id ?? randomUUID());
    for (const record of hands) {
      void this.sandboxes()
        .publishOutputs(record.id, turnId)
        .catch((error: unknown) => this.log.warn("Publishing a hands sandbox's outputs failed", { coordinatorId, sandboxSessionId: record.id, error: (error as Error).message }));
    }
  }

  /** `self` (the calling agent's own sandbox, in direct and mixed) or a worker by name or ID. */
  protected async target(coordinator: SessionRecord, ref: unknown, context: PlatformToolCallContext): Promise<WorkerRecord> {
    if (typeof ref === "string" && ref.trim().toLowerCase() === SELF_REF) {
      const config = this.app.config.deployment.environments[coordinator.environment];
      if (config && config.type === "orchestrator" && executionOf(config) !== "delegate") return (await this.hands(context)).record;
    }
    return this.find(coordinator, ref);
  }
}
