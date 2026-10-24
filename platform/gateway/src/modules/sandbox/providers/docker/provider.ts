// Local Docker backend for isolated placement: one container per session on its own internal network, per-session
// volumes for /workspace, HOME, and runtime state, and a relay container the host gateway reaches each sandboxd through.
import { createHash } from "node:crypto";
import { PLATFORM_KEY_HEADER, SANDBOX_PATHS, SANDBOX_RELAY_PORT, SANDBOX_SIZES, ManagedCopilotError, type EnvironmentConfig } from "@managed-copilot/protocol";
import type { Logger } from "../../../../log.js";
import type { SandboxEndpoint, SandboxImageRef, SandboxProvider, SandboxProviderDeps, SandboxSpec, SandboxStartResult } from "../types.js";
import { DockerClient, DockerError, resolveDockerEndpoints } from "./docker.js";
import { SandboxImages } from "./images.js";

interface RelayTarget {
  /** e.g. http://127.0.0.1:52011 */
  readonly baseUrl: string;
  readonly platformKey: string;
}

export const LABELS = {
  instance: "managed-copilot.instance",
  component: "managed-copilot.component",
  sandbox: "managed-copilot.sandbox",
  session: "managed-copilot.session",
  owner: "managed-copilot.owner",
  environment: "managed-copilot.environment",
  keyHash: "managed-copilot.key-hash",
  image: "managed-copilot.image",
} as const;

export interface SandboxResources {
  readonly container: string;
  readonly network: string;
  readonly alias: string;
  readonly volumes: { readonly workspace: string; readonly home: string; readonly state: string };
}

export interface ProviderOptions {
  readonly docker: DockerClient;
  readonly images: SandboxImages;
  readonly instance: string;
  readonly platformKey: string;
  readonly log: Logger;
  /** Base of the subnet pool for per-sandbox networks, e.g. 10.213.0.0 (a /16), carved into /28s. */
  readonly subnetPool?: string;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isConflict(error: unknown): boolean {
  return error instanceof DockerError && (error.status === 409 || /already exists|already in use/i.test(error.message));
}

function isPoolOverlap(error: unknown): boolean {
  return error instanceof DockerError && /overlap|pool|subnet|address/i.test(error.message);
}

/** Builds the local Docker provider from gateway settings (`DOCKER_HOST`, `MANAGED_COPILOT_SANDBOX_*`). */
export function createDockerSandboxProvider(deps: SandboxProviderDeps): DockerSandboxProvider {
  const { env, log } = deps;
  const docker = new DockerClient(resolveDockerEndpoints(env));
  const images = new SandboxImages({ docker, log, env, appHostDir: deps.appHostDir, ...(env.MANAGED_COPILOT_SANDBOX_CONTEXT ? { contextDir: env.MANAGED_COPILOT_SANDBOX_CONTEXT } : {}) });
  return new DockerSandboxProvider({
    docker,
    images,
    instance: deps.instance,
    platformKey: deps.platformKey,
    log,
    ...(env.MANAGED_COPILOT_SANDBOX_SUBNET_POOL ? { subnetPool: env.MANAGED_COPILOT_SANDBOX_SUBNET_POOL } : {}),
  });
}

/** How long a successful Docker ping is trusted before the next readiness check pings again. */
const READY_TTL_MS = 15_000;

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker";
  /** Warm sandboxes would need prepared, unassigned containers that never held another session's state; not offered locally. */
  readonly capabilities = { warm: false, addressPinning: true };
  readonly #options: ProviderOptions;
  #relay: Promise<RelayTarget> | undefined;
  /** Set once this process started (or adopted) the relay; only then does shutdown remove it. */
  #relayStarted = false;
  #ready: Promise<void> | undefined;
  /** When the cached ping succeeded; 0 while one is in flight. */
  #readyAt = 0;
  #reachable: boolean | undefined;

  constructor(options: ProviderOptions) {
    this.#options = options;
  }

