// Isolated placement on Azure Container Apps Sandboxes: one hardware-isolated microVM per session.
//
// Persistent state lives on three data disks per sandbox (ext4 block devices mounted at /workspace, /home/agent, and
// /var/lib/managed-copilot) that outlive compute. Stopping a sandbox deletes its compute and keeps the disks, so every
// resume recreates compute from the pinned disk image over the same disks: the compute-replacement path is the normal
// path, not a special case. sandboxd (port 7781) is reached through the sandbox's port URL, restricted to the gateway's
// outbound addresses when they are configured, and always behind sandboxd's own per-sandbox key. The platform egress
// policy denies everything except the egress proxy, which applies each session's network policy and vaults.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ManagedCopilotError, SANDBOX_PATHS, SANDBOX_SIZES, SANDBOXD_PORT, type EnvironmentConfig } from "@managed-copilot/protocol";
import type { Logger } from "../../../../log.js";
import type {
  SandboxEndpoint,
  SandboxImageRef,
  SandboxOperationOptions,
  SandboxProvider,
  SandboxProviderDeps,
  SandboxSpec,
  SandboxStartResult,
} from "../types.js";
import { SandboxApi, SandboxApiError, type CreateSandboxBody, type RemoteDiskImage, type RemoteSandbox } from "./api.js";
import { quantityMiB, type AzureSandboxConfig, type LoadedConfig } from "./config.js";
import { RegistryCredentialsError, type RegistryCredentials } from "./registry.js";
import { UnconfirmedCreates } from "./unconfirmed.js";

/** Labels on every resource this gateway creates (Kubernetes-style keys without dots, which the service accepts). */
export const LABELS = {
  instance: "mc-instance",
  sandbox: "mc-sandbox",
  session: "mc-session",
  owner: "mc-owner",
  environment: "mc-environment",
  role: "mc-role",
  image: "mc-image",
} as const;

const DISKS = [
  { role: "ws", mountpoint: SANDBOX_PATHS.workspace, size: "workspace" },
  { role: "home", mountpoint: SANDBOX_PATHS.home, size: "home" },
  { role: "state", mountpoint: SANDBOX_PATHS.state, size: "state" },
] as const;

const READY_IMAGE_STATES = new Set(["ready", "succeeded"]);
const FAILED_IMAGE_STATES = new Set(["failed"]);
const FAILED_SANDBOX_STATES = new Set(["failed", "stopfailed"]);
/** States from which a sandbox becomes (or is) running without being replaced. */
const LIVE_SANDBOX_STATES = new Set(["running", "creating", "resuming"]);


const stateOf = (sandbox: RemoteSandbox): string => sandbox.state?.toLowerCase() ?? "";
const isDeleting = (sandbox: RemoteSandbox): boolean => stateOf(sandbox) === "deleting";

/** A create whose outcome stayed unknown: retrying later adopts the resource if Azure did create it. */
function unconfirmed(what: string, cause: unknown): ManagedCopilotError {
  return unavailable(`Azure did not confirm whether ${what} was created (${(cause as Error)?.message ?? String(cause)}), and it has not appeared yet. Try again in a minute.`, cause);
}

/**
 * A failure that proves Azure did not carry out the request: it never left the gateway, or Azure refused it (4xx).
 * Anything else (no complete answer, a server error, an unexpected exception) may hide a request Azure carried out.
 */
function isDefinite(error: unknown): boolean {
  return error instanceof SandboxApiError && (!error.sent || (error.status >= 400 && error.status < 500));
}
const CUSTOMIZATION_LIMITS = { files: 256, bytes: 8 * 1024 * 1024 };
/** How long a successful readiness check is trusted. */
const READY_TRUST_MS = 30_000;

export interface AzureProviderOverrides {
  readonly api?: SandboxApi;
  /** Pull credentials for a registry image (see registry.ts); undefined for public images. */
  readonly registryCredentials?: (image: string) => Promise<RegistryCredentials | undefined>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** reconcileMs: how long one call looks for an unconfirmed create; unconfirmedMs: how long later calls still wait for it. */
  readonly timeouts?: Partial<{ createMs: number; deleteMs: number; imageMs: number; reconcileMs: number; unconfirmedMs: number }>;
}

