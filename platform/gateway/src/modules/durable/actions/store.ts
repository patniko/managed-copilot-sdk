import type { ActionKind, ActionState, PendingAction } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import { parseJson, toIso } from "../ids.js";

/** States in which an action still needs (or may still receive) an answer. */
export const OPEN_STATES: readonly ActionState[] = ["pending", "claimed", "executing", "needs_reconciliation"];
export const OWNED_STATES: readonly ActionState[] = ["claimed", "executing"];
/** States with an answer the runtime must receive (an expiry is delivered as an error, refusal, or cancel). */
export const ANSWERED_STATES: readonly ActionState[] = ["completed", "failed", "expired"];

export interface ActionRow {
  readonly id: string;
  readonly session_id: string;
  readonly owner_id: number;
  readonly environment: string;
  readonly kind: ActionKind;
  readonly request_id: string;
  readonly tool_call_id: string | null;
  readonly turn_id: string | null;
  readonly tool: string | null;
  readonly provider_id: string | null;
  readonly agent_id: string | null;
  readonly arguments: string | null;
  readonly event: string;
  readonly generation: number;
  readonly state: ActionState;
  readonly idempotency_key: string;
  readonly claim_seq: number;
  readonly claim_token_hash: string | null;
  readonly claimed_by: string | null;
  readonly responder_type: string | null;
  readonly live_connection: string | null;
  readonly lease_expires_at: number | null;
  readonly deadline_at: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly result_hash: string | null;
  readonly reason: string | null;
  readonly forwarded: number;
  readonly forward_attempts: number;
  readonly next_forward_at: number | null;
  /** When the action was first included in a `session.action_required` notification. */
  readonly notified_at: number | null;
  /** JSON `{ connectionId: generation }`: live connections that held this action, and the placement they held it in. */
  readonly live_claimants: string | null;
  /** The session incarnation that asked (session IDs are reusable after deletion). Null only on pre-migration rows. */
  readonly incarnation: string | null;
  /** The request ID the runtime waits on now, when a restarted runtime rebuilt the request under a new one. */
  readonly runtime_request_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export interface NewAction {
  readonly id: string;
  readonly sessionId: string;
  readonly incarnation: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly kind: ActionKind;
  readonly requestId: string;
  readonly toolCallId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly tool?: string | undefined;
  readonly providerId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly arguments?: unknown;
  /** The raw runtime event, replayed to a responder that attaches later. */
  readonly event: unknown;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly deadlineAt: number;
  readonly now: number;
}

export interface ClaimChange {
  readonly state: "claimed" | "executing";
  readonly tokenHash: string;
  readonly claimedBy: string;
  readonly responderType: string;
  /** Set for live claims: the claim lasts as long as this connection stays attached. */
  readonly liveConnection: string | null;
  /** Null for live claims. */
  readonly leaseExpiresAt: number | null;
  /** Live claims: the action's claimant history including this connection (see `ActionRow.live_claimants`). */
  readonly liveClaimants?: string;
  readonly now: number;
}

export interface Outcome {
  readonly state: "completed" | "failed";
  readonly result?: unknown;
  readonly error?: string | undefined;
  readonly resultHash: string;
  readonly reason?: string | undefined;
  readonly now: number;
}

type Bindable = string | number | null;
const n = (value: string | number | undefined | null): Bindable => (value === undefined ? null : value);
const changed = (result: { changes: number | bigint }) => Number(result.changes) === 1;
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/** Synchronous ledger access. Every mutation is a compare-and-set on `claim_seq` and `state`. */
export class ActionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Records an action once per runtime request. The returned row is the one stored under that request, which belongs
   * to another incarnation only if a reused session ID also reused a runtime request ID (callers refuse that).
   */
  insertIfAbsent(action: NewAction): { row: ActionRow; created: boolean } {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO durable_actions (id, session_id, incarnation, owner_id, environment, kind, request_id, tool_call_id, turn_id, tool,
           provider_id, agent_id, arguments, event, generation, state, idempotency_key, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.sessionId,
        action.incarnation,
        action.ownerId,
        action.environment,
        action.kind,
        action.requestId,
        n(action.toolCallId),
        n(action.turnId),
        n(action.tool),
        n(action.providerId),
        n(action.agentId),
        action.arguments === undefined ? null : JSON.stringify(action.arguments),
        JSON.stringify(action.event),
        action.generation,
        action.idempotencyKey,
        action.deadlineAt,
        action.now,
        action.now,
      );
    const row = this.#db
      .prepare("SELECT * FROM durable_actions WHERE session_id = ? AND kind = ? AND request_id = ?")
      .get(action.sessionId, action.kind, action.requestId) as ActionRow | undefined;
    if (!row) throw new Error("Action insert did not persist");
    return { row, created: changed(result) };
  }

