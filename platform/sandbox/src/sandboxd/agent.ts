import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FileEntry, SandboxdStatus, SandboxSetupRecord, SandboxStartEvent, SandboxStartRequest } from "@managed-copilot/protocol";
import { LIMITS, PATHS, SANDBOX_GID, SANDBOX_RUNTIME_PORT, SANDBOX_UID } from "../shared/constants.js";
import type { Log } from "../shared/log.js";
import { PathError, type PathErrorCode } from "../shared/paths.js";
import { redact, type Identity } from "./exec.js";
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

export class AgentError extends Error {
  readonly code: PathErrorCode | "internal" | "unavailable";
  constructor(code: PathErrorCode | "internal" | "unavailable", message: string) {
    super(message);
    this.code = code;
  }
}

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
  }

  async #persist(record: SandboxSetupRecord): Promise<void> {
    const temp = `${this.#setupFile}.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, this.#setupFile);
  }

  status(): SandboxdStatus {
    return {
      sandboxId: this.#config.sandboxId,
      version: this.#config.version,
      state: this.#state,
      runtime: { state: this.runtime.state, restarts: this.runtime.restarts, ...(this.runtime.exitCode !== undefined ? { exitCode: this.runtime.exitCode } : {}) },
      ...(this.#setup ? { setup: this.#setup } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
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
    await fs.chown(PATHS.runtimeHome, SANDBOX_UID, SANDBOX_GID);
    await this.mkdir("outputs");
  }

  async mkdir(relative: string): Promise<FileEntry> {
    const result = await this.#worker(["mkdir", relative]);
    return JSON.parse(result) as FileEntry;
  }

  /** Writes a workspace file atomically as the workload identity. */
  async writeFile(relative: string, body: Buffer | Readable, options: { overwrite: boolean; expectedBytes?: number; signal?: AbortSignal }): Promise<FileEntry & { sha256: string }> {
    const args = ["write", relative, options.overwrite ? "1" : "0", String(LIMITS.uploadBytes), options.expectedBytes === undefined ? "-" : String(options.expectedBytes)];
    return JSON.parse(await this.#worker(args, body, options.signal)) as FileEntry & { sha256: string };
  }

  #worker(args: readonly string[], input?: Buffer | Readable, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER, ...args], {
        cwd: PATHS.workspace,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: PATHS.home },
        uid: IDENTITY.uid,
        gid: IDENTITY.gid,
        stdio: ["pipe", "pipe", "pipe"],
      });
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
        try {
          const failure = JSON.parse(Buffer.concat(stderr).toString("utf8").trim()) as { code: PathErrorCode | "internal"; message: string };
          reject(failure.code === "internal" ? new AgentError("internal", failure.message) : new PathError(failure.code, failure.message));
        } catch {
          reject(new AgentError("internal", `Workspace worker exited with code ${code}.`));
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.runtime.stop();
  }
}
