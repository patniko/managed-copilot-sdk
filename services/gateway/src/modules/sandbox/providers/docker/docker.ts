// Minimal Docker Engine API client over the local named pipe (Windows) or Unix socket, with no dependencies.
import { execFile } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { z } from "zod";

export interface DockerEndpoint {
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly label: string;
}

/** `DOCKER_HOST` (npipe://, unix://, tcp://) or the platform default. */
export function resolveDockerEndpoints(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): DockerEndpoint[] {
  const configured = env.DOCKER_HOST;
  if (configured) {
    if (configured.startsWith("npipe://")) {
      const pipe = configured.slice("npipe://".length).replace(/\//g, "\\");
      return [{ socketPath: pipe.startsWith("\\\\") ? pipe : `\\\\.\\pipe\\${pipe.replace(/^.*\\pipe\\/, "")}`, label: configured }];
    }
    if (configured.startsWith("unix://")) return [{ socketPath: configured.slice("unix://".length), label: configured }];
    if (configured.startsWith("tcp://")) {
      const url = new URL(configured.replace(/^tcp:/, "http:"));
      return [{ host: url.hostname, port: Number(url.port || 2375), label: configured }];
    }
  }
  if (platform === "win32") {
    return [
      { socketPath: "\\\\.\\pipe\\docker_engine", label: "npipe:////./pipe/docker_engine" },
      { socketPath: "\\\\.\\pipe\\dockerDesktopLinuxEngine", label: "npipe:////./pipe/dockerDesktopLinuxEngine" },
    ];
  }
  return [{ socketPath: "/var/run/docker.sock", label: "unix:///var/run/docker.sock" }];
}

const contextSchema = z.object({
  Endpoints: z.object({ docker: z.object({ Host: z.string().min(1), SkipTLSVerify: z.boolean().optional() }) }),
  TLSMaterial: z.record(z.string(), z.array(z.string())).optional(),
});

/** Use Docker's own context selection, including DOCKER_CONTEXT, DOCKER_CONFIG, and its platform defaults. */
export async function discoverDockerEndpoints(env: Readonly<Record<string, string | undefined>>): Promise<DockerEndpoint[]> {
  if (env.DOCKER_HOST && !env.DOCKER_CONTEXT) return resolveDockerEndpoints(env);
  const output = await new Promise<string>((resolve, reject) => {
    execFile("docker", ["context", "inspect", "--format", "{{json .}}"], { env, encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const message = error.code === "ENOENT"
        ? "The Docker CLI could not be found; it is required to discover the sandbox Docker endpoint."
        : error.killed
          ? "Docker endpoint discovery timed out."
          : "Docker endpoint discovery failed. Run `docker context inspect` to check the selected context.";
      reject(new ManagedCopilotError("capability_unavailable", message));
    });
  });
  let metadata: unknown;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new ManagedCopilotError("capability_unavailable", "Docker endpoint discovery returned invalid context metadata.");
  }
  const parsed = contextSchema.safeParse(metadata);
  if (!parsed.success) throw new ManagedCopilotError("capability_unavailable", "Docker endpoint discovery returned invalid context metadata.");
  const context = parsed.data;
  const endpoint = context.Endpoints.docker;
  if (!/^(unix|npipe|tcp):\/\//.test(endpoint.Host) || (endpoint.Host.startsWith("tcp://") && (endpoint.SkipTLSVerify || context.TLSMaterial?.docker?.length))) {
    throw new ManagedCopilotError("capability_unavailable", "The selected Docker context uses a connection type the sandbox backend does not support.");
  }
  return resolveDockerEndpoints({ DOCKER_HOST: endpoint.Host });
}

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

export interface ContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly State: { readonly Status: string; readonly Running: boolean; readonly ExitCode: number };
  readonly Config: { readonly Labels?: Record<string, string>; readonly Image: string };
  readonly Image: string;
  readonly NetworkSettings: {
    readonly Networks?: Record<string, { readonly IPAddress?: string; readonly NetworkID?: string }>;
    readonly Ports?: Record<string, { readonly HostIp: string; readonly HostPort: string }[] | null>;
  };
}

