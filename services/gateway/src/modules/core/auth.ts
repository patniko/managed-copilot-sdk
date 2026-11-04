// GitHub authentication for the gateway: verifies bearer tokens against the GitHub API (cached), applies the
// AppHost access rules, and remembers the tokens it verified for connected callers (for secret scanning).
import { createHash } from "node:crypto";
import { ManagedCopilotError, type AccountInfo } from "@managed-copilot/protocol";
import { isGitHubPrincipal, type Authenticator, type GitHubPrincipal, type Principal, type RequestCredentials } from "../../http.js";
import type { Logger } from "../../log.js";
import type { AppRegistry } from "./apps.js";

export interface AccessRules {
  readonly githubOrgs?: readonly string[];
  readonly githubUsers?: readonly string[];
}

export interface GitHubAuthOptions {
  /** GitHub REST API base URL (https://api.github.com, or a loopback stub in tests). */
  readonly apiUrl: string;
  readonly access?: AccessRules;
  /** Apps that vouch for their own users (spec section 2). */
  readonly apps?: AppRegistry;
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
  /** Overall budget of one verification (user lookup, membership checks, retries). Default 35 s. */
  readonly deadlineMs?: number;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

interface CacheEntry {
  readonly principal?: Principal;
  /**
   * The verified account is not one the access rules allow. It is still admitted through an app that admits any GitHub
   * user (`anyGitHubUser`), never directly.
   */
  readonly denied?: ManagedCopilotError;
  readonly error?: ManagedCopilotError;
  /** Until when the entry answers without calling GitHub. */
  readonly expiresAt: number;
  /** When GitHub last verified the token. */
  readonly verifiedAt?: number;
  /** Until when a verified principal may stand in while GitHub is unreachable. */
  readonly staleUntil?: number;
  /** The principal is standing in on a past verification because GitHub was unreachable at the last check. */
  readonly outage?: boolean;
  /** From GitHub's `github-authentication-token-expiration` header: when the token itself expires. */
  readonly tokenExpiresAt?: number;
}

export interface AuthenticateOptions {
  /**
   * A stored background credential is being re-verified (not a connected caller presenting it): it is never
   * remembered as the account's live credential.
   */
  readonly background?: boolean;
  /** The app the token came through (its key was verified): an app with `anyGitHubUser` admits any GitHub account. */
  readonly app?: string;
}

/** A token GitHub verified, and whether the access rules allow its account directly. */
interface Verified {
  readonly principal: Principal;
  readonly denied?: ManagedCopilotError;
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
    ...(principal.kind === "app-user" || principal.kind === "app" ? { kind: principal.kind } : {}),
    ...(principal.app && principal.kind !== undefined && principal.kind !== "github" ? { app: principal.app } : {}),
    ...(principal.userId !== undefined ? { userId: principal.userId } : {}),
  };
}

export class GitHubAuthenticator implements Authenticator {
  readonly #options: GitHubAuthOptions;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Verified>>();
  /** When a token was last invalidated: verifications that started earlier must not store a result for it. */
  readonly #invalidatedAt = new Map<string, number>();
  readonly #credentials = new Map<number, LiveCredential>();
  readonly #listeners = new Set<(principal: Principal) => void>();
  /** `satisfies` answers per token and rule set, cached like verifications. */
  readonly #ruleCache = new Map<string, { readonly allowed: boolean; readonly expiresAt: number }>();

  constructor(options: GitHubAuthOptions) {
    this.#options = options;
  }

  get accessRules(): AccessRules | undefined {
    return this.#options.access;
  }

  /** The deployment's apps (spec section 2), when it declares any. */
  get apps(): AppRegistry | undefined {
    return this.#options.apps;
  }

