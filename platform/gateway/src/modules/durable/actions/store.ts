import type { ActionKind, ActionState, PendingAction } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import { parseJson, toIso } from "../ids.js";

/** States in which an action still needs (or may still receive) an answer. */
export const OPEN_STATES: readonly ActionState[] = ["pending", "claimed", "executing", "needs_reconciliation"];
export const OWNED_STATES: readonly ActionState[] = ["claimed", "executing"];

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
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export interface NewAction {
  readonly id: string;
  readonly sessionId: string;
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

  insertIfAbsent(action: NewAction): { row: ActionRow; created: boolean } {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO durable_actions (id, session_id, owner_id, environment, kind, request_id, tool_call_id, turn_id, tool,
           provider_id, agent_id, arguments, event, generation, state, idempotency_key, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.sessionId,
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
    const row = this.findByRequest(action.sessionId, action.kind, action.requestId);
    if (!row) throw new Error("Action insert did not persist");
    return { row, created: changed(result) };
  }

  get(id: string): ActionRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_actions WHERE id = ?").get(id) as ActionRow | undefined;
  }

  findByRequest(sessionId: string, kind: ActionKind, requestId: string): ActionRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_actions WHERE session_id = ? AND kind = ? AND request_id = ?").get(sessionId, kind, requestId) as
      | ActionRow
      | undefined;
  }

  listBySession(sessionId: string, states?: readonly ActionState[]): ActionRow[] {
    if (!states) return this.#db.prepare("SELECT * FROM durable_actions WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as unknown as ActionRow[];
    return this.#db
      .prepare(`SELECT * FROM durable_actions WHERE session_id = ? AND state IN (${placeholders(states)}) ORDER BY created_at, rowid`)
      .all(sessionId, ...states) as unknown as ActionRow[];
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
             live_connection = ?, lease_expires_at = ?, reason = NULL, updated_at = ?
           WHERE id = ? AND claim_seq = ? AND state IN (${placeholders(expected.states)})`,
        )
        .run(
          change.state,
          change.tokenHash,
          change.claimedBy,
          change.responderType,
          change.liveConnection,
          change.leaseExpiresAt,
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
    expected: { readonly states: readonly ActionState[]; readonly seq?: number },
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
    return changed(this.#db.prepare(`UPDATE durable_actions SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).run(...params));
  }

  markForwarded(id: string, now: number, reason?: string): void {
    if (reason === undefined) {
      this.#db.prepare("UPDATE durable_actions SET forwarded = 1, next_forward_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
    } else {
      this.#db.prepare("UPDATE durable_actions SET forwarded = 1, next_forward_at = NULL, reason = ?, updated_at = ? WHERE id = ?").run(reason, now, id);
    }
  }

  deferForward(id: string, nextAt: number, now: number): void {
    this.#db.prepare("UPDATE durable_actions SET forward_attempts = forward_attempts + 1, next_forward_at = ?, updated_at = ? WHERE id = ?").run(nextAt, now, id);
  }
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
    requestId: row.request_id,
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
