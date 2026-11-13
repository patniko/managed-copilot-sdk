// The `sandboxes` service (spec sections 4 and 5): per-session sandboxes on a pluggable backend (providers/), created
// only when setup and the runtime are ready, stopped when idle after work drains, resumed without replaying setup, and
// deleted with crash-safe reconciliation.
import type { Readable } from "node:stream";
import {
  ManagedCopilotError,
  SANDBOX_LIMITS,
  type ExecInfo,
  type ExecResult,
  type FileEntry,
  type InfraFact,
  type SandboxState,
} from "@managed-copilot/protocol";
import { redactText } from "../../redaction.js";
import { SandboxAgentClient } from "./agent-client.js";
import type { ArtifactService } from "./artifacts.js";
import type {
  ExecOptions,
  ExecReadOptions,
  FileCallOptions,
  FileDownload,
  FileWriteOptions,
  SandboxesService,
  SandboxRuntimeEvent,
} from "./contract.js";
import type { ExecRow, SandboxRow } from "./store.js";
import {
  ACTION_REQUESTED,
  ACTION_COMPLETED,
  IDLE_SWEEP_MS,
  RECONCILE_MS,
  ABANDONED_SWEEP_MS,
  SHUTDOWN_DRAIN_MS,
  PROBE_MS,
  RECOVERY_GRACE_MS,
  type LiveState,
  optional,
  OPERATOR_STOP_QUIET_MS,
  operatorSetup,
  type SandboxOperatorRecord,
} from "./support.js";
import { SandboxLifecycle } from "./lifecycle.js";

export class SandboxService extends SandboxLifecycle implements SandboxesService {
  attachArtifacts(artifacts: ArtifactService): void {
    this.artifacts = artifacts;
  }

  // Operator views -----------------------------------------------------------------------------------------------

