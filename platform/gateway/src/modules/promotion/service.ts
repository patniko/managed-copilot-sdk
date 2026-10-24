// The promotion service (spec section 9, gate G5): moves a promotable session once, from the shared runtime into its
// own sandbox, keeping the session ID, history, attached clients, and (for agent-initiated promotion) the very turn
// that asked for it. The protocol is in ./contract.ts; core's `PlacementCutover` does the routing parts.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ManagedCopilotError,
  narrowNetwork,
  normalizeNetwork,
  type EnvironmentConfig,
  type ErrorCode,
  type NetworkPolicy,
  type PlatformEvent,
  type PromoteResult,
  type PromotionTrigger,
  type SessionPromotedData,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Principal } from "../../http.js";
import type { Logger } from "../../log.js";
import { optionalService, type PlacementCutover, type PlatformToolCallContext, type PlatformToolResult, type SessionRecord, type SessionsService } from "../core/contracts.js";
import type { PromotionActionsPort, PromotionOperation, PromotionPolicyPort, PromotionSandboxesPort, PromotionService } from "./contract.js";
import { exportSessionState } from "./export.js";
import type { PromotionStore } from "./store.js";

/** What the model reads when its `request_sandbox` call resumes in the sandbox. */
export const SANDBOX_READY_TEXT = [
  "You are now running in your own sandbox: a Linux container with a shell, Python 3, and a writable workspace at /workspace (your current directory).",
  "The conversation and its history moved with you. Continue the task here and save files you want to hand back under /workspace/outputs; they are published as artifacts when this turn completes.",
].join(" ");

const ALREADY_IN_SANDBOX_TEXT = "This session already runs in its sandbox: a Linux container with a shell, Python 3, and a writable workspace at /workspace. Continue the task here.";

export interface PromotionManagerOptions {
  readonly app: GatewayApp;
  readonly log: Logger;
  readonly store: PromotionStore;
  /** Platform directories whose paths are rewritten in exported state (the shared runtime's root). */
  readonly platformRoots: readonly string[];
  /** Where exports are staged (`<dataDir>/promotion`). */
  readonly stagingRoot: string;
  /** How long a tool promotion waits for unrelated work to drain before `promotion_busy`. */
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
  /** Promotions allocating at the same time (each allocates a sandbox). */
  readonly maxConcurrent?: number;
}

interface Attempt {
  readonly record: SessionRecord;
  readonly trigger: PromotionTrigger;
  readonly toolCallId?: string;
  readonly principal?: Principal;
}

interface InFlight {
  readonly generation: number;
  readonly trigger: PromotionTrigger;
  readonly promise: Promise<PromoteResult>;
}

/** Everything a running attempt has touched, so a failure before commit can undo exactly that. */
interface Progress {
  operation: PromotionOperation;
  readonly attempt: Attempt;
  readonly staging: string;
  cutover?: PlacementCutover;
  narrowed: boolean;
  allocated: boolean;
  fenced: boolean;
  sourceClosed: boolean;
}

interface Quiescence {
  readonly ok: boolean;
  readonly reason?: string;
  /** Terminal problems (not worth waiting for). */
  readonly fatal?: ManagedCopilotError;
}

