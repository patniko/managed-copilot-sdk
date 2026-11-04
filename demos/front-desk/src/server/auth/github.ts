/**
 * "Continue with GitHub": GitHub's OAuth web flow with state and PKCE, as in the Copilot SDK's GitHub OAuth guide. The
 * token belongs to the person: Front Desk keeps it sealed and passes it to Managed Copilot for that person's sessions
 * only, so their model use goes to their own Copilot plan. Expiring tokens (GitHub Apps) are refreshed when due.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FrontDeskConfig } from "../config.js";
import { log } from "../log.js";
import type { Sealer } from "../seal.js";
import type { Store, UserRecord } from "../store.js";
import { hashSecret } from "../store.js";
import { OAUTH_TTL_MS } from "./cookies.js";

const execFileAsync = promisify(execFile);
const REFRESH_MARGIN_MS = 5 * 60_000;

export type GitHubSignInErrorCode = "not_configured" | "denied" | "expired" | "failed" | "callback_mismatch" | "needs_sign_in" | "unavailable";

export class GitHubSignInError extends Error {
  readonly code: GitHubSignInErrorCode;

  constructor(code: GitHubSignInErrorCode, message: string) {
    super(message);
    this.name = "GitHubSignInError";
    this.code = code;
  }
}

export interface GitHubAccount {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GitHubAuthOptions {
  readonly config: FrontDeskConfig;
  readonly store: Store;
  readonly sealer: Sealer;
  readonly fetch?: typeof fetch;
  /** Reads this computer's GitHub CLI token (tests replace it). */
  readonly ghToken?: () => Promise<string>;
}

const tokenPurpose = (userId: string) => `github-token:${userId}`;
const refreshPurpose = (userId: string) => `github-refresh:${userId}`;
const verifierPurpose = (state: string) => `oauth-verifier:${hashSecret(state)}`;

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Only same-app paths: never an open redirect. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value.length > 300 ? "/" : value;
}

export class GitHubAuth {
  readonly #options: GitHubAuthOptions;
  readonly #fetch: typeof fetch;
  readonly #refreshing = new Map<string, Promise<string>>();

  constructor(options: GitHubAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return this.#options.config.github !== undefined;
  }

  get callbackUrl(): string {
    return `${this.#options.config.publicUrl}/auth/github/callback`;
  }

