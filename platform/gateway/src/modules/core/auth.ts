// GitHub authentication for the gateway: verifies bearer tokens against the GitHub API (cached), applies the
// AppHost access rules, and keeps the freshest verified token per account for per-session runtime credentials.
import { createHash } from "node:crypto";
import { ManagedCopilotError, type AccountInfo } from "@managed-copilot/protocol";
import type { Authenticator, Principal } from "../../http.js";
import type { Logger } from "../../log.js";

export interface AccessRules {
  readonly githubOrgs?: readonly string[];
  readonly githubUsers?: readonly string[];
}

export interface GitHubAuthOptions {
  /** GitHub REST API base URL (https://api.github.com, or a loopback stub in tests). */
  readonly apiUrl: string;
  readonly access?: AccessRules;
  readonly log: Logger;
  /** How long a verified token is trusted before it is re-verified. */
  readonly cacheTtlMs?: number;
  /** How long a rejected token stays rejected without another GitHub call. */
  readonly negativeTtlMs?: number;
  /**
   * How long after its last successful verification a token is still accepted while GitHub is unreachable
   * (transport errors, timeouts, 5xx, rate limits). Never after GitHub rejected it. Default 15 minutes.
   */
  readonly staleGraceMs?: number;
  /** Base delays between attempts of one GitHub call (each jittered to 50–150%). */
  readonly retryDelaysMs?: readonly number[];
  /** While GitHub is unreachable, how often a token standing in on its recent verification is re-checked. */
  readonly outageRecheckMs?: number;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

interface CacheEntry {
  readonly principal?: Principal;
  readonly error?: ManagedCopilotError;
  /** Until when the entry answers without calling GitHub. */
  readonly expiresAt: number;
  /** When GitHub last verified the token. */
  readonly verifiedAt?: number;
  /** Until when a verified principal may stand in while GitHub is unreachable. */
  readonly staleUntil?: number;
  /** The principal is standing in on a past verification because GitHub was unreachable at the last check. */
  readonly outage?: boolean;
}

export interface LiveCredential {
  readonly token: string;
  readonly verifiedAt: number;
  /** From GitHub's `github-authentication-token-expiration` header, when the token expires. */
  readonly expiresAt?: number;
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function accountInfo(principal: Principal): AccountInfo {
  return {
    id: principal.accountId,
    login: principal.login,
    ...(principal.name ? { name: principal.name } : {}),
    ...(principal.avatarUrl ? { avatarUrl: principal.avatarUrl } : {}),
  };
}

export class GitHubAuthenticator implements Authenticator {
  readonly #options: GitHubAuthOptions;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Principal>>();
  readonly #credentials = new Map<number, LiveCredential>();
  readonly #listeners = new Set<(principal: Principal) => void>();

  constructor(options: GitHubAuthOptions) {
    this.#options = options;
  }

  get accessRules(): AccessRules | undefined {
    return this.#options.access;
  }

  async authenticate(token: string): Promise<Principal> {
    if (!token || token.length > 4096 || /\s/.test(token)) throw new ManagedCopilotError("authentication_required", "The GitHub token is malformed");
    // Action capabilities (`mcc_…`) authorize only their own action routes; they are never sent to GitHub.
    if (token.startsWith("mcc_")) throw new ManagedCopilotError("authentication_required", "Action capability tokens are only valid for their session's action routes");
    const key = tokenFingerprint(token);
    const cached = this.#cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      if (cached.error) throw cached.error;
      if (cached.principal) {
        if (!cached.outage) this.#remember(cached.principal);
        return cached.principal;
      }
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#verify(token, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    // During a GitHub outage, a token already standing in on its recent verification keeps answering while the
    // re-check runs in the background, so callers don't wait out the retry budget on every re-check.
    if (cached?.principal && cached.outage && cached.staleUntil !== undefined && cached.staleUntil > now) {
      pending.catch(() => undefined);
      return cached.principal;
    }
    return pending;
  }

  /** The freshest verified token for an account, if one was seen recently and has not expired. */
  liveCredential(accountId: number): LiveCredential | undefined {
    const credential = this.#credentials.get(accountId);
    if (!credential) return undefined;
    if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
      this.#credentials.delete(accountId);
      return undefined;
    }
    return credential;
  }

