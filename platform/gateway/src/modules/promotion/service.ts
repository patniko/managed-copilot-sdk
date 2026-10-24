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
import type { PromotionActionsPort, PromotionOperation, PromotionParticipant, PromotionParticipantOutcome, PromotionPolicyPort, PromotionSandboxesPort, PromotionService } from "./contract.js";
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
  /** The gateway's data directories: paths under them are rewritten in exported state. */
  readonly platformRoots: readonly string[];
  /** Where exports are staged (`<dataDir>/promotion`). */
  readonly stagingRoot: string;
  /** How long a tool promotion waits for unrelated work to drain before `promotion_busy`. */
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
  /** How long participants (attached clients' own paths into the source) get to pause before `promotion_busy`. */
  readonly participantFenceTimeoutMs?: number;
  /** Promotions in flight at the same time (each allocates a sandbox). */
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
  readonly toolCallId?: string;
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
  /** The candidate sandbox's ID, as soon as creation returned it. */
  candidate?: string;
  fenced: boolean;
  /** Participants whose `fence` was called; each is released once when the cutover ends. */
  readonly participants: PromotionParticipant[];
  /** `session.suspend` or `sessions.close` was attempted: the source may no longer hold the session. */
  sourceTouched: boolean;
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

/** The `items` of a pending-list response; anything else is not a usable answer. */
function items(value: unknown, method: string): Record<string, unknown>[] {
  const list = isRecord(value) ? value["items"] : undefined;
  if (!Array.isArray(list)) throw new ManagedCopilotError("internal", `The runtime returned an unexpected answer to ${method}`);
  return list.filter(isRecord);
}

/** The stock runtime's answer for a session it does not hold (closed, or never resumed since a restart). */
function notHeld(error: unknown): boolean {
  return /session not found/i.test((error as Error)?.message ?? "");
}

export class PromotionManager implements PromotionService {
  readonly #options: PromotionManagerOptions;
  readonly #log: Logger;
  readonly #store: PromotionStore;
  readonly #inflight = new Map<string, InFlight>();
  /** The tail of each session's candidate work (see `#candidateWork`). */
  readonly #candidates = new Map<string, Promise<void>>();
  readonly #participants = new Set<PromotionParticipant>();
  #running = 0;
  #closed = false;

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

  participate(participant: PromotionParticipant): () => void {
    this.#participants.add(participant);
    return () => {
      this.#participants.delete(participant);
    };
  }

  /** At shutdown: recovery stops before its next step (what is left is retried at the next start). */
  close(): void {
    this.#closed = true;
  }

  /** The `request_sandbox` platform tool. Its call is carried into the sandbox and answered there. */
  async fromTool(context: PlatformToolCallContext): Promise<PlatformToolResult> {
    const record = this.#sessions().get(context.sessionId);
    if (!record || record.ownerId !== context.ownerId) return failure("not_found", "This session is no longer available.");
    // A retried call (the gateway restarted while it ran) that already moved the session reports the same outcome,
    // once its carried call is at the new generation.
    const committed = this.#store.committed(record.id);
    if (committed?.toolCallId === context.toolCallId) {
      if (record.placement === "sandbox") this.#finalizeSync(committed, record.generation);
      return SANDBOX_READY_TEXT;
    }
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
      // An API caller joins whatever is already moving the session. A tool call joins only its own retry: another
      // request_sandbox call must get its answer now, or the first one could never drain, and an API promotion needs
      // the idle session the agent's running turn prevents.
      if (attempt.trigger === "tool" && (inflight.trigger !== "tool" || inflight.toolCallId !== attempt.toolCallId)) {
        throw new ManagedCopilotError("promotion_busy", "The session is already moving into its sandbox; the conversation continues there once that finishes");
      }
      return inflight.promise;
    }
    const promise = this.#execute(attempt);
    this.#inflight.set(record.id, { generation: record.generation, trigger: attempt.trigger, ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}), promise });
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