export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly State: string;
  readonly Labels: Record<string, string>;
}

export interface NetworkInspect {
  readonly Id: string;
  readonly Name: string;
  readonly Internal: boolean;
  readonly Labels?: Record<string, string>;
  readonly IPAM?: { readonly Config?: readonly { readonly Subnet?: string }[] };
  readonly Containers?: Record<string, { readonly Name: string; readonly IPv4Address?: string }>;
}

export interface VolumeSummary {
  readonly Name: string;
  readonly Labels?: Record<string, string> | null;
}

export interface ImageInspect {
  readonly Id: string;
  readonly RepoTags?: readonly string[];
  readonly Config?: { readonly Labels?: Record<string, string> | null; readonly User?: string };
}

type Filters = Record<string, string[]>;

export class DockerClient {
  #endpoint: DockerEndpoint;
  #candidates: readonly DockerEndpoint[];
  readonly #resolveEndpoints: (() => Promise<readonly DockerEndpoint[]>) | undefined;

  constructor(endpoints: readonly DockerEndpoint[] | (() => Promise<readonly DockerEndpoint[]>)) {
    this.#resolveEndpoints = typeof endpoints === "function" ? endpoints : undefined;
    this.#candidates = typeof endpoints === "function" ? [] : endpoints;
    if (!this.#resolveEndpoints && this.#candidates.length === 0) throw new Error("No Docker endpoint configured");
    this.#endpoint = this.#candidates[0] ?? { label: "Not resolved" };
  }

  get endpoint(): DockerEndpoint {
    return this.#endpoint;
  }

  /** Finds a reachable endpoint; returns the engine version or throws. */
  async ping(): Promise<{ version: string; os: string; arch: string }> {
    if (this.#resolveEndpoints && this.#candidates.length === 0) {
      this.#candidates = await this.#resolveEndpoints();
      if (this.#candidates.length === 0) throw new Error("No Docker endpoint configured");
    }
    let lastError: unknown;
    for (const candidate of this.#candidates) {
      this.#endpoint = candidate;
      try {
        const info = await this.request<{ Version: string; Os: string; Arch: string }>("GET", "/version", { timeoutMs: 5000 });
        return { version: info.Version, os: info.Os, arch: info.Arch };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Docker is not reachable");
  }

  request<T = unknown>(method: string, path: string, options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (this.#candidates.length === 0) return Promise.reject(new ManagedCopilotError("capability_unavailable", "The sandbox Docker endpoint has not been discovered yet."));
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) search.set(key, String(value));
    const fullPath = search.size > 0 ? `${path}?${search}` : path;
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          ...(this.#endpoint.socketPath ? { socketPath: this.#endpoint.socketPath } : { host: this.#endpoint.host, port: this.#endpoint.port }),
          method,
          path: fullPath,
          headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 500;
            if (status >= 400) {
              let message = text;
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
              } catch {
                // keep raw text
              }
              reject(new DockerError(status, message.trim() || `Docker API ${method} ${path} failed with ${status}`));
              return;
            }
            if (!text) return resolve(undefined as T);
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              resolve(text as unknown as T);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", (error) => reject(new DockerError(0, `Docker is not reachable at ${this.#endpoint.label}: ${error.message}`)));
      if (options.timeoutMs) {
        req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`Docker API ${method} ${path} timed out`)));
      }
      req.end(payload);
    });
  }

  static filters(filters: Filters): string {
    return JSON.stringify(filters);
  }

  // Containers -----------------------------------------------------------------------------------------------

  createContainer(name: string, spec: Record<string, unknown>): Promise<{ Id: string }> {
    return this.request("POST", "/containers/create", { query: { name }, body: spec });
  }

  startContainer(id: string): Promise<void> {
    return this.request<void>("POST", `/containers/${encodeURIComponent(id)}/start`).catch((error: unknown) => {
      if (error instanceof DockerError && error.status === 304) return;
      throw error;
    });
  }

  stopContainer(id: string, timeoutSeconds = 15): Promise<void> {
    return this.request<void>("POST", `/containers/${encodeURIComponent(id)}/stop`, { query: { t: timeoutSeconds }, timeoutMs: (timeoutSeconds + 30) * 1000 }).catch((error: unknown) => {
      if (error instanceof DockerError && (error.status === 304 || error.status === 404)) return;
      throw error;
    });
  }

  removeContainer(id: string): Promise<void> {
    return this.request<void>("DELETE", `/containers/${encodeURIComponent(id)}`, { query: { force: true, v: false } }).catch((error: unknown) => {
      if (error instanceof DockerError && error.status === 404) return;
      throw error;
    });
  }

  async inspectContainer(id: string): Promise<ContainerInspect | undefined> {
    try {
      return await this.request<ContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  listContainers(filters: Filters): Promise<ContainerSummary[]> {
    return this.request("GET", "/containers/json", { query: { all: true, filters: DockerClient.filters(filters) } });
  }

  // Networks -------------------------------------------------------------------------------------------------

  createNetwork(spec: Record<string, unknown>): Promise<{ Id: string }> {
    return this.request("POST", "/networks/create", { body: spec });
  }

  async inspectNetwork(name: string): Promise<NetworkInspect | undefined> {
    try {
      return await this.request<NetworkInspect>("GET", `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  listNetworks(filters: Filters): Promise<NetworkInspect[]> {
    return this.request("GET", "/networks", { query: { filters: DockerClient.filters(filters) } });
  }

  removeNetwork(name: string): Promise<void> {
    return this.request<void>("DELETE", `/networks/${encodeURIComponent(name)}`).catch((error: unknown) => {
      if (error instanceof DockerError && error.status === 404) return;
      throw error;
    });
  }

  connectNetwork(network: string, container: string, aliases?: readonly string[]): Promise<void> {
    return this.request<void>("POST", `/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: container, ...(aliases ? { EndpointConfig: { Aliases: aliases } } : {}) },
    }).catch((error: unknown) => {
      if (error instanceof DockerError && (error.status === 403 || error.status === 409) && /already exists|already attached|is already connected/i.test(error.message)) return;
      throw error;
    });
  }

  disconnectNetwork(network: string, container: string): Promise<void> {
    return this.request<void>("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { body: { Container: container, Force: true } }).catch((error: unknown) => {
      if (error instanceof DockerError && (error.status === 404 || /is not connected/i.test(error.message))) return;
      throw error;
    });
  }

  // Volumes --------------------------------------------------------------------------------------------------

  createVolume(name: string, labels: Record<string, string>): Promise<VolumeSummary> {
    return this.request("POST", "/volumes/create", { body: { Name: name, Labels: labels } });
  }

  removeVolume(name: string): Promise<void> {
    return this.request<void>("DELETE", `/volumes/${encodeURIComponent(name)}`, { query: { force: true } }).catch((error: unknown) => {
      if (error instanceof DockerError && error.status === 404) return;
      throw error;
    });
  }

  async listVolumes(filters: Filters): Promise<VolumeSummary[]> {
    const result = await this.request<{ Volumes: VolumeSummary[] | null }>("GET", "/volumes", { query: { filters: DockerClient.filters(filters) } });
    return result.Volumes ?? [];
  }

  // Images ---------------------------------------------------------------------------------------------------

  async inspectImage(reference: string): Promise<ImageInspect | undefined> {
    try {
      return await this.request<ImageInspect>("GET", `/images/${encodeURIComponent(reference)}/json`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  tagImage(source: string, repository: string, tag: string): Promise<void> {
    return this.request("POST", `/images/${encodeURIComponent(source)}/tag`, { query: { repo: repository, tag } });
  }
}