  get(id: string): ActionRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_actions WHERE id = ?").get(id) as ActionRow | undefined;
  }

  findByRequest(sessionId: string, incarnation: string, kind: ActionKind, requestId: string): ActionRow | undefined {
    // The request ID it was recorded under or the one a restarted runtime uses now; the current one wins.
    return this.#db
      .prepare(
        `SELECT * FROM durable_actions WHERE session_id = ? AND incarnation = ? AND kind = ? AND (request_id = ? OR runtime_request_id = ?)
         ORDER BY CASE WHEN COALESCE(runtime_request_id, request_id) = ? THEN 0 ELSE 1 END, rowid LIMIT 1`,
      )
      .get(sessionId, incarnation, kind, requestId, requestId, requestId) as ActionRow | undefined;
  }

  /** The (latest) tool action for a model tool call: rebuilt requests keep the tool call ID. */
  findByToolCall(sessionId: string, incarnation: string, toolCallId: string): ActionRow | undefined {
    return this.#db
      .prepare("SELECT * FROM durable_actions WHERE session_id = ? AND incarnation = ? AND kind = 'tool' AND tool_call_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(sessionId, incarnation, toolCallId) as ActionRow | undefined;
  }

  /**
   * Points an action at the request ID a restarted runtime now uses (CAS on the previous one). `redeliver` sends a
   * recorded answer again (to the current placement); `clearClaim` voids a previous owner's claim.
   */
  rebindRequest(
    id: string,
    change: {
      readonly from: string;
      readonly to: string;
      readonly event: unknown;
      readonly state: ActionState;
      readonly reason: string | null;
      readonly redeliver: boolean;
      readonly clearClaim: boolean;
      readonly generation: number;
      readonly now: number;
    },
  ): boolean {
    const sets = ["runtime_request_id = ?", "event = ?", "state = ?", "reason = ?", "updated_at = ?"];
    const params: Bindable[] = [change.to, JSON.stringify(change.event), change.state, change.reason, change.now];
    if (change.redeliver) {
      sets.push("forwarded = 0", "next_forward_at = NULL", "forward_attempts = 0", "generation = MAX(generation, ?)");
      params.push(change.generation);
    }
    if (OPEN_STATES.includes(change.state)) sets.push("completed_at = NULL", "forwarded = 0", "next_forward_at = NULL");
    if (change.clearClaim) sets.push("claim_seq = claim_seq + 1", "claim_token_hash = NULL", "claimed_by = NULL", "responder_type = NULL", "live_connection = NULL", "lease_expires_at = NULL");
    params.push(id, change.from);
    return changed(this.#db.prepare(`UPDATE durable_actions SET ${sets.join(", ")} WHERE id = ? AND COALESCE(runtime_request_id, request_id) = ?`).run(...params));
  }

  /** Whether an incarnation's runtime may still wait on the ledger: an open action or an undelivered answer. */
  hasOpenWork(sessionId: string, incarnation: string): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM durable_actions WHERE session_id = ? AND incarnation = ?
             AND (state IN (${placeholders(OPEN_STATES)}) OR (state IN (${placeholders(ANSWERED_STATES)}) AND forwarded = 0)) LIMIT 1`,
        )
        .get(sessionId, incarnation, ...OPEN_STATES, ...ANSWERED_STATES) !== undefined
    );
  }

  /** One incarnation's actions (all of them, or those in `states`), oldest first. */
  listBySession(sessionId: string, incarnation: string, states?: readonly ActionState[]): ActionRow[] {
    if (!states) {
      return this.#db
        .prepare("SELECT * FROM durable_actions WHERE session_id = ? AND incarnation = ? ORDER BY created_at, rowid")
        .all(sessionId, incarnation) as unknown as ActionRow[];
    }
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE session_id = ? AND incarnation = ? AND state IN (${placeholders(states)}) ORDER BY created_at, rowid`)
      .all(sessionId, incarnation, ...states) as unknown as ActionRow[];
  }

  /** Every incarnation's actions in `states` (deletion without a known incarnation; nothing newer exists then). */
  listByAnyIncarnation(sessionId: string, states: readonly ActionState[]): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE session_id = ? AND state IN (${placeholders(states)}) ORDER BY created_at, rowid`)
      .all(sessionId, ...states) as unknown as ActionRow[];
  }

  /** Sessions with rows from before incarnations were recorded. */
  sessionsWithoutIncarnation(): string[] {
    return (this.#db.prepare("SELECT DISTINCT session_id FROM durable_actions WHERE incarnation IS NULL").all() as { session_id: string }[]).map((row) => row.session_id);
  }

  /** Incarnations recorded provisionally from a session's creation time (`created:<iso>`). */
  provisionalIncarnations(): { session_id: string; incarnation: string }[] {
    return this.#db.prepare("SELECT DISTINCT session_id, incarnation FROM durable_actions WHERE incarnation LIKE 'created:%'").all() as unknown as {
      session_id: string;
      incarnation: string;
    }[];
  }

  rekeyIncarnation(sessionId: string, from: string, to: string): void {
    this.#db.prepare("UPDATE durable_actions SET incarnation = ? WHERE session_id = ? AND incarnation = ?").run(to, sessionId, from);
  }

  /** Incarnations with work the runtime may still wait on (open actions or undelivered answers). */
  liveIncarnations(): { session_id: string; incarnation: string }[] {
    return this.#db
      .prepare(
        `SELECT DISTINCT session_id, incarnation FROM durable_actions WHERE incarnation IS NOT NULL AND incarnation != 'retired'
           AND (state IN (${placeholders(OPEN_STATES)}) OR (state IN (${placeholders(ANSWERED_STATES)}) AND forwarded = 0))`,
      )
      .all(...OPEN_STATES, ...ANSWERED_STATES) as unknown as { session_id: string; incarnation: string }[];
  }

  /** Replaces the stored runtime event (the full request arrived for a prompt first known from its derived form). */
  updateEvent(id: string, event: unknown): void {
    this.#db.prepare("UPDATE durable_actions SET event = ? WHERE id = ?").run(JSON.stringify(event), id);
  }

  /**
   * Assigns pre-migration rows to the session's current incarnation when they are its owner's and not older than it;
   * every other such row belonged to an earlier incarnation and is retired (never listed, claimed, or delivered).
   */
  assignIncarnation(sessionId: string, current: { readonly incarnation: string; readonly ownerId: number; readonly createdAtMs?: number } | undefined): void {
    if (current) {
      this.#db
        .prepare("UPDATE durable_actions SET incarnation = ? WHERE session_id = ? AND incarnation IS NULL AND owner_id = ? AND created_at >= ?")
        .run(current.incarnation, sessionId, current.ownerId, current.createdAtMs ?? 0);
    }
    this.#db
      .prepare(
        `UPDATE durable_actions SET incarnation = 'retired', forwarded = 1, next_forward_at = NULL,
           state = CASE WHEN state IN (${placeholders(OPEN_STATES)}) THEN 'cancelled' ELSE state END,
           reason = CASE WHEN state IN (${placeholders(OPEN_STATES)}) THEN 'The session this action belonged to was deleted' ELSE reason END,
           claim_token_hash = NULL, live_connection = NULL, lease_expires_at = NULL
         WHERE session_id = ? AND incarnation IS NULL`,
      )
      .run(...OPEN_STATES, ...OPEN_STATES, sessionId);
  }

  listByLiveConnection(connectionId: string): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE live_connection = ? AND state IN ('claimed', 'executing') ORDER BY created_at, rowid`)
      .all(connectionId) as unknown as ActionRow[];
  }

  /** Live claims survive only as long as their connection; after a gateway restart every one of them is orphaned. */
  listLiveClaims(): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE live_connection IS NOT NULL AND state IN ('claimed', 'executing')`)
      .all() as unknown as ActionRow[];
  }

  listOwnedBy(responderType: string): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE responder_type = ? AND state IN ('claimed', 'executing') ORDER BY created_at, rowid`)
      .all(responderType) as unknown as ActionRow[];
  }

  listLeaseExpired(now: number): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE state IN ('claimed', 'executing') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`)
      .all(now) as unknown as ActionRow[];
  }

  listPastDeadline(now: number): ActionRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE state IN (${placeholders(OPEN_STATES)}) AND deadline_at <= ?`)
      .all(...OPEN_STATES, now) as unknown as ActionRow[];
  }

  /** Answers (and expiry notices) recorded in the ledger that the runtime has not acknowledged yet. */
  listUnforwarded(now: number): ActionRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM durable_actions WHERE state IN ('completed', 'failed', 'expired') AND forwarded = 0
           AND (next_forward_at IS NULL OR next_forward_at <= ?) ORDER BY completed_at, rowid`,
      )
      .all(now) as unknown as ActionRow[];
  }

  claim(id: string, expected: { readonly states: readonly ActionState[]; readonly seq: number }, change: ClaimChange): boolean {
    return changed(
      this.#db
        .prepare(
          `UPDATE durable_actions SET state = ?, claim_seq = claim_seq + 1, claim_token_hash = ?, claimed_by = ?, responder_type = ?,
             live_connection = ?, lease_expires_at = ?, live_claimants = COALESCE(?, live_claimants), reason = NULL, updated_at = ?
           WHERE id = ? AND claim_seq = ? AND state IN (${placeholders(expected.states)})`,
        )
        .run(
          change.state,
          change.tokenHash,
          change.claimedBy,
          change.responderType,
          change.liveConnection,
          change.leaseExpiresAt,
          n(change.liveClaimants),
          change.now,
          id,
          expected.seq,
          ...expected.states,
        ),
    );
  }

  renew(id: string, seq: number, tokenHash: string, leaseExpiresAt: number, now: number): boolean {
    return changed(
      this.#db
        .prepare(
          `UPDATE durable_actions SET state = 'executing', lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND claim_seq = ? AND claim_token_hash = ? AND state IN ('claimed', 'executing')`,
        )
        .run(leaseExpiresAt, now, id, seq, tokenHash),
    );
  }

  /** Records an answer from the current claim holder, identified by its claim token or its live connection. */
  complete(id: string, holder: { readonly seq: number; readonly tokenHash?: string; readonly liveConnection?: string }, outcome: Outcome): boolean {
    const conditions = ["id = ?", "claim_seq = ?", "state IN ('claimed', 'executing', 'needs_reconciliation')"];
    const params: Bindable[] = [id, holder.seq];
    if (holder.tokenHash !== undefined) {
      conditions.push("claim_token_hash = ?");
      params.push(holder.tokenHash);
    }
    if (holder.liveConnection !== undefined) {
      conditions.push("live_connection = ?");
      params.push(holder.liveConnection);
    }
    return changed(
      this.#db
        .prepare(
          `UPDATE durable_actions SET state = ?, result = ?, error = ?, result_hash = ?, reason = ?, completed_at = ?, updated_at = ?,
             lease_expires_at = NULL, forwarded = 0, next_forward_at = NULL
           WHERE ${conditions.join(" AND ")}`,
        )
        .run(
          outcome.state,
          outcome.result === undefined ? null : JSON.stringify(outcome.result),
          n(outcome.error),
          outcome.resultHash,
          n(outcome.reason),
          outcome.now,
          outcome.now,
          ...params,
        ),
    );
  }

  /** Moves an action between states without an answer (release, reconciliation, expiry, cancellation). */
  transition(
    id: string,
    expected: { readonly states: readonly ActionState[]; readonly seq?: number; readonly generation?: number },
    to: { readonly state: ActionState; readonly reason?: string | null; readonly clearClaim?: boolean; readonly forwarded?: boolean; readonly now: number },
  ): boolean {
    const sets = ["state = ?", "reason = ?", "updated_at = ?", "lease_expires_at = NULL"];
    const params: Bindable[] = [to.state, n(to.reason), to.now];
    if (to.clearClaim) sets.push("claim_token_hash = NULL", "claimed_by = NULL", "responder_type = NULL", "live_connection = NULL");
    if (to.forwarded !== undefined) {
      sets.push("forwarded = ?", "next_forward_at = NULL");
      params.push(to.forwarded ? 1 : 0);
    }
    if (to.state === "expired" || to.state === "cancelled") {
      sets.push("completed_at = ?");
      params.push(to.now);
    }
    const conditions = ["id = ?", `state IN (${placeholders(expected.states)})`];
    params.push(id, ...expected.states);
    if (expected.seq !== undefined) {
      conditions.push("claim_seq = ?");
      params.push(expected.seq);
    }
    if (expected.generation !== undefined) {
      conditions.push("generation = ?");
      params.push(expected.generation);
    }
    return changed(this.#db.prepare(`UPDATE durable_actions SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).run(...params));
  }

  /**
   * Moves an open action to a newer placement generation (never back); voiding its claim bumps the claim sequence,
   * so tokens and live connections from before the move can no longer commit (fencing).
   */
  moveToGeneration(
    id: string,
    seq: number,
    change: {
      readonly generation: number;
      readonly state: ActionState;
      readonly clearClaim: boolean;
      readonly reason: string | null;
      /** Updated claimant history (a live claim carried into the new placement is held there). */
      readonly liveClaimants?: string;
      readonly now: number;
    },
  ): boolean {
    const claim = change.clearClaim
      ? ", claim_seq = claim_seq + 1, claim_token_hash = NULL, claimed_by = NULL, responder_type = NULL, live_connection = NULL, lease_expires_at = NULL"
      : "";
    return changed(
      this.#db
        .prepare(
          `UPDATE durable_actions SET generation = ?, state = ?, reason = ?, live_claimants = COALESCE(?, live_claimants), updated_at = ?${claim}
           WHERE id = ? AND claim_seq = ? AND generation < ? AND state IN (${placeholders(OPEN_STATES)})`,
        )
        .run(change.generation, change.state, change.reason, n(change.liveClaimants), change.now, id, seq, change.generation, ...OPEN_STATES),
    );
  }

  /**
   * A newer placement still waits for a request answered under an older one (it was carried across promotion): the
   * recorded answer moves to that generation and is delivered again from a fresh retry budget.
   */
  adoptAnswer(id: string, fromGeneration: number, toGeneration: number, now: number): boolean {
    return changed(
      this.#db
        .prepare(
          `UPDATE durable_actions SET generation = ?, forwarded = 0, next_forward_at = NULL, forward_attempts = 0,
             reason = CASE WHEN state = 'expired' THEN reason ELSE NULL END, updated_at = ?
           WHERE id = ? AND generation = ? AND generation < ? AND state IN (${placeholders(ANSWERED_STATES)})`,
        )
        .run(toGeneration, now, id, fromGeneration, toGeneration, ...ANSWERED_STATES),
    );
  }

  /**
   * Marks an undelivered answer as delivered (or as never deliverable, with a reason). `generation` scopes it to the
   * placement that was attempted, so a late acknowledgment from an older placement never covers a newer one.
   */
  markForwarded(id: string, now: number, reason?: string, generation?: number): void {
    const sets = ["forwarded = 1", "next_forward_at = NULL", "updated_at = ?"];
    const params: Bindable[] = [now];
    if (reason !== undefined) {
      sets.push("reason = ?");
      params.push(reason);
    }
    const conditions = ["id = ?", "forwarded = 0"];
    params.push(id);
    if (generation !== undefined) {
      conditions.push("generation = ?");
      params.push(generation);
    }
    this.#db.prepare(`UPDATE durable_actions SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).run(...params);
  }

  deferForward(id: string, nextAt: number, now: number, generation?: number): void {
    const scope = generation === undefined ? "" : " AND generation = ?";
    this.#db
      .prepare(`UPDATE durable_actions SET forward_attempts = forward_attempts + 1, next_forward_at = ?, updated_at = ? WHERE id = ? AND forwarded = 0${scope}`)
      .run(nextAt, now, id, ...(generation === undefined ? [] : [generation]));
  }

  markNotified(ids: readonly string[], now: number): void {
    if (ids.length === 0) return;
    this.#db.prepare(`UPDATE durable_actions SET notified_at = ? WHERE notified_at IS NULL AND id IN (${placeholders(ids)})`).run(now, ...ids);
  }

  /** The action is offered again and needs a fresh announcement; until one is published, the sweeper repairs it. */
  clearNotified(id: string): void {
    this.#db.prepare("UPDATE durable_actions SET notified_at = NULL WHERE id = ? AND notified_at IS NOT NULL").run(id);
  }

  /** Pending actions created before `createdBefore` that no `session.action_required` announced yet. */
  listUnnotifiedPending(createdBefore: number): ActionRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_actions WHERE state = 'pending' AND notified_at IS NULL AND created_at <= ? ORDER BY created_at, rowid LIMIT 500")
      .all(createdBefore) as unknown as ActionRow[];
  }
}

