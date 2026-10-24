// The shared runtime: the stock `@github/copilot` runtime started headless on a loopback port, supervised by the
// gateway, and reached over a persistent JSON-RPC upstream connection. Client connections never own it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect as connectTcp } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { UpstreamInfo } from "./contracts.js";
import { RpcEndpoint, RpcError, streamTransport, type IncomingRequestContext, type MessageTransport } from "./rpc.js";

/** Minimum and maximum protocol versions this gateway relays (SDK 1.0.26 speaks version 3). */
export const MIN_PROTOCOL_VERSION = 3;
export const MAX_PROTOCOL_VERSION = 3;

export interface UpstreamHandlers {
  onNotification(upstream: RuntimeUpstream, method: string, params: unknown): void;
  onRequest(upstream: RuntimeUpstream, method: string, params: unknown, context: IncomingRequestContext): unknown | Promise<unknown>;
  onClose?(upstream: RuntimeUpstream, error?: Error): void;
}

/** A gateway-owned JSON-RPC connection to one runtime (the shared runtime or one sandbox runtime). */
export class RuntimeUpstream {
  readonly info: UpstreamInfo;
  readonly endpoint: RpcEndpoint;
  #version = "unknown";
  #protocolVersion = MIN_PROTOCOL_VERSION;

  private constructor(info: UpstreamInfo, transport: MessageTransport, handlers: UpstreamHandlers, log: Logger) {
    this.info = info;
    this.endpoint = new RpcEndpoint(transport, {
      name: `runtime ${info.id}`,
      onNotification: (method, params) => handlers.onNotification(this, method, params),
      onRequest: (method, params, context) => handlers.onRequest(this, method, params, context),
      onError: (error, { method }) => log.warn("Runtime request handler failed", { upstream: info.id, method, error: (error as Error)?.message ?? String(error) }),
    });
    transport.onClose((error) => handlers.onClose?.(this, error));
  }

  get version(): string {
    return this.#version;
  }

  get protocolVersion(): number {
    return this.#protocolVersion;
  }

  get closed(): boolean {
    return this.endpoint.closed;
  }

  /** Opens the connection and performs the runtime `connect` handshake with the connection token. */
  static async open(info: UpstreamInfo, transport: MessageTransport, options: { token: string; handlers: UpstreamHandlers; log: Logger; timeoutMs?: number }): Promise<RuntimeUpstream> {
    const upstream = new RuntimeUpstream(info, transport, options.handlers, options.log);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        upstream.endpoint.request<{ protocolVersion?: number; version?: string }>("connect", { token: options.token, supportedTaskKinds: ["agent", "client", "shell"] }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for the runtime handshake")), options.timeoutMs ?? 30_000);
        }),
      ]);
      const protocolVersion = result?.protocolVersion;
      if (typeof protocolVersion !== "number" || protocolVersion < MIN_PROTOCOL_VERSION || protocolVersion > MAX_PROTOCOL_VERSION) {
        throw new Error(`Runtime protocol version ${String(protocolVersion)} is not supported (expected ${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION})`);
      }
      upstream.#protocolVersion = protocolVersion;
      upstream.#version = typeof result.version === "string" ? result.version : "unknown";
      return upstream;
    } catch (error) {
      upstream.endpoint.close();
      throw error instanceof RpcError ? new Error(`Runtime handshake failed: ${error.message}`) : error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  request<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    return this.endpoint.request<T>(method, params, options);
  }

  close(): void {
    this.endpoint.close();
  }
}

/**
 * Resolves the stock headless runtime through public package metadata: the SDK's platform package
 * (`@github/copilot-sdk-<platform>/prebuilds/<platform>/copilot-runtime[.exe]`, what `CopilotClient` itself spawns),
 * falling back to the `@github/copilot` CLI binary of the same pinned version.
 */
