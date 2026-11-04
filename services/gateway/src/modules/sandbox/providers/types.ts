// The compute backend contract for isolated placement. The sandbox service owns policy and lifecycle decisions (setup,
// egress registration, the runtime, idle stop, reconciliation, artifacts); a provider owns compute, persistent
// storage, networking, images, and how the gateway reaches each sandbox's sandboxd. Providers: `docker` (local, this
// directory's docker/) and `azure` (azure/).
import type { EnvironmentConfig, InfraFact, SandboxSize } from "@managed-copilot/protocol";
import type { Logger } from "../../../log.js";

/** Everything a provider needs to create one sandbox. */
export interface SandboxSpec {
  /** `sbx_` plus 24 lowercase hex characters. */
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  /** Maps to CPU and memory limits through `SANDBOX_SIZES`. */
  readonly size: SandboxSize;
  /** The pinned image (`SandboxImageRef.id`); a resume never changes it. */
  readonly imageId: string;
  /**
   * Container environment for sandboxd only (SANDBOX_ID, SANDBOXD_KEY, SANDBOXD_RUNTIME_TOKEN). sandboxd removes these
   * from its own environment before starting anything; providers must never log them.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Gateway-host directory exposed read-only at /opt/managed-copilot/customizations. */
  readonly customizations?: string;
}

/** An environment's immutable image: `ref` for display, `id` (image ID or digest) for pinning. */
export interface SandboxImageRef {
  readonly ref: string;
  readonly id: string;
}

/** How the gateway reaches one sandbox's sandboxd (HTTP requests and WebSocket upgrades). */
export interface SandboxEndpoint {
  /** Base URL; sandboxd routes (`/v1/health`, `/v1/runtime`, …) are appended. `http:` or `https:`. */
  readonly url: string;
  /** Headers for the path to sandboxd (e.g. the relay's platform key). The service adds sandboxd's bearer key. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * `started`: compute is running. `recreate`: compute is gone but storage is intact (the service then calls `create`
 * with the pinned image). `gone`: storage no longer exists, so the session cannot be restored.
 */
export type SandboxStartResult = "started" | "recreate" | "gone";

/** Options for slow backend operations. */
export interface SandboxOperationOptions {
  /** Aborted when the gateway shuts down. */
  readonly signal?: AbortSignal;
  /** Short, user-safe progress messages ("Allocating an Azure sandbox…"); never include secrets. */
  onProgress?(message: string): void;
}

/**
 * A provider must keep these invariants: the image's entrypoint (sandboxd) runs as root holding only CHOWN, KILL,
 * SETGID, and SETUID with no-new-privileges, and the workload runs as uid 10001; /workspace, /home/agent, and
 * /var/lib/managed-copilot are persistent per sandbox and survive stop/start; there is no route between sandboxes and
 * no Internet access except through the egress proxy; sandboxd's port (7781) is reachable only through `endpoint`.
 */
export interface SandboxProvider {
  /** Short backend name for logs ("docker", "azure"). */
  readonly kind: string;
  readonly capabilities: {
    /** Whether the backend can keep prepared, unassigned sandboxes for `warm`; nonzero `warm` fails deployment otherwise. */
    readonly warm: boolean;
    /**
     * Whether `address()` is the source address the egress proxy sees, so proxy credentials can be pinned to it. When
     * false (e.g. traffic arrives through an ingress proxy), the per-sandbox proxy credential is the only binding.
     */
    readonly addressPinning: boolean;
    /** How long a just-created or just-started sandbox may take until sandboxd answers (default 60 s). */
    readonly startTimeoutMs?: number;
  };
  /**
   * Verifies the backend is reachable and configured; rejects with `capability_unavailable` and an actionable message.
   * Also the availability probe behind `/v1/info` (called at registration and every 30 s), so a success may be cached
   * only briefly: a backend that goes away must start failing within seconds.
   */
  ready(): Promise<void>;
  /** Optional eager preparation at gateway start (base image, relay). Failures are retried on first use. */
  prepare?(): Promise<void>;
  /** Resolves (builds, pulls, or looks up) the image for an environment. */
  ensureImage(environment: string, config: EnvironmentConfig): Promise<SandboxImageRef>;
  /** True while a pinned image can still be started. */
  hasImage(id: string): Promise<boolean>;
  /** Creates storage, networking, and compute for a new sandbox (or recreates compute over existing storage) and starts it. Idempotent per sandbox. */
  create(spec: SandboxSpec, options?: SandboxOperationOptions): Promise<void>;
  /** Starts an existing sandbox. */
  start(sandboxId: string, options?: SandboxOperationOptions): Promise<SandboxStartResult>;
  /** Stops compute; storage survives. */
  stop(sandboxId: string): Promise<void>;
  /** Removes compute, storage, and networking. Safe to repeat. */
  remove(sandboxId: string): Promise<void>;
  isRunning(sandboxId: string): Promise<boolean>;
  /** The sandbox's source address as the egress proxy sees it (only consulted when `capabilities.addressPinning`). */
  address(sandboxId: string): Promise<string | undefined>;
  /**
   * Where sandboxes reach the egress proxy on this backend, when it is not the default `mc-egress:3128` alias. Passed
   * to `policy.registerSandbox` so the proxy URL it returns matches the backend's topology.
   */
  egressProxy?(): { readonly host: string; readonly port: number } | undefined;
  endpoint(sandboxId: string): Promise<SandboxEndpoint>;
  /** Called after a connection failure so the provider can repair the path (e.g. recreate a relay). */
  reportUnreachable?(sandboxId: string): void;
  /** Re-wires platform networking for a sandbox found running after a gateway restart. */
  reattach?(sandboxId: string): Promise<void>;
  /** IDs of sandboxes with resources for this gateway instance (orphan sweep at start). */
  inventory(): Promise<Set<string>>;
  /**
   * Non-secret facts about the backend for the operator console (engine version, region, images, relay). Never keys,
   * tokens, or anything sandboxes hold.
   */
  describe?(): readonly InfraFact[] | Promise<readonly InfraFact[]>;
  /**
   * Releases shared resources at gateway shutdown (running sandboxes are stopped by the service first). Only resources
   * this process started: a probe alone must not tear down what another gateway on the same instance uses.
   */
  shutdown?(): Promise<void>;
}

/** What the gateway hands a provider factory. */
export interface SandboxProviderDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
  /** `MANAGED_COPILOT_INSTANCE`: prefix and label for every resource this gateway creates. */
  readonly instance: string;
  /** Internal service credential (relay/egress authentication). */
  readonly platformKey: string;
  readonly appHostDir: string;
  readonly dataDir: string;
}
