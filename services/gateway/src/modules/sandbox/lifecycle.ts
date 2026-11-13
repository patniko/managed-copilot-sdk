// The `sandboxes` service: creating, starting, opening runtimes in, stopping, and deleting sandboxes.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  SANDBOXD_ROUTES,
  type SandboxInfo,
  type SandboxSetupRecord,
} from "@managed-copilot/protocol";
import { InferenceBroker, isProviderTaken } from "./broker.js";
import type {
  CreateSandboxRequest,
  OpenRuntimeOptions,
  RuntimeStateImport,
  SandboxHandle,
  SandboxRuntime,
} from "./contract.js";
import { deferAgentSelection, rewriteSessionParams } from "./params.js";
import {
  SETTLE_MS,
  TURN_INTERRUPTED,
  type LiveState,
  toManaged,
  withOutputTail,
  collectRuntimeState,
} from "./support.js";
import { SandboxInternals } from "./internals.js";

export abstract class SandboxLifecycle extends SandboxInternals {
  // Implemented by later layers of SandboxService.
  protected abstract hasOpenActions(sessionId: string): boolean;
  protected abstract durablyBusy(sessionId: string, live: LiveState): boolean;

  // Lifecycle ----------------------------------------------------------------------------------------------------

  create(request: CreateSandboxRequest): Promise<SandboxHandle> {
    return this.withLock(request.sessionId, () => this.#create(request));
  }

  async #create(request: CreateSandboxRequest): Promise<SandboxHandle> {
    const started = Date.now();
    const { store, provider } = this.options;
    const environment = this.environment(request);
    const { plan, workloadEnv } = this.setupPlan(environment.config, request);
    await this.ready();
    const previous = store.bySession(request.sessionId);
    if (previous) {
      if (previous.state !== "deleted" && previous.state !== "failed") throw new ManagedCopilotError("conflict", `Session ${request.sessionId} already has a sandbox.`);
      await provider.remove(previous.id).catch(() => undefined);
      store.remove(request.sessionId);
    }
    const row = store.insert({
      id: `sbx_${randomBytes(12).toString("hex")}`,
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      environment: request.environment,
      size: request.size,
      network: request.network,
      vaults: [...(request.vaults ?? [])],
      state: "provisioning",
      key: randomBytes(32).toString("base64url"),
      runtimeToken: randomBytes(32).toString("base64url"),
      placeholder: `mcrt_${randomBytes(32).toString("base64url")}`,
      ...(environment.customizations ? { customizations: environment.customizations } : {}),
      workloadEnv,
      idleTimeoutSeconds: environment.config.idleTimeoutSeconds ?? this.options.defaultIdleSeconds,
      runtime: request.runtime !== false,
    });
    this.active.add(request.sessionId);
    this.log.info("Creating sandbox", { sessionId: row.sessionId, sandboxId: row.id, environment: row.environment, size: row.size, network: row.network.access });
    try {
      const image = await provider.ensureImage(request.environment, environment.config);
      store.update(row.sessionId, { image: image.ref, imageId: image.id });
      const egress = await this.registerEgress(row);
      await provider.create(this.spec(row, image.id), this.operation(row));
      store.update(row.sessionId, { state: "setting_up", startedAt: new Date().toISOString() });
      // Egress pins the proxy credential to the sandbox's source address; setup installs already go through it.
      await this.pinAddress(row);
      const agent = this.agent(row);
      await agent.waitHealthy(this.startTimeoutMs);
      const final = await agent.start(
        { mode: "create", setup: plan, platformEnv: egress.env, workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}), ...(row.runtime ? {} : { runtime: false }) },
        (event) => {
          if (event.type === "progress") store.update(row.sessionId, { setup: event.setup });
        },
      );
      if (final.type === "failed") {
        store.update(row.sessionId, { state: "failed", ...(final.setup ? { setup: final.setup } : {}), errorCode: final.code, error: final.message });
        const failedStep = final.setup?.steps.find((step) => step.state === "failed");
        throw new ManagedCopilotError(final.code === "internal" ? "internal" : "setup_failed", withOutputTail(final.message, failedStep?.output), {
          sandboxId: row.id,
          ...(failedStep ? { step: failedStep.name, ...(failedStep.exitCode !== undefined ? { exitCode: failedStep.exitCode } : {}), ...(failedStep.output ? { output: failedStep.output.slice(-2000) } : {}) } : {}),
        });
      }
      if (final.type !== "ready") throw new ManagedCopilotError("internal", "The sandbox did not report ready.");
      store.update(row.sessionId, { state: "running", setup: final.setup, errorCode: null, error: null });
      this.liveFor(row.sessionId).lastActivity = Date.now();
      this.log.info("Sandbox ready", { sessionId: row.sessionId, sandboxId: row.id, ms: Date.now() - started });
      return this.handle(this.row(row.sessionId));
    } catch (error) {
      const managed = toManaged(error);
      const current = store.bySession(row.sessionId);
      if (current && current.state !== "failed") store.update(row.sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      this.log.warn("Sandbox creation failed", { sessionId: row.sessionId, sandboxId: row.id, code: managed.code, error: managed.message });
      // A sandbox that never became ready holds no user state; release its container, volumes, and subnet now.
      await provider.remove(row.id).catch((cleanup: unknown) => this.log.warn("Could not remove a failed sandbox; reconciliation retries", { sandboxId: row.id, error: (cleanup as Error).message }));
      await this.unregisterEgress(row);
      throw managed;
    }
  }

  ensureRunning(sessionId: string): Promise<SandboxHandle> {
    return this.withLock(sessionId, () => this.#ensureRunning(sessionId));
  }

  async #ensureRunning(sessionId: string): Promise<SandboxHandle> {
    const { store, provider } = this.options;
    let row = this.row(sessionId);
    switch (row.state) {
      case "deleting":
        throw new ManagedCopilotError("not_found", `Session ${sessionId}'s sandbox is being deleted.`, { sessionId });
      case "failed":
        throw new ManagedCopilotError("state_restore_failed", row.error ?? "The sandbox failed and cannot be resumed.", { sandboxId: row.id });
      case "provisioning":
      case "setting_up":
        throw new ManagedCopilotError("state_restore_failed", "The sandbox never finished its initial setup.", { sandboxId: row.id });
      case "running": {
        await this.ready();
        if (await provider.isRunning(row.id)) {
          try {
            const status = await this.agent(row).health();
            if (status.state === "ready" && (!row.runtime || status.runtime.state === "running")) return this.handle(row);
          } catch {
            // fall through and restart it
          }
        }
        break;
      }
      default:
        break;
    }
    if (row.setup?.state !== "succeeded") {
      store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: "Initial setup did not complete, and setup is never replayed automatically." });
      throw new ManagedCopilotError("state_restore_failed", "This sandbox cannot be resumed because its initial setup did not complete; setup is never replayed automatically.", { sandboxId: row.id });
    }
    const started = Date.now();
    await this.ready();
    let fresh = false;
    const outcome = await provider.start(row.id, this.operation(row));
    if (outcome === "gone") {
      store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: "The sandbox's persistent storage no longer exists." });
      throw new ManagedCopilotError("state_restore_failed", "The sandbox's persistent storage no longer exists, so the session cannot be restored.", { sandboxId: row.id });
    }
    if (outcome === "recreate") {
      if (!row.imageId || !(await provider.hasImage(row.imageId))) {
        store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: `The sandbox's pinned image ${row.image ?? ""} is no longer available.` });
        throw new ManagedCopilotError("state_restore_failed", `The sandbox's pinned image (${row.image ?? row.imageId ?? "unknown"}) is no longer available, so its toolchain cannot be restored.`, { sandboxId: row.id });
      }
      await provider.create(this.spec(row, row.imageId), this.operation(row));
      fresh = true;
    }
    try {
      const egress = await this.registerEgress(row);
      await this.pinAddress(row);
      const agent = this.agent(row);
      await agent.waitHealthy(this.startTimeoutMs);
      const final = await agent.start(
        { mode: "resume", platformEnv: egress.env, workloadEnv: row.workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}), ...(row.runtime ? {} : { runtime: false }) },
        () => undefined,
      );
      if (final.type === "failed") throw new ManagedCopilotError(final.code === "internal" ? "internal" : "state_restore_failed", final.message, { sandboxId: row.id });
      store.update(sessionId, { state: "running", startedAt: new Date().toISOString(), errorCode: null, error: null });
      row = this.row(sessionId);
      this.liveFor(sessionId).lastActivity = Date.now();
      this.log.info("Sandbox resumed", { sessionId, sandboxId: row.id, ms: Date.now() - started, recreated: fresh });
      return this.handle(row);
    } catch (error) {
      const managed = toManaged(error);
      if (managed.code === "state_restore_failed") store.update(sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      else store.update(sessionId, { state: "stopped", errorCode: managed.code, error: managed.message });
      await provider.stop(row.id).catch(() => undefined);
      await this.unregisterEgress(row);
      throw managed;
    }
  }

  async openRuntime(sessionId: string, options: OpenRuntimeOptions): Promise<SandboxRuntime> {
    const row = this.row(sessionId);
    if (!row.runtime) throw new ManagedCopilotError("invalid_request", `Session ${sessionId} is a workspace-only sandbox; it has no agent or Copilot runtime.`, { sessionId });
    if (row.state !== "running") throw new ManagedCopilotError("capability_unavailable", `The session's sandbox is ${row.state}; resume the session first.`, { sandboxId: row.id });
    const agent = this.agent(row);
    // Which runtime process this connection reaches: a different one than before ended the turn the old one was running.
    // Best effort; an unreachable sandboxd fails the open below.
    const status = await agent.health().catch(() => undefined);
    if (status) this.#observeRuntime(sessionId, status.runtime.instance);
    const stream = await agent.openStream(SANDBOXD_ROUTES.runtime);
    const live = this.liveFor(sessionId);
    const broker = new InferenceBroker({
      sessionId,
      placeholder: row.placeholder,
      resolveToken: () => options.resolveToken(),
      invalidateToken: (token) => this.#invalidateToken(token),
      githubApiUrl: this.options.app.config.githubApiUrl,
      log: this.log,
      ...(options.inference ? { foundry: { account: options.inference.account, host: options.inference.host, token: () => options.inference!.token() } } : {}),
    });
    const deferredAgents = new Map<string, string>();
    // Counted for the operator console's traffic view: model calls the gateway brokers for sandboxes.
    const handlers = new Map(broker.handlers);
    const start = handlers.get("llmInference.httpRequestStart");
    if (start) {
      handlers.set("llmInference.httpRequestStart", (params) => {
        // Optional: test apps built without the gateway's metrics still broker.
        this.options.app.metrics?.increment("inference.requests");
        return start(params);
      });
    }
    const runtime: SandboxRuntime = {
      sandboxId: row.id,
      stream,
      connectionToken: row.runtimeToken,
      handlers,
      initialize: async (send) => {
        try {
          await broker.initialize(send);
        } catch (error) {
          if (!isProviderTaken(error)) throw error;
          throw await this.#replaceHeldRuntime(sessionId, row.id, runtime);
        }
      },
      prepareSessionParams: async (_method, params) => {
        const deferred = deferAgentSelection(rewriteSessionParams(params, row.customizations));
        if (deferred.agent) deferredAgents.set(typeof params["sessionId"] === "string" ? params["sessionId"] : sessionId, deferred.agent);
        // A Foundry session's model calls go to its account with the placeholder, which the broker swaps (never a token).
        return options.inference ? { ...deferred.params, provider: { ...options.inference.provider, bearerToken: row.placeholder } } : deferred.params;
      },
      sessionOpened: async (id) => {
        live.lastActivity = Date.now();
        await broker.sessionOpened(id);
        const agent = deferredAgents.get(id);
        deferredAgents.delete(id);
        if (agent) await broker.selectAgent(id, agent);
      },
      close: () => {
        broker.close();
        stream.destroy();
        live.runtimes.delete(runtime);
      },
    };
    live.runtimes.add(runtime);
    live.lastActivity = Date.now();
    stream.once("close", () => {
      broker.close();
      live.runtimes.delete(runtime);
    });
    return runtime;
  }

  /**
   * Stock runtimes keep their inference-provider registration with the first connection that registered, even after that
   * connection closed (verified on 1.0.103; nothing releases it), so after a gateway restart or a dropped link the runtime
   * refuses every new provider. With no other connection of this gateway open to it, the registration belongs to a
   * connection that is gone: the runtime process is replaced (session state stays on disk) and the caller reopens
   * (`details.reopen`). Sandboxes on images from before sandboxd could restart its runtime are stopped instead, and the
   * reopen starts them again.
   */
  async #replaceHeldRuntime(sessionId: string, sandboxId: string, runtime: SandboxRuntime): Promise<ManagedCopilotError> {
    const live = this.liveFor(sessionId);
    if ([...live.runtimes].some((other) => other !== runtime)) {
      return new ManagedCopilotError("conflict", "Another connection of this gateway is the sandbox runtime's inference provider; close it before opening the runtime again.", { sandboxId });
    }
    await this.withLock(sessionId, async () => {
      const row = this.row(sessionId);
      // A stop, delete, or recreate meanwhile replaced the process already.
      if (row.id !== sandboxId || row.state !== "running") return;
      try {
        const status = await this.agent(row).restartRuntime();
        live.runtimeInstance = status.runtime.instance;
        this.log.info("Restarted a sandbox runtime held by a connection that is gone", { sessionId, sandboxId });
      } catch (error) {
        if (!isManagedCopilotError(error, "not_found")) throw toManaged(error);
        // An older sandboxd without the route: stopping and starting the sandbox starts a fresh runtime. Started here,
        // because the reopen only opens the runtime again.
        await this.stopSandbox(sessionId, "its runtime was held by a connection that is gone");
        await this.#ensureRunning(sessionId);
        this.log.info("Restarted a sandbox whose runtime was held by a connection that is gone", { sessionId, sandboxId });
      }
      this.#runtimeReplaced(sessionId);
    });
    return new ManagedCopilotError("capability_unavailable", "The sandbox's runtime was restarted because a connection that is gone still held it. Reconnect to resume the session.", {
      sandboxId,
      reopen: true,
    });
  }

  /** Records which runtime process serves the session; a different process than before ended the old one's turn. */
  #observeRuntime(sessionId: string, instance: string | undefined): void {
    if (!instance) return;
    const live = this.liveFor(sessionId);
    const previous = live.runtimeInstance;
    live.runtimeInstance = instance;
    if (previous !== undefined && previous !== instance) this.#runtimeReplaced(sessionId);
  }

  /**
   * The session's runtime process was replaced. A turn the old process was running cannot finish: stock runtimes neither
   * continue nor end it when the session is resumed in a new process, unless it was waiting on actions durable still owns
   * (`continuePendingWork` restores those, and answering them continues the turn). Otherwise its outputs are recorded as
   * interrupted and idle stop stops waiting for it; core ends the turn in its ledger.
   */
  #runtimeReplaced(sessionId: string): void {
    if (this.hasOpenActions(sessionId)) return;
    const live = this.liveFor(sessionId);
    const turns = this.artifacts?.turnsInterrupted(sessionId, TURN_INTERRUPTED) ?? [];
    const wasRunning = live.turnRunning || turns.length > 0;
    live.turnRunning = false;
    live.turnFailed = false;
    live.pending.clear();
    live.recoveredAt = undefined;
    if (wasRunning) this.log.info("A turn ended because the sandbox runtime running it was replaced", { sessionId, turns: turns.length });
  }

  /**
   * Core's authenticator forgets a token GitHub rejected for this session's inference, so the next `resolveToken`
   * verifies it with GitHub again instead of handing it out from its cache.
   */
  #invalidateToken(token: string): void {
    const auth = (this.options.app.services as Record<string, unknown>)["auth"] as { invalidate?(token: string): void } | undefined;
    auth?.invalidate?.(token);
  }

  async connect(sessionId: string, port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ManagedCopilotError("invalid_request", "A port between 1 and 65535 is required.");
    await this.ensureRunning(sessionId);
    const row = this.row(sessionId);
    this.touch(sessionId);
    return this.agent(row).openStream(SANDBOXD_ROUTES.tunnel, { port: String(port) });
  }

  importRuntimeState(sessionId: string, options: RuntimeStateImport): Promise<{ files: number; bytes: number }> {
    return this.withLock(sessionId, () => this.#importRuntimeState(sessionId, options));
  }

  async #importRuntimeState(sessionId: string, options: RuntimeStateImport): Promise<{ files: number; bytes: number }> {
    const row = this.row(sessionId);
    if (row.state !== "running") {
      throw new ManagedCopilotError("capability_unavailable", `The session's sandbox is ${row.state}; runtime state can only be imported into a running sandbox.`, { sandboxId: row.id });
    }
    const files = await collectRuntimeState(options.sessionStateDir);
    // An empty directory cannot be resumed; refuse it before anything changes in the sandbox.
    if (files.length === 0) throw new ManagedCopilotError("invalid_request", `The runtime state directory ${options.sessionStateDir} has no files to import.`);
    const agent = this.agent(row);
    const status = await agent.health();
    if (status.state !== "ready" || status.runtime.state !== "running") {
      throw new ManagedCopilotError("capability_unavailable", `The sandbox runtime is ${status.runtime.state}; runtime state can only be imported once it is ready.`, { sandboxId: row.id });
    }
    // The carried turn (`activeTurnId`) runs on this process.
    this.#observeRuntime(sessionId, status.runtime.instance);
    const staging = randomBytes(8).toString("hex");
    let bytes = 0;
    const upload = async (): Promise<void> => {
      try {
        for (const file of files) {
          await agent.writeRuntimeImport(staging, file.relative, createReadStream(file.absolute), file.size);
          bytes += file.size;
        }
        await agent.commitRuntimeImport(staging, sessionId);
      } catch (error) {
        await agent.abortRuntimeImport(staging).catch(() => undefined);
        throw toManaged(error);
      }
    };
    // Busy for the whole transfer, so idle stop waits for it.
    await this.track(sessionId, upload());
    if (options.activeTurnId) {
      this.artifacts?.turnStarted(sessionId, options.activeTurnId);
      const live = this.liveFor(sessionId);
      live.turnRunning = true;
      live.turnFailed = false;
    }
    this.touch(sessionId);
    this.log.info("Imported runtime state", { sessionId, sandboxId: row.id, files: files.length, bytes, activeTurn: options.activeTurnId !== undefined });
    return { files: files.length, bytes };
  }

  async get(sessionId: string): Promise<SandboxInfo | undefined> {
    const row = this.options.store.bySession(sessionId);
    return row ? this.info(row) : undefined;
  }

  setupRecord(sessionId: string): SandboxSetupRecord | undefined {
    return this.options.store.bySession(sessionId)?.setup;
  }

  stop(sessionId: string, reason = "requested"): Promise<void> {
    return this.withLock(sessionId, () => this.stopSandbox(sessionId, reason));
  }

  protected async stopSandbox(sessionId: string, reason: string, idle = false): Promise<void> {
    const { store, provider } = this.options;
    const row = store.bySession(sessionId);
    if (!row || row.state !== "running") return;
    const live = this.live.get(sessionId);
    if (idle && live && (live.turnRunning || live.pending.size > 0 || live.busy > 0 || this.durablyBusy(sessionId, live) || Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000)) return;
    // Commands still writing output keep the sandbox up, until they are quiet for the idle timeout.
    if (idle && (await this.execs.holdsIdle(row, row.idleTimeoutSeconds * 1000))) return;
    this.stoppingSessions.add(sessionId);
    try {
      await this.execs.sandboxStopping(row, idle ? `The sandbox stopped after ${Math.round(row.idleTimeoutSeconds / 60) || 1} min without activity, so this command was stopped.` : `The sandbox stopped (${reason}), so this command was stopped.`);
    } finally {
      this.stoppingSessions.delete(sessionId);
    }
    store.update(sessionId, { state: "stopping" });
    for (const runtime of [...(live?.runtimes ?? [])]) runtime.close();
    try {
      await provider.stop(row.id);
    } catch (error) {
      store.update(sessionId, { state: "running" });
      throw toManaged(error);
    }
    // Only once the workload is stopped: unregistering first would leave a running sandbox without egress.
    await this.unregisterEgress(row);
    store.update(sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
    this.log.info("Sandbox stopped", { sessionId, sandboxId: row.id, reason });
  }

  delete(sessionId: string, options: { readonly sandboxId?: string } = {}): Promise<void> {
    const pending = this.pendingDeletes.get(sessionId) ?? [];
    pending.push(options.sandboxId);
    this.pendingDeletes.set(sessionId, pending);
    const done = () => {
      const index = pending.indexOf(options.sandboxId);
      if (index >= 0) pending.splice(index, 1);
      if (pending.length === 0 && this.pendingDeletes.get(sessionId) === pending) this.pendingDeletes.delete(sessionId);
    };
    return this.withLock(sessionId, () => this.#delete(sessionId, options.sandboxId)).finally(done);
  }

  /**
   * Whether the session is being deleted or is gone, as far as anyone has decided: its sandbox record is missing,
   * deleting, or deleted; a delete of its current sandbox is queued; or core has started deleting the session (core
   * records that before it closes the session's runtime or asks for the sandbox's deletion). Work interrupted by a
   * deletion reports that outcome rather than the transport error the deletion caused.
   */
  isGone(sessionId: string): boolean {
    const row = this.options.store.bySession(sessionId);
    if (!row || row.state === "deleting" || row.state === "deleted") return true;
    if ((this.pendingDeletes.get(sessionId) ?? []).some((expected) => expected === undefined || expected === row.id)) return true;
    try {
      const state = this.sessions()?.get(sessionId)?.state;
      return state === "deleting" || state === "deleted";
    } catch {
      return false;
    }
  }

  /** Resolves once operations already queued for the session (such as a delete) have run, or after `timeoutMs`. */
  async settled(sessionId: string, timeoutMs = SETTLE_MS): Promise<void> {
    const queued = this.locks.get(sessionId);
    if (!queued) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([queued, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  /**
   * True once shutdown has started stopping sandboxes, after publications under way had their chance to finish: a
   * publication that fails from then on was cut off by the shutdown. (During the drain before it, compute is healthy and
   * failures are the publications' own.)
   */
  get stoppingCompute(): boolean {
    return this.computeStopping;
  }

  async #delete(sessionId: string, expected: string | undefined): Promise<void> {
    const { store, provider } = this.options;
    const row = store.bySession(sessionId);
    // Decided inside the lock: a delete that names the sandbox it means (promotion releasing its candidate, retries of
    // an interrupted delete) never removes a newer sandbox, or a newer session's artifacts, that reuse the session ID.
    if (expected !== undefined && row?.id !== expected) {
      if (row) this.log.info("Skipped a delete for a sandbox that was already replaced", { sessionId, expected, current: row.id });
      return;
    }
    if (!row) {
      await this.artifacts?.deleteSession(sessionId);
      return;
    }
    if (row.state === "deleted") return;
    store.update(sessionId, { state: "deleting" });
    for (const runtime of [...(this.live.get(sessionId)?.runtimes ?? [])]) runtime.close();
    try {
      await this.ready();
      await provider.remove(row.id);
      await this.unregisterEgress(row);
      await this.artifacts?.deleteSession(sessionId);
      store.update(sessionId, { state: "deleted", errorCode: null, error: null });
      store.scrub(sessionId);
      store.deleteExecs(sessionId);
      this.live.delete(sessionId);
      this.active.delete(sessionId);
      this.log.info("Sandbox deleted", { sessionId, sandboxId: row.id });
    } catch (error) {
      const message = (error as Error).message;
      store.update(sessionId, { errorCode: "internal", error: `Cleanup is incomplete and will be retried: ${message}` });
      this.log.warn("Sandbox deletion incomplete; will retry", { sessionId, sandboxId: row.id, error: message });
      throw new ManagedCopilotError("internal", "The sandbox could not be fully deleted yet; cleanup will be retried automatically.", { sandboxId: row.id, state: "deleting" });
    }
  }
}
