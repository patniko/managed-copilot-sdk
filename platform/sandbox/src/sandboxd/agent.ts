import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { posix } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FileEntry, SandboxdStatus, SandboxOutputsManifest, SandboxSetupRecord, SandboxStartEvent, SandboxStartRequest } from "@managed-copilot/protocol";
import { LIMITS, PATHS, SANDBOX_GID, SANDBOX_RUNTIME_PORT, SANDBOX_UID } from "../shared/constants.js";
import type { Log } from "../shared/log.js";
import { PathError, type PathErrorCode } from "../shared/paths.js";
import { AgentError } from "./errors.js";
import { asWorkload, redact, type Identity } from "./exec.js";
import { ExecManager } from "./execs.js";
import { runtimeEnvironment, secretValues, workloadEnvironment, type EnvironmentInput } from "./env.js";
import { RuntimeSupervisor } from "./runtime.js";
import { emptyRecord, runSetup } from "./setup.js";
import { applyTrust } from "./trust.js";

export interface AgentConfig {
  readonly sandboxId: string;
  readonly version: string;
  readonly runtimeToken: string;
  readonly runtimeBinary: string;
  readonly stateDir: string;
}

export { AgentError } from "./errors.js";


const WORKER = fileURLToPath(new URL("./fsworker.js", import.meta.url));
const IDENTITY: Identity = { uid: SANDBOX_UID, gid: SANDBOX_GID };

/** The sandbox's platform agent: trust, one-time setup, the runtime, and workspace writes as the workload identity. */
export class SandboxAgent {
  readonly #config: AgentConfig;
  readonly #log: Log;
  readonly runtime: RuntimeSupervisor;
  #state: SandboxdStatus["state"] = "booting";
  #setup: SandboxSetupRecord | undefined;
  #error: string | undefined;
  #starting = false;
  #secrets: string[] = [];
  #envKey: string | undefined;
  #persisting: Promise<void> = Promise.resolve();
  /** What commands run with (`execs`), set by each start; undefined until the first start. */
  #workloadEnv: Record<string, string> | undefined;
  /** False for a workspace-only sandbox: the runtime is never started. */
  #runtimeWanted = true;
  /** Commands run directly in the workspace (`SANDBOXD_ROUTES.exec`). */
  readonly execs: ExecManager;

  constructor(config: AgentConfig, log: Log) {
    this.#config = config;
    this.#log = log;
    this.runtime = new RuntimeSupervisor({
      binary: config.runtimeBinary,
      port: SANDBOX_RUNTIME_PORT,
      identity: IDENTITY,
      cwd: PATHS.workspace,
      log,
      secrets: () => this.#secrets,
    });
    this.execs = new ExecManager({
      dir: posix.join(config.stateDir, "exec"),
      log,
      launch: (command, env) => asWorkload(IDENTITY, PATHS.workspace, "/bin/bash", ["-c", command], env),
      env: () => (this.#state === "ready" ? this.#workloadEnv : undefined),
    });
  }

  get #setupFile(): string {
    return posix.join(this.#config.stateDir, "setup.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(this.#config.stateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#config.stateDir, 0o700);
    try {
      this.#setup = JSON.parse(await fs.readFile(this.#setupFile, "utf8")) as SandboxSetupRecord;
    } catch {
      this.#setup = undefined;
    }
    // A setup that was running when the sandbox stopped can never be resumed or replayed.
    if (this.#setup?.state === "running") {
      this.#setup = { ...this.#setup, state: "failed", error: this.#setup.error ?? "Setup was interrupted before it finished." };
      await this.#persist(this.#setup);
    }
    await this.execs.load();
  }

  /**
   * Writes the setup record atomically. Writes are queued so they land in call order: progress updates are not
   * awaited, and an older "running" record must never replace the final one (a resume would then refuse to start).
   */
  #persist(record: SandboxSetupRecord): Promise<void> {
    const write = async (): Promise<void> => {
      const temp = `${this.#setupFile}.${randomBytes(4).toString("hex")}`;
      await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temp, this.#setupFile);
    };
    const next = this.#persisting.then(write, write);
    this.#persisting = next.catch(() => undefined);
    return next;
  }

