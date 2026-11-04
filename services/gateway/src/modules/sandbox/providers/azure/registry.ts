// Pull credentials for the deployment's Azure Container Registry. The Sandboxes data plane (2026-02-01-preview) imports
// private images only with `registryCredentials`; identity-based pulls are rejected. So the gateway exchanges an Entra
// token of its own identity (which needs AcrPull on the registry) for a short-lived registry refresh token at the
// registry's /oauth2/exchange endpoint, and passes that to the data plane when it imports an image. The token never
// reaches a sandbox and is never logged.
import type { TokenSource } from "./credential.js";

/** The Entra audience Azure Container Registry accepts for token exchange. */
export const REGISTRY_AUDIENCE = "https://containerregistry.azure.net";
/** The user name that goes with a registry refresh token. */
export const REGISTRY_TOKEN_USER = "00000000-0000-0000-0000-000000000000";

const REFRESH_BEFORE_MS = 10 * 60_000;

export interface RegistryCredentials {
  readonly username: string;
  readonly token: string;
}

/** Raised when the gateway cannot get pull credentials; the message says how to fix the setup. */
export class RegistryCredentialsError extends Error {
  override readonly name = "RegistryCredentialsError";
}

/** The registry host of an image reference, if it names one (`host.domain/...`, `host:port/...`). */
export function registryHost(image: string): string | undefined {
  const slash = image.indexOf("/");
  if (slash < 0) return undefined;
  const first = image.slice(0, slash).toLowerCase();
  return first.includes(".") || first.includes(":") || first === "localhost" ? first : undefined;
}

function expiryOf(token: string, now: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number" && payload.exp > 0) return payload.exp * 1000;
  } catch {
    // Not a JWT: assume the documented minimum lifetime.
  }
  return now + 60 * 60_000;
}

export class AcrCredentials {
  readonly #tokens: TokenSource;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly credentials: RegistryCredentials; readonly expiresAt: number }>();

  constructor(tokens: TokenSource, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#tokens = tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Pull credentials for an Azure Container Registry image; undefined for images in other registries. */
  async credentialsFor(image: string): Promise<RegistryCredentials | undefined> {
    const host = registryHost(image);
    if (!host || !/\.azurecr\.(io|us|cn)$/.test(host)) return undefined;
    const cached = this.#cache.get(host);
    if (cached && cached.expiresAt - REFRESH_BEFORE_MS > this.#now()) return cached.credentials;
    let entraToken: string;
    try {
      entraToken = await this.#tokens.token(REGISTRY_AUDIENCE);
    } catch (error) {
      throw new RegistryCredentialsError(`The gateway could not get a token for the registry ${host}: ${(error as Error).message}`);
    }
    let response: Response;
    try {
      response = await this.#fetch(`https://${host}/oauth2/exchange`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "access_token", service: host, access_token: entraToken }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RegistryCredentialsError(`The registry ${host} is not reachable: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: unknown; errors?: { message?: string }[] };
    if (!response.ok || typeof body.refresh_token !== "string" || !body.refresh_token) {
      const reason = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new RegistryCredentialsError(`The gateway's identity cannot pull from ${host} (${reason}). Assign it the AcrPull role on the registry.`);
    }
    const credentials = { username: REGISTRY_TOKEN_USER, token: body.refresh_token };
    this.#cache.set(host, { credentials, expiresAt: expiryOf(body.refresh_token, this.#now()) });
    return credentials;
  }
}