function toManaged(error: unknown, fallback: ErrorCode = "internal"): ManagedCopilotError {
  if (error instanceof ManagedCopilotError) return error;
  return new ManagedCopilotError(fallback, (error as Error)?.message ?? String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function items(value: unknown): Record<string, unknown>[] {
  const list = isRecord(value) ? value["items"] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

export class PromotionManager implements PromotionService {
  readonly #options: PromotionManagerOptions;
  readonly #log: Logger;
  readonly #store: PromotionStore;
  readonly #inflight = new Map<string, InFlight>();
  #allocating = 0;

  constructor(options: PromotionManagerOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#store = options.store;
  }

  // Services -----------------------------------------------------------------------------------------------------

  get #app(): GatewayApp {
    return this.#options.app;
  }

  #sessions(): SessionsService {
    return this.#app.service("sessions");
  }

  #sandboxes(): PromotionSandboxesPort | undefined {
    return optionalService<PromotionSandboxesPort>(this.#app.services, "sandboxes");
  }

  #policy(): PromotionPolicyPort | undefined {
    return optionalService<PromotionPolicyPort>(this.#app.services, "policy");
  }

  #actions(): PromotionActionsPort | undefined {
    return optionalService<PromotionActionsPort>(this.#app.services, "actions");
  }

  /** Whether this deployment can promote at all (advertised as the `promotion` capability). */
  available(): boolean {
    const sessions = optionalService<SessionsService>(this.#app.services, "sessions");
    const sandboxes = this.#sandboxes();
    return typeof sessions?.cutover === "function" && typeof sandboxes?.importRuntimeState === "function";
  }

  // PromotionService -------------------------------------------------------------------------------------------

  async promote(principal: Principal, sessionId: string): Promise<PromoteResult> {
    const record = this.#sessions().getOwned(principal.accountId, sessionId);
    return this.#run({ record, trigger: "api", principal });
  }

  latest(sessionId: string): PromotionOperation | undefined {
    return this.#store.latest(sessionId);
  }

  /** The `request_sandbox` platform tool. Its call is carried into the sandbox and answered there. */
  async fromTool(context: PlatformToolCallContext): Promise<PlatformToolResult> {
    const record = this.#sessions().get(context.sessionId);
    if (!record || record.ownerId !== context.ownerId) return failure("not_found", "This session is no longer available.");
    // A retried call (the gateway restarted while it ran) that already moved the session reports the same outcome.
    const committed = this.#store.committed(record.id);
    if (committed?.toolCallId === context.toolCallId) return SANDBOX_READY_TEXT;
    if (record.placement === "sandbox") return ALREADY_IN_SANDBOX_TEXT;
    try {
      await this.#run({ record, trigger: "tool", toolCallId: context.toolCallId });
      return SANDBOX_READY_TEXT;
    } catch (error) {
      const managed = toManaged(error);
      return failure(managed.code, managed.message);
    }
  }

  // Orchestration ------------------------------------------------------------------------------------------------

  async #run(attempt: Attempt): Promise<PromoteResult> {
    const { record } = attempt;
    if (record.placement === "sandbox") return this.#promotedResult(record);
    const inflight = this.#inflight.get(record.id);
    if (inflight && inflight.generation === record.generation) {
      // A caller joins the operation that is already moving this session. The agent's own tool call cannot wait for
      // an API promotion of its running turn, which needs the session idle.
      if (attempt.trigger === "tool" && inflight.trigger === "api") {
        throw new ManagedCopilotError("promotion_busy", "A promotion requested through the API is already moving this session; try again in a moment");
      }
      return inflight.promise;
    }
    const promise = this.#execute(attempt);
    this.#inflight.set(record.id, { generation: record.generation, trigger: attempt.trigger, promise });
    try {
      return await promise;
    } finally {
      if (this.#inflight.get(record.id)?.promise === promise) this.#inflight.delete(record.id);
    }
  }

  async #promotedResult(record: SessionRecord): Promise<PromoteResult> {
    if (record.type !== "promotable") {
      throw new ManagedCopilotError("invalid_request", `Session ${record.id} runs in an isolated environment and already has its own sandbox; only promotable sessions are promoted`);
    }
    const info = await this.#sandboxes()?.get(record.id);
    const sandboxId = info?.id ?? this.#store.committed(record.id)?.sandboxId;
    if (!sandboxId) throw new ManagedCopilotError("state_restore_failed", `Session ${record.id} is promoted, but its sandbox record is missing`);
    return { sessionId: record.id, placement: "sandbox", sandboxId, generation: record.generation };
  }

  /** Checks everything that does not need the runtime, before anything is allocated. */
  #admit(attempt: Attempt): { target: string; targetConfig: EnvironmentConfig } {
    const { record } = attempt;
    if (record.type !== "promotable") {
      throw new ManagedCopilotError("invalid_request", `Session ${record.id} is in ${record.type} environment "${record.environment}"; only promotable environments can move into a sandbox`);
    }
    if (record.state === "deleting" || record.state === "deleted") throw new ManagedCopilotError("not_found", `Session ${record.id} was not found`, { sessionId: record.id });
    const environments = this.#app.config.deployment.environments;
    const source = environments[record.environment];
    const target = source?.promoteTo;
    const targetConfig = target ? environments[target] : undefined;
    if (!source || !target || !targetConfig || targetConfig.type !== "isolated") {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${record.environment}" has no isolated promoteTo target in this deployment`);
    }
    const sessions = this.#sessions();
    const sandboxes = this.#sandboxes();
    if (typeof sessions.cutover !== "function") throw new ManagedCopilotError("capability_unavailable", "This gateway's router cannot move sessions between placements yet");
    if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "This deployment has no sandboxes, so sessions cannot be promoted");
    if (typeof sandboxes.importRuntimeState !== "function") throw new ManagedCopilotError("capability_unavailable", "This deployment's sandboxes cannot import session state yet");
    if (targetConfig.models && record.model && !targetConfig.models.includes(record.model)) {
      throw new ManagedCopilotError("policy_violation", `Model "${record.model}" is not allowed in "${target}", the sandbox environment this session would move to`, { allowedModels: targetConfig.models });
    }
    if (attempt.trigger === "api" && (record.state === "running" || record.state === "waiting" || record.lastTurn?.status === "running")) {
      throw new ManagedCopilotError("session_busy", `Session ${record.id} is working on a turn; promote it once the turn completes`, { sessionId: record.id });
    }
    if (this.#allocating >= (this.#options.maxConcurrent ?? 4)) {
      throw new ManagedCopilotError("promotion_busy", "Several sessions are being promoted right now; try again in a moment");
    }
    return { target, targetConfig };
  }

  async #execute(attempt: Attempt): Promise<PromoteResult> {
    const started = Date.now();
    const { record } = attempt;
    const { target, targetConfig } = this.#admit(attempt);
    const operation = this.#store.insert({
      id: `prm_${randomUUID().replace(/-/g, "")}`,
      sessionId: record.id,
      ownerId: record.ownerId,
      fromGeneration: record.generation,
      trigger: attempt.trigger,
      ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
      target,
    });
    const progress: Progress = { operation, attempt, staging: join(this.#options.stagingRoot, operation.id), narrowed: false, allocated: false, fenced: false, sourceClosed: false };
    this.#log.info("Promoting session", { sessionId: record.id, operation: operation.id, trigger: attempt.trigger, target });
    const sessions = this.#sessions();
    const sandboxes = this.#sandboxes()!;
    let committed: SessionRecord;
    let network: NetworkPolicy;
    let sandboxId: string;
    let requestId: string | undefined;
    this.#allocating++;
    try {
      const cutover = await sessions.cutover!(record.id, { generation: record.generation });
      progress.cutover = cutover;
      if (!cutover.sourceStateDir) {
        throw new ManagedCopilotError("capability_unavailable", "The shared runtime runs outside this gateway, so its session state cannot be moved into a sandbox");
      }
      if (attempt.trigger === "api") await this.#requireIdle(progress);

      // Allocation: the source keeps serving while the target's image and setup are prepared.
      network = this.#narrow(progress, target);
      this.#update(progress, { state: "allocating" });
      progress.allocated = true;
      const handle = await sandboxes.create({
        sessionId: record.id,
        ownerId: record.ownerId,
        environment: target,
        size: targetConfig.size ?? "small",
        network,
        ...(record.environmentRequest.vaults ? { vaults: record.environmentRequest.vaults } : {}),
        additions: {
          ...(record.environmentRequest.files ? { files: record.environmentRequest.files } : {}),
          ...(record.environmentRequest.packages ? { packages: record.environmentRequest.packages } : {}),
          ...(record.environmentRequest.env ? { env: record.environmentRequest.env } : {}),
        },
        resolved: this.#resolved(record, targetConfig),
      });
      sandboxId = handle.sandboxId;
      this.#update(progress, { state: "quiescing", sandboxId });

      // Quiesce at a supported checkpoint, then fence the source and re-check what may have started meanwhile.
      if (attempt.trigger === "tool") await this.#drain(progress);
      else await this.#requireIdle(progress);
      cutover.fence();
      progress.fenced = true;
      if (attempt.trigger === "tool") {
        const check = await this.#quiescent(progress);
        if (!check.ok) throw check.fatal ?? new ManagedCopilotError("promotion_busy", `Other work started while the session was moving (${check.reason}); try again when it completes`);
      } else {
        await this.#requireIdle(progress);
      }

      // Move the runtime state: checkpoint the pending call, close the session on the source, copy, import.
      this.#update(progress, { state: "transferring" });
      if (attempt.trigger === "tool") await cutover.source("session.suspend");
      await cutover.source("sessions.close");
      progress.sourceClosed = true;
      const secrets = this.#secretsFor(attempt);
      const exported = await exportSessionState({
        sourceDir: cutover.sourceStateDir,
        targetDir: progress.staging,
        sessionId: record.id,
        platformRoots: this.#options.platformRoots,
        secrets,
      });
      const activeTurnId = attempt.trigger === "tool" ? record.lastTurn?.turnId : undefined;
      await sandboxes.importRuntimeState!(record.id, { sessionStateDir: progress.staging, ...(activeTurnId ? { activeTurnId } : {}) });
      this.#log.info("Session state moved", { sessionId: record.id, operation: operation.id, files: exported.files, bytes: exported.bytes, rewritten: exported.rewritten });

      // Resume the same session ID in the sandbox; a tool promotion carries its pending call along.
      this.#update(progress, { state: "opening" });
      const destination = await cutover.open(attempt.trigger === "tool" ? { continuePendingWork: true } : {});
      if (attempt.trigger === "tool") {
        const pending = items(await destination.request("session.tools.listPendingRequests"));
        const carried = pending.find((item) => item["toolCallId"] === attempt.toolCallId);
        if (!carried || typeof carried["requestId"] !== "string") {
          throw new ManagedCopilotError("state_restore_failed", "The sandbox runtime resumed the session without the pending request_sandbox call, so the turn could not continue there");
        }
        requestId = carried["requestId"];
      }

      committed = cutover.commit();
      this.#update(progress, { state: "committed", toGeneration: committed.generation, committedAt: new Date().toISOString(), ...(requestId ? { requestId } : {}) });
    } catch (error) {
      const managed = toManaged(error);
      await this.#rollback(progress, managed);
      throw managed;
    } finally {
      this.#allocating--;
    }

    // After commit only the destination is recovered; nothing below may undo the move.
    await this.#afterCommit(progress, { committed, network, sandboxId, requestId, durationMs: Date.now() - started, target });
    return { sessionId: record.id, placement: "sandbox", sandboxId, generation: committed.generation };
  }

  #update(progress: Progress, fields: Parameters<PromotionStore["update"]>[1]): void {
    progress.operation = this.#store.update(progress.operation.id, fields);
  }

  /** The session's policy narrowed by the target's ceiling: through the network module when present, else locally. */
  #narrow(progress: Progress, target: string): NetworkPolicy {
    const { record } = progress.attempt;
    const policy = this.#policy();
    if (policy?.promoteSession) {
      const narrowed = policy.promoteSession(record.id, target);
      progress.narrowed = true;
      return narrowed;
    }
    const ceiling = normalizeNetwork(this.#app.config.deployment.environments[target]?.network, normalizeNetwork(this.#app.config.deployment.network));
    return narrowNetwork(ceiling, record.network);
  }

  /** The target's compute (image, size, setup, idle policy) with the source's customizations: no new persona. */
  #resolved(record: SessionRecord, targetConfig: EnvironmentConfig): { config: EnvironmentConfig; customizations?: { root: string } } {
    let root: string | undefined;
    try {
      root = this.#app.service("environments").forSession(record).customizations?.root;
    } catch (error) {
      this.#log.warn("Could not resolve the session's customizations; the sandbox gets none", { sessionId: record.id, error: (error as Error).message });
    }
    return { config: targetConfig, ...(root ? { customizations: { root } } : {}) };
  }

  /** Literal secrets the export must not contain: the owner's current GitHub token(s) the gateway knows. */
  #secretsFor(attempt: Attempt): string[] {
    const secrets = new Set<string>();
    if (attempt.principal?.token) secrets.add(attempt.principal.token);
    const auth = optionalService<{ liveCredential?(accountId: number): { token: string } | undefined }>(this.#app.services, "auth");
    try {
      const live = auth?.liveCredential?.(attempt.record.ownerId);
      if (live?.token) secrets.add(live.token);
    } catch {
      // No live credential: the pattern scan still applies.
    }
    return [...secrets];
  }

  // Quiescence -----------------------------------------------------------------------------------------------------

  /** API promotions move idle sessions only (`session_busy` otherwise); work is never interrupted invisibly. */
  async #requireIdle(progress: Progress): Promise<void> {
    const cutover = progress.cutover!;
    const record = this.#sessions().get(progress.attempt.record.id);
    const busy = (why: string) => new ManagedCopilotError("session_busy", `Session ${progress.attempt.record.id} is ${why}; promote it once that completes`, { sessionId: progress.attempt.record.id });
    if (!record) throw new ManagedCopilotError("not_found", `Session ${progress.attempt.record.id} was not found`);
    if (record.generation !== progress.attempt.record.generation || record.placement !== "shared") throw new ManagedCopilotError("conflict", `Session ${record.id} moved while it was being promoted`);
    if (!progress.fenced && (record.state === "running" || record.state === "waiting" || record.lastTurn?.status === "running")) throw busy("working on a turn");
    const open = this.#actions()?.list(record.id, { open: true }) ?? [];
    if (open.length > 0) throw busy(`waiting for ${open.length === 1 ? "an action" : `${open.length} actions`} (tool calls or prompts)`);
    const processing = await cutover.source<{ processing?: boolean }>("session.metadata.isProcessing").catch(() => undefined);
    if (processing?.processing === true) throw busy("working on a turn");
    const tasks = await this.#activeTasks(cutover);
    if (tasks > 0) throw busy(`running ${tasks === 1 ? "a background task" : `${tasks} background tasks`}`);
  }

  /** Tool promotions wait (bounded) for unrelated work to finish; their own call is the checkpoint. */
  async #drain(progress: Progress): Promise<void> {
    const deadline = Date.now() + (this.#options.drainTimeoutMs ?? 20_000);
    for (;;) {
      const check = await this.#quiescent(progress);
      if (check.ok) return;
      if (check.fatal) throw check.fatal;
      if (Date.now() >= deadline) {
        throw new ManagedCopilotError("promotion_busy", `The session cannot move while ${check.reason}; try again when that completes`, { sessionId: progress.attempt.record.id });
      }
      await new Promise((resolve) => setTimeout(resolve, this.#options.drainPollMs ?? 500));
    }
  }

  async #quiescent(progress: Progress): Promise<Quiescence> {
    const cutover = progress.cutover!;
    const { record, toolCallId } = progress.attempt;
    const tools = items(await cutover.source("session.tools.listPendingRequests"));
    const own = tools.find((item) => item["toolCallId"] === toolCallId);
    if (!own) {
      return { ok: false, fatal: new ManagedCopilotError("conflict", "The turn that asked for a sandbox ended before the sandbox was ready, so the session stays where it is") };
    }
    if (typeof own["agentId"] === "string" && own["agentId"]) {
      return { ok: false, fatal: new ManagedCopilotError("invalid_request", "Only the main agent can move the session into a sandbox; a subagent asked for it") };
    }
    const others = tools.length - 1;
    if (others > 0) return { ok: false, reason: `${others === 1 ? "another tool call is" : `${others} other tool calls are`} still running` };
    const permissions = items(await cutover.source("session.permissions.pendingRequests"));
    if (permissions.length > 0) return { ok: false, reason: "a permission prompt is waiting for an answer" };
    const open = (this.#actions()?.list(record.id, { open: true }) ?? []).filter((action) => action.toolCallId !== toolCallId);
    if (open.length > 0) return { ok: false, reason: `${open.length === 1 ? "an action is" : `${open.length} actions are`} waiting for a responder` };
    const tasks = await this.#activeTasks(cutover);
    if (tasks > 0) return { ok: false, reason: `${tasks === 1 ? "a background task is" : `${tasks} background tasks are`} running` };
    const queue = await cutover.source<{ items?: unknown[]; steeringMessages?: unknown[] }>("session.queue.pendingItems").catch(() => undefined);
    const queued = (queue?.items?.length ?? 0) + (queue?.steeringMessages?.length ?? 0);
    if (queued > 0) return { ok: false, reason: `${queued === 1 ? "a message is" : `${queued} messages are`} queued behind this turn` };
    return { ok: true };
  }

  /** Background agents and shells that are running or waiting for input (they do not survive a runtime move). */
  async #activeTasks(cutover: PlacementCutover): Promise<number> {
    const list = await cutover.source<{ tasks?: { status?: string }[] }>("session.tasks.list").catch(() => undefined);
    return (list?.tasks ?? []).filter((task) => task.status === "running" || task.status === "idle").length;
  }

  // Failure before commit, and the steps after commit --------------------------------------------------------------

  async #rollback(progress: Progress, error: ManagedCopilotError): Promise<void> {
    const { record, trigger } = progress.attempt;
    this.#log.warn("Promotion failed before commit; the session stays on shared placement", { sessionId: record.id, operation: progress.operation.id, state: progress.operation.state, code: error.code, error: error.message });
    if (progress.narrowed) {
      try {
        this.#policy()?.revertPromotion?.(record.id);
      } catch (revertError) {
        this.#log.error("Could not restore the session's network policy after a failed promotion", { sessionId: record.id, error: (revertError as Error).message });
      }
    }
    if (progress.cutover) {
      try {
        // A closed source resumes on next use; a tool promotion's call must stay answerable there.
        await progress.cutover.abort(progress.sourceClosed && trigger === "tool" ? { resume: { continuePendingWork: true } } : undefined);
      } catch (abortError) {
        this.#log.error("Could not abort the placement cutover", { sessionId: record.id, error: (abortError as Error).message });
      }
    }
    if (progress.allocated) {
      try {
        await this.#sandboxes()?.delete(record.id);
      } catch (deleteError) {
        this.#log.warn("Could not release the candidate sandbox yet; sandbox reconciliation retries", { sessionId: record.id, error: (deleteError as Error).message });
      }
    }
    await rm(progress.staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    this.#update(progress, { state: "failed", errorCode: error.code, error: error.message });
  }

  async #afterCommit(
    progress: Progress,
    input: { committed: SessionRecord; network: NetworkPolicy; sandboxId: string; requestId: string | undefined; durationMs: number; target: string },
  ): Promise<void> {
    const { record, trigger, toolCallId } = progress.attempt;
    const { committed, sandboxId, requestId } = input;
    try {
      this.#policy()?.commitPromotion?.(record.id);
    } catch (error) {
      this.#log.warn("Could not finalize the session's promoted network binding", { sessionId: record.id, error: (error as Error).message });
    }
    try {
      // Before the tool returns: the carried call stays claimed and its answer is delivered to the new generation.
      await this.#actions()?.onGenerationChanged?.(record.id, committed.generation, requestId ? { carried: [requestId] } : {});
    } catch (error) {
      this.#log.error("Durable did not move the session's actions to the new generation", { sessionId: record.id, error: (error as Error).message });
    }
    const data: SessionPromotedData = {
      generation: committed.generation,
      placement: "sandbox",
      target: input.target,
      trigger,
      ...(toolCallId ? { toolCallId } : {}),
      network: input.network,
      durationMs: input.durationMs,
    };
    const event: PlatformEvent = {
      id: `evt_${randomUUID()}`,
      type: "session.promoted",
      createdAt: new Date().toISOString(),
      sessionId: record.id,
      environment: record.environment,
      sandboxId,
      data: data as unknown as Record<string, unknown>,
    };
    try {
      this.#app.service("events").publish(event, { ownerId: record.ownerId });
    } catch (error) {
      this.#log.warn("Could not publish session.promoted", { sessionId: record.id, error: (error as Error).message });
    }
    await rm(progress.staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    await this.#cleanSource(progress.operation, progress.cutover?.sourceStateDir);
    this.#log.info("Session promoted", { sessionId: record.id, operation: progress.operation.id, sandboxId, generation: committed.generation, trigger, ms: input.durationMs });
  }

  /** Removes the source runtime's copy of the session state, so the fenced owner can never be reactivated. */
  async #cleanSource(operation: PromotionOperation, directory: string | undefined): Promise<void> {
    const target = directory ?? this.#sourceStateDir(operation.sessionId);
    if (!target) return;
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      this.#store.update(operation.id, { sourceCleaned: true });
    } catch (error) {
      this.#log.warn("Could not remove the session's state from the shared runtime yet; it is retried at the next start", { sessionId: operation.sessionId, error: (error as Error).message });
    }
  }

  #sourceStateDir(sessionId: string): string | undefined {
    const root = this.#options.platformRoots[0];
    return root ? join(root, "copilot-home", "session-state", sessionId) : undefined;
  }

  // Recovery -------------------------------------------------------------------------------------------------------

  /**
   * After a restart: an attempt whose commit reached core's ledger is finished (cleanup only); any other open attempt
   * never committed, so its candidate sandbox is released and the source stays the owner.
   */
  async recover(): Promise<void> {
    const sessions = optionalService<SessionsService>(this.#app.services, "sessions");
    for (const operation of this.#store.unfinished()) {
      const record = sessions?.get(operation.sessionId);
      if (record && record.placement === "sandbox" && record.generation > operation.fromGeneration) {
        this.#store.update(operation.id, { state: "committed", toGeneration: record.generation, committedAt: new Date().toISOString() });
        this.#log.info("Promotion committed before the restart; finishing its cleanup", { sessionId: operation.sessionId, operation: operation.id });
        continue;
      }
      this.#log.warn("Promotion was interrupted by a restart before commit; the session stays on shared placement", { sessionId: operation.sessionId, operation: operation.id, state: operation.state });
      try {
        this.#policy()?.revertPromotion?.(operation.sessionId);
      } catch (error) {
        this.#log.warn("Could not restore the network policy of an interrupted promotion", { sessionId: operation.sessionId, error: (error as Error).message });
      }
      if (operation.state !== "admitted" && (!record || record.placement === "shared")) {
        await this.#sandboxes()
          ?.delete(operation.sessionId)
          .catch((error: unknown) => this.#log.warn("Could not release an interrupted promotion's sandbox yet", { sessionId: operation.sessionId, error: (error as Error).message }));
      }
      await rm(join(this.#options.stagingRoot, operation.id), { recursive: true, force: true }).catch(() => undefined);
      this.#store.update(operation.id, { state: "failed", errorCode: "internal", error: "The gateway restarted before the promotion committed; the session stayed on shared placement" });
    }
    for (const operation of this.#store.uncleaned()) await this.#cleanSource(operation, undefined);
  }
}

function failure(code: string, message: string): PlatformToolResult {
  return {
    textResultForLlm: `The session could not move into a sandbox: ${message} Continue without one: say what you would have run, or answer from what you know.`,
    resultType: "failure",
    error: `${code}: ${message}`,
  };
}
