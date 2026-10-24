// Data-plane client for Azure Container Apps Sandboxes (https://management.<region>.azuredevcompute.io).
//
// The wire format follows the published Python SDK (azure-containerapps-sandbox 0.1.0b4, API 2026-02-01-preview): PUT to
// create sandboxes, volumes, and disk images; POST for stop/resume; PUT for file writes. The API is still in preview,
// so every request shape lives in this file and nowhere else.
import type { TokenSource } from "./credential.js";
import { z } from "zod";

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

const labelsSchema = z.record(z.string(), z.string()).optional();
const sandboxSchema: z.ZodType<RemoteSandbox> = z.object({
  id: z.string().min(1),
  state: z.string().optional(),
  labels: labelsSchema,
  ports: z.array(z.object({
    port: z.number().int().min(1).max(65535),
    name: z.string().optional(),
    url: z.string().optional(),
  }).passthrough()).optional(),
  stateDetails: z.object({ stoppedReason: z.string().optional() }).passthrough().optional(),
  outboundIpAddresses: z.array(z.string()).optional(),
}).passthrough();
const diskImageSchema: z.ZodType<RemoteDiskImage> = z.object({
  id: z.string().min(1),
  labels: labelsSchema,
  status: z.object({ state: z.string().optional(), errorMessage: z.string().optional() }).passthrough().optional(),
}).passthrough();
const volumeSchema = z.object({
  name: z.string().min(1).optional(),
  volumeName: z.string().min(1).optional(),
  type: z.string().min(1),
  labels: labelsSchema,
  isAttached: z.boolean().optional(),
}).passthrough().refine((volume) => volume.type !== "DataDisk" || volume.isAttached !== undefined);
const executionSchema = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });

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
        response = await this.#fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(60_000) });
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

  async #list<T>(path: string, parse: (body: unknown) => T, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    const initial = this.#url(path, query);
    let next: URL | undefined = initial;
    const seen = new Set<string>();
    while (next) {
      if (seen.size >= 100 || seen.has(next.href)) throw malformed(`${path} pagination`);
      seen.add(next.href);
      const { body } = await this.#request("GET", next);
      if (Array.isArray(body)) return [...items, ...body.map(parse)];
      if (!body || typeof body !== "object" || !("value" in body) || !Array.isArray(body.value)) {
        throw malformed(`${path} listing`);
      }
      items.push(...body.value.map(parse));
      const link = "nextLink" in body ? body.nextLink : undefined;
      if (link === undefined || link === null || link === "") break;
      if (typeof link !== "string") throw malformed(`${path} continuation`);
      let continuation: URL;
      try {
        continuation = new URL(link, next);
      } catch {
        throw malformed(`${path} continuation`);
      }
      if (continuation.origin !== initial.origin || continuation.pathname.toLowerCase() !== initial.pathname.toLowerCase() || continuation.username || continuation.password) {
        throw malformed(`${path} continuation scope`);
      }
      if (!continuation.searchParams.has("api-version")) continuation.searchParams.set("api-version", this.#options.apiVersion);
      next = continuation;
    }
    return items;
  }

  // Sandboxes --------------------------------------------------------------------------------------------------

  async listSandboxes(labels?: Readonly<Record<string, string>>): Promise<RemoteSandbox[]> {
    const sandboxes = await this.#list("/sandboxes", parseSandbox, labels ? { labels: formatLabels(labels) } : {});
    if (labels && sandboxes.some((sandbox) => Object.entries(labels).some(([key, value]) => sandbox.labels?.[key] !== value))) {
      throw malformed("filtered sandbox listing");
    }
    return sandboxes;
  }

  async getSandbox(id: string): Promise<RemoteSandbox | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/sandboxes/${encodeURIComponent(id)}`), { allow404: true });
    if (status === 404) return undefined;
    const sandbox = parseSandbox(body);
    if (sandbox.id !== id) throw malformed("sandbox identity");
    return sandbox;
  }

  async createSandbox(body: CreateSandboxBody): Promise<RemoteSandbox> {
    return parseSandbox((await this.#request("PUT", this.#url("/sandboxes"), { body, idempotent: false })).body);
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
    return parseResource(executionSchema, body, "command result");
  }

  /** Replaces a running sandbox's egress policy; it applies to subsequent requests. */
  async setEgressPolicy(id: string, policy: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#request("POST", this.#url(`/sandboxes/${encodeURIComponent(id)}/egresspolicy`), { body: policy });
  }

  // Volumes ----------------------------------------------------------------------------------------------------

  listVolumes(): Promise<RemoteVolume[]> {
    return this.#list("/volumes", parseVolume);
  }

  async getVolume(name: string): Promise<RemoteVolume | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/volumes/${encodeURIComponent(name)}`), { allow404: true });
    if (status === 404) return undefined;
    const volume = parseVolume(body);
    if (volume.name !== name) throw malformed("volume identity");
    return volume;
  }

  async createDataDisk(name: string, size: string, labels: Readonly<Record<string, string>>): Promise<RemoteVolume> {
    const { body } = await this.#request("PUT", this.#url(`/volumes/${encodeURIComponent(name)}`), { body: { type: "DataDisk", size, labels } });
    return parseVolume(body);
  }

  async deleteVolume(name: string): Promise<void> {
    await this.#request("DELETE", this.#url(`/volumes/${encodeURIComponent(name)}`), { allow404: true });
  }

  // Disk images ------------------------------------------------------------------------------------------------

  listDiskImages(): Promise<RemoteDiskImage[]> {
    return this.#list("/diskimages", parseDiskImage);
  }

  async getDiskImage(id: string): Promise<RemoteDiskImage | undefined> {
    const { status, body } = await this.#request("GET", this.#url(`/diskimages/${encodeURIComponent(id)}`), { allow404: true });
    if (status === 404) return undefined;
    const image = parseDiskImage(body);
    if (image.id !== id) throw malformed("disk image identity");
    return image;
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
    return parseDiskImage((await this.#request("PUT", this.#url("/diskimages"), { body, idempotent: false })).body);
  }
}

/**
 * The resource a create answered with. A success without a readable resource (a truncated or non-JSON body) does not
 * say what Azure created, so it counts as an answer that never arrived (status 0): the caller reconciles by labels.
 */
function malformed(what: string): SandboxApiError {
  return new SandboxApiError(0, "invalid_response", `Azure returned a malformed ${what}; the resource outcome cannot be inferred from that response.`);
}

function parseResource<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw malformed(what);
  return parsed.data;
}

const parseSandbox = (body: unknown): RemoteSandbox => parseResource(sandboxSchema, body, "sandbox");
const parseDiskImage = (body: unknown): RemoteDiskImage => parseResource(diskImageSchema, body, "disk image");

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

function parseVolume(body: unknown): RemoteVolume {
  const volume = parseResource(volumeSchema, body, "volume");
  const name = volume.volumeName ?? volume.name;
  if (!name) throw malformed("volume identity");
  return { ...volume, name };
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