  /** Observes successful authentications (e.g. to refresh session credentials). */
  onAuthenticated(listener: (principal: Principal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Forgets a token (e.g. after GitHub rejected it for model calls). */
  invalidate(token: string): void {
    this.#cache.delete(tokenFingerprint(token));
    for (const [accountId, credential] of this.#credentials) {
      if (credential.token === token) this.#credentials.delete(accountId);
    }
  }

  async #verify(token: string, key: string): Promise<Principal> {
    try {
      return await this.#verifyWithGitHub(token, key);
    } catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      const { log } = this.#options;
      const now = Date.now();
      const previous = this.#cache.get(key);
      if (previous?.principal && previous.staleUntil !== undefined && previous.staleUntil > now) {
        // GitHub is briefly unreachable. This token verified recently and GitHub has not rejected it since (a
        // rejection replaces the entry), so its last verification stands in until the stale window closes.
        log.warn("GitHub is unreachable; accepting the token's recent verification", {
          login: previous.principal.login,
          verifiedSecondsAgo: Math.round((now - (previous.verifiedAt ?? now)) / 1000),
          error: error.message,
        });
        this.#cache.set(key, { ...previous, outage: true, expiresAt: Math.min(previous.staleUntil, now + (this.#options.outageRecheckMs ?? OUTAGE_RECHECK_MS)) });
        return previous.principal;
      }
      log.warn("GitHub is unreachable while verifying a token", { error: error.message });
      throw new ManagedCopilotError("upstream_unavailable", "GitHub is unreachable from the gateway right now, so the credential cannot be verified. Retry shortly.", {
        upstream: "github",
        retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      });
    }
  }

