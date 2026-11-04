import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

export interface Identity {
  readonly uid: number;
  readonly gid: number;
}

const SETPRIV = "/usr/bin/setpriv";
const ENV = "/usr/bin/env";
/** The only environment a launch has while it still runs as root: nothing the workload controls. */
const LAUNCH_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface WorkloadLaunch {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  /** The environment to spawn with: the trusted launch environment, never the workload's. */
  readonly env: Record<string, string>;
}

/**
 * Spawn arguments that run `command` as the workload identity with no way back to privilege, independent of what the
 * backend's container runtime enforces. `setpriv` starts as root with only a fixed PATH (glibc honors variables such
 * as LD_AUDIT or GLIBC_TUNABLES for a root process that is not setuid, so the workload's environment must never reach
 * it). It switches uid/gid, clears supplementary groups, sets no_new_privs, and empties the inheritable, ambient, and
 * bounding capability sets (the bounding drop is a no-op where sandboxd lacks CAP_SETPCAP, as under Docker's minimal
 * set). Only then does `env -i -C <cwd>` install the workload's environment, enter `cwd` (after the drop, because
 * sandboxd's root holds no DAC capabilities), and exec the command, so the pid and signals are the command's own.
 */
export function asWorkload(identity: Identity, cwd: string, command: string, args: readonly string[], env: Readonly<Record<string, string>>): WorkloadLaunch {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name "${name}".`);
    if (value.includes("\u0000")) throw new Error(`The value of environment variable "${name}" contains a NUL character.`);
    return `${name}=${value}`;
  });
  return {
    command: SETPRIV,
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--",
      ENV,
      "-i",
      "-C",
      cwd,
      "--",
      ...assignments,
      command,
      ...args,
    ],
    cwd: "/",
    env: { ...LAUNCH_ENV },
  };
}

/** Replaces secret values, URL userinfo, and signed-URL credentials (SAS `sig`, S3/GCS signatures, tokens) in diagnostic text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|token|access_token|api[-_]?key|code)=)[^&\s'")]+/gi, "$1[redacted]");
}

/** Keeps the last `limit` bytes of combined output. */
export class OutputTail {
  #chunks: Buffer[] = [];
  #size = 0;
  readonly #limit: number;
  constructor(limit = 16 * 1024) {
    this.#limit = limit;
  }
  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift()!.length;
    }
  }
  toString(): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return text.length > this.#limit ? text.slice(-this.#limit) : text;
  }
}

export interface RunOptions {
  readonly identity?: Identity;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly input?: Buffer | Readable;
  readonly outputLimit?: number;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly output: string;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a command (no shell) in its own process group, optionally as another identity, capturing the stdout and a
 * bounded tail of combined output. On timeout the whole group is killed.
 */
export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Without an identity the command runs as root and must be given a trusted environment by the caller.
    const target = options.identity ? asWorkload(options.identity, options.cwd, command, args, options.env) : { command, args: [...args], cwd: options.cwd, env: { ...options.env } };
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: target.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const tail = new OutputTail(options.outputLimit);
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      tail.push(chunk);
      if (stdoutSize < 4 * 1024 * 1024) {
        stdout.push(chunk);
        stdoutSize += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stdin.on("error", () => undefined);
    if (options.input instanceof Readable) options.input.pipe(child.stdin);
    else child.stdin.end(options.input ?? undefined);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child, "SIGTERM");
          setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), output: tail.toString() });
    });
  });
}
