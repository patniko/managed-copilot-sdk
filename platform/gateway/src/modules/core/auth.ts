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
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

interface CacheEntry {
  readonly principal?: Principal;
  readonly error?: ManagedCopilotError;
  readonly expiresAt: number;
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
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      if (cached.principal) {
        this.#remember(cached.principal);
        return cached.principal;
      }
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#verify(token, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
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
    const { log } = this.#options;
    let response: Response;
    try {
      response = await this.#get("/user", token);
    } catch (error) {
      log.warn("GitHub API unreachable while verifying a token", { error: (error as Error).message });
      throw new ManagedCopilotError("capability_unavailable", "Cannot verify GitHub credentials right now; GitHub is unreachable from the gateway");
    }
    if (response.status === 401) {
      return this.#reject(key, new ManagedCopilotError("authentication_required", "GitHub rejected this token. Sign in again (for example `gh auth login`) and retry."));
    }
    if (!response.ok) {
      log.warn("GitHub API returned an unexpected status while verifying a token", { status: response.status });
      throw new ManagedCopilotError("capability_unavailable", `Cannot verify GitHub credentials right now (GitHub returned HTTP ${response.status})`);
    }
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
    const ttl = this.#options.cacheTtlMs ?? 5 * 60_000;
    this.#cache.set(key, { principal, expiresAt: Math.min(Date.now() + ttl, expiresAt ?? Number.POSITIVE_INFINITY) });
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
      try {
        // The caller checks their own membership, so private memberships are visible to them.
        const response = await this.#get(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(principal.login)}`, principal.token);
        if (response.status === 204) return;
      } catch (error) {
        this.#options.log.warn("GitHub API unreachable while checking organization membership", { org, error: (error as Error).message });
        throw new ManagedCopilotError("capability_unavailable", "Cannot verify organization membership right now; GitHub is unreachable from the gateway");
      }
    }
    const allowed = [...orgs.map((org) => `members of ${org}`), ...users.map((user) => `@${user}`)].join(", ");
    this.#reject(key, new ManagedCopilotError("forbidden", `@${principal.login} is not allowed to use this deployment (allowed: ${allowed})`));
  }

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
    for (const [key, entry] of this.#cache) if (entry.expiresAt <= now) this.#cache.delete(key);
  }

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
    // These GETs are idempotent: ride out GitHub's occasional 5xx answers and dropped connections, but not timeouts.
    for (let attempt = 0; ; attempt++) {
      const delay = GITHUB_RETRY_DELAYS_MS[attempt];
      try {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        if (delay === undefined || !TRANSIENT_STATUSES.has(response.status)) return response;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (delay === undefined || (error as Error).name === "TimeoutError") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const GITHUB_RETRY_DELAYS_MS: readonly number[] = [250, 1000];
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** Parses GitHub's `2026-11-01 08:00:00 UTC` (or `-0700` offset) token expiration header. */
export function parseExpiration(value: string | null): number | undefined {
  const match = value ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim()) : null;
  if (!match) return undefined;
  const zone = !match[3] || /^(utc|z)$/i.test(match[3]) ? "Z" : `${match[3].slice(0, 3)}:${match[3].slice(-2)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(time) ? undefined : time;
}
