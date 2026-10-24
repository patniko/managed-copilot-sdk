/**
 * Isolated placement contracts (spec sections 4, 5, 6; architecture "Isolated placement").
 *
 * The gateway reaches each sandbox's platform agent (`sandboxd`) through the sandbox relay at
 * `/relay/<sandboxId>/<sandboxd route>`. `sandboxd` runs as root inside the sandbox, never as the workload
 * identity, and starts the stock Copilot runtime as `SANDBOX_UID` on loopback. These types are shared by the
 * gateway's sandbox module and `platform/sandbox`; `sandboxd` imports them as types only.
 */
import type { FileEntry } from "./api.js";

/** `sandboxd` HTTP port inside a sandbox (bearer-authenticated with the per-sandbox key). */
export const SANDBOXD_PORT = 7781;
/** Port the relay listens on inside its container. */
export const SANDBOX_RELAY_PORT = 7780;
/** Loopback port of the stock runtime inside a sandbox. */
export const SANDBOX_RUNTIME_PORT = 7790;

/** Header carrying the platform key on gateway → relay requests (the relay strips it). */
export const PLATFORM_KEY_HEADER = "x-managed-copilot-platform-key";

export const SANDBOXD_ROUTES = {
  health: "/v1/health",
  /** `POST` NDJSON stream of `SandboxStartEvent`s: trust, setup (first start only), runtime. */
  start: "/v1/start",
  status: "/v1/status",
  /** WebSocket: binary frames carry the runtime's LSP-framed JSON-RPC byte stream. */
  runtime: "/v1/runtime",
  /** WebSocket `?port=`: raw TCP tunnel to a loopback port inside the sandbox (e.g. an AHP listener for CLI attach). */
  tunnel: "/v1/tunnel",
  /** `GET ?path=&recursive=` lists workspace entries. */
  files: "/v1/files",
  /** `GET ?path=` streams a workspace file; `PUT ?path=&overwrite=` writes one atomically. */
  fileContent: "/v1/files/content",
  /** `POST` hashes the bounded regular files under `/workspace/outputs`. */
  outputsManifest: "/v1/outputs/manifest",
  /** `GET ?path=` streams a file under `/workspace/outputs`. */
  outputsContent: "/v1/outputs/content",
  /** `PUT ?staging=&path=` writes one file of a runtime-state import into its staging directory (promotion). */
  runtimeImportContent: "/v1/runtime-import/content",
  /** `POST ?staging=&sessionId=` replaces `session-state/<sessionId>/` in the runtime's COPILOT_HOME with the staging directory. */
  runtimeImportCommit: "/v1/runtime-import/commit",
  /** `POST ?staging=` discards a staging directory. */
  runtimeImportAbort: "/v1/runtime-import/abort",
} as const;

/** Fixed paths inside every sandbox. */
export const SANDBOX_PATHS = {
  workspace: "/workspace",
  outputs: "/workspace/outputs",
  home: "/home/agent",
  /** Persisted Python environment, first on `PATH`. */
  venv: "/home/agent/.venv",
  /** Persisted npm global prefix. */
  npmPrefix: "/home/agent/.npm-global",
  /** Read-only bind mount of the environment's `customizations` folder (agents, skills, instructions). */
  customizations: "/opt/managed-copilot/customizations",
  /** Persistent platform state volume: `runtime/` is the runtime's `COPILOT_HOME`; `sandboxd/` is root-only. */
  state: "/var/lib/managed-copilot",
  runtimeHome: "/var/lib/managed-copilot/runtime",
  /** Where `sandboxd` installs the egress proxy's CA certificate before the runtime starts. */
  egressCaCertificate: "/usr/local/share/ca-certificates/managed-copilot-egress.crt",
  systemCaBundle: "/etc/ssl/certs/ca-certificates.crt",
} as const;

/**
 * Environment variables a customer `env` can never set (exact names, case-insensitive), plus reserved prefixes.
 * Identity, proxy, trust, and runtime settings belong to the platform.
 */
export const RESERVED_SANDBOX_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "PWD",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "VIRTUAL_ENV",
  "NPM_CONFIG_PREFIX",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
] as const;
export const RESERVED_SANDBOX_ENV_PREFIXES = ["COPILOT_", "MANAGED_COPILOT_", "SANDBOXD_", "GH_ENTERPRISE_", "GITHUB_COPILOT_"] as const;