  async authenticate(token: string, options: AuthenticateOptions = {}): Promise<Principal> {
    if (!token || token.length > 4096 || /\s/.test(token)) throw new ManagedCopilotError("authentication_required", "The GitHub token is malformed");
    // Action capabilities (`mcc_…`) authorize only their own action routes; they are never sent to GitHub.
    if (token.startsWith("mcc_")) throw new ManagedCopilotError("authentication_required", "Action capability tokens are only valid for their session's action routes");
    const key = tokenFingerprint(token);
    const cached = this.#cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      if (cached.error) throw cached.error;
      if (cached.principal) return this.#admit(key, { principal: cached.principal, ...(cached.denied ? { denied: cached.denied } : {}) }, options);
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      const started = this.#verify(token, key).finally(() => {
        if (this.#inflight.get(key) === started) this.#inflight.delete(key);
      });
      pending = started;
      this.#inflight.set(key, started);
    }
    // During a GitHub outage, a token already standing in on its recent verification keeps answering while the
    // re-check runs in the background, so callers don't wait out the retry budget on every re-check. A connected
    // caller's token becomes the account's live credential once that re-check succeeds.
    if (cached?.principal && cached.outage && cached.staleUntil !== undefined && cached.staleUntil > now) {
      pending.then(
        (verified) => {
          if (!options.background && this.#admits(verified, options)) this.#remember(key, verified.principal);
        },
        () => undefined,
      );
      return this.#admit(key, { principal: cached.principal, ...(cached.denied ? { denied: cached.denied } : {}) }, options, { remember: false });
    }
    return this.#admit(key, await pending, options);
  }

  /** Whether a verified account may use the deployment this way: allowed by `access`, or through an app that admits anyone. */
  #admits(verified: Verified, options: AuthenticateOptions): boolean {
    if (!verified.denied) return true;
    return options.app !== undefined && this.#options.apps?.get(options.app)?.anyGitHubUser === true;
  }

  #admit(key: string, verified: Verified, options: AuthenticateOptions, behavior: { readonly remember?: boolean } = {}): Principal {
    if (!this.#admits(verified, options)) throw verified.denied!;
    if (!options.background && behavior.remember !== false) this.#remember(key, verified.principal);
    return verified.principal;
  }

  /**
   * A request's credentials: a GitHub token alone, or an app key (spec section 2) acting for one of the app's own users,
   * a GitHub user who signed in to it, or itself.
   */
  async authenticateRequest(credentials: RequestCredentials): Promise<Principal> {
    if (credentials.appKey === undefined) {
      if (credentials.appUser !== undefined) throw new ManagedCopilotError("authentication_required", "An app user can only be sent with the app's key");
      if (!credentials.token) throw new ManagedCopilotError("authentication_required", "Sign in with a GitHub token");
      return this.authenticate(credentials.token);
    }
    const apps = this.#options.apps;
    const app = apps?.match(credentials.appKey);
    if (!apps || !app) throw new ManagedCopilotError("authentication_required", "The app key is not valid for this deployment. Use the key the AppHost issued to the app (MANAGED_COPILOT_APP_KEY).");
    if (credentials.appUser !== undefined) {
      if (credentials.token) throw new ManagedCopilotError("invalid_request", "Act for one person at a time: send an app user or a GitHub token, not both");
      return apps.userPrincipal(app, credentials.appUser, credentials.appUserName);
    }
    if (credentials.appUserName !== undefined) throw new ManagedCopilotError("invalid_request", "An app user's name was sent without the app user");
    if (credentials.token) return { ...(await this.authenticate(credentials.token, { app: app.name })), app: app.name };
    return apps.appPrincipal(app);
  }

  /** Checks a long-lived connection's principal again: a GitHub user's token, or that an app user's app still exists. */
  async reverify(principal: Principal): Promise<Principal> {
    if (principal.kind === "app-user" || principal.kind === "app") {
      if (!principal.app || !this.#options.apps?.get(principal.app)) throw new ManagedCopilotError("authentication_required", `The "${principal.app}" app is no longer configured on this deployment`);
      return principal;
    }
    if (!principal.token) throw new ManagedCopilotError("authentication_required", "The connection has no credential to check");
    const verified = await this.authenticate(principal.token, principal.app ? { app: principal.app } : {});
    if (verified.accountId !== principal.accountId) throw new ManagedCopilotError("authentication_required", "The credential now belongs to another account");
    return principal.app ? { ...verified, app: principal.app } : verified;
  }

  /**
   * The token a connected caller of the account presented and GitHub verified within the cache TTL, if any. Only
   * connected callers count (never a background credential's re-verification), and an outage's stand-in does not.
   */
  liveCredential(accountId: number): LiveCredential | undefined {
    const credential = this.#credentials.get(accountId);
    if (!credential) return undefined;
    const now = Date.now();
    const verified = this.#cache.get(tokenFingerprint(credential.token));
    if ((credential.expiresAt !== undefined && credential.expiresAt <= now) || !verified?.principal || verified.outage || now - credential.verifiedAt > (this.#options.cacheTtlMs ?? 5 * 60_000)) {
      this.#credentials.delete(accountId);
      return undefined;
    }
    return credential;
  }

  /** When GitHub said a verified token expires (fine-grained and app tokens); undefined when it did not say. */
  tokenExpiration(token: string): number | undefined {
    return this.#cache.get(tokenFingerprint(token))?.tokenExpiresAt;
  }

  /**
   * Drops the account references to a token (a background credential being removed at logout) without touching its
   * verification: a connected caller presenting the same token is verified again as usual.
   */
  forgetCredential(token: string): void {
    for (const [accountId, credential] of this.#credentials) {
      if (credential.token === token) this.#credentials.delete(accountId);
    }
  }

  /** Observes successful authentications (e.g. to refresh session credentials). */
  onAuthenticated(listener: (principal: Principal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Forgets a token (e.g. after GitHub rejected it for model calls): its cached verification, its live credential,
   * and any verification already in flight, which can no longer store a result.
   */
  invalidate(token: string): void {
    const key = tokenFingerprint(token);
    const now = Date.now();
    this.#cache.delete(key);
    this.#inflight.delete(key);
    this.#invalidatedAt.set(key, now);
    for (const ruleKey of this.#ruleCache.keys()) if (ruleKey.startsWith(`${key}|`)) this.#ruleCache.delete(ruleKey);
    if (this.#invalidatedAt.size > 1000) {
      for (const [entry, at] of this.#invalidatedAt) if (now - at > 10 * 60_000) this.#invalidatedAt.delete(entry);
    }
    for (const [accountId, credential] of this.#credentials) {
      if (credential.token === token) this.#credentials.delete(accountId);
    }
  }

  /** Whether nothing invalidated the token since a verification started at `startedAt`. */
  #current(key: string, startedAt: number): boolean {
    const at = this.#invalidatedAt.get(key);
    return at === undefined || at < startedAt;
  }

  /**
   * Whether a verified principal matches a rule set other than the access rules (the AppHost's `operators`): a named
   * login, or a member of a named organization. Membership is checked with the principal's own token, like the access
   * rules, and the answer is cached as long as a verification. Empty rules match nobody. GitHub outages fail with
   * `upstream_unavailable`, never "not a member"; a token GitHub rejects fails with `authentication_required`.
   */
  async satisfies(principal: Principal, rules: AccessRules): Promise<boolean> {
    // App users and apps are never GitHub accounts, whatever their login looks like.
    if (!isGitHubPrincipal(principal)) return false;
    const users = rules.githubUsers ?? [];
    const orgs = rules.githubOrgs ?? [];
    if (users.some((user) => user.toLowerCase() === principal.login.toLowerCase())) return true;
    if (orgs.length === 0) return false;
    const fingerprint = tokenFingerprint(principal.token);
    const key = `${fingerprint}|${principal.accountId}|${[...new Set(orgs.map((org) => org.toLowerCase()))].sort().join(",")}`;
    const startedAt = Date.now();
    const cached = this.#ruleCache.get(key);
    if (cached && cached.expiresAt > startedAt) return cached.allowed;
    const deadline = startedAt + (this.#options.deadlineMs ?? GITHUB_DEADLINE_MS);
    let allowed = false;
    try {
      for (const org of orgs) {
        const response = await this.#get(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(principal.login)}`, principal.token, deadline, { json: false });
        if (response.status === 204) {
          allowed = true;
          break;
        }
        if (response.status === 401) {
          this.invalidate(principal.token);
          throw new ManagedCopilotError("authentication_required", "GitHub rejected this token. Sign in again (for example `gh auth login`) and retry.");
        }
        if (response.status >= 500) throw new GitHubUnavailable(`GitHub returned HTTP ${response.status} for an organization membership check`);
      }
    } catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      this.#options.log.warn("GitHub is unreachable while checking organization membership", { error: error.message });
      throw new ManagedCopilotError("upstream_unavailable", "GitHub is unreachable from the gateway right now, so organization membership cannot be checked. Retry shortly.", {
        upstream: "github",
        retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      });
    }
    if (this.#current(fingerprint, startedAt)) {
      const now = Date.now();
      this.#ruleCache.set(key, { allowed, expiresAt: now + (this.#options.cacheTtlMs ?? 5 * 60_000) });
      if (this.#ruleCache.size > 1000) for (const [entry, value] of this.#ruleCache) if (value.expiresAt <= now) this.#ruleCache.delete(entry);
    }
    return allowed;
  }

  async #verify(token: string, key: string): Promise<Verified> {
    const startedAt = Date.now();
    try {
      // One budget for the whole verification (user lookup, membership checks, retries, and body reads).
      return await this.#verifyWithGitHub(token, key, startedAt, startedAt + (this.#options.deadlineMs ?? GITHUB_DEADLINE_MS));
    } catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      const { log } = this.#options;
      const now = Date.now();
      const previous = this.#cache.get(key);
      if (previous?.principal && previous.staleUntil !== undefined && previous.staleUntil > now && this.#current(key, startedAt)) {
        // GitHub is briefly unreachable. This token verified recently and GitHub has not rejected it since (a
        // rejection replaces the entry), so its last verification stands in until the stale window closes.
        log.warn("GitHub is unreachable; accepting the token's recent verification", {
          login: previous.principal.login,
          verifiedSecondsAgo: Math.round((now - (previous.verifiedAt ?? now)) / 1000),
          error: error.message,
        });
        this.#cache.set(key, { ...previous, outage: true, expiresAt: Math.min(previous.staleUntil, now + (this.#options.outageRecheckMs ?? OUTAGE_RECHECK_MS)) });
        return { principal: previous.principal, ...(previous.denied ? { denied: previous.denied } : {}) };
      }
      log.warn("GitHub is unreachable while verifying a token", { error: error.message });
      throw new ManagedCopilotError("upstream_unavailable", "GitHub is unreachable from the gateway right now, so the credential cannot be verified. Retry shortly.", {
        upstream: "github",
        retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      });
    }
  }

  async #verifyWithGitHub(token: string, key: string, startedAt: number, deadline: number): Promise<Verified> {
    const response = await this.#get("/user", token, deadline, { json: true });
    if (response.status === 401) {
      this.invalidate(token);
      return this.#reject(key, new ManagedCopilotError("authentication_required", "GitHub rejected this token. Sign in again (for example `gh auth login`) and retry."));
    }
    if (response.status === 403) {
      this.invalidate(token);
      return this.#reject(key, new ManagedCopilotError("authentication_required", "This token cannot identify a GitHub user (GitHub returned HTTP 403). Use a user token, for example from `gh auth token`."));
    }
    if (response.status !== 200) throw new GitHubUnavailable(`GitHub returned HTTP ${response.status}`);
    const user = (response.body ?? {}) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown; type?: unknown };
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new ManagedCopilotError("authentication_required", "The token does not identify a GitHub user account");
    }
    const principal: GitHubPrincipal = {
      accountId: user.id,
      login: user.login,
      ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
      ...(typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {}),
      token,
    };
    const expiresAt = parseExpiration(response.headers.get("github-authentication-token-expiration"));
    const denied = await this.#checkAccess(principal, key, deadline);
    if (!this.#current(key, startedAt)) {
      throw new ManagedCopilotError("authentication_required", "This token was revoked while it was being verified. Sign in again and retry.");
    }
    const now = Date.now();
    const limit = expiresAt ?? Number.POSITIVE_INFINITY;
    this.#cache.set(key, {
      principal,
      ...(denied ? { denied } : {}),
      verifiedAt: now,
      // A denial is checked again as soon as a rejection would be (organization membership can change).
      expiresAt: Math.min(now + (denied ? (this.#options.negativeTtlMs ?? 30_000) : (this.#options.cacheTtlMs ?? 5 * 60_000)), limit),
      staleUntil: Math.min(now + (this.#options.staleGraceMs ?? 15 * 60_000), limit),
      ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}),
    });
    if (!denied) this.#notify(principal);
    this.#prune();
    return { principal, ...(denied ? { denied } : {}) };
  }

  /** Undefined when the access rules allow the account; otherwise why not (it may still come through an app). */
  async #checkAccess(principal: GitHubPrincipal, key: string, deadline: number): Promise<ManagedCopilotError | undefined> {
    const access = this.#options.access;
    const users = access?.githubUsers ?? [];
    const orgs = access?.githubOrgs ?? [];
    if (users.length === 0 && orgs.length === 0) return undefined;
    if (users.some((user) => user.toLowerCase() === principal.login.toLowerCase())) return undefined;
    for (const org of orgs) {
      // The caller checks their own membership, so private memberships are visible to them. Outages throw
      // GitHubUnavailable (never "not a member"); a 401 rejects the token outright; 404 and other refusals mean
      // not a member of this org.
      const response = await this.#get(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(principal.login)}`, principal.token, deadline, { json: false });
      if (response.status === 204) return undefined;
      if (response.status === 401) {
        this.invalidate(principal.token);
        this.#reject(key, new ManagedCopilotError("authentication_required", "GitHub rejected this token. Sign in again (for example `gh auth login`) and retry."));
      }
      if (response.status >= 500) throw new GitHubUnavailable(`GitHub returned HTTP ${response.status} for an organization membership check`);
    }
    // The account lost (or never had) access: its live credential must not keep serving its sessions' runtimes. A
    // connection through an app that admits any GitHub user remembers it again.
    if (this.#credentials.get(principal.accountId)) this.#credentials.delete(principal.accountId);
    const allowed = [...orgs.map((org) => `members of ${org}`), ...users.map((user) => `@${user}`)].join(", ");
    return new ManagedCopilotError("forbidden", `@${principal.login} is not allowed to use this deployment (allowed: ${allowed})`);
  }

  /** Records a definitive answer from GitHub; it replaces any earlier verification, so no stale window survives it. */
  #reject(key: string, error: ManagedCopilotError): never {
    this.#cache.set(key, { error, expiresAt: Date.now() + (this.#options.negativeTtlMs ?? 30_000) });
    throw error;
  }

  /** Remembers a connected caller's token while its verification is current (not an outage's stand-in). */
  #remember(key: string, principal: Principal): void {
    const entry = this.#cache.get(key);
    if (entry?.principal !== principal || entry.outage || entry.verifiedAt === undefined || !isGitHubPrincipal(principal)) return;
    this.#credentials.set(principal.accountId, {
      token: principal.token,
      verifiedAt: entry.verifiedAt,
      ...(entry.tokenExpiresAt !== undefined ? { expiresAt: entry.tokenExpiresAt } : {}),
    });
  }

  /** Observers of successful verifications (`onAuthenticated`). */
  #notify(principal: Principal): void {
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
   * attempt's timeout, a connection lost while reading the body) and 5xx answers are retried with jittered backoff
   * until the caller's deadline. Rate limits are not retried. Throws GitHubUnavailable when GitHub could not answer;
   * any other status is returned, with the parsed body of a 200 when `json` is set.
   */
  async #get(path: string, token: string, deadline: number, options: { readonly json: boolean }): Promise<GitHubResponse> {
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
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GitHubUnavailable("GitHub did not answer in time");
      let problem: string;
      try {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(Math.min(GITHUB_ATTEMPT_TIMEOUT_MS, remaining)) });
        const retryAfter = rateLimitRetryAfter(response);
        if (retryAfter !== undefined) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubUnavailable(`GitHub rate-limited the gateway (HTTP ${response.status})`, retryAfter);
        }
        if (!TRANSIENT_STATUSES.has(response.status)) {
          // The body is read inside the retry boundary: a connection lost mid-body is an outage, not a bad token.
          if (options.json && response.status === 200) return { status: 200, headers: response.headers, body: (await response.json()) as unknown };
          await response.body?.cancel().catch(() => undefined);
          return { status: response.status, headers: response.headers };
        }
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

interface GitHubResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body?: unknown;
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