function unavailable(message: string, cause?: unknown): ManagedCopilotError {
  const error = new ManagedCopilotError("capability_unavailable", message);
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

function describeApiError(error: unknown, config: AzureSandboxConfig): string {
  if (!(error instanceof SandboxApiError)) return (error as Error)?.message ?? String(error);
  if (error.status === 401 || error.status === 403) {
    return `the gateway's managed identity is not allowed to use sandbox group "${config.sandboxGroup}" (assign it the "Container Apps SandboxGroup Data Owner" role on that sandbox group, in resource group "${config.resourceGroup}"): ${error.message}`;
  }
  if (error.status === 404) return `sandbox group "${config.sandboxGroup}" was not found in resource group "${config.resourceGroup}" (${config.region}): ${error.message}`;
  return error.message;
}

export class AzureSandboxProvider implements SandboxProvider {
  readonly kind = "azure";
  readonly capabilities = { warm: false, addressPinning: false, startTimeoutMs: 180_000 };
  readonly #deps: SandboxProviderDeps;
  readonly #config: AzureSandboxConfig | undefined;
  readonly #problems: readonly string[];
  readonly #api: SandboxApi | undefined;
  readonly #log: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #timeouts: { createMs: number; deleteMs: number; imageMs: number; reconcileMs: number; unconfirmedMs: number };
  readonly #unconfirmed: UnconfirmedCreates;
  readonly #registryCredentials: (image: string) => Promise<RegistryCredentials | undefined>;
  readonly #remoteIds = new Map<string, string>();
  readonly #images = new Map<string, Promise<SandboxImageRef>>();
  #readyUntil = 0;
  #warnedOpenPorts = false;

  constructor(deps: SandboxProviderDeps, loaded: LoadedConfig, api: SandboxApi | undefined, overrides: AzureProviderOverrides = {}) {
    this.#deps = deps;
    this.#config = loaded.config;
    this.#problems = loaded.problems;
    this.#api = overrides.api ?? api;
    this.#log = deps.log.child("azure");
    this.#sleep = overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = overrides.pollMs ?? 2_000;
    this.#timeouts = { createMs: 10 * 60_000, deleteMs: 5 * 60_000, imageMs: 30 * 60_000, reconcileMs: 60_000, unconfirmedMs: 5 * 60_000, ...overrides.timeouts };
    this.#unconfirmed = new UnconfirmedCreates(join(deps.dataDir, "sandbox-azure", "unconfirmed-creates.json"), this.#timeouts.unconfirmedMs);
    this.#registryCredentials = overrides.registryCredentials ?? (async () => undefined);
  }

  #require(): { config: AzureSandboxConfig; api: SandboxApi } {
    if (!this.#config || !this.#api) {
      throw unavailable(`Isolated sessions are not available on this Azure deployment: ${this.#problems.join(" ")}`);
    }
    return { config: this.#config, api: this.#api };
  }

  get #instance(): string {
    return this.#deps.instance;
  }

  // Readiness and images -----------------------------------------------------------------------------------------

  async ready(): Promise<void> {
    const { config, api } = this.#require();
    // Also the service's availability probe (every 30 s and before backend operations): trust a success only briefly.
    if (Date.now() < this.#readyUntil) return;
    try {
      await api.listSandboxes({ [LABELS.instance]: this.#instance });
    } catch (error) {
      this.#readyUntil = 0;
      throw unavailable(`Isolated sessions are not available: ${describeApiError(error, config)}`, error);
    }
    if (config.ingressCidrs.length === 0 && !this.#warnedOpenPorts) {
      this.#warnedOpenPorts = true;
      this.#log.warn("Sandbox ports accept any source address; only sandboxd's per-sandbox key protects them. Set MANAGED_COPILOT_AZURE_INGRESS_CIDRS to the gateway's outbound addresses.");
    }
    this.#readyUntil = Date.now() + READY_TRUST_MS;
  }

  /** Converts every deployed sandbox image into a disk image ahead of the first session. */
  async prepare(): Promise<void> {
    const { config } = this.#require();
    await Promise.all(
      Object.keys(config.images).map((environment) =>
        this.ensureImage(environment, {} as EnvironmentConfig).catch((error: unknown) => {
          this.#log.warn("Could not prepare a sandbox disk image; the first session will retry", { environment, error: (error as Error).message });
        }),
      ),
    );
  }

  ensureImage(environment: string, environmentConfig: EnvironmentConfig): Promise<SandboxImageRef> {
    const { config } = this.#require();
    if ((environmentConfig.packages?.system?.length ?? 0) > 0 && !config.images[environment]) {
      // The base image lacks them: running without them would be a silently weaker environment.
      return Promise.reject(
        unavailable(`Environment "${environment}" declares system packages, but no image with them was deployed. Redeploy with \`aspire deploy\` so its image is built and pushed.`),
      );
    }
    const ref = config.images[environment] ?? config.images["*"];
    if (!ref) {
      return Promise.reject(unavailable(`No sandbox image was deployed for environment "${environment}". Redeploy with \`aspire deploy\` so its image is built and pushed.`));
    }
    let pending = this.#images.get(ref);
    if (!pending) {
      pending = this.#diskImageFor(ref).catch((error: unknown) => {
        this.#images.delete(ref);
        throw error;
      });
      this.#images.set(ref, pending);
    }
    return pending;
  }

  async #diskImageFor(ref: string): Promise<SandboxImageRef> {
    const { config, api } = this.#require();
    const key = createHash("sha256").update(ref).digest("hex").slice(0, 40);
    const existing = (await api.listDiskImages()).filter((image) => image.labels?.[LABELS.image] === key && image.labels?.[LABELS.instance] === this.#instance);
    let image = existing.find((candidate) => READY_IMAGE_STATES.has(candidate.status?.state?.toLowerCase() ?? "")) ?? existing.find((candidate) => !FAILED_IMAGE_STATES.has(candidate.status?.state?.toLowerCase() ?? ""));
    if (image) this.#unconfirmed.clear(`image:${key}`);
    if (!image) {
      this.#log.info("Converting the sandbox image into a disk image", { image: ref });
      image = await this.#createDiskImage(ref, key);
    }
    const deadline = Date.now() + this.#timeouts.imageMs;
    for (;;) {
      const state = image.status?.state?.toLowerCase() ?? "";
      if (READY_IMAGE_STATES.has(state)) return { ref, id: image.id };
      if (FAILED_IMAGE_STATES.has(state)) {
        throw unavailable(`The sandbox image ${ref} could not be prepared on Azure: ${image.status?.errorMessage ?? "the disk image build failed"}.`);
      }
      if (Date.now() > deadline) throw unavailable(`The sandbox image ${ref} is still being prepared on Azure; try again in a few minutes.`);
      await this.#sleep(this.#pollMs * 2);
      image = (await api.getDiskImage(image.id)) ?? image;
    }
  }

  /** Creates a disk image; like sandbox creation, never submits a second create when Azure's answer was lost. */
  async #createDiskImage(ref: string, key: string): Promise<RemoteDiskImage> {
    const { api } = this.#require();
    const labels = { [LABELS.instance]: this.#instance, [LABELS.image]: key };
    // Before the create is recorded: failing to get credentials sends nothing.
    let registryCredentials: RegistryCredentials | undefined;
    try {
      registryCredentials = await this.#registryCredentials(ref);
    } catch (error) {
      if (error instanceof RegistryCredentialsError) throw unavailable(`The sandbox image ${ref} cannot be imported: ${error.message}`, error);
      throw error;
    }
    const lookup = async () =>
      (await api.listDiskImages()).find(
        (image) => image.labels?.[LABELS.image] === key && image.labels?.[LABELS.instance] === this.#instance && !FAILED_IMAGE_STATES.has(image.status?.state?.toLowerCase() ?? ""),
      );
    return this.#createOnce(`image:${key}`, `the disk image for ${ref}`, () => api.createDiskImage(ref, labels, registryCredentials ? { registryCredentials } : {}), lookup);
  }

  /**
   * Submits a create at most once while its outcome is unknown. The attempt is recorded (durably) before the request
   * goes out and forgotten once Azure's answer is definite, so neither a lost answer nor a crash mid-request leads to
   * a second create: later calls, also from a restarted gateway, look the resource up by its labels instead until it
   * appears or the horizon passes. After a failure without a definite answer, this call also keeps looking for the
   * resource until the reconciliation window ends.
   */
  async #createOnce<T>(key: string, what: string, create: () => Promise<T>, lookup: () => Promise<T | undefined>): Promise<T> {
    const since = this.#unconfirmed.outstanding(key);
    if (since !== undefined) {
      const adopted = await lookup();
      if (adopted) {
        this.#unconfirmed.clear(key);
        return adopted;
      }
      const waitS = Math.max(1, Math.ceil((since + this.#timeouts.unconfirmedMs - Date.now()) / 1000));
      throw unavailable(`An earlier attempt to create ${what} has not been confirmed by Azure yet. Try again in ${waitS} s.`);
    }
    this.#unconfirmed.record(key);
    let created: T;
    try {
      created = await create();
    } catch (error) {
      if (isDefinite(error)) {
        this.#unconfirmed.clear(key); // never sent, or refused: nothing will appear
        throw error;
      }
      const adopted = await this.#reconcile(lookup);
      if (!adopted) throw unconfirmed(what, error); // the record stays until the resource appears or the horizon passes
      this.#unconfirmed.clear(key);
      this.#log.warn("Adopted a resource Azure created without answering", { resource: what });
      return adopted;
    }
    this.#unconfirmed.clear(key);
    return created;
  }

  /**
   * After a create without a definite answer, looks for the resource by its labels until it appears or the
   * reconciliation window ends. Azure may still be carrying out the request, so an empty lookup is no reason to create
   * it again.
   */
  async #reconcile<T>(lookup: () => Promise<T | undefined>): Promise<T | undefined> {
    const deadline = Date.now() + this.#timeouts.reconcileMs;
    for (;;) {
      const found = await lookup();
      if (found) return found;
      if (Date.now() >= deadline) return undefined;
      await this.#sleep(Math.max(this.#pollMs * 2, 1));
    }
  }

  async hasImage(id: string): Promise<boolean> {
    const { api } = this.#require();
    const image = await api.getDiskImage(id);
    return Boolean(image && READY_IMAGE_STATES.has(image.status?.state?.toLowerCase() ?? ""));
  }

  // Sandboxes ----------------------------------------------------------------------------------------------------

  #diskName(sandboxId: string, role: string): string {
    return `${this.#instance}-${sandboxId.replace("_", "-")}-${role}`;
  }

  /** Every Azure sandbox labelled with this sandbox ID (normally one; more only after an interrupted replacement). */
  async #remotes(sandboxId: string): Promise<RemoteSandbox[]> {
    const { api } = this.#require();
    return (await api.listSandboxes({ [LABELS.instance]: this.#instance, [LABELS.sandbox]: sandboxId })).filter(
      (sandbox) => sandbox.labels?.[LABELS.sandbox] === sandboxId && sandbox.labels?.[LABELS.instance] === this.#instance,
    );
  }

  /** The sandbox's compute: a live one if any, else one still being deleted (which still holds the disks). */
  async #remote(sandboxId: string): Promise<RemoteSandbox | undefined> {
    const { api } = this.#require();
    const cached = this.#remoteIds.get(sandboxId);
    if (cached) {
      const sandbox = await api.getSandbox(cached);
      if (sandbox && !isDeleting(sandbox)) return sandbox;
      this.#remoteIds.delete(sandboxId);
    }
    const matches = await this.#remotes(sandboxId);
    const found = matches.find((sandbox) => !isDeleting(sandbox)) ?? matches[0];
    if (found && !isDeleting(found)) this.#remoteIds.set(sandboxId, found.id);
    return found;
  }
  async #ensureDisks(spec: SandboxSpec, options: SandboxOperationOptions): Promise<void> {
    const { config, api } = this.#require();
    const sizes = config.disks[spec.size];
    for (const disk of DISKS) {
      const name = this.#diskName(spec.sandboxId, disk.role);
      if (await api.getVolume(name)) continue;
      options.onProgress?.("Creating the sandbox's persistent storage…");
      await api.createDataDisk(name, sizes[disk.size], { [LABELS.instance]: this.#instance, [LABELS.sandbox]: spec.sandboxId, [LABELS.role]: disk.role });
    }
  }

  async #disksExist(sandboxId: string): Promise<boolean> {
    const { api } = this.#require();
    for (const disk of DISKS) if (!(await api.getVolume(this.#diskName(sandboxId, disk.role)))) return false;
    return true;
  }

  #egressPolicy(config: AzureSandboxConfig): Record<string, unknown> {
    const proxy = config.egressProxy;
    if (config.egressPolicyTemplate) {
      return JSON.parse(config.egressPolicyTemplate.replaceAll("{{proxyHost}}", proxy?.host ?? "").replaceAll("{{proxyPort}}", String(proxy?.port ?? ""))) as Record<string, unknown>;
    }
    // Measured on Azure (deploy/azure/qualify): HTTP rules cannot route through the VNet ("RoutingMode is only
    // supported on Rewrite rules") and a forward proxy cannot carry per-sandbox credentials, but a TCP transport rule to
    // the proxy's private address passes the sandbox's CONNECT, with its Proxy-Authorization, through the VNet
    // connection. Everything else is denied: direct HTTP(S) (the platform inspects it) and other TCP/UDP.
    const deny = { http: { defaultAction: "Deny", rules: [] } };
    if (!proxy) return deny;
    return {
      ...deny,
      transportRules: { defaultAction: "Deny", rules: [{ name: "managed-copilot-egress", action: "Allow", protocol: "Tcp", destination: `${proxy.host}/32`, port: proxy.port }] },
    };
  }

  #createBody(spec: SandboxSpec, config: AzureSandboxConfig): CreateSandboxBody {
    const size = SANDBOX_SIZES[spec.size];
    const port: Record<string, unknown> = { port: SANDBOXD_PORT, name: "sandboxd", protocol: "Http", auth: { anonymous: true } };
    if (config.ingressCidrs.length > 0) {
      port.ipAccessControl = { defaultAction: "Deny", rules: [{ name: "gateway", action: "Allow", priority: 100, sourceCidrs: [...config.ingressCidrs] }] };
    }
    return {
      sourcesRef: { diskImage: { id: spec.imageId } },
      resources: { cpu: String(size.cpus), memory: `${size.memoryMiB}Mi`, disk: `${quantityMiB(config.disks[spec.size].root)}Mi` },
      labels: {
        [LABELS.instance]: this.#instance,
        [LABELS.sandbox]: spec.sandboxId,
        [LABELS.session]: spec.sessionId,
        [LABELS.owner]: String(spec.ownerId),
        [LABELS.environment]: spec.environment,
      },
      environment: { ...spec.env },
      volumes: DISKS.map((disk) => ({ volumeName: this.#diskName(spec.sandboxId, disk.role), mountpoint: disk.mountpoint })),
      ports: [port],
      // The gateway decides when a sandbox is idle (pending actions, transfers, publications); the platform must not.
      lifecycle: { autoSuspendPolicy: { enabled: false }, autoDeletePolicy: { enabled: false } },
      egressPolicy: this.#egressPolicy(config),
      ...(config.vnetConnection ? { customerVnetConnectionName: config.vnetConnection } : {}),
    };
  }

  async #waitForState(remoteId: string, target: string, options: SandboxOperationOptions, timeoutMs: number, what: string): Promise<RemoteSandbox> {
    const { api } = this.#require();
    const deadline = Date.now() + timeoutMs;
    let announced = "";
    for (;;) {
      if (options.signal?.aborted) throw unavailable(`Stopped waiting for the sandbox to ${what}: the gateway is shutting down.`);
      const sandbox = await api.getSandbox(remoteId);
      if (!sandbox) throw unavailable(`The sandbox disappeared while waiting for it to ${what}.`);
      const state = sandbox.state?.toLowerCase() ?? "";
      if (state === target) return sandbox;
      if (FAILED_SANDBOX_STATES.has(state)) throw unavailable(`The Azure sandbox could not ${what} (state ${sandbox.state}).`);
      if (state && state !== announced) {
        announced = state;
        if (state === "creating") options.onProgress?.("Starting the sandbox…");
      }
      if (Date.now() > deadline) throw unavailable(`The Azure sandbox did not ${what} within ${Math.round(timeoutMs / 1000)} s (state ${sandbox.state ?? "unknown"}).`);
      await this.#sleep(this.#pollMs);
    }
  }

  async create(spec: SandboxSpec, options: SandboxOperationOptions = {}): Promise<void> {
    const { config } = this.#require();
    await this.#ensureDisks(spec, options);
    const existing = await this.#remotes(spec.sandboxId);
    let remote = existing.find((sandbox) => LIVE_SANDBOX_STATES.has(stateOf(sandbox)));
    if (remote) this.#unconfirmed.clear(`sandbox:${spec.sandboxId}`);
    for (const leftover of existing) {
      if (leftover === remote) continue;
      // Compute left from before (stopped by the platform, failed, or still being deleted) holds the disks.
      this.#log.info("Removing the sandbox's leftover compute", { sandboxId: spec.sandboxId, remoteId: leftover.id, state: leftover.state });
      await this.#deleteCompute(spec.sandboxId, leftover);
    }
    if (!remote) {
      options.onProgress?.("Allocating an Azure sandbox…");
      remote = await this.#createCompute(spec, config);
      this.#log.info("Created an Azure sandbox", { sandboxId: spec.sandboxId, remoteId: remote.id, size: spec.size });
    }
    this.#remoteIds.set(spec.sandboxId, remote.id);
    await this.#waitForState(remote.id, "running", options, this.#timeouts.createMs, "start");
    if (spec.customizations) {
      options.onProgress?.("Copying the environment's customizations…");
      await this.#uploadCustomizations(remote.id, spec.customizations);
    }
  }

  /** Copies the pinned customizations bundle to /opt/managed-copilot/customizations (root-owned, read-only to the workload). */
  async #uploadCustomizations(remoteId: string, root: string): Promise<void> {
    const { api } = this.#require();
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) files.push(path);
        if (files.length > CUSTOMIZATION_LIMITS.files) throw unavailable(`The environment's customizations have more than ${CUSTOMIZATION_LIMITS.files} files.`);
      }
    };
    await walk(root);
    let total = 0;
    for (const file of files) {
      const content = await readFile(file);
      total += content.byteLength;
      if (total > CUSTOMIZATION_LIMITS.bytes) throw unavailable("The environment's customizations are larger than 8 MiB.");
      const target = `${SANDBOX_PATHS.customizations}/${relative(root, file).split(sep).join("/")}`;
      await api.writeFile(remoteId, target, content, "0644");
    }
  }

  /**
   * Creates the sandbox's compute. A failure without a definite answer (network error, server error) may hide a
   * request Azure accepted or is still carrying out: the sandbox is looked up by its labels and adopted when it
   * appears, and never created a second time from this call.
   */
  async #createCompute(spec: SandboxSpec, config: AzureSandboxConfig): Promise<RemoteSandbox> {
    const { api } = this.#require();
    return this.#createOnce(
      `sandbox:${spec.sandboxId}`,
      "the sandbox",
      () => api.createSandbox(this.#createBody(spec, config)),
      async () => (await this.#remotes(spec.sandboxId)).find((sandbox) => !isDeleting(sandbox)),
    );
  }

  async start(sandboxId: string, options: SandboxOperationOptions = {}): Promise<SandboxStartResult> {
    const remotes = await this.#remotes(sandboxId);
    const live = remotes.find((sandbox) => stateOf(sandbox) === "running") ?? remotes.find((sandbox) => LIVE_SANDBOX_STATES.has(stateOf(sandbox)));
    if (live) {
      this.#remoteIds.set(sandboxId, live.id);
      if (stateOf(live) !== "running") await this.#waitForState(live.id, "running", options, this.#timeouts.createMs, "start");
      return "started";
    }
    // No running compute (stopped by the platform, failed, or still being deleted): it must release the disks before
    // the service recreates the sandbox over them.
    for (const leftover of remotes) {
      this.#log.info("Replacing the sandbox's compute", { sandboxId, remoteId: leftover.id, state: leftover.state });
      await this.#deleteCompute(sandboxId, leftover);
    }
    return (await this.#disksExist(sandboxId)) ? "recreate" : "gone";
  }

  /** Deletes one sandbox's compute and waits until it is gone (and has released its disks). */
  async #deleteCompute(sandboxId: string, remote: RemoteSandbox): Promise<void> {
    const { api } = this.#require();
    // Deletion is asynchronous; a sandbox already being deleted needs only the wait.
    if (!isDeleting(remote)) await api.deleteSandbox(remote.id);
    const deadline = Date.now() + this.#timeouts.deleteMs;
    while (await api.getSandbox(remote.id)) {
      if (Date.now() > deadline) throw unavailable(`The Azure sandbox for ${sandboxId} is still being deleted; try again shortly.`);
      await this.#sleep(this.#pollMs);
    }
    if (this.#remoteIds.get(sandboxId) === remote.id) this.#remoteIds.delete(sandboxId);
  }

  /** Deletes compute; the data disks (and with them every declared piece of state) survive. */
  async stop(sandboxId: string): Promise<void> {
    for (const remote of await this.#remotes(sandboxId)) await this.#deleteCompute(sandboxId, remote);
    this.#remoteIds.delete(sandboxId);
  }

  async remove(sandboxId: string): Promise<void> {
    const { api } = this.#require();
    await this.stop(sandboxId);
    // A create that never confirmed is no longer awaited; if it appears later, its labels put it in the orphan sweep.
    this.#unconfirmed.clear(`sandbox:${sandboxId}`);
    for (const disk of DISKS) {
      const name = this.#diskName(sandboxId, disk.role);
      const deadline = Date.now() + this.#timeouts.deleteMs;
      for (;;) {
        const volume = await api.getVolume(name);
        if (!volume) break;
        if (!volume.isAttached) {
          await api.deleteVolume(name);
          if (!(await api.getVolume(name))) break;
        }
        if (Date.now() > deadline) throw unavailable(`The sandbox's disk ${name} could not be deleted yet; reconciliation will retry.`);
        await this.#sleep(this.#pollMs);
      }
    }
  }

  async isRunning(sandboxId: string): Promise<boolean> {
    return (await this.#remote(sandboxId))?.state?.toLowerCase() === "running";
  }

  async address(): Promise<string | undefined> {
    return undefined;
  }

  egressProxy(): { readonly host: string; readonly port: number } | undefined {
    return this.#config?.egressProxy;
  }

  async endpoint(sandboxId: string): Promise<SandboxEndpoint> {
    const remote = await this.#remote(sandboxId);
    const url = remote && !isDeleting(remote) ? remote.ports?.find((port) => port.port === SANDBOXD_PORT)?.url : undefined;
    if (!remote || !url) throw unavailable("The sandbox is not running, so it has no endpoint.");
    return { url: url.replace(/\/+$/, ""), headers: {} };
  }

  reportUnreachable(sandboxId: string): void {
    this.#remoteIds.delete(sandboxId);
  }

  async inventory(): Promise<Set<string>> {
    const { api } = this.#require();
    const ids = new Set<string>();
    for (const sandbox of await api.listSandboxes({ [LABELS.instance]: this.#instance })) {
      const id = sandbox.labels?.[LABELS.sandbox];
      if (id && sandbox.labels?.[LABELS.instance] === this.#instance) ids.add(id);
    }
    for (const volume of await api.listVolumes()) {
      const id = volume.labels?.[LABELS.sandbox];
      if (id && volume.labels?.[LABELS.instance] === this.#instance) ids.add(id);
    }
    return ids;
  }
}