  /** Starts the web flow: the URL to send the browser to, and the state to bind to it with a cookie. */
  begin(returnTo: string): { url: string; state: string } {
    const client = this.#options.config.github;
    if (!client) throw new GitHubSignInError("not_configured", "GitHub sign-in isn't set up on this Front Desk. Use an email and password instead.");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.#options.store.saveOAuthState(state, this.#options.sealer.seal(verifier, verifierPurpose(state)), safeReturnTo(returnTo));
    const url = new URL(`${this.#options.config.githubUrl}/login/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      allow_signup: "true",
    }).toString();
    return { url: url.toString(), state };
  }

  /** Handles GitHub's redirect back: checks the state against this browser's, exchanges the code, and signs the person in. */
  async complete(params: URLSearchParams, browserState: string | undefined): Promise<{ user: UserRecord; returnTo: string }> {
    const client = this.#options.config.github;
    if (!client) throw new GitHubSignInError("not_configured", "GitHub sign-in isn't set up on this Front Desk.");
    const error = params.get("error");
    const state = params.get("state");
    const pending = state ? this.#options.store.takeOAuthState(state) : undefined;
    if (error) throw new GitHubSignInError(error === "access_denied" ? "denied" : "failed", error === "access_denied" ? "You cancelled the GitHub sign-in." : `GitHub sign-in failed (${error}).`);
    const code = params.get("code");
    if (!state || !code || !browserState || !sameText(state, browserState) || !pending || Date.now() - Date.parse(pending.createdAt) > OAUTH_TTL_MS) {
      throw new GitHubSignInError("expired", "That GitHub sign-in expired or was started in another browser. Try again.");
    }
    const verifier = this.#options.sealer.open(pending.verifier, verifierPurpose(state));
    const token = await this.#exchange({ client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: this.callbackUrl, code_verifier: verifier });
    const account = await this.verify(token.access_token!);
    const user = this.#remember(account, token, "oauth");
    log.info("Signed in with GitHub", { user: user.id, login: account.login });
    return { user, returnTo: pending.returnTo };
  }

  /** Local only: signs in as the account this computer's GitHub CLI uses (`gh auth token`). */
  async signInWithLocalCli(): Promise<UserRecord> {
    if (!this.#options.config.localGitHubSignIn) throw new GitHubSignInError("unavailable", "This sign-in is only offered by a Front Desk running on your own computer.");
    let value: string;
    try {
      value = (await (this.#options.ghToken ?? defaultGhToken)()).trim();
    } catch {
      throw new GitHubSignInError("unavailable", "The GitHub CLI isn't signed in on this computer. Run `gh auth login`, then try again.");
    }
    if (!value) throw new GitHubSignInError("unavailable", "The GitHub CLI isn't signed in on this computer. Run `gh auth login`, then try again.");
    const account = await this.verify(value);
    const user = this.#remember(account, { access_token: value }, "local");
    log.info("Signed in with this computer's GitHub CLI account", { user: user.id, login: account.login });
    return user;
  }

  /** Who a token belongs to (`GET /user`). */
  async verify(token: string): Promise<GitHubAccount> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.config.githubApiUrl}/user`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "managed-copilot-front-desk", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubSignInError("failed", "Couldn't reach GitHub to finish signing in. Try again in a moment.");
    }
    if (response.status === 401) throw new GitHubSignInError("needs_sign_in", "GitHub didn't accept that sign-in. Sign in with GitHub again.");
    if (!response.ok) throw new GitHubSignInError("failed", `GitHub didn't answer who you are (HTTP ${response.status}). Try again in a moment.`);
    const body = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown };
    if (typeof body.id !== "number" || typeof body.login !== "string") throw new GitHubSignInError("failed", "GitHub answered without an account ID.");
    return {
      id: body.id,
      login: body.login,
      ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(typeof body.avatar_url === "string" ? { avatarUrl: body.avatar_url } : {}),
    };
  }

  /** The person's GitHub token, refreshed first when it is about to expire. */
  async token(userId: string): Promise<string> {
    const record = this.#options.store.getGitHubToken(userId);
    if (!record) throw new GitHubSignInError("needs_sign_in", "Your GitHub sign-in ended. Sign in with GitHub again.");
    const due = record.expiresAt !== undefined && Date.parse(record.expiresAt) - REFRESH_MARGIN_MS <= Date.now();
    if (!due) return this.#options.sealer.open(record.token, tokenPurpose(userId));
    if (!record.refreshToken) {
      this.forget(userId);
      throw new GitHubSignInError("needs_sign_in", "Your GitHub sign-in expired. Sign in with GitHub again.");
    }
    let pending = this.#refreshing.get(userId);
    if (!pending) {
      pending = this.#refresh(userId, record.refreshToken).finally(() => this.#refreshing.delete(userId));
      this.#refreshing.set(userId, pending);
    }
    return pending;
  }

  /** Forgets the person's GitHub token (signed out everywhere, or GitHub rejected it). */
  forget(userId: string): void {
    this.#options.store.deleteGitHubToken(userId);
  }

  async #refresh(userId: string, sealedRefresh: string): Promise<string> {
    const client = this.#options.config.github;
    if (!client) {
      this.forget(userId);
      throw new GitHubSignInError("needs_sign_in", "Your GitHub sign-in expired. Sign in with GitHub again.");
    }
    try {
      const token = await this.#exchange({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.#options.sealer.open(sealedRefresh, refreshPurpose(userId)),
      });
      this.#saveToken(userId, token, "oauth");
      return token.access_token!;
    } catch (error) {
      if (error instanceof GitHubSignInError && (error.code === "expired" || error.code === "needs_sign_in")) {
        this.forget(userId);
        throw new GitHubSignInError("needs_sign_in", "Your GitHub sign-in expired. Sign in with GitHub again.");
      }
      throw error;
    }
  }

  async #exchange(params: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.config.githubUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": "managed-copilot-front-desk" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubSignInError("failed", "Couldn't reach GitHub to finish signing in. Try again in a moment.");
    }
    let body: TokenResponse = {};
    try {
      body = (await response.json()) as TokenResponse;
    } catch {
      // Handled below.
    }
    if (body.error === "bad_verification_code" || body.error === "bad_refresh_token") throw new GitHubSignInError("expired", "That GitHub sign-in expired. Try again.");
    if (body.error === "redirect_uri_mismatch") {
      throw new GitHubSignInError("callback_mismatch", `GitHub refused the return address. Add ${this.callbackUrl} as a callback URL of Front Desk's GitHub app.`);
    }
    if (body.error === "incorrect_client_credentials") throw new GitHubSignInError("failed", "GitHub refused Front Desk's client ID or secret. Check the GitHub app settings.");
    if (!response.ok || body.error || !body.access_token) {
      throw new GitHubSignInError("failed", `GitHub sign-in failed${body.error ? ` (${body.error})` : response.ok ? "" : ` (HTTP ${response.status})`}.`);
    }
    return body;
  }

  #remember(account: GitHubAccount, token: TokenResponse, source: "oauth" | "local"): UserRecord {
    const user = this.#options.store.upsertGitHubUser({ githubId: account.id, login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) });
    this.#saveToken(user.id, token, source);
    return user;
  }

  #saveToken(userId: string, token: TokenResponse, source: "oauth" | "local"): void {
    const { sealer, store } = this.#options;
    store.saveGitHubToken({
      userId,
      token: sealer.seal(token.access_token!, tokenPurpose(userId)),
      ...(token.refresh_token ? { refreshToken: sealer.seal(token.refresh_token, refreshPurpose(userId)) } : {}),
      ...(token.expires_in ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() } : {}),
      source,
    });
  }
}

async function defaultGhToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 });
  return stdout;
}
