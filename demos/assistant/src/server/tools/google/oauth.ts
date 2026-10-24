/**
 * Google OAuth 2.0 for a web server application: authorization code flow with PKCE, offline access, and minimal
 * scopes. Refresh and access tokens are sealed at rest and never leave this process (spec principle 4).
 */
import { createHash, randomBytes } from "node:crypto";
import type { GoogleClientConfig } from "../../config.js";
import type { Logger } from "../../log.js";
import type { Sealer } from "../../seal.js";
import type { Store } from "../../store.js";

export const GOOGLE_SCOPES = {
  /** Search and read mail. */
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  /** Create drafts and send mail (no delete, no label changes). */
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  /** Read and change events on your calendars (no calendar settings or sharing). */
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;
export const REQUESTED_SCOPES: readonly string[] = Object.values(GOOGLE_SCOPES);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const STATE_TTL_MS = 15 * 60_000;
const EXPIRY_SKEW_MS = 60_000;

export type GoogleAuthErrorCode = "not_configured" | "not_connected" | "needs_reconnect" | "denied" | "expired" | "failed";

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;

  constructor(code: GoogleAuthErrorCode, message: string) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleAuthOptions {
  readonly client: GoogleClientConfig | undefined;
  readonly redirectUri: string;
  readonly store: Store;
  readonly sealer: Sealer;
  readonly log: Logger;
  readonly fetch?: typeof fetch;
}

export class GoogleAuth {
  readonly #options: GoogleAuthOptions;
  readonly #fetch: typeof fetch;
  readonly #refreshing = new Map<number, Promise<string>>();

  constructor(options: GoogleAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return this.#options.client !== undefined;
  }

  get redirectUri(): string {
    return this.#options.redirectUri;
  }

  #client(): GoogleClientConfig {
    const client = this.#options.client;
    if (!client) {
      throw new GoogleAuthError("not_configured", "Google sign-in isn't configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }
    return client;
  }

  /** Starts the consent flow; returns the Google URL to redirect the browser to. */
  beginAuthorization(accountId: number): string {
    const client = this.#client();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.#options.store.saveOAuthState(state, accountId, this.#options.sealer.seal(verifier, `oauth-state:${state}`));
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.#options.redirectUri,
      response_type: "code",
      scope: REQUESTED_SCOPES.join(" "),
      access_type: "offline",
      // Always show consent so Google returns a refresh token even if this app was authorized before.
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  /** Handles the redirect back from Google: verifies state, exchanges the code, and seals the tokens. */
  async completeAuthorization(params: URLSearchParams): Promise<{ accountId: number; email?: string; missingScopes: string[] }> {
    const error = params.get("error");
    const state = params.get("state");
    const pending = state ? this.#options.store.takeOAuthState(state) : undefined;
    if (error) {
      throw new GoogleAuthError(error === "access_denied" ? "denied" : "failed", error === "access_denied" ? "Google access wasn't granted." : `Google sign-in failed (${error}).`);
    }
    const code = params.get("code");
    if (!state || !pending || !code || Date.now() - Date.parse(pending.createdAt) > STATE_TTL_MS) {
      throw new GoogleAuthError("expired", "This Google sign-in link expired or was already used. Start again from Connections.");
    }
    const verifier = this.#options.sealer.open(pending.verifier, `oauth-state:${state}`);
    const token = await this.#token({ grant_type: "authorization_code", code, redirect_uri: this.#options.redirectUri, code_verifier: verifier });
    if (!token.access_token || !token.refresh_token) {
      throw new GoogleAuthError("failed", "Google didn't grant offline access. Remove the app from your Google Account's third-party access page and connect again.");
    }
    const scopes = (token.scope ?? "").split(" ").filter(Boolean);
    let email: string | undefined;
    if (scopes.includes(GOOGLE_SCOPES.gmailRead)) {
      try {
        const response = await this.#fetch(PROFILE_URL, { headers: { authorization: `Bearer ${token.access_token}` } });
        if (response.ok) email = ((await response.json()) as { emailAddress?: string }).emailAddress;
      } catch {
        // The address is a display nicety; the connection works without it.
      }
    }
    const { sealer, store } = this.#options;
    const accountId = pending.accountId;
    store.saveGoogle({
      accountId,
      email,
      scopes,
      refreshToken: sealer.seal(token.refresh_token, `google:${accountId}:refresh`),
      accessToken: sealer.seal(token.access_token, `google:${accountId}:access`),
      accessExpiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
      status: "ok",
      connectedAt: new Date().toISOString(),
    });
    this.#options.log.info("Google account connected", { accountId, email, scopes: scopes.length });
    return { accountId, email, missingScopes: REQUESTED_SCOPES.filter((scope) => !scopes.includes(scope)) };
  }

  hasScope(accountId: number, scope: string): boolean {
    return this.#options.store.getGoogle(accountId)?.scopes.includes(scope) ?? false;
  }

  /** A valid access token, refreshing it with the sealed refresh token when it is about to expire. */
  async accessToken(accountId: number, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const record = this.#options.store.getGoogle(accountId);
    if (!record) throw new GoogleAuthError("not_connected", "Google isn't connected. Connect it from the Connections panel.");
    if (record.status === "needs_reconnect") throw new GoogleAuthError("needs_reconnect", "Google access has expired or was revoked. Reconnect Google from the Connections panel.");
    if (!options.forceRefresh && record.accessToken && record.accessExpiresAt && Date.parse(record.accessExpiresAt) - EXPIRY_SKEW_MS > Date.now()) {
      return this.#options.sealer.open(record.accessToken, `google:${accountId}:access`);
    }
    let pending = this.#refreshing.get(accountId);
    if (!pending) {
      pending = this.#refresh(accountId, record.refreshToken).finally(() => this.#refreshing.delete(accountId));
      this.#refreshing.set(accountId, pending);
    }
    return pending;
  }

  async #refresh(accountId: number, sealedRefreshToken: string): Promise<string> {
    const { sealer, store } = this.#options;
    const refreshToken = sealer.open(sealedRefreshToken, `google:${accountId}:refresh`);
    let token: TokenResponse;
    try {
      token = await this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
    } catch (error) {
      if (error instanceof GoogleAuthError && error.code === "needs_reconnect") store.setGoogleStatus(accountId, "needs_reconnect");
      throw error;
    }
    if (!token.access_token) throw new GoogleAuthError("failed", "Google didn't return an access token.");
    const scopes = token.scope ? token.scope.split(" ").filter(Boolean) : undefined;
    store.updateGoogleAccess(accountId, sealer.seal(token.access_token, `google:${accountId}:access`), new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(), scopes);
    return token.access_token;
  }

  async #token(params: Record<string, string>): Promise<TokenResponse> {
    const client = this.#client();
    let response: Response;
    try {
      response = await this.#fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }).toString(),
      });
    } catch {
      throw new GoogleAuthError("failed", "Couldn't reach Google to sign in. Check your network connection.");
    }
    let body: TokenResponse = {};
    try {
      body = (await response.json()) as TokenResponse;
    } catch {
      // Handled below.
    }
    if (!response.ok) {
      if (body.error === "invalid_grant") throw new GoogleAuthError("needs_reconnect", "Google access has expired or was revoked. Reconnect Google from the Connections panel.");
      if (body.error === "invalid_client" || body.error === "unauthorized_client") {
        throw new GoogleAuthError("failed", "Google rejected this app's client ID or secret. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
      }
      if (body.error === "redirect_uri_mismatch") throw new GoogleAuthError("failed", `Add ${this.#options.redirectUri} as an authorized redirect URI in Google Cloud Console.`);
      throw new GoogleAuthError("failed", `Google sign-in failed${body.error ? ` (${body.error})` : ` (HTTP ${response.status})`}.`);
    }
    return body;
  }

  /** Revokes Google's grant (best effort) and deletes the sealed tokens. */
  async disconnect(accountId: number): Promise<void> {
    const record = this.#options.store.getGoogle(accountId);
    if (!record) return;
    try {
      const refreshToken = this.#options.sealer.open(record.refreshToken, `google:${accountId}:refresh`);
      await this.#fetch(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    } catch (error) {
      this.#options.log.warn("Couldn't revoke the Google grant; deleting local tokens anyway", { error: (error as Error).message });
    }
    this.#options.store.deleteGoogle(accountId);
  }
}
