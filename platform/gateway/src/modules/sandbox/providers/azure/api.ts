// Data-plane client for Azure Container Apps Sandboxes (https://management.<region>.azuredevcompute.io).
//
// The wire format follows the published Python SDK (azure-containerapps-sandbox 0.1.0b4, API 2026-02-01-preview): PUT to
// create sandboxes, volumes, and disk images; POST for stop/resume; PUT for file writes. The API is still in preview,
// so every request shape lives in this file and nowhere else.
import type { TokenSource } from "./credential.js";

export const DATA_PLANE_RESOURCE = "https://management.azuredevcompute.io";

export type RemoteSandboxState = "Running" | "Stopped" | "Idle" | "Creating" | "Stopping" | "StopFailed" | "Resuming" | "Failed" | "Deleting" | (string & {});

export interface RemotePort {
  readonly port: number;
  readonly name?: string;
  readonly url?: string;
}

export interface RemoteSandbox {
  readonly id: string;
  readonly state?: RemoteSandboxState;
  readonly labels?: Readonly<Record<string, string>>;
  readonly ports?: readonly RemotePort[];
  readonly stateDetails?: { readonly stoppedReason?: string };
  readonly outboundIpAddresses?: readonly string[];
}

export interface RemoteVolume {
  readonly name: string;
  readonly type?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly isAttached?: boolean;
}

export interface RemoteDiskImage {
  readonly id: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly status?: { readonly state?: string; readonly errorMessage?: string };
}

export interface CreateSandboxBody {
  readonly sourcesRef: { readonly diskImage: { readonly id: string } };
  readonly resources: { readonly cpu: string; readonly memory: string; readonly disk?: string };
  readonly labels: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly volumes: readonly { readonly volumeName: string; readonly mountpoint: string; readonly readOnly?: boolean }[];
  readonly ports: readonly Record<string, unknown>[];
  readonly lifecycle: Record<string, unknown>;
  readonly egressPolicy: Record<string, unknown>;
  readonly customerVnetConnectionName?: string;
}

/** An unsuccessful data-plane response. */
export class SandboxApiError extends Error {
  override readonly name = "SandboxApiError";
  /** HTTP status, or 0 when no complete answer arrived. */
  readonly status: number;
  readonly code: string | undefined;
  /** False when the request never left the gateway (for example, no credential), so Azure cannot have acted on it. */
  readonly sent: boolean;

  constructor(status: number, code: string | undefined, message: string, options: { sent?: boolean } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.sent = options.sent ?? true;
  }
}

export interface SandboxApiOptions {
  readonly endpoint: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly sandboxGroup: string;
  readonly apiVersion: string;
  readonly tokens: TokenSource;
  readonly fetch?: typeof fetch;
  /** Retries for 429/5xx and network errors (default 4). */
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | undefined>;

export class SandboxApi {
  readonly #options: SandboxApiOptions;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: SandboxApiOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get #groupPath(): string {
    const { subscriptionId, resourceGroup, sandboxGroup } = this.#options;
    return `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/sandboxGroups/${encodeURIComponent(sandboxGroup)}`;
  }

  #url(path: string, query: Query = {}): URL {
    const url = new URL(`${this.#options.endpoint}${this.#groupPath}${path}`);
    url.searchParams.set("api-version", this.#options.apiVersion);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return url;
  }

