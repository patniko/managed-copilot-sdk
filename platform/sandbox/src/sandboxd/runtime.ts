import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import type { SandboxdRuntimeState } from "@managed-copilot/protocol";
import type { Log } from "../shared/log.js";
import type { Identity } from "./exec.js";

export interface RuntimeOptions {
  readonly binary: string;
  readonly port: number;
  readonly identity: Identity;
  readonly cwd: string;
  readonly log: Log;
  /** Values that must not appear in forwarded runtime output. */
  readonly secrets: () => readonly string[];
}

const READY_TIMEOUT_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 5 * 60_000;

/**
 * Supervises the stock headless runtime (`copilot-runtime --headless --port`) as the workload identity on loopback.
 * Restarts it after an unexpected exit (bounded), and stops it gracefully on shutdown.
 */
export class RuntimeSupervisor {
  readonly #options: RuntimeOptions;
  #child: ChildProcess | undefined;
  #env: Record<string, string> | undefined;
  #state: SandboxdRuntimeState = "stopped";
  #restarts = 0;
  #restartTimes: number[] = [];
  #exitCode: number | undefined;
  #stopping = false;
  #ready: Promise<void> | undefined;
  readonly #onExit = new Set<() => void>();

  constructor(options: RuntimeOptions) {
    this.#options = options;
  }

  get state(): SandboxdRuntimeState {
    return this.#state;
  }

  get restarts(): number {
    return this.#restarts;
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /** Called whenever the runtime process exits (so bridged connections can be closed). */
  onExit(listener: () => void): () => void {
    this.#onExit.add(listener);
    return () => this.#onExit.delete(listener);
  }

  /** Starts the runtime with `env` (idempotent while running) and resolves once it accepts connections. */
  start(env: Record<string, string>): Promise<void> {
    this.#env = env;
    this.#stopping = false;
    if (this.#state === "running" && this.#child) return Promise.resolve();
    if (this.#ready && this.#state === "starting") return this.#ready;
    this.#ready = this.#spawn();
    return this.#ready;
  }

  #spawn(): Promise<void> {
    const { binary, port, identity, cwd, log } = this.#options;
    const env = this.#env ?? {};
    this.#state = "starting";
    this.#exitCode = undefined;
    const child = spawn(binary, ["--headless", "--no-auto-update", "--no-auto-login", "--port", String(port)], {
      cwd,
      env,
      uid: identity.uid,
      gid: identity.gid,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      let text = chunk.toString("utf8");
      for (const secret of this.#options.secrets()) if (secret.length >= 6) text = text.split(secret).join("[redacted]");
      for (const line of text.split("\n")) if (line.trim()) log.debug("runtime output", { stream, line: line.slice(0, 2000) });
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));

    const ready = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.once("exit", (code, signal) => settle(new Error(`The Copilot runtime exited during startup (${code ?? signal}).`)));
      child.once("error", (error) => settle(new Error(`The Copilot runtime could not start: ${error.message}`)));
      const probe = () => {
        if (settled) return;
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          settle();
        });
        socket.once("error", () => {
          socket.destroy();
          if (Date.now() > deadline) settle(new Error(`The Copilot runtime did not listen on port ${port} within ${READY_TIMEOUT_MS / 1000} seconds.`));
          else setTimeout(probe, 150);
        });
      };
      setTimeout(probe, 100);
    });

    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#exitCode = code ?? undefined;
      for (const listener of this.#onExit) listener();
      if (this.#stopping) {
        this.#state = "stopped";
        return;
      }
      this.#state = "exited";
      log.warn("Copilot runtime exited", { code, signal });
      const now = Date.now();
      this.#restartTimes = this.#restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
      if (this.#restartTimes.length >= MAX_RESTARTS) {
        log.error("Copilot runtime keeps exiting; not restarting", { restarts: this.#restarts });
        return;
      }
      this.#restartTimes.push(now);
      this.#restarts++;
      setTimeout(() => {
        if (this.#stopping || this.#child) return;
        this.#ready = this.#spawn().catch((error: Error) => {
          log.error("Copilot runtime restart failed", { error: error.message });
        });
      }, 1000);
    });

    return ready.then(
      () => {
        if (this.#child === child) this.#state = "running";
        log.info("Copilot runtime is running", { port, pid: child.pid });
      },
      (error: Error) => {
        if (this.#child === child) {
          this.#stopping = true;
          child.kill("SIGKILL");
        }
        this.#state = "exited";
        throw error;
      },
    );
  }

  /** Stops the runtime: SIGTERM, then SIGKILL after `graceMs`. */
  async stop(graceMs = 10_000): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) {
      this.#state = "stopped";
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.#state = "stopped";
  }
}