/** The request ID the runtime waits on now (a restarted runtime may have rebuilt the request under a new one). */
export function runtimeRequestId(row: Pick<ActionRow, "request_id" | "runtime_request_id">): string {
  return row.runtime_request_id ?? row.request_id;
}

/** Customer-visible view of an action (`GET /v1/sessions/:id/actions`, `SessionInfo.pendingActions`). */
export function toPendingAction(row: ActionRow): PendingAction {
  const answered = row.state === "completed" || row.state === "failed";
  const owned = row.state === "claimed" || row.state === "executing";
  const payload = actionPayload(row);
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    requestId: runtimeRequestId(row),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.kind === "tool" && row.arguments !== null ? { arguments: parseJson(row.arguments) } : {}),
    ...(payload !== undefined ? { payload } : {}),
    idempotencyKey: row.idempotency_key,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    createdAt: toIso(row.created_at)!,
    expiresAt: toIso(row.deadline_at)!,
    ...(row.claimed_by && (owned || answered) ? { claimedBy: row.claimed_by } : {}),
    ...(answered && row.result !== null ? { result: parseJson(row.result) } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

/** What a handler needs besides arguments: the stock `PermissionRequest`, or the elicitation's message and schema. */
function actionPayload(row: ActionRow): unknown {
  if (row.kind === "permission") return parseJson<{ data?: Record<string, unknown> }>(row.event)?.data?.permissionRequest;
  if (row.kind === "elicitation") return parseJson(row.arguments);
  return undefined;
}