export function isReservedSandboxEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (RESERVED_SANDBOX_ENV as readonly string[]).includes(upper) || RESERVED_SANDBOX_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export const SANDBOX_LIMITS = {
  /** Setup `files` entries (spec section 5): count, per-file, and total decoded bytes. */
  setupFiles: { count: 64, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 },
  /** Streamed uploads through the files API. */
  uploadBytes: 512 * 1024 * 1024,
  /** Artifact publication from `/workspace/outputs` (spec section 6). */
  artifacts: { count: 256, fileBytes: 100 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 },
  /** Entries returned by one recursive listing. */
  listEntries: 10_000,
  setupCommandTimeoutSeconds: 15 * 60,
} as const;

/** Setup admitted for one sandbox: the environment's declaration plus caller additions (spec section 5). */
export interface SandboxSetupPlan {
  readonly packages?: { readonly python?: readonly string[]; readonly npm?: readonly string[] };
  /** Workspace-relative POSIX paths → base64 contents. */
  readonly files?: Readonly<Record<string, string>>;
  readonly setupCommands?: readonly string[];
}

export type SandboxSetupStepKind = "python" | "npm" | "files" | "command";
export type SandboxSetupState = "pending" | "running" | "succeeded" | "failed";

export interface SandboxSetupStep {
  readonly kind: SandboxSetupStepKind;
  /** Human label, e.g. `pip install pandas==2.2.3` or the setup command. */
  readonly name: string;
  readonly state: SandboxSetupState;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  /** Redacted tail of combined output, recorded on failure. */
  readonly output?: string;
}

/** Durable record of initial setup; the gateway's copy is authoritative, never the sandbox's. */
export interface SandboxSetupRecord {
  readonly state: SandboxSetupState;
  readonly steps: readonly SandboxSetupStep[];
  /** Resolved versions of installed packages, e.g. `{ python: { pandas: "2.2.3" }, npm: { typescript: "5.9.3" } }`. */
  readonly resolved: { readonly python?: Readonly<Record<string, string>>; readonly npm?: Readonly<Record<string, string>> };
  /** Files written by setup with their SHA-256 digests. */
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Redacted failure summary. */
  readonly error?: string;
}

export interface SandboxStartRequest {
  /** `create` runs `setup` once; `resume` never replays it and requires a succeeded record. */
  readonly mode: "create" | "resume";
  readonly setup?: SandboxSetupPlan;
  /** Platform-owned variables from the egress service (proxy, `NODE_USE_ENV_PROXY`, vault placeholders). */
  readonly platformEnv: Readonly<Record<string, string>>;
  /** Customer-visible, non-reserved variables (`env` from the environment and the caller). */
  readonly workloadEnv: Readonly<Record<string, string>>;
  /** PEM of the egress proxy's CA, installed into the system trust store before anything runs. */
  readonly caCertificate?: string;
}

export type SandboxStartEvent =
  | { readonly type: "progress"; readonly setup: SandboxSetupRecord }
  | { readonly type: "runtime"; readonly state: "starting" | "running" }
  | { readonly type: "ready"; readonly setup: SandboxSetupRecord; readonly runtimePort: number }
  | { readonly type: "failed"; readonly code: "setup_failed" | "state_restore_failed" | "internal"; readonly message: string; readonly setup?: SandboxSetupRecord };

export type SandboxdRuntimeState = "stopped" | "starting" | "running" | "exited";

export interface SandboxdStatus {
  readonly sandboxId: string;
  readonly version: string;
  readonly state: "booting" | "starting" | "ready" | "failed";
  readonly runtime: { readonly state: SandboxdRuntimeState; readonly restarts: number; readonly exitCode?: number };
  readonly setup?: SandboxSetupRecord;
  readonly error?: string;
}

export interface SandboxOutputFile {
  /** Path relative to `/workspace/outputs`. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly modifiedAt: string;
}

export interface SandboxOutputsManifest {
  readonly files: readonly SandboxOutputFile[];
  /** Entries that cannot be published (symlinks, special files, changing files, limits). */
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

export type SandboxFileEntry = FileEntry;