  /** A sandbox backend reported down (Docker stopped, Azure not configured) is probed once more before refusing. */
  async #requireBackend(): Promise<void> {
    const ready = await Promise.resolve(this.#sandboxes()?.probe?.()).catch(() => false);
    if (ready !== true) {
      throw new ManagedCopilotError("capability_unavailable", "Sandboxes are unavailable on this deployment right now, so the session stays on shared placement; try again later");
    }
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
    // The session keeps its own policy (models, approvals) and billing route; a target that would change the
    // billing route is incompatible rather than silently ignored.
    if (targetConfig.inference?.foundry) {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${target}" routes inference to Azure AI Foundry; promotion cannot change a session's billing route`);
    }
    const sessions = this.#sessions();
    const sandboxes = this.#sandboxes();
    if (typeof sessions.cutover !== "function") throw new ManagedCopilotError("capability_unavailable", "This gateway's router cannot move sessions between placements yet");
    if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "This deployment has no sandboxes, so sessions cannot be promoted");
    if (typeof sandboxes.importRuntimeState !== "function") throw new ManagedCopilotError("capability_unavailable", "This deployment's sandboxes cannot import session state yet");
    if (attempt.trigger === "api" && (record.state === "running" || record.state === "waiting" || record.lastTurn?.status === "running")) {
      throw new ManagedCopilotError("session_busy", `Session ${record.id} is working on a turn; promote it once the turn completes`, { sessionId: record.id });
    }
    if (this.#running >= (this.#options.maxConcurrent ?? 4)) {
      throw new ManagedCopilotError("promotion_busy", "Several sessions are being promoted right now; try again in a moment");
    }
    return { target, targetConfig };
  }

  async #execute(attempt: Attempt): Promise<PromoteResult> {
    const started = Date.now();
    const { record } = attempt;
    let admission = this.#admit(attempt);
    if (this.#sandboxes()?.available === false) {
      await this.#requireBackend();
      admission = this.#admit(attempt);
    }
    const { target, targetConfig } = admission;
    const operation = this.#store.insert({
      id: `prm_${randomUUID().replace(/-/g, "")}`,
      sessionId: record.id,
      ownerId: record.ownerId,
      fromGeneration: record.generation,
      trigger: attempt.trigger,
      ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
      target,
    });
    const progress: Progress = { operation, attempt, staging: join(this.#options.stagingRoot, operation.id), narrowed: false, allocated: false, fenced: false, participants: [], sourceTouched: false };
    this.#log.info("Promoting session", { sessionId: record.id, operation: operation.id, trigger: attempt.trigger, target });
    const sessions = this.#sessions();
    const sandboxes = this.#sandboxes()!;
    let committed: SessionRecord;
    let network: NetworkPolicy;
    let sandboxId: string;
    let requestId: string | undefined;
    this.#running++;
    try {
      try {
        const cutover = await sessions.cutover!(record.id, { generation: record.generation });
        progress.cutover = cutover;
        if (!cutover.sourceStateDir) {
          throw new ManagedCopilotError("capability_unavailable", "The shared runtime runs outside this gateway, so its session state cannot be moved into a sandbox");
        }
        this.#update(progress, { sourceStateDir: cutover.sourceStateDir });
        // Nothing is allocated for a request that cannot be honored: the session must be idle (API), or the call must
        // come from the main agent's still-running turn (tool).
        if (attempt.trigger === "api") await this.#requireIdle(progress);
        else {
          const check = await this.#quiescent(progress);
          if (check.fatal) throw check.fatal;
        }
        // Allocation: the source keeps serving while the target's image and setup are prepared. It runs in order with
        // releasing what earlier attempts left behind, so a release never undoes this attempt's candidate.
        const allocated = await this.#candidateWork(record.id, async () => {
          await this.#releaseLeftovers(record.id, operation.id);
          // The session may have been deleted, and its ID reused, while this attempt waited its turn: confirm it is the
          // same incarnation in the same synchronous step that narrows its policy.
          this.#current(progress);
          const narrowed = this.#narrow(progress, target);
          this.#update(progress, { state: "allocating" });
          progress.allocated = true;
          const handle = await sandboxes.create({
            sessionId: record.id,
            ownerId: record.ownerId,
            environment: target,
            size: targetConfig.size ?? "small",
            network: narrowed,
            ...(record.environmentRequest.vaults ? { vaults: record.environmentRequest.vaults } : {}),
            additions: {
              ...(record.environmentRequest.files ? { files: record.environmentRequest.files } : {}),
              ...(record.environmentRequest.packages ? { packages: record.environmentRequest.packages } : {}),
              ...(record.environmentRequest.env ? { env: record.environmentRequest.env } : {}),
            },
            resolved: this.#resolved(record, targetConfig),
          });
          // Recorded at once: rollback and recovery release this candidate by its ID, never another sandbox.
          progress.candidate = handle.sandboxId;
          this.#update(progress, { state: "quiescing", sandboxId: handle.sandboxId });
          return { network: narrowed, sandboxId: handle.sandboxId };
        });
        network = allocated.network;
        sandboxId = allocated.sandboxId;

        // Quiesce at a supported checkpoint, then fence the source and re-check what may have started meanwhile.
        if (attempt.trigger === "tool") await this.#drain(progress);
        else await this.#requireIdle(progress);
        // In the same synchronous step as the fence: a session deleted during the last probe (core then aborted the
        // cutover, so fencing it is a no-op) stops here, before anything else is fenced for it.
        this.#current(progress);
        cutover.fence();
        progress.fenced = true;
        // Paths into the source that core's fence does not cover (an attached Copilot CLI) are fenced before the
        // re-check, so it also sees what they started.
        await this.#fenceParticipants(progress);
        if (attempt.trigger === "tool") {
          const check = await this.#quiescent(progress);
          if (!check.ok) throw check.fatal ?? new ManagedCopilotError("promotion_busy", `Other work started while the session was moving (${check.reason}); try again when it completes`);
        } else {
          await this.#requireIdle(progress);
        }

        // Move the runtime state: checkpoint the pending call, close the session on the source, copy, import.
        this.#update(progress, { state: "transferring" });
        progress.sourceTouched = true;
        if (attempt.trigger === "tool") await cutover.source("session.suspend");
        // Idempotent in the stock runtime; a session it does not hold has nothing to close.
        await cutover.source("sessions.close").catch((error: unknown) => {
          if (!notHeld(error)) throw error;
        });
        const exported = await exportSessionState({
          sourceDir: cutover.sourceStateDir,
          targetDir: progress.staging,
          sessionId: record.id,
          platformRoots: this.#options.platformRoots,
          secrets: this.#secretsFor(attempt),
        });
        const activeTurnId = attempt.trigger === "tool" ? this.#sessions().get(record.id)?.lastTurn?.turnId : undefined;
        await sandboxes.importRuntimeState!(record.id, { sessionStateDir: progress.staging, ...(activeTurnId ? { activeTurnId } : {}) });
        this.#log.info("Session state moved", { sessionId: record.id, operation: operation.id, files: exported.files, bytes: exported.bytes, rewritten: exported.rewritten });

        // Resume the same session ID in the sandbox; a tool promotion carries its pending call along.
        this.#update(progress, { state: "opening" });
        const destination = await cutover.open(attempt.trigger === "tool" ? { continuePendingWork: true } : {});
        if (attempt.trigger === "tool") {
          const pending = items(await destination.request("session.tools.listPendingRequests"), "session.tools.listPendingRequests");
          const carried = pending.find((item) => item["toolCallId"] === attempt.toolCallId);
          if (!carried || typeof carried["requestId"] !== "string") {
            throw new ManagedCopilotError("state_restore_failed", "The sandbox runtime resumed the session without the pending request_sandbox call, so the turn could not continue there");
          }
          requestId = carried["requestId"];
          // Recorded before commit, so recovery can carry the call even if the gateway stops right after commit.
          this.#update(progress, { requestId });
        }
        committed = await this.#commit(progress, cutover);
      } catch (error) {
        const managed = toManaged(error);
        await this.#rollback(progress, managed);
        throw managed;
      }
    } finally {
      this.#running--;
    }

    // The commit is the point of no return: nothing below may undo the move, and core recovers only the destination.
    this.#releaseParticipants(progress, { committed: true, sealed: true });
    try {
      this.#update(progress, { state: "committed", toGeneration: committed.generation, committedAt: new Date().toISOString(), sandboxId });
    } catch (error) {
      this.#log.error("Could not record the promotion's commit; recovery finishes it at the next start", { sessionId: record.id, error: (error as Error).message });
    }
    this.#finalizeSync(progress.operation, committed.generation);
    await this.#finalize(progress.operation, { committed, network, sandboxId, durationMs: Date.now() - started });
    this.#log.info("Session promoted", { sessionId: record.id, operation: operation.id, sandboxId, generation: committed.generation, trigger: attempt.trigger, ms: Date.now() - started });
    return { sessionId: record.id, placement: "sandbox", sandboxId, generation: committed.generation };
  }

  #update(progress: Progress, fields: Parameters<PromotionStore["update"]>[1]): void {
    progress.operation = this.#store.update(progress.operation.id, fields);
  }

  /**
   * Runs work on a session's candidate sandboxes (releasing what earlier attempts left, allocating a new one) one at a
   * time, so a release never overlaps an allocation it would undo.
   */
  async #candidateWork<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#candidates.get(sessionId) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#candidates.set(sessionId, settled);
    try {
      return await run;
    } finally {
      if (this.#candidates.get(sessionId) === settled) this.#candidates.delete(sessionId);
    }
  }

  /** Commits the cutover. A commit that fails after core's ledger moved the session still moved it: nothing may undo that. */
  async #commit(progress: Progress, cutover: PlacementCutover): Promise<SessionRecord> {
    const { record } = progress.attempt;
    try {
      return await cutover.commit();
    } catch (error) {
      const moved = this.#sessions().get(record.id);
      if (!moved || moved.placement !== "sandbox" || moved.generation <= record.generation || moved.createdAt !== record.createdAt) throw error;
      this.#log.error("The placement commit failed after the session moved; finishing the promotion", { sessionId: record.id, operation: progress.operation.id, error: (error as Error).message });
      return moved;
    }
  }

  /** The session's policy narrowed by the target's ceiling: through the network module when present, else locally. */
  #narrow(progress: Progress, target: string): NetworkPolicy {
    const { record } = progress.attempt;
    const policy = this.#policy();
    if (policy?.promoteSession) {
      progress.narrowed = true;
      return policy.promoteSession(record.id, target);
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

  /** The session as the ledger has it now; it must still be the same, live, shared incarnation. */
  #current(progress: Progress): SessionRecord {
    const { record } = progress.attempt;
    const current = this.#sessions().get(record.id);
    // Another creation time is a new session that reused the ID after this one was deleted.
    if (!current || current.state === "deleting" || current.state === "deleted" || current.createdAt !== record.createdAt) {
      throw new ManagedCopilotError("not_found", `Session ${record.id} was deleted while it was being promoted`, { sessionId: record.id });
    }
    if (current.generation !== record.generation || current.placement !== "shared") {
      throw new ManagedCopilotError("conflict", `Session ${record.id} changed placement while it was being promoted`, { sessionId: record.id });
    }
    return current;
  }

  /**
   * API promotions move idle sessions only (`session_busy` otherwise); work is never interrupted invisibly. A probe
   * that fails for another reason than "the runtime does not hold this session" fails the promotion: idleness is
   * never assumed.
   */
  async #requireIdle(progress: Progress): Promise<void> {
    const cutover = progress.cutover!;
    const id = progress.attempt.record.id;
    const busy = (why: string) => new ManagedCopilotError("session_busy", `Session ${id} is ${why}; promote it once that completes`, { sessionId: id });
    const current = this.#current(progress);
    if (!progress.fenced && (current.state === "running" || current.state === "waiting" || current.lastTurn?.status === "running")) throw busy("working on a turn");
    const open = this.#actions()?.list(id, { open: true }) ?? [];
    if (open.length > 0) throw busy(`waiting for ${open.length === 1 ? "an action" : `${open.length} actions`} (tool calls or prompts)`);
    const probe = async <T>(method: string): Promise<T | undefined> => {
      try {
        return await cutover.source<T>(method);
      } catch (error) {
        if (notHeld(error)) return undefined;
        throw new ManagedCopilotError("session_busy", `Session ${id} could not be confirmed idle (${method}: ${(error as Error).message}); try again in a moment`, { sessionId: id });
      }
    };
    const processing = await probe<{ processing?: boolean }>("session.metadata.isProcessing");
    if (processing?.processing === true) throw busy("working on a turn");
    const tasks = await probe<{ tasks?: { status?: string }[] }>("session.tasks.list");
    const active = activeTasks(tasks);
    if (active > 0) throw busy(`running ${active === 1 ? "a background task" : `${active} background tasks`}`);
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

  /**
   * Fences the registered participants (paths into the source that core's fence does not cover), all at once and
   * bounded. A participant that fails or does not finish in time fails the promotion before the checkpoint.
   */
  async #fenceParticipants(progress: Progress): Promise<void> {
    const participants = [...this.#participants];
    if (participants.length === 0) return;
    const sessionId = progress.attempt.record.id;
    const controller = new AbortController();
    // Released once each, whatever happens below.
    progress.participants.push(...participants);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ManagedCopilotError("promotion_busy", "A client attached to the session could not be paused in time, so the session stays where it is; try again in a moment", { sessionId }));
      }, this.#options.participantFenceTimeoutMs ?? 15_000);
      timer.unref();
    });
    const fenced = Promise.all(
      participants.map(async (participant) => {
        try {
          await participant.fence(sessionId, controller.signal);
        } catch (error) {
          throw new ManagedCopilotError("promotion_busy", `The session's ${participant.name} connection could not be paused (${(error as Error)?.message ?? String(error)}), so the session stays where it is; try again in a moment`, { sessionId });
        }
      }),
    );
    try {
      await Promise.race([fenced, deadline]);
    } catch (error) {
      controller.abort();
      // The losing side settles later; nothing waits for it.
      fenced.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the participants' fence once the cutover ended (after commit, or after the abort settled the source). */
  #releaseParticipants(progress: Progress, outcome: PromotionParticipantOutcome): void {
    const sessionId = progress.attempt.record.id;
    for (const participant of progress.participants.splice(0)) {
      try {
        participant.release(sessionId, outcome);
      } catch (error) {
        this.#log.warn("A promotion participant could not release the session", { sessionId, participant: participant.name, error: (error as Error)?.message ?? String(error) });
      }
    }
  }

  /** Whether the agent's own call is the only open work. Every probe must answer; a failed probe fails the move. */
  async #quiescent(progress: Progress): Promise<Quiescence> {
    const cutover = progress.cutover!;
    const { toolCallId } = progress.attempt;
    const id = this.#current(progress).id;
    const probe = async <T>(method: string): Promise<T> => {
      try {
        return await cutover.source<T>(method);
      } catch (error) {
        throw new ManagedCopilotError("promotion_busy", `The session's state could not be checked before moving it (${method}: ${(error as Error).message})`, { sessionId: id });
      }
    };
    const tools = items(await probe("session.tools.listPendingRequests"), "session.tools.listPendingRequests");
    const own = tools.find((item) => item["toolCallId"] === toolCallId);
    if (!own) {
      return { ok: false, fatal: new ManagedCopilotError("conflict", "The turn that asked for a sandbox ended before the sandbox was ready, so the session stays where it is") };
    }
    if (typeof own["agentId"] === "string" && own["agentId"]) {
      return { ok: false, fatal: new ManagedCopilotError("invalid_request", "Only the main agent can move the session into a sandbox; a subagent asked for it") };
    }
    const others = tools.length - 1;
    if (others > 0) return { ok: false, reason: `${others === 1 ? "another tool call is" : `${others} other tool calls are`} still running` };
    const permissions = items(await probe("session.permissions.pendingRequests"), "session.permissions.pendingRequests");
    if (permissions.length > 0) return { ok: false, reason: "a permission prompt is waiting for an answer" };
    const open = (this.#actions()?.list(id, { open: true }) ?? []).filter((action) => action.toolCallId !== toolCallId);
    if (open.length > 0) return { ok: false, reason: `${open.length === 1 ? "an action is" : `${open.length} actions are`} waiting for a responder` };
    const tasks = activeTasks(await probe<{ tasks?: { status?: string }[] }>("session.tasks.list"));
    if (tasks > 0) return { ok: false, reason: `${tasks === 1 ? "a background task is" : `${tasks} background tasks are`} running` };
    const queue = await probe<{ items?: unknown[]; steeringMessages?: unknown[] }>("session.queue.pendingItems");
    if (!isRecord(queue) || !Array.isArray(queue.items)) throw new ManagedCopilotError("promotion_busy", "The runtime returned an unexpected answer to session.queue.pendingItems");
    const queued = queue.items.length + (Array.isArray(queue.steeringMessages) ? queue.steeringMessages.length : 0);
    if (queued > 0) return { ok: false, reason: `${queued === 1 ? "a message is" : `${queued} messages are`} queued behind this turn` };
    return { ok: true };
  }

  // Failure before commit, and the steps after commit --------------------------------------------------------------

  async #rollback(progress: Progress, error: ManagedCopilotError): Promise<void> {
    const { record, trigger } = progress.attempt;
    this.#log.warn("Promotion failed before commit; the session stays on shared placement", { sessionId: record.id, operation: progress.operation.id, state: progress.operation.state, code: error.code, error: error.message });
    if (progress.narrowed && this.#sameIncarnation(progress.operation)) {
      try {
        this.#policy()?.revertPromotion?.(record.id);
      } catch (revertError) {
        this.#log.error("Could not restore the session's network policy after a failed promotion", { sessionId: record.id, error: (revertError as Error).message });
      }
    }
    if (progress.cutover) {
      try {
        // Once suspend or close was attempted the source resumes on next use; a tool promotion's call must stay
        // answerable there, so it resumes with its pending work.
        await progress.cutover.abort(progress.sourceTouched && trigger === "tool" ? { resume: { continuePendingWork: true } } : undefined);
      } catch (abortError) {
        this.#log.error("Could not abort the placement cutover", { sessionId: record.id, error: (abortError as Error).message });
      }
    }
    // Once the abort settled the source (its state restored, its requests flowing): attached clients may continue there.
    this.#releaseParticipants(progress, { committed: false, sealed: progress.sourceTouched });
    let released = !progress.allocated;
    if (progress.allocated) {
      try {
        // Without a candidate ID, creation failed: the sandbox module already released what it had allocated.
        const operation = progress.candidate ? { ...progress.operation, sandboxId: progress.candidate } : progress.operation;
        released = await this.#releaseIfCandidate(operation, { createFailed: !progress.candidate });
      } catch (deleteError) {
        this.#log.warn("Could not release the candidate sandbox yet; it is retried at the next start", { sessionId: record.id, error: (deleteError as Error).message });
      }
    }
    await rm(progress.staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    this.#update(progress, { state: "failed", errorCode: error.code, error: error.message, cleanupPending: !released });
  }

  /** Whether the session ID still names the incarnation an attempt was made for, or nothing (it was deleted). */
  #sameIncarnation(operation: PromotionOperation): boolean {
    const current = optionalService<SessionsService>(this.#app.services, "sessions")?.get(operation.sessionId);
    return !current || current.createdAt <= operation.createdAt;
  }

  /**
   * Releases an attempt's candidate if it is still registered under the session ID, and reports whether that
   * obligation is settled (false: not decidable now; retried at the next start). A deleted session's ID can name a new
   * session, even another owner's, so only a provable candidate is deleted:
   * - Which sandbox can be the candidate: the recorded one, by its ID (unique per creation); after a failed creation
   *   only a `failed` row (the sandbox module released the rest); after a restart during creation, whatever is there.
   *   A sandbox already being deleted is someone else's release in progress.
   * - Never while the ID names a session in sandbox placement: the promoted incarnation's home, or a new session's own
   *   sandbox, whose creation may already be queued in the sandbox service behind anything deleted now. A candidate
   *   still registered then is retried once the ID names no such session.
   * - Otherwise (no session, or a shared one, which owns no sandbox but promotion candidates, and promotion work for
   *   the ID is serialized with this) it is deleted. Core records a session before allocating its sandbox, and this
   *   check and the queued delete happen in one synchronous step, so no other session's creation can be queued ahead;
   *   the expected ID goes along for the sandbox service to confirm under its lock.
   */
  async #releaseIfCandidate(operation: PromotionOperation, options: { readonly createFailed?: boolean } = {}): Promise<boolean> {
    const sandboxes = this.#sandboxes();
    const info = await sandboxes?.get(operation.sessionId);
    if (!sandboxes || !info || info.state === "deleted" || info.state === "deleting") return true;
    const candidate = operation.sandboxId !== undefined ? info.id === operation.sandboxId : !options.createFailed || info.state === "failed";
    if (!candidate) return true;
    const current = optionalService<SessionsService>(this.#app.services, "sessions")?.get(operation.sessionId);
    if (current?.placement === "sandbox") return current.createdAt <= operation.createdAt || info.state === "failed";
    await sandboxes.delete(operation.sessionId, { sandboxId: info.id });
    return true;
  }

  /** Synchronous post-commit steps, so durable sees the carried call at the new generation before anything replays. */
  #finalizeSync(operation: PromotionOperation, generation: number): void {
    try {
      this.#policy()?.commitPromotion?.(operation.sessionId);
    } catch (error) {
      this.#log.warn("Could not finalize the session's promoted network binding", { sessionId: operation.sessionId, error: (error as Error).message });
    }
    try {
      // Before the tool returns: the carried call stays claimed and its answer is delivered to the new generation.
      this.#actions()?.onGenerationChanged?.(operation.sessionId, generation, operation.requestId ? { carried: [operation.requestId] } : {});
    } catch (error) {
      this.#log.error("Durable did not move the session's actions to the new generation", { sessionId: operation.sessionId, error: (error as Error).message });
    }
  }

  /** The rest of the post-commit work: the platform event, staging, and the source's copy of the state. Idempotent. */
  async #finalize(operation: PromotionOperation, input: { committed: SessionRecord; network: NetworkPolicy | undefined; sandboxId: string | undefined; durationMs: number }): Promise<void> {
    const { committed } = input;
    let current = this.#store.get(operation.id) ?? operation;
    if (!current.eventPublished) {
      const network = input.network ?? (await Promise.resolve(this.#policy()?.session?.(committed.id)).catch(() => undefined))?.policy ?? committed.network;
      const data: SessionPromotedData = {
        generation: committed.generation,
        placement: "sandbox",
        target: current.target,
        trigger: current.trigger,
        ...(current.toolCallId ? { toolCallId: current.toolCallId } : {}),
        network,
        durationMs: input.durationMs,
      };
      const sandboxId = input.sandboxId ?? current.sandboxId ?? (await this.#sandboxes()?.get(committed.id))?.id;
      const event: PlatformEvent = {
        // Stable per attempt, so subscribers can drop a repeat published by recovery.
        id: `evt_promoted_${current.id}`,
        type: "session.promoted",
        createdAt: new Date().toISOString(),
        sessionId: committed.id,
        environment: committed.environment,
        ...(sandboxId ? { sandboxId } : {}),
        data: data as unknown as Record<string, unknown>,
      };
      try {
        // Core reports `false` when the event reached live subscribers but not its ledger (so `Last-Event-ID` replay
        // would miss it); it is then published again, with the same ID, at the next start.
        const stored: unknown = this.#app.service("events").publish(event, { ownerId: committed.ownerId });
        if (stored === false) this.#log.warn("session.promoted was not stored in the event ledger; it is published again at the next start", { sessionId: committed.id });
        else current = this.#store.update(current.id, { eventPublished: true });
      } catch (error) {
        this.#log.warn("Could not publish session.promoted; it is retried at the next start", { sessionId: committed.id, error: (error as Error).message });
      }
    }
    await rm(join(this.#options.stagingRoot, current.id), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    current = await this.#cleanSource(current);
    if (current.eventPublished && current.sourceCleaned) this.#store.update(current.id, { finalized: true });
  }

  /**
   * Removes the source runtime's copy of the session state, so the fenced owner can never be reactivated. Only for
   * the incarnation that was promoted, or after that session was deleted: a session ID reused since then is someone
   * else's state and is never touched.
   */
  async #cleanSource(operation: PromotionOperation): Promise<PromotionOperation> {
    const target = operation.sourceStateDir;
    const current = optionalService<SessionsService>(this.#app.services, "sessions")?.get(operation.sessionId);
    const promoted = current !== undefined && current.placement === "sandbox" && current.generation >= (operation.toGeneration ?? operation.fromGeneration + 1) && current.createdAt <= operation.createdAt;
    if (!target || (current !== undefined && !promoted)) return this.#store.update(operation.id, { sourceCleaned: true });
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return this.#store.update(operation.id, { sourceCleaned: true });
    } catch (error) {
      this.#log.warn("Could not remove the session's state from the shared runtime yet; it is retried at the next start", { sessionId: operation.sessionId, error: (error as Error).message });
      return operation;
    }
  }

  /** A new attempt first releases what earlier attempts of the session left behind (their candidate sandbox). */
  async #releaseLeftovers(sessionId: string, current: string): Promise<void> {
    for (const operation of this.#store.owing()) {
      if (operation.sessionId === sessionId && operation.id !== current) await this.#releaseCandidate(operation.id);
    }
  }

  /**
   * Releases the candidate sandbox of an attempt that failed or was interrupted, if that is still owed. Runs inside
   * `#candidateWork`: an owed release means no later attempt of the session has allocated since.
   */
  async #releaseCandidate(operationId: string): Promise<void> {
    const operation = this.#store.get(operationId);
    if (!operation || operation.state !== "failed" || !operation.cleanupPending) return;
    const settled = await this.#releaseIfCandidate(operation);
    await rm(join(this.#options.stagingRoot, operation.id), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    if (settled) this.#store.update(operation.id, { cleanupPending: false });
  }

  // Recovery -------------------------------------------------------------------------------------------------------

  /**
   * Synchronous ledger reconciliation, run while modules register (before any of them starts and replays work). An
   * attempt whose commit reached core's ledger is committed: its carried call moves to the new generation at once,
   * before durable replays platform tools. Any other open attempt never committed: it is marked failed, its network
   * narrowing is reverted, and its candidate is released later by `recover()`. The source is then the only owner.
   */
  reconcile(): void {
    const sessions = optionalService<SessionsService>(this.#app.services, "sessions");
    for (const operation of this.#store.unfinished()) {
      const record = sessions?.get(operation.sessionId);
      if (record && record.placement === "sandbox" && record.generation > operation.fromGeneration && record.createdAt <= operation.createdAt) {
        this.#store.update(operation.id, { state: "committed", toGeneration: record.generation, committedAt: new Date().toISOString() });
        this.#log.info("A promotion committed before the restart; finishing its post-commit steps", { sessionId: operation.sessionId, operation: operation.id });
        continue;
      }
      this.#log.warn("A promotion was interrupted by a restart before it committed; the session stays on shared placement", { sessionId: operation.sessionId, operation: operation.id, state: operation.state });
      // A session that reused the ID was bound afresh, and its policy is its own.
      if (!record || record.createdAt <= operation.createdAt) {
        try {
          this.#policy()?.revertPromotion?.(operation.sessionId);
        } catch (error) {
          this.#log.warn("Could not restore the network policy of an interrupted promotion", { sessionId: operation.sessionId, error: (error as Error).message });
        }
      }
      this.#store.update(operation.id, {
        state: "failed",
        errorCode: "internal",
        error: "The gateway restarted before the promotion committed; the session stayed on shared placement",
        cleanupPending: operation.state !== "admitted",
      });
    }
    // Committed attempts whose post-commit steps a restart cut short: the carried call must reach the new generation
    // before durable replays it (both steps are idempotent).
    for (const operation of this.#store.owing()) {
      if (operation.state !== "committed") continue;
      const record = sessions?.get(operation.sessionId);
      if (record && record.placement === "sandbox" && record.createdAt <= operation.createdAt) this.#finalizeSync(operation, record.generation);
    }
  }

  /** Finishes what terminal attempts still owe: post-commit steps, or releasing an interrupted attempt's candidate. */
  async recover(): Promise<void> {
    const sessions = optionalService<SessionsService>(this.#app.services, "sessions");
    for (const operation of this.#store.owing()) {
      if (this.#closed) return;
      const record = sessions?.get(operation.sessionId);
      try {
        if (operation.state === "committed") {
          if (record && record.placement === "sandbox" && record.createdAt <= operation.createdAt) {
            this.#finalizeSync(operation, record.generation);
            await this.#finalize(operation, { committed: record, network: undefined, sandboxId: operation.sandboxId, durationMs: Date.parse(operation.committedAt ?? operation.updatedAt) - Date.parse(operation.createdAt) });
          } else {
            // The promoted session is gone (deleted, or its ID reused): only its leftovers remain to clean up.
            await rm(join(this.#options.stagingRoot, operation.id), { recursive: true, force: true }).catch(() => undefined);
            const cleaned = await this.#cleanSource(operation);
            this.#store.update(operation.id, { finalized: cleaned.sourceCleaned });
          }
          continue;
        }
        // An interrupted attempt's candidate, released in order with any newer attempt's allocation (which releases
        // it itself first, so a snapshot taken before that never undoes the newer candidate).
        await this.#candidateWork(operation.sessionId, () => this.#releaseCandidate(operation.id));
      } catch (error) {
        this.#log.warn("Promotion recovery step failed; it is retried at the next start", { sessionId: operation.sessionId, operation: operation.id, error: (error as Error).message });
      }
    }
  }
}

/** Background agents and shells that are running or waiting for input (they do not survive a runtime move). */
function activeTasks(list: { tasks?: { status?: string }[] } | undefined): number {
  return (list?.tasks ?? []).filter((task) => task.status === "running" || task.status === "idle").length;
}

function failure(code: string, message: string): PlatformToolResult {
  return {
    textResultForLlm: `The session could not move into a sandbox: ${message} Continue without one: say what you would have run, or answer from what you know.`,
    resultType: "failure",
    error: `${code}: ${message}`,
  };
}
