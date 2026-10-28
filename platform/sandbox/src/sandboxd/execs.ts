// Commands run directly in the sandbox (`managed.exec`, an orchestrator's hands tools): `bash -c` as the workload
// identity in /workspace, each in its own process group, journaled by ID so a caller can reattach after a gateway
// restart, read new output from an offset, write to stdin, or stop it. The journal lives in sandboxd's root-only
// state directory and survives sandbox stops; a command that was running when sandboxd stopped reads as `stopped`.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { posix } from "node:path";
import type { SandboxExecRead, SandboxExecRecord, SandboxExecRequest } from "@managed-copilot/protocol";
import { LIMITS } from "../shared/constants.js";
import type { Log } from "../shared/log.js";
import { AgentError } from "./errors.js";
import type { WorkloadLaunch } from "./exec.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a command that exited may keep its output pipes open (a child it left behind) before it counts as ended. */
const CLOSE_GRACE_MS = 250;
/** How long a stopped command's group gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** How often a running command's journal entry is saved while its output changes. */
const PERSIST_MS = 2_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

export const STOPPED_BY_RESTART = "The sandbox restarted while this command was running, so it was stopped.";
export const STOPPED_BY_SHUTDOWN = "The sandbox stopped while this command was running.";

export interface ExecLimits {
  readonly outputBytes: number;
  readonly readBytes: number;
  readonly running: number;
  readonly retained: number;
  readonly commandBytes: number;
  readonly inputBytes: number;
  readonly maxWaitMs: number;
}

export interface ExecManagerOptions {
  /** Root-only directory for the journal. */
  readonly dir: string;
  readonly log: Log;
  /** How a command is launched: `bash -c <command>` as the workload identity in /workspace, with `env`. */
  readonly launch: (command: string, env: Record<string, string>) => WorkloadLaunch;
  /** The workload environment, or undefined while the sandbox is not ready to run commands. */
  readonly env: () => Record<string, string> | undefined;
  readonly limits?: Partial<ExecLimits>;
  /** Default true: each command leads its own process group (tests on Windows turn it off). */
  readonly processGroups?: boolean;
}

interface Entry {
  record: SandboxExecRecord;
  /** The newest output bytes, oldest first; `kept` bytes in total, starting at offset `record.outputBytes - kept`. */
  chunks: Buffer[];
  kept: number;
  child?: ChildProcess;
  stdinOpen: boolean;
  stopReason?: string;
  timedOut?: boolean;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  dirty: boolean;
  /** Saves run one at a time, so an older snapshot never replaces a newer one. */
  persisting: Promise<void>;
  waiters: Set<() => void>;
  finished: Promise<void>;
  finish: () => void;
}

interface Persisted {
  readonly record: SandboxExecRecord;
  /** Base64 of the kept output tail. */
  readonly tail: string;
}

function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (child?.pid === undefined) return;
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