  ready(): Promise<void> {
    if (this.#ready && (this.#readyAt === 0 || Date.now() - this.#readyAt < READY_TTL_MS)) return this.#ready;
    const { docker, log } = this.#options;
    this.#readyAt = 0;
    const attempt: Promise<void> = docker.ping().then(
      (info) => {
        if (this.#ready === attempt) this.#readyAt = Date.now();
        if (this.#reachable !== true) log.info("Docker is available for sandboxes", { version: info.version, platform: `${info.os}/${info.arch}`, endpoint: docker.endpoint.label });
        this.#reachable = true;
      },
      (error: unknown) => {
        if (this.#ready === attempt) this.#ready = undefined;
        this.#reachable = false;
        throw new ManagedCopilotError("capability_unavailable", `Isolated sandboxes need Docker, which is not reachable (${(error as Error).message}). Start Docker Desktop and retry.`);
      },
    );
    this.#ready = attempt;
    return attempt;
  }

  async prepare(): Promise<void> {
    await this.ready();
    await this.#options.images.ensureBase();
    await this.relay();
  }

  async ensureImage(environment: string, config: EnvironmentConfig): Promise<SandboxImageRef> {
    const image = await this.#options.images.ensureEnvironment(environment, config);
    return { ref: image.tag, id: image.id };
  }

  async hasImage(id: string): Promise<boolean> {
    return Boolean(await this.#options.docker.inspectImage(id));
  }

  async endpoint(sandboxId: string): Promise<SandboxEndpoint> {
    const relay = await this.relay();
    return { url: `${relay.baseUrl}/relay/${sandboxId}`, headers: { [PLATFORM_KEY_HEADER]: relay.platformKey } };
  }

  reportUnreachable(): void {
    this.#relay = undefined;
  }

  async reattach(sandboxId: string): Promise<void> {
    await this.attachPlatform(this.resources(sandboxId).network);
  }

  async shutdown(): Promise<void> {
    if (!this.#relayStarted) return;
    this.#relayStarted = false;
    this.#relay = undefined;
    await this.#options.docker.removeContainer(this.relayName);
  }

  get instance(): string {
    return this.#options.instance;
  }

  get edgeNetwork(): string {
    return `${this.#options.instance}-edge`;
  }

  get sandboxesNetwork(): string {
    return `${this.#options.instance}-sandboxes`;
  }

  get relayName(): string {
    return `${this.#options.instance}-relay`;
  }

  get egressName(): string {
    return `${this.#options.instance}-egress`;
  }

  resources(sandboxId: string): SandboxResources {
    const alias = sandboxId.replace("_", "-");
    const base = `${this.#options.instance}-${alias}`;
    return { container: base, network: base, alias, volumes: { workspace: `${base}-workspace`, home: `${base}-home`, state: `${base}-state` } };
  }

  #labels(component: string, extra: Record<string, string> = {}): Record<string, string> {
    return { [LABELS.instance]: this.#options.instance, [LABELS.component]: component, ...extra };
  }

  // Infrastructure -----------------------------------------------------------------------------------------------

  async #ensureNetwork(name: string, spec: Record<string, unknown>): Promise<void> {
    if (await this.#options.docker.inspectNetwork(name)) return;
    try {
      await this.#options.docker.createNetwork({ Name: name, CheckDuplicate: true, ...spec });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  /** The relay's address, (re)creating it when missing, stale, or started with another platform key. */
  relay(): Promise<RelayTarget> {
    this.#relay ??= this.#startRelay().catch((error: unknown) => {
      this.#relay = undefined;
      throw error;
    });
    return this.#relay;
  }

  async #startRelay(): Promise<RelayTarget> {
    const { docker, log, platformKey } = this.#options;
    await this.ready();
    this.#relayStarted = true;
    await this.#ensureNetwork(this.edgeNetwork, { Driver: "bridge", Internal: false, Labels: this.#labels("edge-network") });
    await this.#ensureNetwork(this.sandboxesNetwork, { Driver: "bridge", Internal: true, Labels: this.#labels("sandboxes-network") });
    // The relay runs from the base sandbox image.
    const image = (await this.#options.images.ensureBase()).id;
    const keyHash = hashKey(platformKey);
    let existing = await docker.inspectContainer(this.relayName);
    if (existing && (existing.Config.Labels?.[LABELS.keyHash] !== keyHash || existing.Image !== image)) {
      log.info("Replacing the sandbox relay (platform key or image changed)");
      await docker.removeContainer(existing.Id);
      existing = undefined;
    }
    if (!existing) {
      await docker.createContainer(this.relayName, {
        Image: image,
        User: "65534:65534",
        Entrypoint: ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/sandboxd/dist/relay/main.js"],
        Cmd: [],
        Env: [`RELAY_PLATFORM_KEY=${platformKey}`],
        Labels: this.#labels("relay", { [LABELS.keyHash]: keyHash }),
        ExposedPorts: { [`${SANDBOX_RELAY_PORT}/tcp`]: {} },
        HostConfig: {
          NetworkMode: this.edgeNetwork,
          PortBindings: { [`${SANDBOX_RELAY_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          ReadonlyRootfs: true,
          Memory: 256 * 1024 * 1024,
          PidsLimit: 256,
          RestartPolicy: { Name: "unless-stopped" },
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
        },
      });
    }
    await docker.startContainer(this.relayName);
    let port: string | undefined;
    for (let attempt = 0; attempt < 50 && !port; attempt++) {
      const inspected = await docker.inspectContainer(this.relayName);
      port = inspected?.NetworkSettings.Ports?.[`${SANDBOX_RELAY_PORT}/tcp`]?.find((binding) => binding.HostIp === "127.0.0.1" || binding.HostIp === "0.0.0.0")?.HostPort;
      if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new ManagedCopilotError("capability_unavailable", "The sandbox relay started without a published port.");
    const baseUrl = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) break;
      } catch {
        // starting
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log.info("Sandbox relay ready", { url: baseUrl });
    return { baseUrl, platformKey };
  }

  // Per-sandbox resources ---------------------------------------------------------------------------------------

  /** Creates the sandbox's own internal network on an explicit /28 so Docker's default pools are not exhausted. */
  async #createSandboxNetwork(sandboxId: string, network: string): Promise<string> {
    const existing = await this.#options.docker.inspectNetwork(network);
    if (existing) return existing.IPAM?.Config?.[0]?.Subnet ?? "";
    const [a, b] = (this.#options.subnetPool ?? "10.213.0.0").split(".").map(Number) as [number, number];
    const start = parseInt(createHash("sha256").update(sandboxId).digest("hex").slice(0, 4), 16) % 4096;
    for (let attempt = 0; attempt < 128; attempt++) {
      const index = (start + attempt) % 4096;
      const subnet = `${a}.${b}.${Math.floor(index / 16)}.${(index % 16) * 16}/28`;
      try {
        await this.#options.docker.createNetwork({
          Name: network,
          CheckDuplicate: true,
          Driver: "bridge",
          Internal: true,
          IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
          Options: { "com.docker.network.bridge.enable_icc": "true" },
          Labels: this.#labels("sandbox-network", { [LABELS.sandbox]: sandboxId }),
        });
        return subnet;
      } catch (error) {
        if (isConflict(error)) return (await this.#options.docker.inspectNetwork(network))?.IPAM?.Config?.[0]?.Subnet ?? subnet;
        if (!isPoolOverlap(error)) throw error;
      }
    }
    throw new ManagedCopilotError("capability_unavailable", "No free subnet is available for another sandbox network; delete unused sandboxes or widen the subnet pool.");
  }

  /** Connects the relay and (when running) the egress proxy to a sandbox network. Idempotent. */
  async attachPlatform(network: string): Promise<void> {
    const { docker } = this.#options;
    await this.relay();
    await docker.connectNetwork(network, this.relayName);
    if (await docker.inspectContainer(this.egressName)) await docker.connectNetwork(network, this.egressName, ["mc-egress"]);
  }

  async create(spec: SandboxSpec): Promise<void> {
    const { docker, log } = this.#options;
    await this.ready();
    const resources = this.resources(spec.sandboxId);
    const labels = this.#labels("sandbox", {
      [LABELS.sandbox]: spec.sandboxId,
      [LABELS.session]: spec.sessionId,
      [LABELS.owner]: String(spec.ownerId),
      [LABELS.environment]: spec.environment,
    });
    const subnet = await this.#createSandboxNetwork(spec.sandboxId, resources.network);
    await this.attachPlatform(resources.network);
    for (const volume of Object.values(resources.volumes)) await docker.createVolume(volume, labels);
    const size = SANDBOX_SIZES[spec.size];
    const mounts: Record<string, unknown>[] = [
      { Type: "volume", Source: resources.volumes.workspace, Target: SANDBOX_PATHS.workspace },
      { Type: "volume", Source: resources.volumes.home, Target: SANDBOX_PATHS.home },
      { Type: "volume", Source: resources.volumes.state, Target: SANDBOX_PATHS.state },
    ];
    if (spec.customizations) mounts.push({ Type: "bind", Source: spec.customizations, Target: SANDBOX_PATHS.customizations, ReadOnly: true });
    try {
      await docker.createContainer(resources.container, {
        Image: spec.imageId,
        User: "0:0",
        Hostname: "sandbox",
        WorkingDir: SANDBOX_PATHS.workspace,
        Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
        Labels: labels,
        HostConfig: {
          NanoCpus: size.cpus * 1_000_000_000,
          Memory: size.memoryMiB * 1024 * 1024,
          MemorySwap: size.memoryMiB * 1024 * 1024,
          PidsLimit: 4096,
          CapDrop: ["ALL"],
          // sandboxd (root) needs only identity switching and signalling; every workspace access runs as uid 10001.
          CapAdd: ["CHOWN", "KILL", "SETGID", "SETUID"],
          SecurityOpt: ["no-new-privileges:true"],
          Mounts: mounts,
          NetworkMode: resources.network,
          RestartPolicy: { Name: "no" },
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        },
        NetworkingConfig: { EndpointsConfig: { [resources.network]: { Aliases: [resources.alias] } } },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    await docker.startContainer(resources.container);
    log.debug("Sandbox container started", { sandboxId: spec.sandboxId, network: resources.network, subnet });
  }

  /** Starts a stopped sandbox, recreating its network attachment if needed. */
  async start(sandboxId: string): Promise<SandboxStartResult> {
    const { docker } = this.#options;
    await this.ready();
    const resources = this.resources(sandboxId);
    const container = await docker.inspectContainer(resources.container);
    if (!container) return (await this.#volumesExist(sandboxId)) ? "recreate" : "gone";
    if (!(await docker.inspectNetwork(resources.network))) {
      await this.#createSandboxNetwork(sandboxId, resources.network);
      await docker.connectNetwork(resources.network, resources.container, [resources.alias]);
    }
    await this.attachPlatform(resources.network);
    if (!container.State.Running) await docker.startContainer(resources.container);
    return "started";
  }

  async #volumesExist(sandboxId: string): Promise<boolean> {
    const resources = this.resources(sandboxId);
    const volumes = await this.#options.docker.listVolumes({ label: [`${LABELS.sandbox}=${sandboxId}`] });
    const names = new Set(volumes.map((volume) => volume.Name));
    return Object.values(resources.volumes).every((volume) => names.has(volume));
  }

  async isRunning(sandboxId: string): Promise<boolean> {
    const container = await this.#options.docker.inspectContainer(this.resources(sandboxId).container);
    return Boolean(container?.State.Running);
  }

  /** The sandbox's IP on its own network (for egress source pinning). */
  async address(sandboxId: string): Promise<string | undefined> {
    const resources = this.resources(sandboxId);
    const container = await this.#options.docker.inspectContainer(resources.container);
    return container?.NetworkSettings.Networks?.[resources.network]?.IPAddress || undefined;
  }

  /** Stops the container, then detaches the relay and egress proxy from its network (re-attached on start). */
  async stop(sandboxId: string): Promise<void> {
    const { docker } = this.#options;
    const resources = this.resources(sandboxId);
    await docker.stopContainer(resources.container, 15);
    await this.#detachPlatform(resources.network);
  }

  async #detachPlatform(network: string): Promise<void> {
    const { docker } = this.#options;
    if (!(await docker.inspectNetwork(network))) return;
    for (const name of [this.relayName, this.egressName]) await docker.disconnectNetwork(network, name);
  }

  /** Removes the container, its volumes, and its network. Safe to repeat. */
  async remove(sandboxId: string): Promise<void> {
    const { docker } = this.#options;
    const resources = this.resources(sandboxId);
    await docker.removeContainer(resources.container);
    for (const volume of Object.values(resources.volumes)) await docker.removeVolume(volume);
    await this.#removeNetwork(resources.network);
  }

  async #removeNetwork(network: string): Promise<void> {
    const { docker } = this.#options;
    const inspected = await docker.inspectNetwork(network);
    if (!inspected) return;
    for (const endpoint of Object.values(inspected.Containers ?? {})) await docker.disconnectNetwork(network, endpoint.Name);
    await docker.removeNetwork(network);
  }

  /** Sandbox IDs that have Docker resources for this instance (containers, volumes, or networks). */
  async inventory(): Promise<Set<string>> {
    const { docker, instance } = this.#options;
    const filter = { label: [`${LABELS.instance}=${instance}`] };
    const ids = new Set<string>();
    for (const container of await docker.listContainers(filter)) {
      const id = container.Labels[LABELS.sandbox];
      if (id) ids.add(id);
    }
    for (const volume of await docker.listVolumes(filter)) {
      const id = volume.Labels?.[LABELS.sandbox];
      if (id) ids.add(id);
    }
    for (const network of await docker.listNetworks(filter)) {
      const id = network.Labels?.[LABELS.sandbox];
      if (id) ids.add(id);
    }
    return ids;
  }
}