  async #verifyWithGitHub(token: string, key: string): Promise<Principal> {
    const response = await this.#get("/user", token);
    if (response.status === 401) {
      this.invalidate(token);
      return this.#reject(key, new ManagedCopilotError("authentication_required", "GitHub rejected this token. Sign in again (for example `gh auth login`) and retry."));
    }
    if (response.status === 403) {
      this.invalidate(token);
      return this.#reject(key, new ManagedCopilotError("authentication_required", "This token cannot identify a GitHub user (GitHub returned HTTP 403). Use a user token, for example from `gh auth token`."));
    }
    if (!response.ok) throw new GitHubUnavailable(`GitHub returned HTTP ${response.status}`);
    const user = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown; type?: unknown };
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new ManagedCopilotError("authentication_required", "The token does not identify a GitHub user account");
    }
    const principal: Principal = {
      accountId: user.id,
      login: user.login,
      ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
      ...(typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {}),
      token,
    };
    const expiresAt = parseExpiration(response.headers.get("github-authentication-token-expiration"));
    await this.#checkAccess(principal, key);
    const now = Date.now();
    const limit = expiresAt ?? Number.POSITIVE_INFINITY;
    this.#cache.set(key, {
      principal,
      verifiedAt: now,
      expiresAt: Math.min(now + (this.#options.cacheTtlMs ?? 5 * 60_000), limit),
      staleUntil: Math.min(now + (this.#options.staleGraceMs ?? 15 * 60_000), limit),
    });
    this.#remember(principal, expiresAt);
    this.#prune();
    return principal;
  }

  async #checkAccess(principal: Principal, key: string): Promise<void> {
    const access = this.#options.access;
    const users = access?.githubUsers ?? [];
    const orgs = access?.githubOrgs ?? [];
    if (users.length === 0 && orgs.length === 0) return;
    if (users.some((user) => user.toLowerCase() === principal.login.toLowerCase())) return;
    for (const org of orgs) {
      // The caller checks their own membership, so private memberships are visible to them. Outages throw
      // GitHubUnavailable (never "not a member"); 404 and other refusals mean not a member of this org.
      const response = await this.#get(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(principal.login)}`, principal.token);
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 204) return;
      if (response.status >= 500) throw new GitHubUnavailable(`GitHub returned HTTP ${response.status} for an organization membership check`);
    }
    const allowed = [...orgs.map((org) => `members of ${org}`), ...users.map((user) => `@${user}`)].join(", ");
    this.#reject(key, new ManagedCopilotError("forbidden", `@${principal.login} is not allowed to use this deployment (allowed: ${allowed})`));
  }

  /** Records a definitive answer from GitHub; it replaces any earlier verification, so no stale window survives it. */
  #reject(key: string, error: ManagedCopilotError): never {
    this.#cache.set(key, { error, expiresAt: Date.now() + (this.#options.negativeTtlMs ?? 30_000) });
    throw error;
  }

  #remember(principal: Principal, expiresAt?: number): void {
    const previous = this.#credentials.get(principal.accountId);
    const credential: LiveCredential = {
      token: principal.token,
      verifiedAt: Date.now(),
      ...(expiresAt !== undefined ? { expiresAt } : previous?.token === principal.token && previous.expiresAt !== undefined ? { expiresAt: previous.expiresAt } : {}),
    };
    this.#credentials.set(principal.accountId, credential);
    for (const listener of this.#listeners) {
      try {
        listener(principal);
      } catch (error) {
        this.#options.log.warn("Authentication listener failed", { error: (error as Error).message });
      }
    }
  }

  #prune(): void {
    if (this.#cache.size < 1000) return;
    const now = Date.now();
    for (const [key, entry] of this.#cache) if (Math.max(entry.expiresAt, entry.staleUntil ?? 0) <= now) this.#cache.delete(key);
  }

  /**
   * GETs are idempotent, so transport errors (resets, refused connections, a cold DNS/TLS path that stalls past one
   * attempt's timeout) and 5xx answers are retried with jittered backoff within an overall deadline. Rate limits are
   * not retried. Throws GitHubUnavailable when GitHub could not answer; any other status is returned.
   */
  async #get(path: string, token: string): Promise<Response> {
    const doFetch = this.#options.fetch ?? fetch;
    const url = `${this.#options.apiUrl.replace(/\/+$/, "")}${path}`;
    const init = {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.#options.userAgent ?? "managed-copilot-gateway",
      },
      redirect: "manual" as const,
    };
    const delays = this.#options.retryDelaysMs ?? GITHUB_RETRY_DELAYS_MS;
    const deadline = Date.now() + GITHUB_DEADLINE_MS;
    for (let attempt = 0; ; attempt++) {
      const timeout = Math.max(1_000, Math.min(GITHUB_ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
      let problem: string;
      try {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
        const retryAfter = rateLimitRetryAfter(response);
        if (retryAfter !== undefined) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubUnavailable(`GitHub rate-limited the gateway (HTTP ${response.status})`, retryAfter);
        }
        if (!TRANSIENT_STATUSES.has(response.status)) return response;
        await response.body?.cancel().catch(() => undefined);
        problem = `GitHub returned HTTP ${response.status}`;
      } catch (error) {
        if (error instanceof GitHubUnavailable) throw error;
        problem = describeFetchError(error);
      }
      const base = delays[attempt];
      if (base === undefined || deadline - Date.now() < base + 1_000) throw new GitHubUnavailable(`${problem} (after ${attempt + 1} attempts)`);
      await new Promise((resolve) => setTimeout(resolve, Math.round(base * (0.5 + Math.random()))));
    }
  }
}

/** GitHub could not answer (transport error, timeout, 5xx, rate limit). Says nothing about the token itself. */
class GitHubUnavailable extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "GitHubUnavailable";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Seconds to wait when GitHub rate-limited the request (429, or 403 with rate-limit headers); otherwise undefined. */
function rateLimitRetryAfter(response: Response): number | undefined {
  const limited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
  if (!limited) return undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60;
}

function describeFetchError(error: unknown): string {
  if ((error as Error).name === "TimeoutError") return "GitHub did not answer in time";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  return `${(error as Error).message || "request failed"}${detail ? ` (${detail})` : ""}`;
}

const GITHUB_ATTEMPT_TIMEOUT_MS = 15_000;
const GITHUB_DEADLINE_MS = 35_000;
const GITHUB_RETRY_DELAYS_MS: readonly number[] = [200, 600, 1500];
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const OUTAGE_RECHECK_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Parses GitHub's `2026-11-01 08:00:00 UTC` (or `-0700` offset) token expiration header. */
export function parseExpiration(value: string | null): number | undefined {
  const match = value ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim()) : null;
  if (!match) return undefined;
  const zone = !match[3] || /^(utc|z)$/i.test(match[3]) ? "Z" : `${match[3].slice(0, 3)}:${match[3].slice(-2)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(time) ? undefined : time;
}