  /**
   * `idempotent: false` (collection creates with server-assigned IDs): a network failure or server error is not retried,
   * because Azure may have carried out the request; the caller reconciles by labels. Throttling (429) is still retried.
   */
  async #request(
    method: string,
    url: URL | string,
    init: { body?: unknown; raw?: Uint8Array; allow404?: boolean; idempotent?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    const retries = this.#options.retries ?? 4;
    const retryAmbiguous = init.idempotent ?? true;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.#options.tokens.token(DATA_PLANE_RESOURCE);
      } catch (error) {
        throw new SandboxApiError(0, "credential", `The gateway could not get a token for Azure Container Apps Sandboxes: ${(error as Error).message}`, { sent: false });
      }
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      let body: RequestInit["body"] | undefined;
      if (init.raw) {
        headers["content-type"] = "application/octet-stream";
        body = init.raw;
      } else if (init.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(init.body);
      }
      let response: Response;
      try {
        response = await this.#fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        if (retryAmbiguous && attempt < retries) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        // Failing to connect at all proves the request never reached Azure; any later failure may hide one it received.
        const code = ((error as { cause?: { code?: unknown } }).cause?.code ?? (error as { code?: unknown }).code) as string | undefined;
        throw new SandboxApiError(0, "network", `Azure Container Apps Sandboxes is not reachable: ${(error as Error).message}`, {
          sent: !(code !== undefined && NOT_SENT_CODES.has(code)),
        });
      }
      if (response.status === 404 && init.allow404) {
        await response.body?.cancel();
        return { status: 404, body: undefined };
      }
      if ((response.status === 429 || (retryAmbiguous && response.status >= 500)) && attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await this.#sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoff(attempt));
        continue;
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // The answer broke off after its status line: for a success the request was carried out, and for a server error
        // it may have been, so only a client error stays a definite answer.
        throw new SandboxApiError(response.ok ? 0 : response.status, "network", `The answer from Azure Container Apps Sandboxes broke off: ${(error as Error).message}`);
      }
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!response.ok) {
        const { code, message } = describeFailure(parsed);
        throw new SandboxApiError(response.status, code, message ?? `HTTP ${response.status}`);
      }
      return { status: response.status, body: parsed };
    }
  }

  async #list<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    let next: URL | string | undefined = this.#url(path, query);
    for (let page = 0; next && page < 100; page++) {
      const { body } = await this.#request("GET", next);
      if (Array.isArray(body)) return [...items, ...(body as T[])];
      const paged = body as { value?: T[]; nextLink?: string } | undefined;
      items.push(...(paged?.value ?? []));
      next = paged?.nextLink && new URL(paged.nextLink).origin === new URL(this.#options.endpoint).origin ? paged.nextLink : undefined;
    }
    return items;
  }

  // Sandboxes --------------------------------------------------------------------------------------------------

  listSandboxes(labels?: Readonly<Record<string, string>>): Promise<RemoteSandbox[]> {
    return this.#list<RemoteSandbox>("/sandboxes", labels ? { labels: formatLabels(labels) } : {});
  }

  async getSandbox(id: string): Promise<RemoteSandbox | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/sandboxes/${encodeURIComponent(id)}`), { allow404: true });
    return status === 404 ? undefined : (body as RemoteSandbox);
  }

  async createSandbox(body: CreateSandboxBody): Promise<RemoteSandbox> {
    return created<RemoteSandbox>((await this.#request("PUT", this.#url("/sandboxes"), { body, idempotent: false })).body, "sandbox");
  }

  async deleteSandbox(id: string): Promise<void> {
    await this.#request("DELETE", this.#url(`/sandboxes/${encodeURIComponent(id)}`), { allow404: true });
  }

  async stopSandbox(id: string): Promise<void> {
    await this.#request("POST", this.#url(`/sandboxes/${encodeURIComponent(id)}/stop`));
  }

  async resumeSandbox(id: string): Promise<void> {
    await this.#request("POST", this.#url(`/sandboxes/${encodeURIComponent(id)}/resume`));
  }

  async writeFile(id: string, path: string, content: Uint8Array, mode: string): Promise<void> {
    await this.#request("PUT", this.#url(`/sandboxes/${encodeURIComponent(id)}/files`, { path, createDirs: "true", mode }), { raw: content });
  }

  /** Runs a shell command in the sandbox's VM (as the platform's agent, outside sandboxd). Qualification and diagnostics. */
  async executeShellCommand(id: string, command: string, workingDirectory?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { body } = await this.#request("POST", this.#url(`/sandboxes/${encodeURIComponent(id)}/executeShellCommand`), {
      body: { command, ...(workingDirectory ? { workingDirectory } : {}) },
      idempotent: false,
    });
    const result = (body ?? {}) as { exitCode?: number; stdout?: string; stderr?: string };
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** Replaces a running sandbox's egress policy; it applies to subsequent requests. */
  async setEgressPolicy(id: string, policy: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#request("POST", this.#url(`/sandboxes/${encodeURIComponent(id)}/egresspolicy`), { body: policy });
  }

  // Volumes ----------------------------------------------------------------------------------------------------

  listVolumes(): Promise<RemoteVolume[]> {
    return this.#list<RemoteVolume & { volumeName?: string }>("/volumes").then((volumes) => volumes.map(normalizeVolume));
  }

  async getVolume(name: string): Promise<RemoteVolume | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/volumes/${encodeURIComponent(name)}`), { allow404: true });
    return status === 404 ? undefined : normalizeVolume(body as RemoteVolume & { volumeName?: string });
  }

  async createDataDisk(name: string, size: string, labels: Readonly<Record<string, string>>): Promise<RemoteVolume> {
    const { body } = await this.#request("PUT", this.#url(`/volumes/${encodeURIComponent(name)}`), { body: { type: "DataDisk", size, labels } });
    return normalizeVolume(body as RemoteVolume & { volumeName?: string });
  }

  async deleteVolume(name: string): Promise<void> {
    await this.#request("DELETE", this.#url(`/volumes/${encodeURIComponent(name)}`), { allow404: true });
  }

  // Disk images ------------------------------------------------------------------------------------------------

  listDiskImages(): Promise<RemoteDiskImage[]> {
    return this.#list<RemoteDiskImage>("/diskimages");
  }

  async getDiskImage(id: string): Promise<RemoteDiskImage | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/diskimages/${encodeURIComponent(id)}`), { allow404: true });
    return status === 404 ? undefined : (body as RemoteDiskImage);
  }

  /**
   * Imports a registry image as a disk image. A private registry needs `registryCredentials` (for Azure Container
   * Registry, a token from its /oauth2/exchange); the 2026-02-01-preview data plane rejects identity-based pulls.
   */
  async createDiskImage(
    image: string,
    labels: Readonly<Record<string, string>>,
    auth: { readonly registryCredentials?: { readonly username: string; readonly token: string } } = {},
  ): Promise<RemoteDiskImage> {
    const body = { image: { base: image }, labels, ...(auth.registryCredentials ? { registryCredentials: auth.registryCredentials } : {}) };
    return created<RemoteDiskImage>((await this.#request("PUT", this.#url("/diskimages"), { body, idempotent: false })).body, "disk image");
  }
}

/**
 * The resource a create answered with. A success without a readable resource (a truncated or non-JSON body) does not
 * say what Azure created, so it counts as an answer that never arrived (status 0): the caller reconciles by labels.
 */
function created<T extends { readonly id: string }>(body: unknown, what: string): T {
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) throw new SandboxApiError(0, "network", `Azure accepted the ${what} create but its answer did not name the ${what}.`);
  return body as T;
}

/**
 * The reason a request failed: ARM-style `{ error: { code, message } }` or RFC 9110 problem details
 * (`{ title, detail, errors }`, what the 2026-02-01-preview data plane answers).
 */
function describeFailure(body: unknown): { code: string | undefined; message: string | undefined } {
  if (typeof body === "string") return { code: undefined, message: body.slice(0, 500) || undefined };
  if (!body || typeof body !== "object") return { code: undefined, message: undefined };
  const arm = (body as { error?: { code?: string; message?: string } }).error;
  if (arm?.message) return { code: arm.code, message: arm.message };
  const problem = body as { title?: string; detail?: string; errors?: Record<string, string[]> };
  const fields = Object.entries(problem.errors ?? {})
    .filter(([field]) => field !== "request")
    .map(([field, messages]) => `${field}: ${messages.join(" ")}`);
  const message = [problem.detail, ...fields].filter(Boolean).join(" ") || problem.title;
  return { code: problem.title, message: message?.slice(0, 1000) };
}

function normalizeVolume(volume: RemoteVolume & { volumeName?: string }): RemoteVolume {
  return { ...volume, name: volume.volumeName ?? volume.name };
}

export function formatLabels(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
}

/** Connection failures that happen before any byte of the request is sent. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
