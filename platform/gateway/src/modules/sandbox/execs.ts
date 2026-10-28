// Commands run directly in sandboxes (`sandboxes.exec`): started through sandboxd's journal and recorded in the
// gateway's own (`sandbox_execs`) with who ran them. A command is never started twice for one ID: a replay reattaches,
// and a command whose start was never confirmed reads as `uncertain` rather than running again.
import { createHash, randomBytes } from "node:crypto";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  SANDBOX_LIMITS,
  type ExecInfo,
  type ExecResult,
  type SandboxExecRecord,
} from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { SandboxAgentClient } from "./agent-client.js";
import { answeredBySandbox } from "./agent-client.js";
import type { ExecOptions, ExecReadOptions, FileCallOptions } from "./contract.js";
import type { ExecPatch, ExecRow, SandboxRow, SandboxStore } from "./store.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One long poll to sandboxd; under any ingress's request timeout. */
const POLL_MS = 25_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/** Output one call collects (the newest bytes; older ones are reported as skipped). */
const COLLECT_BYTES = SANDBOX_LIMITS.exec.outputBytes;

export const STOPPED_WITH_SANDBOX = "The sandbox stopped while this command was running, so it was stopped.";
export const UNCONFIRMED =
  "The platform lost track of this command before the sandbox confirmed it started, so it may or may not have run. It was not run again; check the workspace before running it again.";
export const LOST =
  "The sandbox no longer has a record of this command (its journal was lost), so its outcome is unknown. It was not run again; check the workspace before running it again.";

export interface ExecDeps {
  readonly store: SandboxStore;
  readonly log: Logger;
  /** The session's sandbox record; `not_found` when it has none. */
  row(sessionId: string): SandboxRow;
  /** Fails with `not_found` unless `sandboxId` (when given) is still the session's sandbox. */
  expectSandbox(sessionId: string, sandboxId: string | undefined, row?: SandboxRow): void;
  /** The sandbox's agent, starting the sandbox if it is stopped. */
  agentFor(sessionId: string, sandboxId?: string): Promise<SandboxAgentClient>;
  /** The agent of a running sandbox, without starting anything. */
  agentOf(row: SandboxRow): SandboxAgentClient;
  /** Marks the session busy while `work` runs (idle stop waits). */
  track<T>(sessionId: string, work: Promise<T>): Promise<T>;
  touch(sessionId: string): void;
  /** A command ended (or was found ended): publication and busy accounting. */
  ended(row: ExecRow): void;
  /** The number of live commands of the session changed. */
  activity(sessionId: string): void;
  /** Aborted at gateway shutdown. */
  readonly shutdown: AbortSignal;
}

function toManaged(error: unknown): ManagedCopilotError {
  if (error instanceof ManagedCopilotError) return error;
  return new ManagedCopilotError("internal", (error as Error)?.message ?? String(error));
}

/** A command's journal ID: the caller's, one derived from a durable action ID, or a fresh one. */
export function execIdFor(options: Pick<ExecOptions, "id" | "actionId">): string {
  if (options.id !== undefined) {
    if (typeof options.id !== "string" || !ID.test(options.id)) throw new ManagedCopilotError("invalid_request", "id must be 1 to 64 letters, digits, hyphens, or underscores.");
    return options.id;
  }
  if (options.actionId !== undefined) return `ex_${createHash("sha256").update(options.actionId).digest("hex").slice(0, 32)}`;
  return `ex_${randomBytes(12).toString("hex")}`;
}

function live(state: ExecRow["state"]): boolean {
  return state === "running" || state === "starting";
}

export function execInfo(row: ExecRow): ExecInfo {
  return {
    id: row.id,
    sessionId: row.sessionId,
    command: row.command,
    state: row.state === "starting" ? "running" : row.state,
    background: row.background,
    ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.timeoutMs !== undefined ? { timeoutMs: row.timeoutMs } : {}),
    startedAt: row.startedAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.lastOutputAt ? { lastOutputAt: row.lastOutputAt } : {}),
    outputBytes: row.outputBytes,
    ...(row.caller ? { caller: row.caller } : {}),
  };
}