  /** The backend's readiness, its non-secret facts, and sandbox counts (operator console). */
  async operatorStatus(): Promise<{
    provider: string;
    available: boolean;
    checkedAt?: string;
    lastError?: string;
    defaultIdleSeconds: number;
    facts: readonly InfraFact[];
    counts: Partial<Record<SandboxState, number>>;
  }> {
    const counts: Partial<Record<SandboxState, number>> = {};
    for (const row of this.options.store.all()) counts[row.state] = (counts[row.state] ?? 0) + 1;
    let facts: readonly InfraFact[] = [];
    try {
      facts = (await this.options.provider.describe?.()) ?? [];
    } catch (error) {
      facts = [{ label: "Details", value: `Unavailable: ${(error as Error).message}` }];
    }
    return {
      provider: this.options.provider.kind,
      available: this.isAvailable,
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.lastProbeError ? { lastError: redactText(this.lastProbeError) } : {}),
      defaultIdleSeconds: this.options.defaultIdleSeconds,
      facts,
      counts,
    };
  }

  /** Sandboxes of every owner, most recently updated first (never their keys, tokens, placeholders, or variables). */
  operatorSandboxes(query: { readonly state?: SandboxState; readonly ownerId?: number; readonly sessionId?: string; readonly limit?: number } = {}): SandboxOperatorRecord[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    return this.options.store
      .all()
      .filter((row) => (query.state ? row.state === query.state : row.state !== "deleted"))
      .filter((row) => query.ownerId === undefined || row.ownerId === query.ownerId)
      .filter((row) => query.sessionId === undefined || row.sessionId === query.sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((row) => this.#operatorRecord(row));
  }

  #operatorRecord(row: SandboxRow): SandboxOperatorRecord {
    const live = this.live.get(row.sessionId);
    return {
      id: row.id,
      sessionId: row.sessionId,
      ownerId: row.ownerId,
      environment: row.environment,
      size: row.size,
      state: row.state,
      ...(row.image ? { image: row.image } : {}),
      ...(row.imageId ? { imageId: row.imageId } : {}),
      network: row.network,
      vaults: row.vaults,
      ...(row.subnet ? { subnet: row.subnet } : {}),
      idleTimeoutSeconds: row.idleTimeoutSeconds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.stoppedAt ? { stoppedAt: row.stoppedAt } : {}),
      ...(row.error ? { error: { ...(row.errorCode ? { code: row.errorCode } : {}), message: redactText(row.error) } } : {}),
      ...(row.setup ? { setup: operatorSetup(row.setup) } : {}),
      ...(live
        ? {
            activity: {
              runtimes: live.runtimes.size,
              busy: live.busy,
              turnRunning: live.turnRunning,
              lastActivityAt: new Date(live.lastActivity).toISOString(),
              pending: live.pending.size,
            },
          }
        : {}),
    };
  }

  /**
   * An operator's stop: like an idle stop, but without waiting out the idle timeout. Refused with `session_busy` while
   * the session has work (a running turn, pending tool calls, open durable actions, a call core has in flight to its
   * runtime, an attached Copilot CLI) or was active moments ago, so it never cuts a turn that is starting. The checks
   * and the runtime's close run in one synchronous step. State volumes are kept; the session restarts the sandbox on
   * next use.
   */
  operatorStop(sessionId: string, reason: string): Promise<{ readonly sandboxId: string; readonly stopped: boolean }> {
    return this.withLock(sessionId, async () => {
      const row = this.options.store.bySession(sessionId);
      if (!row || row.state === "deleted" || row.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} has no sandbox`, { sessionId });
      if (row.state !== "running") throw new ManagedCopilotError("conflict", `Sandbox ${row.id} is ${row.state}, not running.`, { sandboxId: row.id, state: row.state });
      const live = this.live.get(sessionId);
      if (live && (live.turnRunning || live.pending.size > 0 || live.busy > 0)) {
        throw new ManagedCopilotError("session_busy", `Sandbox ${row.id} is working (a turn or a tool call is in progress). Stop it once the session is idle.`, { sandboxId: row.id });
      }
      if (live ? this.durablyBusy(sessionId, live) : this.hasOpenActions(sessionId)) {
        throw new ManagedCopilotError("session_busy", `Sandbox ${row.id}'s session is waiting on actions (tool calls or prompts), or on a turn that was running when the gateway restarted. Stop it once the session is idle.`, { sandboxId: row.id });
      }
      if (this.options.store.liveExecs(row.id).length > 0) {
        throw new ManagedCopilotError("session_busy", `Sandbox ${row.id} is running commands. Stop it once they finish (or its owner stops them).`, { sandboxId: row.id });
      }
      const activity = this.sessions()?.runtimeActivity?.(sessionId);
      if (activity?.busy) throw new ManagedCopilotError("session_busy", `Sandbox ${row.id}'s session is busy: ${activity.busy}. Stop it once the session is idle.`, { sandboxId: row.id });
      // A turn the runtime accepted a moment ago may not have reported itself yet.
      const lastActive = Math.max(live?.lastActivity ?? 0, activity?.lastRequestAt ?? 0);
      if (Date.now() - lastActive < OPERATOR_STOP_QUIET_MS) {
        throw new ManagedCopilotError("session_busy", `Sandbox ${row.id} was in use moments ago. Try again in a few seconds, once the session is idle.`, { sandboxId: row.id });
      }
      await this.stopSandbox(sessionId, reason);
      return { sandboxId: row.id, stopped: this.options.store.bySession(sessionId)?.state === "stopped" };
    });
  }

  // Files --------------------------------------------------------------------------------------------------------

  /**
   * The session's sandbox agent, starting the sandbox if it is stopped. With `sandboxId`, only while that is still the
   * session's sandbox (checked before the start and again after it).
   */
  async agentFor(sessionId: string, sandboxId?: string): Promise<SandboxAgentClient> {
    this.expectSandbox(sessionId, sandboxId);
    await this.ensureRunning(sessionId);
    const row = this.row(sessionId);
    this.expectSandbox(sessionId, sandboxId, row);
    return this.agent(row);
  }

  protected expectSandbox(sessionId: string, sandboxId: string | undefined, row: SandboxRow | undefined = this.options.store.bySession(sessionId)): void {
    if (sandboxId === undefined || (row?.id === sandboxId && row.state !== "deleting" && row.state !== "deleted")) return;
    throw new ManagedCopilotError("not_found", `Session ${sessionId} no longer has the sandbox this call was for.`, { sessionId, sandboxId });
  }

  async listFiles(sessionId: string, path: string, options: FileCallOptions & { readonly recursive?: boolean } = {}): Promise<FileEntry[]> {
    const agent = await this.agentFor(sessionId, options.sandboxId);
    return this.track(sessionId, agent.listFiles(path, options.recursive === true));
  }

  async readFile(sessionId: string, path: string, options: FileCallOptions = {}): Promise<FileDownload> {
    const agent = await this.agentFor(sessionId, options.sandboxId);
    const live = this.liveFor(sessionId);
    live.busy++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      live.busy = Math.max(0, live.busy - 1);
      live.lastActivity = Date.now();
    };
    try {
      const file = await agent.readFile(path);
      file.body.once("end", release);
      file.body.once("error", release);
      file.body.once("close", release);
      const name = path.replace(/^\/workspace\//, "").replace(/^\.?\/+/, "");
      return { entry: { path: name, type: "file", size: file.size, modifiedAt: file.modifiedAt }, body: file.body };
    } catch (error) {
      release();
      throw error;
    }
  }

  async writeFile(sessionId: string, path: string, body: Readable, options: FileWriteOptions = {}): Promise<FileEntry> {
    if (options.size !== undefined && options.size > SANDBOX_LIMITS.uploadBytes) {
      throw new ManagedCopilotError("invalid_request", `Uploads are limited to ${Math.round(SANDBOX_LIMITS.uploadBytes / (1024 * 1024))} MiB.`);
    }
    const agent = await this.agentFor(sessionId, options.sandboxId);
    const entry = await this.track(
      sessionId,
      agent.writeFile(path, body, { overwrite: options.overwrite !== false, ...(options.size !== undefined ? { size: options.size } : {}), ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}) }),
    );
    return { path: entry.path, type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
  }

  // Commands -----------------------------------------------------------------------------------------------------

  exec(sessionId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.execs.exec(sessionId, command, options);
  }

  readExec(sessionId: string, execId: string, options: ExecReadOptions = {}): Promise<ExecResult> {
    return this.execs.read(sessionId, execId, options);
  }

  writeExec(sessionId: string, execId: string, input: { readonly data?: string; readonly eof?: boolean }, options: FileCallOptions = {}): Promise<ExecInfo> {
    return this.execs.write(sessionId, execId, input, options);
  }

  stopExec(sessionId: string, execId: string, options: FileCallOptions & { readonly reason?: string } = {}): Promise<ExecInfo> {
    return this.execs.stop(sessionId, execId, options);
  }

  listExecs(sessionId: string, options: FileCallOptions = {}): ExecInfo[] {
    return this.execs.list(sessionId, options);
  }

  async publishOutputs(sessionId: string, turnId: string): Promise<void> {
    const artifacts = this.artifacts;
    if (!artifacts) return;
    this.row(sessionId);
    artifacts.turnStarted(sessionId, turnId);
    const turnIds = artifacts.turnsCompleted(sessionId, "completed");
    if (turnIds.length > 0) await artifacts.publish(sessionId, turnIds, "completed");
  }

  /** A command ended: a standalone workspace-only sandbox publishes its outputs (each command is its "turn"). */
  protected execEnded(row: ExecRow): void {
    this.execActivity(row.sessionId);
    const live = this.live.get(row.sessionId);
    if (live) live.lastActivity = Date.now();
    const session = this.sessions()?.get(row.sessionId);
    if (session?.kind !== "workspace" || session.parentSessionId !== undefined) return;
    const sandbox = this.options.store.bySession(row.sessionId);
    // Never restart a sandbox that is stopping just to publish what a command left.
    if (sandbox?.id !== row.sandboxId || sandbox.state !== "running" || this.stoppingSessions.has(row.sessionId) || this.stopping) return;
    const artifacts = this.artifacts;
    if (!artifacts) return;
    artifacts.turnStarted(row.sessionId, row.id);
    const outcome = row.state === "completed" ? "completed" : "cancelled";
    const turnIds = artifacts.turnsCompleted(row.sessionId, outcome);
    if (turnIds.length === 0) return;
    void artifacts.publish(row.sessionId, turnIds, outcome).catch((error: unknown) => this.log.warn("Publishing a command's outputs failed", { sessionId: row.sessionId, error: (error as Error).message }));
  }

  protected execActivity(sessionId: string): void {
    try {
      this.sessions()?.execActivity?.(sessionId, this.execs.liveCount(sessionId));
    } catch (error) {
      this.log.warn("Could not report command activity", { sessionId, error: (error as Error).message });
    }
  }

  // Events, idle stop, and reconciliation --------------------------------------------------------------------------

  #onEvent(sessionId: string, event: SandboxRuntimeEvent): void {
    if (!this.active.has(sessionId)) return;
    const live = this.liveFor(sessionId);
    live.lastActivity = Date.now();
    const data = (event.data ?? {}) as Record<string, unknown>;
    const requestId = typeof data["requestId"] === "string" ? (data["requestId"] as string) : typeof data["toolCallId"] === "string" ? (data["toolCallId"] as string) : undefined;
    if (ACTION_REQUESTED.has(event.type)) {
      live.pending.add(requestId ?? event.id);
      return;
    }
    if (ACTION_COMPLETED.has(event.type)) {
      if (requestId) live.pending.delete(requestId);
      return;
    }
    if (event.agentId) return;
    const artifacts = this.artifacts;
    if (event.type === "user.message") {
      const turnId = typeof data["messageId"] === "string" ? (data["messageId"] as string) : event.id;
      artifacts?.turnStarted(sessionId, turnId);
      live.turnRunning = true;
      live.turnFailed = false;
      // Root-turn tracking is re-established; the restart guard is no longer needed.
      live.recoveredAt = undefined;
    } else if (event.type === "session.error") {
      if (live.turnRunning) live.turnFailed = true;
    } else if (event.type === "session.idle") {
      const outcome = data["aborted"] === true ? "cancelled" : live.turnFailed ? "failed" : "completed";
      live.turnRunning = false;
      live.turnFailed = false;
      live.pending.clear();
      // The turn that was running across the restart (if any) has ended.
      live.recoveredAt = undefined;
      const turnIds = artifacts?.turnsCompleted(sessionId, outcome) ?? [];
      if (artifacts && turnIds.length > 0) {
        void artifacts.publish(sessionId, turnIds, outcome).catch((error: unknown) => {
          // Only possible when the ledger closes under a publication that outlasted the shutdown drain.
          if (this.computeStopping) this.log.info("A publication was cut off by gateway shutdown", { sessionId, error: (error as Error).message });
          else this.log.warn("Publication crashed", { sessionId, error: (error as Error).message });
        });
      }
    }
  }

  #sweepIdle(): void {
    if (this.stopping) return;
    for (const row of this.options.store.inStates(["running"])) {
      const live = this.liveFor(row.sessionId);
      if (live.turnRunning || live.pending.size > 0 || live.busy > 0 || this.durablyBusy(row.sessionId, live)) continue;
      if (Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000) continue;
      void this.withLock(row.sessionId, () => this.stopSandbox(row.sessionId, "idle", true)).catch((error: unknown) =>
        this.log.warn("Idle stop failed", { sessionId: row.sessionId, error: (error as Error).message }),
      );
    }
  }

  /**
   * Work that in-memory tracking cannot see after a gateway restart: open durable actions (the stock runtime does not
   * re-emit pending requests), and a turn the ledger last saw running in a sandbox recovered at startup, until its
   * events are observed again or the recovery grace ends.
   */
  protected durablyBusy(sessionId: string, live: LiveState): boolean {
    if (this.hasOpenActions(sessionId)) return true;
    if (live.recoveredAt !== undefined && Date.now() - live.recoveredAt < RECOVERY_GRACE_MS) {
      return this.sessions()?.get?.(sessionId)?.lastTurn?.status === "running";
    }
    return false;
  }

  /**
   * Whether durable owns open actions of the session's current incarnation: its runtime may be waiting on them (including
   * answers recorded but not yet delivered), and `continuePendingWork` carries them into a new runtime process. The same
   * predicate core uses (`hasOpenActions`); read errors count as yes.
   */
  protected hasOpenActions(sessionId: string): boolean {
    const actions = optional<{
      hasOpenActions?(sessionId: string, options?: { readonly incarnation?: string }): boolean;
      list?(sessionId: string, options: { readonly open?: boolean; readonly incarnation?: string }): readonly unknown[];
    }>(this.options.app, "actions");
    if (!actions) return false;
    try {
      // This incarnation's: actions an earlier session with the same ID left behind are not this session's work.
      const incarnation = this.sessions()?.get?.(sessionId)?.incarnation;
      const scope = incarnation ? { incarnation } : {};
      if (typeof actions.hasOpenActions === "function") return actions.hasOpenActions(sessionId, scope);
      return typeof actions.list === "function" && actions.list(sessionId, { open: true, ...scope }).length > 0;
    } catch (error) {
      this.log.warn("Could not read pending actions; treating the session as waiting on them", { sessionId, error: (error as Error).message });
      return true;
    }
  }

  /** Finishes interrupted work after a crash or restart and removes backend resources no record owns. */
  async reconcile(): Promise<void> {
    const { store, provider } = this.options;
    const rows = store.all().filter((row) => row.state !== "deleted");
    if (rows.length === 0 && !this.options.prepareOnStart) return;
    try {
      await this.ready();
    } catch (error) {
      this.log.warn(`Skipping sandbox reconciliation: the ${provider.kind} backend is not reachable`, { error: (error as Error).message });
      return;
    }
    for (const row of rows) {
      try {
        if (row.state === "provisioning" || row.state === "setting_up") {
          await this.withLock(row.sessionId, async () => {
            store.update(row.sessionId, { state: "failed", errorCode: "setup_failed", error: "Sandbox creation was interrupted before setup finished; it is not replayed." });
            await provider.remove(row.id);
            await this.unregisterEgress(row);
          });
        } else if (row.state === "deleting") {
          await this.delete(row.sessionId, { sandboxId: row.id });
        } else if (row.state === "running" || row.state === "stopping") {
          if (!(await provider.isRunning(row.id))) store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
          else if (row.state === "stopping") {
            // A stop interrupted by the restart: finish it rather than leave the sandbox unmanaged.
            await this.withLock(row.sessionId, async () => {
              await provider.stop(row.id);
              await this.unregisterEgress(row);
              store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
            });
          } else {
            await provider.reattach?.(row.id);
            this.liveFor(row.sessionId).recoveredAt = Date.now();
          }
        } else if (row.state === "failed") {
          // Never-ready sandboxes hold no user state; failed resumes keep their volumes until the session is deleted.
          if (row.setup?.state === "succeeded") await provider.stop(row.id);
          else await provider.remove(row.id);
        }
      } catch (error) {
        this.log.warn("Sandbox reconciliation step failed", { sessionId: row.sessionId, sandboxId: row.id, state: row.state, error: (error as Error).message });
      }
    }
    // Commands of sandboxes still running are followed again; those of stopped sandboxes stopped with them.
    await this.execs.recover().catch((error: unknown) => this.log.warn("Command recovery failed", { error: (error as Error).message }));
    try {
      for (const id of await provider.inventory()) {
        // Decide on current ownership: a sandbox created while this sweep ran already has its row.
        const row = store.byId(id);
        if (row && row.state !== "deleted") continue;
        this.log.info("Removing orphaned sandbox resources", { sandboxId: id });
        await provider.remove(id);
      }
    } catch (error) {
      this.log.warn("Orphan sweep failed", { error: (error as Error).message });
    }
  }

  async start(): Promise<void> {
    const interrupted = this.artifacts?.failInterruptedTurns() ?? 0;
    if (interrupted > 0) this.log.warn("Marked turns and publications interrupted by a gateway restart as failed", { count: interrupted });
    const sessions = this.sessions();
    if (sessions?.subscribe) this.unsubscribe = sessions.subscribe((sessionId, event) => this.#onEvent(sessionId, event));
    else this.log.warn("The sessions service is unavailable; artifact publication and idle tracking are disabled");
    await this.reconcile();
    // Idle sweeps start only after reconciliation restored what in-memory state cannot know.
    this.timers.push(setInterval(() => this.#sweepIdle(), IDLE_SWEEP_MS).unref());
    this.timers.push(
      setInterval(() => {
        for (const row of this.options.store.inStates(["deleting"])) void this.delete(row.sessionId, { sandboxId: row.id }).catch(() => undefined);
      }, RECONCILE_MS).unref(),
    );
    // Keeps `available` current: a backend that starts later is advertised, one that goes away stops being advertised.
    this.timers.push(setInterval(() => void this.probe(), PROBE_MS).unref());
    if (ABANDONED_SWEEP_MS > 0 && this.options.provider.sweepAbandoned) {
      const sweep = () =>
        void this.options.provider.sweepAbandoned!().catch((error: unknown) => this.log.debug("Sweep for abandoned Docker resources skipped", { error: (error as Error).message }));
      sweep();
      this.timers.push(setInterval(sweep, ABANDONED_SWEEP_MS).unref());
    }
    if (this.options.prepareOnStart) {
      const { provider } = this.options;
      void this.ready()
        .then(() => provider.prepare?.())
        .catch((error: unknown) => this.log.warn("Sandbox preparation failed; it will be retried on first use", { error: (error as Error).message }));
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.shutdownController.abort();
    this.unsubscribe?.();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    // A turn that completed just before shutdown still publishes: publications under way finish (bounded) before
    // compute stops beneath them.
    if (this.artifacts && !(await this.artifacts.drain(SHUTDOWN_DRAIN_MS))) {
      this.log.info("Stopping sandboxes while turn outputs are still being published; those publications are recorded as interrupted");
    }
    this.computeStopping = true;
    const running = this.options.store.inStates(["running"]);
    for (const live of this.live.values()) for (const runtime of [...live.runtimes]) runtime.close();
    await Promise.all(
      running.map((row) =>
        this.withLock(row.sessionId, async () => {
          await this.execs.sandboxStopping(row, "The platform stopped, so the sandbox stopped while this command was running.");
          await this.options.provider.stop(row.id).catch(() => undefined);
          await this.unregisterEgress(row);
          this.options.store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
        }).catch(() => undefined),
      ),
    );
    // Publications that outlasted the drain fail fast once compute is gone; let them record that while the ledger is open.
    await this.artifacts?.drain(5_000);
    if (running.length > 0) this.log.info("Stopped sandboxes for shutdown; they resume on next use", { count: running.length });
    await this.options.provider.shutdown?.().catch(() => undefined);
  }
}

export type { SandboxOperatorRecord, SandboxServiceOptions } from "./support.js";