/** The length of `buffer` without a UTF-8 sequence cut off at its end. */
export function utf8Complete(buffer: Buffer): number {
  const end = buffer.length;
  for (let back = 1; back <= Math.min(3, end); back++) {
    const byte = buffer[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? end - back : end;
  }
  return end;
}

/** Continuation bytes at the start of `buffer` (the tail of a character whose start was dropped). */
function leadingContinuation(buffer: Buffer): number {
  let index = 0;
  while (index < Math.min(3, buffer.length) && (buffer[index]! & 0xc0) === 0x80) index++;
  return index;
}

export class ExecManager {
  readonly #options: ExecManagerOptions;
  readonly #limits: ExecLimits;
  readonly #entries = new Map<string, Entry>();
  #closed = false;

  constructor(options: ExecManagerOptions) {
    this.#options = options;
    this.#limits = { ...LIMITS.exec, ...options.limits };
  }

  #file(id: string): string {
    return posix.join(this.#options.dir, `${id}.json`);
  }

  /** Loads the journal. Commands it recorded as running were cut off by a stop or a crash of the sandbox. */
  async load(): Promise<void> {
    await fs.mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
    let names: string[] = [];
    try {
      names = await fs.readdir(this.#options.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const stored = JSON.parse(await fs.readFile(posix.join(this.#options.dir, name), "utf8")) as Persisted;
        if (!ID.test(stored.record.id)) continue;
        const tail = Buffer.from(stored.tail ?? "", "base64");
        const entry = this.#entry({ ...stored.record }, tail.length > 0 ? [tail] : []);
        if (entry.record.state === "running") {
          entry.record = { ...entry.record, state: "stopped", reason: STOPPED_BY_RESTART, finishedAt: entry.record.finishedAt ?? new Date().toISOString() };
          entry.dirty = true;
          await this.#persist(entry);
        }
        entry.finish();
        this.#entries.set(entry.record.id, entry);
      } catch (error) {
        this.#options.log.warn("Skipped an unreadable command journal entry", { file: name, error: (error as Error).message });
      }
    }
  }

  #entry(record: SandboxExecRecord, chunks: Buffer[]): Entry {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    return { record, chunks, kept: chunks.reduce((sum, chunk) => sum + chunk.length, 0), stdinOpen: false, dirty: false, persisting: Promise.resolve(), waiters: new Set(), finished, finish };
  }

  list(): SandboxExecRecord[] {
    return [...this.#entries.values()].map((entry) => entry.record).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): SandboxExecRecord {
    return this.#get(id).record;
  }

  #get(id: string): Entry {
    const entry = ID.test(id) ? this.#entries.get(id) : undefined;
    if (!entry) throw new AgentError("not_found", `This sandbox has no command ${id}.`);
    return entry;
  }

  /** Running commands (their latest output keeps an idle sandbox from stopping). */
  running(): SandboxExecRecord[] {
    return this.list().filter((record) => record.state === "running");
  }

  /** Starts a command; a start with an ID the journal has answers with that command and starts nothing. */
  async start(request: SandboxExecRequest): Promise<SandboxExecRecord> {
    if (this.#closed) throw new AgentError("unavailable", "The sandbox is stopping.");
    if (typeof request?.id !== "string" || !ID.test(request.id)) throw new AgentError("invalid_request", "id must be 1 to 64 letters, digits, hyphens, or underscores.");
    const existing = this.#entries.get(request.id);
    if (existing) return existing.record;
    if (typeof request.command !== "string" || request.command.trim() === "") throw new AgentError("invalid_request", "command must be a non-empty string.");
    if (Buffer.byteLength(request.command, "utf8") > this.#limits.commandBytes) throw new AgentError("invalid_request", `Commands are limited to ${this.#limits.commandBytes} bytes; write a script with the files API and run it.`);
    if (request.command.includes("\u0000")) throw new AgentError("invalid_request", "command must not contain NUL characters.");
    const timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) throw new AgentError("invalid_request", "timeoutMs must be a positive whole number of milliseconds (at most 7 days).");
    const stdin = request.stdin ?? "closed";
    if (stdin !== "open" && stdin !== "closed") throw new AgentError("invalid_request", 'stdin must be "open" or "closed".');
    const env = this.#options.env();
    if (!env) throw new AgentError("unavailable", "The sandbox is not ready to run commands.");
    if (this.running().length >= this.#limits.running) throw new AgentError("conflict", `This sandbox already runs ${this.#limits.running} commands; wait for one to finish or stop one.`);

    const entry = this.#entry(
      { id: request.id, command: request.command, state: "running", stdin, ...(timeoutMs !== undefined ? { timeoutMs } : {}), startedAt: new Date().toISOString(), outputBytes: 0 },
      [],
    );
    this.#entries.set(entry.record.id, entry);
    // Journaled before it runs: a crash from here on leaves a record that reads as stopped, never a silent rerun. A
    // command that could not be journaled does not run.
    entry.dirty = true;
    try {
      await this.#persist(entry, true);
    } catch (error) {
      this.#entries.delete(entry.record.id);
      await fs.rm(this.#file(entry.record.id), { force: true }).catch(() => undefined);
      throw new AgentError("internal", `The command could not be journaled, so it was not started: ${(error as Error).message}`);
    }
    this.#spawn(entry, env);
    await this.#prune();
    return entry.record;
  }

  #spawn(entry: Entry, env: Record<string, string>): void {
    const launch = this.#options.launch(entry.record.command, env);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: this.#options.processGroups !== false });
    } catch (error) {
      this.#end(entry, { state: "failed", reason: `The command could not be started: ${(error as Error).message}` });
      return;
    }
    entry.child = child;
    entry.stdinOpen = entry.record.stdin === "open";
    child.stdin?.on("error", () => undefined);
    if (!entry.stdinOpen) child.stdin?.end();
    const onData = (chunk: Buffer) => this.#output(entry, chunk);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    if (entry.record.timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        entry.timedOut = true;
        entry.stopReason = `The command ran longer than its ${Math.round(entry.record.timeoutMs! / 1000)} s timeout, so it was stopped.`;
        this.#kill(entry);
      }, entry.record.timeoutMs);
    }
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let ended = false;
    const end = () => {
      if (ended || !exited) return;
      ended = true;
      const { code, signal } = exited;
      if (entry.stopReason !== undefined) {
        this.#end(entry, { state: entry.timedOut ? "timed_out" : "stopped", reason: entry.stopReason, ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) });
      } else {
        this.#end(entry, { state: "completed", ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) });
      }
    };
    child.once("error", (error) => {
      if (exited) return;
      exited = { code: null, signal: null };
      ended = true;
      this.#end(entry, { state: "failed", reason: `The command could not be started: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      // Output written just before exit is still in the pipes; a child left behind may keep them open, so wait briefly.
      setTimeout(end, CLOSE_GRACE_MS).unref();
    });
    child.once("close", () => setImmediate(end));
  }

  #output(entry: Entry, chunk: Buffer): void {
    entry.chunks.push(chunk);
    entry.kept += chunk.length;
    const limit = this.#limits.outputBytes;
    while (entry.kept > limit) {
      const first = entry.chunks[0]!;
      const excess = entry.kept - limit;
      if (first.length <= excess) {
        entry.chunks.shift();
        entry.kept -= first.length;
      } else {
        entry.chunks[0] = first.subarray(excess);
        entry.kept -= excess;
      }
    }
    entry.record = { ...entry.record, outputBytes: entry.record.outputBytes + chunk.length, lastOutputAt: new Date().toISOString() };
    entry.dirty = true;
    this.#schedulePersist(entry);
    this.#wake(entry);
  }

  #end(entry: Entry, outcome: Pick<SandboxExecRecord, "state"> & Partial<Pick<SandboxExecRecord, "exitCode" | "signal" | "reason">>): void {
    if (entry.record.state !== "running") return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.timer = entry.killTimer = entry.persistTimer = undefined;
    // A timed-out or stopped command's children go with it.
    if (outcome.state === "stopped" || outcome.state === "timed_out") killGroup(entry.child, "SIGKILL");
    entry.child?.stdout?.removeAllListeners("data");
    entry.child?.stderr?.removeAllListeners("data");
    entry.child?.stdout?.destroy();
    entry.child?.stderr?.destroy();
    entry.child?.stdin?.destroy();
    entry.child = undefined;
    entry.stdinOpen = false;
    entry.record = { ...entry.record, ...outcome, finishedAt: new Date().toISOString() };
    entry.dirty = true;
    void this.#persist(entry).finally(() => {
      entry.finish();
      this.#wake(entry);
    });
  }

  #kill(entry: Entry): void {
    killGroup(entry.child, "SIGTERM");
    if (!entry.killTimer) {
      entry.killTimer = setTimeout(() => killGroup(entry.child, "SIGKILL"), KILL_GRACE_MS);
      entry.killTimer.unref();
    }
  }

  #wake(entry: Entry): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Waits until the entry changes (output or its end), `ms` passes, or `signal` aborts. */
  #changed(entry: Entry, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      entry.waiters.add(done);
      timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Output from `offset`. With `waitMs`, waits that long for output past `offset` that can be delivered whole (a
   * character split across writes waits for its last byte), or for the command's end. An offset past the output's end
   * waits for the end only. Output older than the kept tail is skipped and reported as `skippedBytes`.
   */
  async read(id: string, offset: number, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<SandboxExecRead> {
    const entry = this.#get(id);
    if (!Number.isInteger(offset) || offset < 0) throw new AgentError("invalid_request", "offset must be a non-negative whole number.");
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), this.#limits.maxWaitMs);
    const deadline = Date.now() + waitMs;
    const pastEnd = offset > entry.record.outputBytes;
    for (;;) {
      // An ended command's final record is written before readers see it as ended.
      if (entry.record.state !== "running") {
        await entry.finished;
        return this.#slice(entry, offset);
      }
      const slice = this.#slice(entry, offset);
      const progress = !pastEnd && (slice.output !== "" || slice.offset !== offset || slice.skippedBytes !== undefined);
      if (progress || Date.now() >= deadline || options.signal?.aborted) return slice;
      await this.#changed(entry, deadline - Date.now(), options.signal);
    }
  }

  /** Waits up to `waitMs` for the command to end (no output). */
  async wait(id: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<SandboxExecRecord> {
    const entry = this.#get(id);
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), this.#limits.maxWaitMs);
    const deadline = Date.now() + waitMs;
    while (entry.record.state === "running" && Date.now() < deadline && !options.signal?.aborted) {
      await this.#changed(entry, deadline - Date.now(), options.signal);
    }
    if (entry.record.state !== "running") await entry.finished;
    return entry.record;
  }

  #slice(entry: Entry, requested: number): SandboxExecRead {
    const total = entry.record.outputBytes;
    const first = total - entry.kept;
    let offset = Math.min(requested, total);
    let skipped = 0;
    if (offset < first) {
      skipped = first - offset;
      offset = first;
    }
    const tail = entry.chunks.length === 1 ? entry.chunks[0]! : Buffer.concat(entry.chunks);
    let bytes = tail.subarray(offset - first, Math.min(offset - first + this.#limits.readBytes, tail.length));
    if (skipped > 0) {
      const partial = leadingContinuation(bytes);
      skipped += partial;
      offset += partial;
      bytes = bytes.subarray(partial);
    }
    const more = offset + bytes.length < total;
    // Never split a character between reads, unless the command ended mid-character and this is the end.
    const usable = more || entry.record.state === "running" ? utf8Complete(bytes) : bytes.length;
    const output = bytes.subarray(0, usable).toString("utf8");
    return { exec: entry.record, output, offset: offset + usable, ...(skipped > 0 ? { skippedBytes: skipped } : {}) };
  }

  /** Writes to a running command's stdin; `eof` closes it. */
  async input(id: string, data: string | undefined, eof: boolean): Promise<SandboxExecRecord> {
    const entry = this.#get(id);
    if (data !== undefined && typeof data !== "string") throw new AgentError("invalid_request", "data must be a string.");
    if (data !== undefined && Buffer.byteLength(data, "utf8") > this.#limits.inputBytes) throw new AgentError("invalid_request", `One write is limited to ${this.#limits.inputBytes} bytes.`);
    if (entry.record.state !== "running") throw new AgentError("conflict", `Command ${id} is ${entry.record.state}; it no longer reads input.`);
    if (!entry.stdinOpen || !entry.child?.stdin || entry.child.stdin.destroyed) throw new AgentError("conflict", `Command ${id}'s input is closed${entry.record.stdin === "closed" ? " (it was started with stdin closed)" : ""}.`);
    const stdin = entry.child.stdin;
    if (data) {
      await new Promise<void>((resolve, reject) => stdin.write(data, (error) => (error ? reject(new AgentError("conflict", `Command ${id} stopped reading input.`)) : resolve())));
    }
    if (eof) {
      entry.stdinOpen = false;
      stdin.end();
    }
    return entry.record;
  }

  /** Kills a running command's process group (SIGTERM, then SIGKILL) and resolves once it ended (at most ~10 s). */
  async stop(id: string, reason?: string): Promise<SandboxExecRecord> {
    const entry = this.#get(id);
    if (entry.record.state !== "running") return entry.record;
    entry.stopReason ??= reason?.trim() ? reason.trim().slice(0, 500) : "The command was stopped.";
    this.#kill(entry);
    await Promise.race([entry.finished, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 5_000).unref())]);
    if (entry.record.state === "running") {
      // The group outlived SIGKILL (it should not); record the stop anyway, so no caller waits on it forever.
      this.#end(entry, { state: "stopped", reason: entry.stopReason });
      await entry.finished;
    }
    return entry.record;
  }

  /** Stops every running command (an idle stop, or sandboxd shutting down). */
  async stopAll(reason: string): Promise<SandboxExecRecord[]> {
    const running = [...this.#entries.values()].filter((entry) => entry.record.state === "running");
    return Promise.all(running.map((entry) => this.stop(entry.record.id, reason)));
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.stopAll(STOPPED_BY_SHUTDOWN);
  }

  #schedulePersist(entry: Entry): void {
    if (entry.persistTimer) return;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = undefined;
      void this.#persist(entry);
    }, PERSIST_MS);
    entry.persistTimer.unref();
  }

  /** Saves the entry after any save already under way, so an older snapshot never replaces a newer one. */
  #persist(entry: Entry, strict = false): Promise<void> {
    const next = entry.persisting.then(() => this.#save(entry, strict));
    entry.persisting = next.catch(() => undefined);
    return next;
  }

  /** `strict`: a failure is thrown (a command that could not be journaled must not run), not only logged. */
  async #save(entry: Entry, strict: boolean): Promise<void> {
    if (!entry.dirty) return;
    entry.dirty = false;
    const file = this.#file(entry.record.id);
    const temp = `${file}.${randomBytes(4).toString("hex")}`;
    const stored: Persisted = { record: entry.record, tail: Buffer.concat(entry.chunks).toString("base64") };
    try {
      await fs.writeFile(temp, JSON.stringify(stored), { mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      entry.dirty = true;
      await fs.rm(temp, { force: true }).catch(() => undefined);
      this.#options.log.warn("Could not save a command journal entry", { id: entry.record.id, error: (error as Error).message });
      if (strict) throw error;
    }
  }

  /** Forgets the oldest ended commands beyond the retention limit. */
  async #prune(): Promise<void> {
    const ended = [...this.#entries.values()].filter((entry) => entry.record.state !== "running").sort((a, b) => (a.record.finishedAt ?? "").localeCompare(b.record.finishedAt ?? ""));
    const excess = ended.length - this.#limits.retained;
    for (const entry of ended.slice(0, Math.max(0, excess))) {
      this.#entries.delete(entry.record.id);
      await fs.rm(this.#file(entry.record.id), { force: true }).catch(() => undefined);
    }
  }
}
