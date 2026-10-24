/**
 * Promotion workstream contract (spec section 9 and its Promotion contract, gate G5; architecture "Promotion").
 *
 * Types only, so other modules can import it without the implementation.
 *
 * - Provides `promotion` (`promote`, `latest`), the `request_sandbox` platform tool, `POST /v1/sessions/:id/promote`,
 *   and the `session.promoted` platform event (top-level `sessionId` and `sandboxId`; `data: SessionPromotedData`).
 * - Consumes core's `sessions.cutover` (`PlacementCutover`), `events`, and `platformTools`; sandbox's `sandboxes`
 *   (`create`, `importRuntimeState`, `delete`, `get`); network's `policy` (`promoteSession`, `revertPromotion`); and
 *   durable's `actions` (`list`, `onGenerationChanged`). The ports below are structural, so providers only need to be
 *   compatible with them.
 *
 * ## One promotion, step by step (the stock runtime 1.0.103 primitives it relies on are noted)
 *
 * 1. Admit one operation per session and placement generation: the session is promotable and owned, the target is
 *    an available isolated environment on the same billing route, and no other operation is open. API calls join an
 *    operation already in flight; a second `request_sandbox` call is answered `promotion_busy` at once.
 * 2. Narrow the session's network policy to the target (`policy.promoteSession`) and allocate the sandbox from the
 *    target's image, size, and setup with the source's customizations, policy, vaults, and caller additions. The
 *    source keeps serving while setup runs.
 * 3. Quiesce: an API promotion needs an idle session (`session_busy` otherwise); a tool promotion needs its own
 *    `request_sandbox` call to be the only open work (`promotion_busy` otherwise). Then `fence()`, then fence the
 *    participants (paths into the source that core's fence does not cover, such as an attached Copilot CLI's AHP
 *    relay), then check again: what either path started before its fence is visible now.
 * 4. Move the runtime state: `session.suspend` (tool promotion: checkpoints the pending call), `sessions.close`,
 *    copy `session-state/<id>/` (lock files skipped, platform paths rewritten, refused if it holds a GitHub token),
 *    and `importRuntimeState` it into the sandbox runtime's COPILOT_HOME.
 * 5. `open({ continuePendingWork })`: the destination resumes the same session ID with the sandbox admission. A
 *    tool promotion verifies the carried `request_sandbox` call is pending there (same requestId and toolCallId).
 * 6. `commit()`: placement and generation move in one transaction, routing switches, and the old owner stays fenced.
 *    Durable moves the carried call to the new generation; `session.promoted` is published; the source copy of the
 *    state is deleted so nothing can reactivate it.
 * 7. Before commit, any failure aborts the cutover (the source resumes on next use, with `continuePendingWork` for a
 *    tool promotion so its call can still be answered), reverts the network narrowing, and deletes the candidate.
 *    After commit, only the destination is recovered.
 */
import type { NetworkPolicy, PendingAction, PromoteResult, PromotionTrigger, SandboxInfo } from "@managed-copilot/protocol";
import type { Principal } from "../../http.js";
import type { CreateSandboxRequest } from "../sandbox/contract.js";

export type OperationState = "admitted" | "allocating" | "quiescing" | "transferring" | "opening" | "committed" | "failed";