function patchFrom(record: SandboxExecRecord): ExecPatch {
  return {
    state: record.state,
    outputBytes: record.outputBytes,
    startedAt: record.startedAt,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal ? { signal: record.signal } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.lastOutputAt ? { lastOutputAt: record.lastOutputAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
  };
}

export class SandboxExecs {
  readonly #deps: ExecDeps;
  /** Commands whose start is in flight in this process (`sandbox\0id`): never resolved as unconfirmed meanwhile. */
  readonly #starting = new Map<string, Promise<unknown>>();
  /** Commands this process watches for their end (`sandbox\0id`). */
  readonly #watching = new Set<string>();

  constructor(deps: ExecDeps) {
    this.#deps = deps;
  }

  /** Records what sandboxd reports; an end it observes for the first time runs `ended` once. */
  #sync(row: ExecRow, record: SandboxExecRecord): ExecRow {
    const before = this.#deps.store.exec(row.sandboxId, row.id) ?? row;
    const after = this.#deps.store.updateExec(row.sandboxId, row.id, patchFrom(record)) ?? before;
    if (live(before.state) && !live(after.state)) this.#ended(after);
    return after;
  }

  /** Ends a command the gateway decided about (stopped with its sandbox, or uncertain). */
  #settle(row: ExecRow, state: "stopped" | "uncertain", reason: string): ExecRow {
    const after = this.#deps.store.updateExec(row.sandboxId, row.id, { state, reason, finishedAt: new Date().toISOString() }) ?? row;
    if (live(row.state) && !live(after.state)) this.#ended(after);
    return after;
  }

  #ended(row: ExecRow): void {
    try {
      this.#deps.ended(row);
    } catch (error) {
      this.#deps.log.warn("Handling a command's end failed", { sessionId: row.sessionId, execId: row.id, error: (error as Error).message });
    }
  }

  // Starting -------------------------------------------------------------------------------------------------------

  async exec(sessionId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (typeof command !== "string" || command.trim() === "") throw new ManagedCopilotError("invalid_request", "command must be a non-empty string.");
    if (Buffer.byteLength(command, "utf8") > SANDBOX_LIMITS.exec.commandBytes) {
      throw new ManagedCopilotError("invalid_request", `Commands are limited to ${SANDBOX_LIMITS.exec.commandBytes / 1024} KiB; write a script with the files API and run it.`);
    }
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS)) {
      throw new ManagedCopilotError("invalid_request", "timeoutMs must be a positive whole number of milliseconds (at most 7 days).");
    }
    if (options.waitMs !== undefined && (!Number.isFinite(options.waitMs) || options.waitMs < 0)) throw new ManagedCopilotError("invalid_request", "waitMs must be zero or more milliseconds.");
    if (options.stdin !== undefined && options.stdin !== "open" && options.stdin !== "closed") throw new ManagedCopilotError("invalid_request", 'stdin must be "open" or "closed".');
    const id = execIdFor(options);
    const background = options.background === true;
    this.#deps.expectSandbox(sessionId, options.sandboxId);
    const agent = await this.#deps.agentFor(sessionId, options.sandboxId);
    const sandbox = this.#deps.row(sessionId);
    const key = `${sandbox.id}\0${id}`;
    await this.#starting.get(key)?.catch(() => undefined);
    let row = this.#deps.store.exec(sandbox.id, id);
    let inserted: ExecRow | undefined;
    if (!row) {
      try {
        inserted = this.#insert(sandbox, id, sessionId, command, background, options);
      } catch (error) {
        // The same ID started concurrently: that call's command is this one.
        row = this.#deps.store.exec(sandbox.id, id);
        if (!row) throw error;
        await this.#starting.get(key)?.catch(() => undefined);
        row = this.#deps.store.exec(sandbox.id, id) ?? row;
      }
    }
    if (inserted) {
      const started = this.#start(agent, inserted);
      this.#starting.set(key, started);
      try {
        row = await started;
      } finally {
        this.#starting.delete(key);
      }
      this.#deps.log.info("Command started", { sessionId, sandboxId: sandbox.id, execId: id, background, caller: row.caller?.kind ?? "platform", ...(row.caller?.name ? { tool: row.caller.name } : {}) });
    } else if (row!.state === "starting") {
      row = await this.#resolveUnconfirmed(agent, row!);
    }
    const current = row!;
    if (live(current.state)) this.#watch(current);
    this.#deps.touch(sessionId);
    const waitMs = options.waitMs ?? (background ? 0 : Number.POSITIVE_INFINITY);
    return this.#deps.track(sessionId, this.#collect(agent, current, { waitMs, ...(options.signal ? { signal: options.signal } : {}), stopOnAbort: !background }));
  }

  #insert(sandbox: SandboxRow, id: string, sessionId: string, command: string, background: boolean, options: ExecOptions): ExecRow {
    const row = this.#deps.store.insertExec({
      sandboxId: sandbox.id,
      id,
      sessionId,
      ownerId: sandbox.ownerId,
      ...(options.actionId !== undefined ? { actionId: options.actionId } : {}),
      command,
      background,
      stdin: options.stdin ?? (background ? "open" : "closed"),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.caller ? { caller: options.caller } : {}),
      state: "starting",
      startedAt: new Date().toISOString(),
    });
    this.#deps.activity(sessionId);
    return row;
  }

  async #start(agent: SandboxAgentClient, row: ExecRow): Promise<ExecRow> {
    try {
      const record = await agent.startExec({ id: row.id, command: row.command, stdin: row.stdin, ...(row.timeoutMs !== undefined ? { timeoutMs: row.timeoutMs } : {}) });
      return this.#sync(row, record);
    } catch (error) {
      return this.#afterFailedStart(agent, row, error);
    }
  }

  /**
   * A start that failed: sandboxd either refused it, never got it, or ran it and the answer was lost. A refusal
   * sandboxd answered itself means it never ran: the record goes and the error stands. Otherwise its journal decides:
   * a command it has is reattached; one it lacks may still have run (its journal could have been lost since), so it
   * is `uncertain`; when it cannot be asked, the command stays unconfirmed and is decided on its next read.
   */
  async #afterFailedStart(agent: SandboxAgentClient, row: ExecRow, error: unknown): Promise<ExecRow> {
    const failure = toManaged(error);
    if (answeredBySandbox(error)) {
      this.#deps.store.deleteExec(row.sandboxId, row.id);
      this.#deps.activity(row.sessionId);
      throw failure;
    }
    try {
      const read = await agent.readExec(row.id, 0, 0);
      return this.#sync(row, read.exec);
    } catch (lookup) {
      if (isManagedCopilotError(lookup, "not_found")) return this.#settle(row, "uncertain", UNCONFIRMED);
    }
    throw new ManagedCopilotError(failure.code === "invalid_request" ? "internal" : failure.code, `${failure.message} Whether command ${row.id} started is not known yet; read it again with its ID before running it again.`, { execId: row.id });
  }

  /** A start this gateway never saw confirmed (it restarted meanwhile): sandboxd's journal decides, else `uncertain`. */
  async #resolveUnconfirmed(agent: SandboxAgentClient, row: ExecRow): Promise<ExecRow> {
    try {
      const read = await agent.readExec(row.id, 0, 0);
      return this.#sync(row, read.exec);
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return this.#settle(row, "uncertain", UNCONFIRMED);
      throw toManaged(error);
    }
  }

  /**
   * Reads from `offset` until the command ends (and its output is drained), `waitMs` passes, or `signal` aborts (which
   * stops a command that is not `background`).
   */
  async #collect(agent: SandboxAgentClient, start: ExecRow, options: { waitMs: number; signal?: AbortSignal; stopOnAbort: boolean; offset?: number }): Promise<ExecResult> {
    let row = start;
    let offset = options.offset ?? 0;
    let chunks: string[] = [];
    let collected = 0;
    let skipped = 0;
    const deadline = Date.now() + options.waitMs;
    for (;;) {
      if (row.state === "uncertain") break;
      if (options.signal?.aborted) {
        // A background command runs on; the caller only stopped waiting.
        if (!options.stopOnAbort && live(row.state)) break;
        if (live(row.state)) row = await this.#stop(agent, row, "The call that ran this command was cancelled, so it was stopped.");
        if (!live(row.state) && offset >= row.outputBytes) break;
      }
      const ended = !live(row.state);
      const wait = ended || options.signal?.aborted ? 0 : Math.max(0, Math.min(POLL_MS, deadline - Date.now()));
      let read;
      try {
        read = await agent.readExec(row.id, offset, wait, options.signal?.aborted ? undefined : options.signal);
      } catch (error) {
        if (options.signal?.aborted && live(row.state)) continue;
        if (options.signal?.aborted) break;
        if (isManagedCopilotError(error, "not_found")) {
          row = this.#settle(row, "uncertain", LOST);
          break;
        }
        throw toManaged(error);
      }
      row = this.#sync(row, read.exec);
      skipped += read.skippedBytes ?? 0;
      if (read.output) {
        chunks.push(read.output);
        collected += Buffer.byteLength(read.output, "utf8");
        if (collected > COLLECT_BYTES * 2) {
          const text = chunks.join("");
          const kept = Buffer.from(text, "utf8").subarray(-COLLECT_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
          skipped += collected - Buffer.byteLength(kept, "utf8");
          chunks = [kept];
          collected = Buffer.byteLength(kept, "utf8");
        }
      }
      offset = read.offset;
      if (!live(row.state)) {
        if (read.output === "" || offset >= row.outputBytes) break;
        continue;
      }
      // A running command is answered at the deadline with what it printed so far, however much more it prints.
      if (Date.now() >= deadline) break;
    }
    let output = chunks.join("");
    if (collected > COLLECT_BYTES) {
      const kept = Buffer.from(output, "utf8").subarray(-COLLECT_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
      skipped += collected - Buffer.byteLength(kept, "utf8");
      output = kept;
    }
    return { ...execInfo(row), output, offset, ...(skipped > 0 ? { skippedBytes: skipped } : {}) };
  }

  // Reading, input, stopping -----------------------------------------------------------------------------------------

  #current(sessionId: string, execId: string, options: FileCallOptions): ExecRow {
    const sandbox = this.#deps.row(sessionId);
    this.#deps.expectSandbox(sessionId, options.sandboxId, sandbox);
    const row = typeof execId === "string" && ID.test(execId) ? this.#deps.store.exec(sandbox.id, execId) : undefined;
    if (!row) throw new ManagedCopilotError("not_found", `Session ${sessionId} has no command ${execId}.`, { sessionId, execId });
    return row;
  }

  async read(sessionId: string, execId: string, options: ExecReadOptions = {}): Promise<ExecResult> {
    let row = this.#current(sessionId, execId, options);
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new ManagedCopilotError("invalid_request", "offset must be a non-negative whole number.");
    if (row.state === "uncertain") return { ...execInfo(row), output: "", offset };
    const agent = await this.#deps.agentFor(sessionId, row.sandboxId);
    const key = `${row.sandboxId}\0${row.id}`;
    if (this.#starting.has(key)) {
      await this.#starting.get(key)?.catch(() => undefined);
      row = this.#deps.store.exec(row.sandboxId, row.id) ?? row;
    }
    if (row.state === "starting") row = await this.#resolveUnconfirmed(agent, row);
    if (row.state === "uncertain") return { ...execInfo(row), output: "", offset };
    this.#deps.touch(sessionId);
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), SANDBOX_LIMITS.exec.maxWaitMs);
    try {
      const read = await this.#deps.track(sessionId, agent.readExec(row.id, offset, waitMs, options.signal));
      row = this.#sync(row, read.exec);
      if (live(row.state)) this.#watch(row);
      return { ...execInfo(row), output: read.output, offset: read.offset, ...(read.skippedBytes ? { skippedBytes: read.skippedBytes } : {}) };
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) {
        row = this.#settle(row, "uncertain", LOST);
        return { ...execInfo(row), output: "", offset };
      }
      throw toManaged(error);
    }
  }

  async write(sessionId: string, execId: string, input: { readonly data?: string; readonly eof?: boolean }, options: FileCallOptions = {}): Promise<ExecInfo> {
    const row = this.#current(sessionId, execId, options);
    if (input.data !== undefined && typeof input.data !== "string") throw new ManagedCopilotError("invalid_request", "data must be a string.");
    if (input.data !== undefined && Buffer.byteLength(input.data, "utf8") > SANDBOX_LIMITS.exec.inputBytes) throw new ManagedCopilotError("invalid_request", "One write is limited to 1 MiB.");
    if (!live(row.state)) throw new ManagedCopilotError("conflict", `Command ${execId} is ${row.state}; it no longer reads input.`, { execId, state: row.state });
    const agent = await this.#deps.agentFor(sessionId, row.sandboxId);
    this.#deps.touch(sessionId);
    const record = await this.#deps.track(sessionId, agent.execInput(row.id, input.data, input.eof === true));
    return execInfo(this.#sync(row, record));
  }

  async stop(sessionId: string, execId: string, options: FileCallOptions & { readonly reason?: string } = {}): Promise<ExecInfo> {
    const row = this.#current(sessionId, execId, options);
    if (!live(row.state)) return execInfo(row);
    const sandbox = this.#deps.row(sessionId);
    // A stopped sandbox stopped its commands; nothing to start for it.
    if (sandbox.state !== "running") return execInfo(this.#settle(row, "stopped", STOPPED_WITH_SANDBOX));
    const agent = this.#deps.agentOf(sandbox);
    return execInfo(await this.#deps.track(sessionId, this.#stop(agent, row, options.reason?.trim() || "Stopped on request.")));
  }

  async #stop(agent: SandboxAgentClient, row: ExecRow, reason: string): Promise<ExecRow> {
    try {
      return this.#sync(row, await agent.stopExec(row.id, reason));
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return row.state === "starting" ? this.#settle(row, "uncertain", UNCONFIRMED) : this.#settle(row, "uncertain", LOST);
      throw toManaged(error);
    }
  }

  list(sessionId: string, options: FileCallOptions = {}): ExecInfo[] {
    const sandbox = this.#deps.row(sessionId);
    this.#deps.expectSandbox(sessionId, options.sandboxId, sandbox);
    return this.#deps.store.execs(sandbox.id).map(execInfo);
  }

  // Lifecycle --------------------------------------------------------------------------------------------------------

  /** Follows a running command until it ends, so its end is recorded (and published) without anyone reading it. */
  #watch(row: ExecRow): void {
    const key = `${row.sandboxId}\0${row.id}`;
    if (this.#watching.has(key) || this.#deps.shutdown.aborted) return;
    this.#watching.add(key);
    void (async () => {
      try {
        for (let failures = 0; !this.#deps.shutdown.aborted; ) {
          const current = this.#deps.store.exec(row.sandboxId, row.id);
          if (!current || !live(current.state)) return;
          const sandbox = this.#deps.store.bySession(row.sessionId);
          // A stop, delete, or replacement of the sandbox settles its commands itself.
          if (!sandbox || sandbox.id !== row.sandboxId || sandbox.state !== "running") return;
          if (current.state === "starting" && this.#starting.has(key)) {
            await new Promise((resolve) => setTimeout(resolve, 500).unref());
            continue;
          }
          try {
            const record = await this.#deps.agentOf(sandbox).waitExec(row.id, POLL_MS, this.#deps.shutdown);
            failures = 0;
            this.#sync(current, record);
          } catch (error) {
            if (this.#deps.shutdown.aborted) return;
            if (isManagedCopilotError(error, "not_found")) {
              this.#settle(current, "uncertain", current.state === "starting" ? UNCONFIRMED : LOST);
              return;
            }
            failures++;
            await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))).unref());
          }
        }
      } finally {
        this.#watching.delete(key);
      }
    })();
  }

  /**
   * Whether running commands keep an idle sandbox up: one wrote output (or started) within `idleMs`. Commands that went
   * quiet longer than that no longer count.
   */
  async holdsIdle(sandbox: SandboxRow, idleMs: number): Promise<boolean> {
    const rows = this.#deps.store.liveExecs(sandbox.id);
    if (rows.length === 0) return false;
    let records: SandboxExecRecord[];
    try {
      records = await this.#deps.agentOf(sandbox).listExecs(10_000);
    } catch {
      return false;
    }
    const now = Date.now();
    let holds = false;
    for (const row of rows) {
      const record = records.find((candidate) => candidate.id === row.id);
      if (!record) continue;
      this.#sync(row, record);
      if (record.state !== "running") continue;
      const last = Date.parse(record.lastOutputAt ?? record.startedAt);
      if (Number.isFinite(last) && now - last < idleMs) holds = true;
    }
    return holds;
  }

  /** Before a sandbox stops: its running commands are stopped with `reason` and recorded so. */
  async sandboxStopping(sandbox: SandboxRow, reason: string): Promise<void> {
    const rows = this.#deps.store.liveExecs(sandbox.id);
    if (rows.length === 0) return;
    try {
      const records = await this.#deps.agentOf(sandbox).stopAllExecs(reason);
      for (const record of records) {
        const row = rows.find((candidate) => candidate.id === record.id);
        if (row) this.#sync(row, record);
      }
    } catch (error) {
      this.#deps.log.warn("Could not stop the sandbox's commands before stopping it", { sandboxId: sandbox.id, error: (error as Error).message });
    }
    this.sandboxStopped(sandbox, reason);
  }

  /** After a sandbox stopped (or was found stopped): commands still recorded as live were stopped with it. */
  sandboxStopped(sandbox: Pick<SandboxRow, "id">, reason = STOPPED_WITH_SANDBOX): void {
    for (const row of this.#deps.store.liveExecs(sandbox.id)) {
      if (row.state === "starting") this.#settle(row, "uncertain", UNCONFIRMED);
      else this.#settle(row, "stopped", reason);
    }
  }

  /** At startup: commands of running sandboxes are followed again; those of stopped ones were stopped with them. */
  async recover(): Promise<void> {
    for (const row of this.#deps.store.liveExecs()) {
      const sandbox = this.#deps.store.bySession(row.sessionId);
      if (!sandbox || sandbox.id !== row.sandboxId || sandbox.state !== "running") {
        if (row.state === "starting") this.#settle(row, "uncertain", UNCONFIRMED);
        else this.#settle(row, "stopped", STOPPED_WITH_SANDBOX);
        continue;
      }
      try {
        const current = row.state === "starting" ? await this.#resolveUnconfirmed(this.#deps.agentOf(sandbox), row) : row;
        if (live(current.state)) this.#watch(current);
      } catch (error) {
        this.#deps.log.warn("Could not recover a command; it is checked again when read", { sessionId: row.sessionId, execId: row.id, error: (error as Error).message });
      }
    }
  }

  liveCount(sessionId: string): number {
    const sandbox = this.#deps.store.bySession(sessionId);
    return sandbox ? this.#deps.store.liveExecs(sandbox.id).length : 0;
  }
}