  status(): SandboxdStatus {
    return {
      sandboxId: this.#config.sandboxId,
      version: this.#config.version,
      state: this.#state,
      runtime: {
        state: this.runtime.state,
        restarts: this.runtime.restarts,
        ...(this.runtime.exitCode !== undefined ? { exitCode: this.runtime.exitCode } : {}),
        ...(this.runtime.instance ? { instance: this.runtime.instance } : {}),
      },
      ...(this.#setup ? { setup: this.#setup } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /**
   * Replaces the runtime process with a fresh one (`SANDBOXD_ROUTES.runtimeRestart`). The gateway asks for it when a
   * previous connection still holds the stock runtime's inference-provider registration. Only once the sandbox is ready.
   */
  async restartRuntime(): Promise<void> {
    if (this.#starting || this.#state !== "ready") {
      throw new AgentError("conflict", `The sandbox is ${this.#starting ? "starting" : this.#state}; its runtime can only be restarted once it is ready.`);
    }
    if (!this.#runtimeWanted) throw new AgentError("conflict", "This is a workspace-only sandbox; it has no Copilot runtime.");
    const previous = this.runtime.instance;
    try {
      await this.runtime.restart();
    } catch (error) {
      throw new AgentError("internal", `The Copilot runtime could not be restarted: ${redact((error as Error).message ?? String(error), this.#secrets)}`);
    }
    this.#log.info("Copilot runtime restarted on request", { previous, instance: this.runtime.instance });
  }

  /**
   * Applies trust, runs initial setup once (`create`), and starts the runtime. Emits progress events. A `resume`
   * never replays setup and requires a succeeded record; a changed environment (e.g. rotated proxy credentials)
   * restarts the runtime.
   */
  async start(request: SandboxStartRequest, emit: (event: SandboxStartEvent) => void): Promise<void> {
    if (this.#starting) throw new AgentError("conflict", "A start is already in progress.");
    this.#starting = true;
    this.#state = "starting";
    this.#error = undefined;
    try {
      const caInstalled = await applyTrust(request.caCertificate);
      const input: EnvironmentInput = { platformEnv: request.platformEnv ?? {}, workloadEnv: request.workloadEnv ?? {}, caInstalled };
      this.#secrets = secretValues(input, [this.#config.runtimeToken]);
      await this.#ensureWorkspace();

      if (request.mode === "create" && this.#setup === undefined) {
        const record = await runSetup(request.setup ?? {}, {
          env: workloadEnvironment(input),
          secrets: this.#secrets,
          identity: IDENTITY,
          writeFile: async (path, content) => {
            const entry = await this.writeFile(path, content, { overwrite: true });
            return { size: entry.size, sha256: entry.sha256 };
          },
          onProgress: (progress) => {
            this.#setup = progress;
            void this.#persist(progress).catch(() => undefined);
            emit({ type: "progress", setup: progress });
          },
        });
        this.#setup = record;
        await this.#persist(record);
        if (record.state !== "succeeded") {
          this.#state = "failed";
          this.#error = record.error ?? "Setup failed.";
          emit({ type: "failed", code: "setup_failed", message: this.#error, setup: record });
          return;
        }
      } else if (this.#setup?.state !== "succeeded") {
        const reason = this.#setup ? `initial setup is ${this.#setup.state}${this.#setup.error ? `: ${this.#setup.error}` : ""}` : "no setup record exists";
        this.#state = "failed";
        this.#error = `This sandbox cannot be resumed because ${reason}. Setup is never replayed automatically.`;
        emit({ type: "failed", code: request.mode === "create" ? "setup_failed" : "state_restore_failed", message: this.#error, ...(this.#setup ? { setup: this.#setup } : {}) });
        return;
      }

      this.#workloadEnv = workloadEnvironment(input);
      this.#runtimeWanted = request.runtime !== false;
      if (!this.#runtimeWanted) {
        if (this.runtime.state !== "stopped") await this.runtime.stop();
        this.#state = "ready";
        emit({ type: "ready", setup: this.#setup ?? emptyRecord(), runtimePort: 0 });
        return;
      }
      const env = runtimeEnvironment(input, this.#config.runtimeToken);
      const envKey = JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)));
      if (this.runtime.state === "running" && this.#envKey !== envKey) await this.runtime.stop();
      this.#envKey = envKey;
      emit({ type: "runtime", state: "starting" });
      await this.runtime.start(env);
      this.#state = "ready";
      emit({ type: "runtime", state: "running" });
      emit({ type: "ready", setup: this.#setup ?? emptyRecord(), runtimePort: SANDBOX_RUNTIME_PORT });
    } catch (error) {
      this.#state = "failed";
      this.#error = redact((error as Error).message ?? String(error), this.#secrets);
      this.#log.error("Sandbox start failed", { error: this.#error });
      emit({ type: "failed", code: "internal", message: this.#error });
    } finally {
      this.#starting = false;
    }
  }

  async #ensureWorkspace(): Promise<void> {
    await fs.mkdir(PATHS.runtimeHome, { recursive: true, mode: 0o700 });
    // lchown: never follow a link the workload may have planted.
    await fs.lchown(PATHS.runtimeHome, SANDBOX_UID, SANDBOX_GID);
    await this.mkdir("outputs");
  }

  async mkdir(relative: string): Promise<FileEntry> {
    const result = await this.#worker(["mkdir", "workspace", relative]);
    return JSON.parse(result) as FileEntry;
  }

  /** Writes a workspace file atomically as the workload identity. */
  async writeFile(relative: string, body: Buffer | Readable, options: { overwrite: boolean; expectedBytes?: number; signal?: AbortSignal }): Promise<FileEntry & { sha256: string }> {
    const args = ["write", "workspace", relative, options.overwrite ? "1" : "0", String(LIMITS.uploadBytes), options.expectedBytes === undefined ? "-" : String(options.expectedBytes)];
    return JSON.parse(await this.#worker(args, body, options.signal)) as FileEntry & { sha256: string };
  }

  /** Lists workspace entries as the workload identity. */
  async list(relative: string, recursive: boolean): Promise<FileEntry[]> {
    return JSON.parse(await this.#worker(["list", "workspace", relative, recursive ? "1" : "0", String(LIMITS.listEntries)])) as FileEntry[];
  }

  /** Writes one file of a runtime-state import into its staging directory under COPILOT_HOME (promotion). */
  async writeImport(staging: string, relative: string, body: Readable, options: { expectedBytes?: number; signal?: AbortSignal }): Promise<FileEntry & { sha256: string }> {
    const args = ["write", "runtime-import", `${staging}/${relative}`, "1", String(LIMITS.uploadBytes), options.expectedBytes === undefined ? "-" : String(options.expectedBytes)];
    return JSON.parse(await this.#worker(args, body, options.signal)) as FileEntry & { sha256: string };
  }

  /** Replaces `session-state/<sessionId>` with a staged import. */
  async commitImport(staging: string, sessionId: string): Promise<void> {
    await this.#worker(["import-commit", "runtime-import", staging, sessionId]);
  }

  async abortImport(staging: string): Promise<void> {
    await this.#worker(["import-abort", "runtime-import", staging]);
  }

  /** Hashes the publishable files under /workspace/outputs as the workload identity. */
  async outputsManifest(): Promise<SandboxOutputsManifest> {
    const { count, fileBytes, totalBytes } = LIMITS.artifacts;
    return JSON.parse(await this.#worker(["manifest", "outputs", String(count), String(fileBytes), String(totalBytes)])) as SandboxOutputsManifest;
  }

  /** Streams a regular file (workspace- or outputs-relative) read by the workload identity. */
  openRead(scope: "workspace" | "outputs", relative: string, signal?: AbortSignal): Promise<{ size: number; modifiedAt: string; body: Readable }> {
    return new Promise((resolve, reject) => {
      const child = this.#spawnWorker(["read", scope, relative]);
      const body = new PassThrough();
      const stderr: Buffer[] = [];
      let header: Buffer | undefined = Buffer.alloc(0);
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end();
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdout.on("data", (chunk: Buffer) => {
        if (header === undefined) {
          if (!body.write(chunk)) {
            child.stdout.pause();
            body.once("drain", () => child.stdout.resume());
          }
          return;
        }
        header = Buffer.concat([header, chunk]);
        const newline = header.indexOf(0x0a);
        if (newline < 0) return;
        const meta = JSON.parse(header.subarray(0, newline).toString("utf8")) as { size: number; modifiedAt: string };
        const rest = header.subarray(newline + 1);
        header = undefined;
        if (rest.length > 0) body.write(rest);
        resolve({ size: meta.size, modifiedAt: meta.modifiedAt, body });
      });
      body.on("close", () => {
        if (child.exitCode === null) child.kill("SIGTERM");
      });
      child.on("error", (error) => reject(new AgentError("internal", `Workspace worker failed: ${error.message}`)));
      child.on("close", (code) => {
        signal?.removeEventListener("abort", abort);
        if (code === 0 && header === undefined) {
          body.end();
          return;
        }
        const error = this.#workerError(code, stderr);
        if (header !== undefined) reject(error);
        else body.destroy(error);
      });
    });
  }

  #spawnWorker(args: readonly string[]) {
    // The worker enters /workspace itself, after dropping to the workload identity.
    const target = asWorkload(IDENTITY, "/", process.execPath, [WORKER, ...args], { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: PATHS.home });
    return spawn(target.command, target.args, {
      cwd: target.cwd,
      env: target.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  #workerError(code: number | null, stderr: readonly Buffer[]): Error {
    try {
      const failure = JSON.parse(Buffer.concat(stderr).toString("utf8").trim()) as { code: PathErrorCode | "internal"; message: string };
      return failure.code === "internal" ? new AgentError("internal", failure.message) : new PathError(failure.code, failure.message);
    } catch {
      return new AgentError("internal", `Workspace worker exited with code ${code}.`);
    }
  }

  #worker(args: readonly string[], input?: Buffer | Readable, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.#spawnWorker(args);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => undefined);
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      if (input === undefined) child.stdin.end();
      else if (Buffer.isBuffer(input)) child.stdin.end(input);
      else {
        input.on("error", abort);
        input.pipe(child.stdin);
      }
      child.on("error", (error) => reject(new AgentError("internal", `Workspace worker failed: ${error.message}`)));
      child.on("close", (code) => {
        signal?.removeEventListener("abort", abort);
        if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
        if (signal?.aborted) return reject(new AgentError("invalid_request", "The upload was cancelled."));
        reject(this.#workerError(code, stderr));
      });
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.execs.shutdown(), this.runtime.stop()]);
  }
}