/** One promotion attempt (`promotion_operations`). */
export interface PromotionOperation {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: number;
  readonly fromGeneration: number;
  readonly toGeneration?: number;
  readonly trigger: PromotionTrigger;
  /** Tool promotions: the `request_sandbox` call that is carried into the sandbox. */
  readonly toolCallId?: string;
  /** The carried call's runtime request ID on the destination. */
  readonly requestId?: string;
  /** The isolated environment that supplies the sandbox. */
  readonly target: string;
  readonly state: OperationState;
  readonly sandboxId?: string;
  readonly errorCode?: string;
  readonly error?: string;
  /** The source runtime's copy of the session state (removed after commit). */
  readonly sourceStateDir?: string;
  /** Whether the source runtime's copy of the session state was removed after commit. */
  readonly sourceCleaned: boolean;
  /** Whether `session.promoted` went out. */
  readonly eventPublished: boolean;
  /** Committed attempts: every post-commit step is done. */
  readonly finalized: boolean;
  /** Failed attempts interrupted by a restart: the candidate sandbox and staging still have to be released. */
  readonly cleanupPending: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export interface PromotionService {
  /** Promotes an owned, idle, promotable session into its sandbox. Idempotent per placement generation. */
  promote(principal: Principal, sessionId: string): Promise<PromoteResult>;
  /** The most recent operation for a session, for diagnostics. */
  latest(sessionId: string): PromotionOperation | undefined;
  /**
   * Registers a module with its own path into sessions' runtimes, fenced with every promotion (see
   * `PromotionParticipant`). Register at start (promotion registers after most modules). Returns the unregistration.
   */
  participate(participant: PromotionParticipant): () => void;
}

/** How a cutover a participant was fenced for ended. */
export interface PromotionParticipantOutcome {
  /** The session now runs in its sandbox (core's `promoted` lifecycle event has already fired). */
  readonly committed: boolean;
  /**
   * The source runtime was checkpointed (`session.suspend` and/or `sessions.close` were attempted). After an abort the
   * source then holds the session afresh: core resumed it, so anything bound to the session object it had before (an
   * AHP host's publication) is stale. Always true when `committed`.
   */
  readonly sealed: boolean;
}

/**
 * A module with its own path into a session's runtime that core's fence does not cover: attach's relay of an attached
 * Copilot CLI to an AHP host on the source runtime. Promotion fences participants right after core's fence (the ledger
 * already says `promoting`, so new attachments are refused) and before it checks quiescence again and checkpoints the
 * source, and releases them when the cutover ends.
 */
export interface PromotionParticipant {
  /** Shown in errors and logs (for example "Copilot CLI attach"). */
  readonly name: string;
  /**
   * Resolve once nothing more from this path can reach the source runtime for the session, and what it already sent
   * there has been handed to the session, so promotion's check right after sees any work it started (then the move
   * fails with `session_busy`/`promotion_busy` instead of abandoning that work). Rejecting, or not resolving within the
   * bound (`signal` aborts), fails the promotion before the checkpoint; `release` follows either way.
   */
  fence(sessionId: string, signal: AbortSignal): Promise<void>;
  /**
   * Called once for every `fence` call, after the cutover ended: after commit, or after core's abort settled the source
   * (its ledger state restored, its requests flowing again). Must not throw; may run while a timed-out `fence` is still
   * settling.
   */
  release(sessionId: string, outcome: PromotionParticipantOutcome): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports consumed from other workstreams
// ---------------------------------------------------------------------------------------------------------------

/** From sandbox: `sandboxes`. */
export interface PromotionSandboxesPort {
  /** False while the backend fails its readiness checks (Docker down, Azure not configured). */
  readonly available?: boolean;
  /** Re-checks the backend now and returns the new `available`. */
  probe?(): Promise<boolean>;
  create(request: CreateSandboxRequest): Promise<{ readonly sandboxId: string; readonly info: SandboxInfo }>;
  /**
   * Copies a staged `session-state/<sessionId>` directory into the running sandbox runtime's COPILOT_HOME (as the
   * sandbox user, symlinks refused). `activeTurnId` marks a turn that started on the source and finishes in the
   * sandbox, so its `outputs/` publish when it completes.
   */
  importRuntimeState?(sessionId: string, input: { readonly sessionStateDir: string; readonly activeTurnId?: string }): Promise<{ readonly files: number; readonly bytes: number }>;
  /**
   * Deletes the session's sandbox. With `sandboxId`, only while that is still the session's sandbox (checked under
   * the session lock); implementations without the option delete unconditionally.
   */
  delete(sessionId: string, options?: { readonly sandboxId?: string }): Promise<void>;
  get(sessionId: string): Promise<SandboxInfo | undefined> | SandboxInfo | undefined;
}

/** From network: `policy`. */
export interface PromotionPolicyPort {
  session?(sessionId: string): { readonly policy: NetworkPolicy } | undefined | Promise<{ readonly policy: NetworkPolicy } | undefined>;
  /** Narrows the session's binding by the target's ceiling (never broader) and returns the new policy. */
  promoteSession?(sessionId: string, targetEnvironment: string): NetworkPolicy;
  /** Restores the binding from before the last `promoteSession` (pre-commit rollback); a no-op when none is pending. */
  revertPromotion?(sessionId: string): NetworkPolicy | undefined | void;
  /** Makes the promoted binding final once the cutover committed (a later revert is a no-op). */
  commitPromotion?(sessionId: string): void;
}

/** From durable: `actions`. */
export interface PromotionActionsPort {
  list(sessionId: string, options?: { readonly open?: boolean }): readonly PendingAction[];
  /** Moves actions to a new placement generation; `carried` requests stay claimed and are delivered there. */
  onGenerationChanged?(sessionId: string, generation: number, options?: { readonly carried?: readonly string[] }): void | Promise<void>;
}

declare module "../../app.js" {
  interface GatewayServices {
    promotion: PromotionService;
  }
}
