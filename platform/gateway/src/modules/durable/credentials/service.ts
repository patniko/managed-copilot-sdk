import { ManagedCopilotError, type AccountInfo, type BackgroundCredentialStatus } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import type { Authenticator, Principal } from "../../../http.js";
import type { Logger } from "../../../log.js";
import type { CredentialsService, SchedulesService } from "../contract.js";
import { toIso } from "../ids.js";
import { seal, unseal } from "../keys.js";

interface CredentialRow {
  readonly account_id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatar_url: string | null;
  readonly sealed_token: string | null;
  readonly state: "active" | "revoked" | "invalid";
  readonly reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_verified_at: number | null;
}

export interface CredentialsDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly sealKey: Buffer;
  readonly auth: () => Authenticator | undefined;
  readonly schedules: () => SchedulesService | undefined;
  readonly now?: () => number;
  /** How long a successful verification is reused before GitHub is asked again. */
  readonly verifyCacheMs?: number;
}

export const LOGIN_HINT = "Sign in once with `npx managed-copilot login` so work can continue while you're away.";
const LOGOUT_REASON = "Signed out with `managed-copilot logout`.";
const REJECTED_REASON = "GitHub no longer accepts the stored sign-in (it was revoked or expired). Run `npx managed-copilot login` again.";

const context = (accountId: number) => `durable/background-credential/${accountId}`;

/**
 * Background sign-in (spec section 2): the caller's own GitHub credential, sealed at rest, verified again whenever
 * background work uses it. A credential that GitHub rejects, or that now resolves to a different account, is
 * invalidated and its owner's schedules pause with a visible reason. Never substitutes another account.
 */
export class DurableCredentials implements CredentialsService {
  readonly #deps: CredentialsDeps;
  readonly #now: () => number;
  readonly #verified = new Map<number, { principal: Principal; at: number }>();

  constructor(deps: CredentialsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  store(principal: Principal): BackgroundCredentialStatus {
    const now = this.#now();
    this.#deps.db
      .prepare(
        `INSERT INTO durable_credentials (account_id, login, name, avatar_url, sealed_token, state, reason, created_at, updated_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
           sealed_token = excluded.sealed_token, state = 'active', reason = NULL, created_at = excluded.created_at,
           updated_at = excluded.updated_at, last_verified_at = excluded.last_verified_at`,
      )
      .run(principal.accountId, principal.login, principal.name ?? null, principal.avatarUrl ?? null, seal(this.#deps.sealKey, principal.token, context(principal.accountId)), now, now, now);
    this.#verified.set(principal.accountId, { principal, at: now });
    this.#deps.log.info("Background sign-in stored", { account: principal.login });
    return this.status(principal);
  }

  status(principal: Principal): BackgroundCredentialStatus {
    const row = this.#row(principal.accountId);
    const account = accountOf(principal);
    if (!row) return { account, active: false, reason: `Not signed in for background work. ${LOGIN_HINT}` };
    return {
      account,
      active: row.state === "active" && row.sealed_token !== null,
      createdAt: toIso(row.created_at)!,
      ...(row.last_verified_at !== null ? { lastVerifiedAt: toIso(row.last_verified_at)! } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  revoke(principal: Principal, reason = LOGOUT_REASON): void {
    this.#invalidate(principal.accountId, "revoked", reason);
  }

  has(accountId: number): boolean {
    const row = this.#row(accountId);
    return row !== undefined && row.state === "active" && row.sealed_token !== null;
  }

  async principalFor(accountId: number): Promise<Principal> {
    const cached = this.#verified.get(accountId);
    const row = this.#row(accountId);
    if (!row || row.state !== "active" || row.sealed_token === null) {
      this.#verified.delete(accountId);
      const who = row?.login ?? `Account ${accountId}`;
      throw new ManagedCopilotError("authentication_required", `${who} has no active background sign-in for this deployment. ${row?.reason ?? LOGIN_HINT}`);
    }
    const now = this.#now();
    if (cached && now - cached.at < (this.#deps.verifyCacheMs ?? 120_000)) return cached.principal;

    const authenticator = this.#deps.auth();
    if (!authenticator) throw new ManagedCopilotError("capability_unavailable", "Authentication is not configured on this gateway");
    const token = unseal(this.#deps.sealKey, row.sealed_token, context(accountId));
    let principal: Principal;
    try {
      principal = await authenticator.authenticate(token);
    } catch (error) {
      if (error instanceof ManagedCopilotError && (error.code === "authentication_required" || error.code === "forbidden")) {
        this.#invalidate(accountId, "invalid", error.code === "forbidden" ? `This account is no longer allowed to use this deployment. ${error.message}` : REJECTED_REASON);
        throw new ManagedCopilotError("authentication_required", `${row.login}'s background sign-in is no longer valid. ${REJECTED_REASON}`);
      }
      throw error;
    }
    if (principal.accountId !== accountId) {
      // Never run one person's work as another account.
      this.#invalidate(accountId, "invalid", "The stored sign-in now belongs to a different GitHub account. Run `npx managed-copilot login` again.");
      throw new ManagedCopilotError("authentication_required", `${row.login}'s background sign-in resolves to a different account`);
    }
    this.#deps.db.prepare("UPDATE durable_credentials SET last_verified_at = ?, login = ?, updated_at = ? WHERE account_id = ?").run(now, principal.login, now, accountId);
    this.#verified.set(accountId, { principal, at: now });
    return principal;
  }

  #invalidate(accountId: number, state: "revoked" | "invalid", reason: string): void {
    const now = this.#now();
    this.#verified.delete(accountId);
    this.#deps.db.prepare("UPDATE durable_credentials SET sealed_token = NULL, state = ?, reason = ?, updated_at = ? WHERE account_id = ?").run(state, reason, now, accountId);
    const paused = this.#deps.schedules()?.pauseAllForOwner(accountId, `Paused: ${reason}`) ?? 0;
    this.#deps.log.warn("Background sign-in removed", { accountId, state, pausedSchedules: paused });
  }

  #row(accountId: number): CredentialRow | undefined {
    return this.#deps.db.prepare("SELECT * FROM durable_credentials WHERE account_id = ?").get(accountId) as CredentialRow | undefined;
  }
}

function accountOf(principal: Principal): AccountInfo {
  return { id: principal.accountId, login: principal.login, ...(principal.name ? { name: principal.name } : {}), ...(principal.avatarUrl ? { avatarUrl: principal.avatarUrl } : {}) };
}