export function resolveRuntimeBinary(override?: string): string {
  if (override) return override;
  const require = createRequire(import.meta.url);
  const platform = process.platform === "linux" ? `${isMusl() ? "linuxmusl" : "linux"}-${process.arch}` : `${process.platform}-${process.arch}`;
  try {
    // The SDK's exports map hides package.json; find the package root from its entry point instead.
    let root = dirname(require.resolve("@github/copilot-sdk"));
    while (!existsSync(join(root, "package.json")) || !/"name":\s*"@github\/copilot-sdk"/.test(readFileSync(join(root, "package.json"), "utf8"))) {
      const parent = dirname(root);
      if (parent === root) throw new Error("not found");
      root = parent;
    }
    const sdk = createRequire(join(root, "package.json"));
    const platformRoot = dirname(sdk.resolve(`@github/copilot-sdk-${platform}/package.json`));
    const binary = join(platformRoot, "prebuilds", platform, process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime");
    if (existsSync(binary)) return binary;
  } catch {
    // Fall through to the CLI package.
  }
  try {
    const cli = createRequire(require.resolve("@github/copilot/package.json"));
    const candidates = process.platform === "linux" ? (isMusl() ? ["linuxmusl", "linux"] : ["linux"]) : [process.platform];
    for (const candidate of candidates) {
      try {
        return cli.resolve(`@github/copilot-${candidate}-${process.arch}`);
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Reported below.
  }
  throw new ManagedCopilotError("capability_unavailable", `No stock Copilot runtime is installed for ${platform}; reinstall the gateway's dependencies`);
}

function isMusl(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
}

/** OS variables the runtime needs. Everything else (tokens, BYOK provider settings, allow-all flags) is withheld. */
const RUNTIME_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "SystemDrive",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS",
];

export function runtimeEnvironment(source: Readonly<Record<string, string | undefined>>, overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

export interface SharedRuntimeOptions {
  readonly log: Logger;
  /** Platform-owned runtime directory (COPILOT_HOME, HOME, logs, per-session working directories). */
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly binary?: string;
  readonly logLevel?: string;
  /** Connect to an already-running runtime (`tcp://host:port`) instead of spawning one. */
  readonly externalUrl?: string;
  readonly externalToken?: string;
  readonly handlers: UpstreamHandlers;
  /** Called after each successful (re)connection with the new upstream and its generation. */
  readonly onConnected?: (upstream: RuntimeUpstream, generation: number) => void;
}

type RuntimeState = "stopped" | "starting" | "running" | "restarting" | "failed";

/** Starts and supervises the shared runtime. Restarts with backoff after crashes; sessions are re-resumed lazily. */
export class SharedRuntime {
  readonly #options: SharedRuntimeOptions;
  #state: RuntimeState = "stopped";
  #child: ChildProcess | undefined;
  #upstream: RuntimeUpstream | undefined;
  #generation = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #backoffMs = 1000;
  #stopping = false;
  #reaped = false;
  #waiters: { resolve(upstream: RuntimeUpstream): void; reject(error: Error): void }[] = [];
  #lastError: string | undefined;
  #stderrTail: string[] = [];

  constructor(options: SharedRuntimeOptions) {
    this.#options = options;
  }

  get state(): RuntimeState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  get workspacesRoot(): string {
    return join(this.#options.root, "workspaces");
  }

  /** Where the spawned runtime keeps a session's state; undefined for an external runtime. */
  sessionStateDirectory(sessionId: string): string | undefined {
    return this.#options.externalUrl ? undefined : join(this.#options.root, "copilot-home", "session-state", sessionId);
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  /** The connected upstream, if any. */
  current(): RuntimeUpstream | undefined {
    return this.#upstream && !this.#upstream.closed ? this.#upstream : undefined;
  }

  /** Waits for a connected upstream, failing with `capability_unavailable` after `timeoutMs`. */
  ready(timeoutMs = 30_000): Promise<RuntimeUpstream> {
    const current = this.current();
    if (current) return Promise.resolve(current);
    if (this.#state === "stopped" || this.#state === "failed") {
      return Promise.reject(new ManagedCopilotError("capability_unavailable", `The shared runtime is not running${this.#lastError ? `: ${this.#lastError}` : ""}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (upstream: RuntimeUpstream) => {
          clearTimeout(timer);
          resolve(upstream);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
        reject(new ManagedCopilotError("capability_unavailable", "The shared runtime is restarting; try again shortly"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#state = "starting";
    try {
      await this.#launch();
    } catch (error) {
      this.#state = "failed";
      this.#lastError = (error as Error).message;
      this.#rejectWaiters(new ManagedCopilotError("capability_unavailable", `The shared runtime failed to start: ${this.#lastError}`));
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#state = "stopped";
    const upstream = this.#upstream;
    const child = this.#child;
    this.#upstream = undefined;
    this.#child = undefined;
    this.#rejectWaiters(new ManagedCopilotError("capability_unavailable", "The gateway is shutting down"));
    if (upstream && !upstream.closed && child) {
      // Let the runtime flush session state before it exits.
      await Promise.race([upstream.request("runtime.shutdown", {}).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    upstream?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  async #launch(): Promise<void> {
    const { log } = this.#options;
    let transport: MessageTransport;
    let token: string;
    if (this.#options.externalUrl) {
      const url = new URL(this.#options.externalUrl);
      token = this.#options.externalToken ?? "";
      transport = await openTcp(url.hostname, Number(url.port));
    } else {
      const spawned = await this.#spawn();
      token = spawned.token;
      try {
        transport = await openTcp("127.0.0.1", spawned.port);
      } catch (error) {
        this.#killChild();
        throw error;
      }
    }
    const generation = this.#generation + 1;
    const info: UpstreamInfo = { id: "shared", kind: "shared" };
    let upstream: RuntimeUpstream;
    try {
      upstream = await RuntimeUpstream.open(info, transport, {
        token,
        log,
        handlers: {
          onNotification: this.#options.handlers.onNotification,
          onRequest: this.#options.handlers.onRequest,
          onClose: (closed, error) => {
            this.#options.handlers.onClose?.(closed, error);
            if (this.#upstream === closed) this.#onLost(`connection closed${error ? `: ${error.message}` : ""}`);
          },
        },
      });
    } catch (error) {
      transport.close();
      this.#killChild();
      throw error;
    }
    this.#generation = generation;
    this.#upstream = upstream;
    this.#state = "running";
    this.#backoffMs = 1000;
    this.#lastError = undefined;
    log.info("Shared runtime ready", { version: upstream.version, protocolVersion: upstream.protocolVersion, generation });
    this.#options.onConnected?.(upstream, generation);
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(upstream);
  }

  async #spawn(): Promise<{ port: number; token: string }> {
    const { log, root } = this.#options;
    if (!this.#reaped) {
      this.#reaped = true;
      await reapStaleRuntime(root, log);
    }
    const binary = resolveRuntimeBinary(this.#options.binary);
    const copilotHome = join(root, "copilot-home");
    const home = join(root, "home");
    for (const dir of [copilotHome, home, this.workspacesRoot]) mkdirSync(dir, { recursive: true });
    const token = randomBytes(32).toString("base64url");
    const env = runtimeEnvironment(this.#options.env, {
      COPILOT_HOME: copilotHome,
      HOME: home,
      USERPROFILE: home,
      COPILOT_CONNECTION_TOKEN: token,
      COPILOT_DISABLE_KEYTAR: "1",
      COPILOT_AUTO_UPDATE: "false",
      NO_COLOR: "1",
    });
    // The same flags the stock SDK passes for a TCP runtime, plus `--no-auto-login` (no ambient credentials).
    const args = ["--headless", "--no-auto-update", "--no-auto-login", "--log-level", this.#options.logLevel ?? "info"];
    // The runtime's cwd must contain every session working directory (AHP publication requires it).
    const child = spawn(binary, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    this.#stderrTail = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
        log.debug("runtime stderr", { line });
      }
    });
    const port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out waiting for the runtime to listen. ${this.#stderrTail.join(" ").slice(-500)}`));
      }, 30_000);
      child.stdout?.setEncoding("utf8");
      const onData = (chunk: string) => {
        stdout += chunk;
        const match = /listening on port (\d+)/i.exec(stdout);
        if (match) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.stdout?.on("data", () => undefined);
          resolve(Number(match[1]));
        }
      };
      child.stdout?.on("data", onData);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not start the runtime: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`The runtime exited during startup (${signal ?? `code ${code}`}). ${this.#stderrTail.join(" ").slice(-500)}`));
      });
    });
    child.once("exit", (code, signal) => {
      clearRuntimeRecord(root, child.pid);
      if (this.#child !== child) return;
      this.#child = undefined;
      if (!this.#stopping) this.#onLost(`runtime exited (${signal ?? `code ${code}`})`);
    });
    // Lets a later gateway on this data directory stop this runtime if this gateway dies without tearing it down.
    void recordRuntime(root, child, () => this.#child === child);
    log.info("Shared runtime started", { pid: child.pid, port, binary });
    return { port, token };
  }

  #onLost(reason: string): void {
    if (this.#stopping || this.#state === "restarting") return;
    const { log } = this.#options;
    this.#lastError = reason;
    this.#state = "restarting";
    this.#upstream?.close();
    this.#upstream = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) child.kill();
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    log.warn("Shared runtime lost; restarting", { reason, delayMs: delay });
    this.#restartTimer = setTimeout(() => {
      this.#launch().catch((error: Error) => {
        this.#state = "restarting";
        this.#lastError = error.message;
        log.error("Shared runtime restart failed", { error: error.message });
        this.#state = "running"; // allow #onLost to schedule the next attempt
        this.#onLost(error.message);
      });
    }, delay);
    this.#restartTimer.unref();
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  /** Stops a spawned runtime that never became usable. */
  #killChild(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

const execFileAsync = promisify(execFile);
const RUNTIME_RECORD = "runtime.json";

interface RuntimeRecord {
  readonly pid: number;
  /** The process's OS start time, so a reused pid is never mistaken for it. */
  readonly startTime: string;
  readonly gatewayPid: number;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The OS start time of a running process, or undefined. */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 });
      return stdout.trim() || undefined;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Records the spawned runtime in its data directory (best effort) while `current()` still holds. */
export async function recordRuntime(root: string, child: ChildProcess, current: () => boolean): Promise<void> {
  if (!child.pid) return;
  const startTime = await processStartTime(child.pid);
  if (!startTime || !current()) return;
  const record: RuntimeRecord = { pid: child.pid, startTime, gatewayPid: process.pid };
  try {
    writeFileSync(join(root, RUNTIME_RECORD), JSON.stringify(record));
  } catch {
    // Best effort: without a record a stale runtime is not reaped, nothing else changes.
  }
}

export function clearRuntimeRecord(root: string, pid: number | undefined): void {
  const file = join(root, RUNTIME_RECORD);
  try {
    if ((JSON.parse(readFileSync(file, "utf8")) as Partial<RuntimeRecord>).pid === pid) rmSync(file, { force: true });
  } catch {
    // No record.
  }
}

/**
 * Stops the shared runtime a previous gateway on this data directory left running. On Windows, non-detached
 * children share a kill-on-close job with the gateway, but a gateway launched where that job cannot apply, or a
 * POSIX gateway killed with SIGKILL, leaves its runtime behind. Only the exact recorded process (pid and start time)
 * is stopped, and never while the gateway that recorded it is still running.
 */
export async function reapStaleRuntime(root: string, log: Logger): Promise<void> {
  const file = join(root, RUNTIME_RECORD);
  let record: Partial<RuntimeRecord>;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as Partial<RuntimeRecord>;
  } catch {
    return;
  }
  const { pid, startTime, gatewayPid } = record;
  if (typeof pid !== "number" || typeof startTime !== "string" || pid === process.pid) {
    rmSync(file, { force: true });
    return;
  }
  if (typeof gatewayPid === "number" && gatewayPid !== process.pid && isRunning(gatewayPid)) {
    log.warn("Another gateway may be using this data directory; leaving its shared runtime alone", { pid, gatewayPid });
    return;
  }
  // The record goes only once the recorded runtime is known gone, so a gateway that dies mid-reap leaves it for the next.
  if (!isRunning(pid) || (await processStartTime(pid)) !== startTime) {
    rmSync(file, { force: true });
    return;
  }
  log.warn("Stopping the shared runtime a previous gateway left running", { pid });
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  for (let waited = 0; waited < 5000 && isRunning(pid); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  // Escalate only against the same process: the pid may have been reused while waiting.
  if (isRunning(pid) && (await processStartTime(pid)) === startTime) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (!isRunning(pid) || (await processStartTime(pid)) !== startTime) rmSync(file, { force: true });
}

function openTcp(host: string, port: number): Promise<MessageTransport> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port }, () => {
      socket.off("error", reject);
      socket.setNoDelay(true);
      resolve(streamTransport(socket));
    });
    socket.once("error", reject);
  });
}
