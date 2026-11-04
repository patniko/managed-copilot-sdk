/**
 * Isolated placement contracts (spec sections 4, 5, 6; architecture "Isolated placement").
 *
 * The gateway reaches each sandbox's platform agent (`sandboxd`) through the sandbox relay at
 * `/relay/<sandboxId>/<sandboxd route>`. `sandboxd` runs as root inside the sandbox, never as the workload
 * identity, and starts the stock Copilot runtime as `SANDBOX_UID` on loopback. These types are shared by the
 * gateway's sandbox module and `services/sandbox`; `sandboxd` imports them as types only.
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
  /** `GET ?path=` streams a workspace file; `PUT ?path=&overwrite=&ifMatch=` writes one atomically (`ifMatch`: replace only if its SHA-256 is still this). */
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
  /**
   * `POST` replaces the stock runtime process with a fresh one on the same `COPILOT_HOME` (session state stays on disk;
   * bridged runtime connections close). Stock runtimes keep their inference-provider registration with their first
   * provider connection even after it closed, so a new gateway connection can only become the provider of a new process.
   */
  runtimeRestart: "/v1/runtime/restart",
  /**
   * `POST` (`SandboxExecRequest`) starts a command, idempotent by its ID (an ID it already has answers with that
   * command); `GET` lists the journaled commands (`SandboxExecRecord[]`). Per command: `GET /v1/exec/<id>?offset=&waitMs=`
   * reads (`SandboxExecRead`), `POST /v1/exec/<id>/input` (`{ data?, eof? }`) writes to its stdin, `POST
   * /v1/exec/<id>/stop?reason=` kills its process group.
   */
  exec: "/v1/exec",
  /** `POST ?reason=` stops every running command (before an idle stop); answers with the commands it stopped. */
  execStopAll: "/v1/exec-stop",
} as const;

/** A command's sandboxd route (`SANDBOXD_ROUTES.exec`), with an optional `input` or `stop` action. */
export function sandboxdExecRoute(id: string, action?: "input" | "stop"): string {
  return `${SANDBOXD_ROUTES.exec}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

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
  /**
   * Commands run directly in a sandbox (`managed.exec`): the output each one keeps (the newest bytes; older output is
   * skipped), the most one read returns, how many run at once, how many finished ones are journaled, the command's
   * size, one stdin write, and how long one call may wait.
   */
  exec: { outputBytes: 1024 * 1024, readBytes: 256 * 1024, running: 32, retained: 200, commandBytes: 128 * 1024, inputBytes: 1024 * 1024, maxWaitMs: 30_000 },
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
  /**
   * Default true. False: a workspace-only sandbox (commands and files only), where sandboxd never starts the Copilot
   * runtime and reports ready once setup succeeded.
   */
  readonly runtime?: boolean;
}

/** `POST SANDBOXD_ROUTES.exec`: runs `bash -c <command>` as the workload identity in `/workspace`. */
export interface SandboxExecRequest {
  /** The command's journal ID (`[A-Za-z0-9_-]{1,64}`); a start with an ID sandboxd already has answers with that command. */
  readonly id: string;
  readonly command: string;
  /** Kills the command's process group after this long (none: runs until it ends, is stopped, or the sandbox stops). */
  readonly timeoutMs?: number;
  /** `closed` (default): stdin is at end of file from the start. `open`: write to it with the input route. */
  readonly stdin?: "open" | "closed";
}

/** How a command ended: `failed` means it could not be started; `uncertain` (gateway only) that its outcome is unknown. */
export type ExecState = "running" | "completed" | "failed" | "timed_out" | "stopped" | "uncertain";

/** sandboxd's journal entry for one command. */
export interface SandboxExecRecord {
  readonly id: string;
  readonly command: string;
  readonly state: Exclude<ExecState, "uncertain">;
  readonly stdin: "open" | "closed";
  readonly exitCode?: number;
  readonly signal?: string;
  /** Why it was stopped, timed out, or failed. */
  readonly reason?: string;
  readonly timeoutMs?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly lastOutputAt?: string;
  /** Bytes of combined stdout and stderr the command wrote so far (offsets count these). */
  readonly outputBytes: number;
}

/** `GET` of one command: its record and its output from `offset` on. */
export interface SandboxExecRead {
  readonly exec: SandboxExecRecord;
  /** UTF-8 output from the requested offset (at most `SANDBOX_LIMITS.exec.readBytes`). */
  readonly output: string;
  /** The offset to read from next. */
  readonly offset: number;
  /** Bytes between the requested offset and the oldest output the journal still keeps, which this read skipped. */
  readonly skippedBytes?: number;
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
  /** `instance` identifies the runtime process: it changes whenever a new process starts (restart, crash recovery, or a new sandbox). */
  readonly runtime: { readonly state: SandboxdRuntimeState; readonly restarts: number; readonly exitCode?: number; readonly instance?: string };
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
