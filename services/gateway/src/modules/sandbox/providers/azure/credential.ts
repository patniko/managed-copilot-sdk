// Entra ID tokens for the gateway's calls to Azure: the managed identity endpoint inside Container Apps, or the signed-in
// Azure CLI for local qualification runs. Tokens are cached until five minutes before they expire and never logged.
import { execFile } from "node:child_process";

export interface TokenSource {
  /** An access token for `resource` (for example https://management.azuredevcompute.io). */
  token(resource: string): Promise<string>;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

const REFRESH_BEFORE_MS = 5 * 60_000;

/** Raised when no token can be obtained; the message says how to fix the identity setup. */
export class TokenUnavailableError extends Error {
  override readonly name = "TokenUnavailableError";
}

abstract class CachingTokenSource implements TokenSource {
  readonly #cache = new Map<string, CachedToken>();
  readonly #inflight = new Map<string, Promise<CachedToken>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async token(resource: string): Promise<string> {
    const cached = this.#cache.get(resource);
    if (cached && cached.expiresAt - REFRESH_BEFORE_MS > this.#now()) return cached.value;
    let pending = this.#inflight.get(resource);
    if (!pending) {
      pending = this.fetchToken(resource).finally(() => this.#inflight.delete(resource));
      this.#inflight.set(resource, pending);
    }
    const fresh = await pending;
    this.#cache.set(resource, fresh);
    return fresh.value;
  }

  protected abstract fetchToken(resource: string): Promise<CachedToken>;
}

/** The managed identity endpoint Container Apps exposes (IDENTITY_ENDPOINT + IDENTITY_HEADER). */
export class ManagedIdentityTokenSource extends CachingTokenSource {
  readonly #endpoint: string;
  readonly #header: string;
  readonly #clientId: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: { endpoint: string; header: string; clientId?: string; fetch?: typeof fetch; now?: () => number }) {
    super(options.now);
    this.#endpoint = options.endpoint;
    this.#header = options.header;
    this.#clientId = options.clientId;
    this.#fetch = options.fetch ?? fetch;
  }

  protected async fetchToken(resource: string): Promise<CachedToken> {
    const url = new URL(this.#endpoint);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", resource);
    if (this.#clientId) url.searchParams.set("client_id", this.#clientId);
    let response: Response;
    try {
      response = await this.#fetch(url, { headers: { "x-identity-header": this.#header }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new TokenUnavailableError(`The managed identity endpoint is not reachable: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_on?: string | number; error_description?: string; message?: string };
    if (!response.ok || !body.access_token) {
      const reason = body.error_description ?? body.message ?? `HTTP ${response.status}`;
      throw new TokenUnavailableError(
        `The gateway's managed identity could not get a token for ${resource}: ${reason}. Check that the identity${this.#clientId ? ` (client ID ${this.#clientId})` : ""} is assigned to the gateway's container app.`,
      );
    }
    return { value: body.access_token, expiresAt: Number(body.expires_on) * 1000 || Date.now() + 30 * 60_000 };
  }
}

/** `az account get-access-token` (the signed-in Azure CLI), for qualification runs outside Azure. */
export class AzureCliTokenSource extends CachingTokenSource {
  readonly #az: string;

  constructor(options: { az?: string; now?: () => number } = {}) {
    super(options.now);
    this.#az = options.az ?? (process.platform === "win32" ? "az.cmd" : "az");
  }

  protected fetchToken(resource: string): Promise<CachedToken> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#az,
        ["account", "get-access-token", "--resource", resource, "--output", "json"],
        { windowsHide: true, timeout: 60_000, shell: process.platform === "win32" },
        (error, stdout) => {
          if (error) {
            reject(new TokenUnavailableError(`The Azure CLI could not get a token for ${resource}; run \`az login\`. (${error.message.split("\n")[0]})`));
            return;
          }
          try {
            const body = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string };
            const expiresAt = body.expires_on ? body.expires_on * 1000 : Date.parse(body.expiresOn ?? "") || Date.now() + 30 * 60_000;
            resolve({ value: body.accessToken, expiresAt });
          } catch {
            reject(new TokenUnavailableError("The Azure CLI returned an unexpected token response."));
          }
        },
      );
    });
  }
}
