// Runs the gateway (or an app with state on the shared volume) only while holding the single-writer lease on its data
// directory.
//
// Standby: the supervisor answers the gateway's port with 503 (so readiness fails and no traffic arrives) and keeps
// trying to take the lease. Holding: it starts the gateway as a child process and renews the lease. A heartbeat that
// fails means the lease may belong to someone else, so the gateway is killed at once (fencing).
//
// Handover: Container Apps keeps the old revision until the new one is ready, and a standby replica never becomes
// ready. So a standby replica whose deployment stamp is newer files a takeover request, and the holder stops its
// gateway, releases the lease, and goes back to standby. If the newer replica never takes the lease (for example
// because it crashed), the old holder reclaims it and refuses that stamp for a while instead of flapping. Replicas of
// the same deployment never hand over to each other; the extra one simply waits.
//
// The supervised process runs in its own process group (POSIX), so its descendants (the gateway's shared runtime)
// are stopped with it: the lease is released only after every process in the group has exited.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { Lease, LeaseStorageError, type LeaseIdentity } from "./lease.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export interface SupervisorTimings {
  /** Standby: how often to try to take the lease. */
  readonly pollMs: number;
  /** Holder: how often to renew the lease and look for takeover requests. */
  readonly heartbeatMs: number;
  /** Takeover requests not refreshed within this window are ignored (the requester went away). */
  readonly requestTtlMs: number;
  /** Time the gateway gets to shut down after SIGTERM before SIGKILL. */
  readonly stopGraceMs: number;
  /** After handing over, reclaim the lease if no newer instance has taken it by then. */
  readonly reclaimAfterMs: number;
  /** After reclaiming, refuse handovers to the stamp that failed to take over for this long. */
  readonly refuseAfterReclaimMs: number;
  /**
   * How long after a handover a reclaim counts against the deployment it went to. Later, this instance waits like any
   * other replica (it defers to every newer deployment, including that one).
   */
  readonly handoverSettleMs: number;
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  pollMs: 1_000,
  heartbeatMs: 5_000,
  requestTtlMs: 30_000,
  stopGraceMs: 25_000,
  reclaimAfterMs: 60_000,
  refuseAfterReclaimMs: 10 * 60_000,
  handoverSettleMs: 5 * 60_000,
};

export interface SupervisorOptions {
  /** The supervised process's data directory; the lease lives in `<dataDir>/.lease/`. */
  readonly dataDir: string;
  readonly identity: LeaseIdentity;
  /** Command line of the supervised process, e.g. ["node", "dist/main.js"]. */
  readonly command: readonly string[];
  /** Its port. The standby server answers on it while this instance does not hold the lease. */
  readonly port: number;
  /** What the supervised process is called in logs and standby answers (default "gateway"). */
  readonly subject?: string;
  readonly host?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timings?: Partial<SupervisorTimings>;
  readonly log?: Logger;
}

export type SupervisorState = "standby" | "starting" | "serving" | "handing-over" | "stopping" | "stopped";

/** Exit codes: the gateway's own code when it exits, these otherwise. */
export const EXIT = { ok: 0, fenced: 70, storage: 78 } as const;

interface TakeoverRequest {
  readonly stamp: string;
  readonly holder: string;
}

/** Orders deployment stamps: numeric stamps (epoch milliseconds) numerically, others lexicographically. */
export function compareStamps(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether any process in a process group is still running. Linux reads /proc so zombies (exited, not yet reaped by
 * their new parent) do not count; elsewhere a zero signal to the group answers. Anything it cannot tell counts as
 * running. Signal the group before asking: a snapshot can miss a process forked while it was taken.
 */
export function groupAlive(group: number): boolean {
  if (process.platform === "linux" && existsSync("/proc/self/stat")) {
    let entries: string[] | undefined;
    try {
      entries = readdirSync("/proc");
    } catch {
      entries = undefined;
    }
    if (entries) {
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          // "pid (comm) state ppid pgrp ...": comm may contain spaces and parentheses, so parse after the last ")".
          const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(pgrp) === group && state !== "Z" && state !== "X") return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ESRCH") return true; // cannot tell: assume it still runs
        }
      }
      return false;
    }
  }
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const consoleLogger: Logger = (level, message, fields) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [lease] ${message}${fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}`;
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #subject: string;
  readonly #timings: SupervisorTimings;
  readonly #log: Logger;
  readonly #leaseFile: string;
  readonly #requestsDir: string;
  readonly #requestFile: string;
  #state: SupervisorState = "standby";
  #lease: Lease | undefined;
  /** The supervised process, until it has exited (stops, handovers, and fencing all wait for that). */
  #child: ChildProcess | undefined;
  #childExit: Promise<number> | undefined;
  /** Its process group (POSIX): kept until every member has exited. */
  #group: number | undefined;
  #stopping: Promise<void> | undefined;
  #reaping: Promise<void> | undefined;
  #fencing = false;
  #standby: Server | undefined;
  #standbyReason: string;
  #timer: NodeJS.Timeout | undefined;
  #refused = new Map<string, number>();
  #handedOverAt = 0;
  #handedOverTo: string | undefined;
  #done!: (code: number) => void;
  readonly #finished: Promise<number>;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#subject = options.subject ?? "gateway";
    this.#standbyReason = `waiting for the previous ${this.#subject} instance to stop`;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#log = options.log ?? consoleLogger;
    const leaseDir = join(options.dataDir, ".lease");
    this.#leaseFile = join(leaseDir, "gateway.lease");
    this.#requestsDir = join(leaseDir, "requests");
    this.#requestFile = join(this.#requestsDir, `${safeName(options.identity.stamp)}--${safeName(options.identity.holder)}.json`);
    this.#finished = new Promise<number>((resolve) => (this.#done = resolve));
  }

  get state(): SupervisorState {
    return this.#state;
  }

  get generation(): number | undefined {
    return this.#lease?.generation;
  }

  /** Starts supervision; resolves with the process exit code once the supervisor has stopped. */
  async run(): Promise<number> {
    mkdirSync(this.#requestsDir, { recursive: true });
    await this.#enterStandby(`waiting for the previous ${this.#subject} instance to stop`);
    return this.#finished;
  }

  /** Stops the gateway (SIGTERM, then SIGKILL after the grace period), releases the lease, and resolves run(). */
  async stop(reason = "stop requested"): Promise<void> {
    if (this.#state === "stopping" || this.#state === "stopped") return;
    this.#state = "stopping";
    this.#log("info", "Stopping", { reason });
    this.#clearTimer();
    // Shares a stop already in progress (a handover): the lease is released only once the process group is gone.
    await this.#stopChild();
    this.#releaseLease();
    this.#removeRequest();
    await this.#closeStandby();
    this.#finish(EXIT.ok);
  }

  #finish(code: number): void {
    this.#state = "stopped";
    this.#clearTimer();
    this.#done(code);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delayMs: number, work: () => void | Promise<void>): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          this.#log("error", "Supervisor step failed", { error: (error as Error)?.message ?? String(error) });
          void this.#fence("an unexpected supervisor error");
        });
    }, delayMs);
  }

  // Standby -----------------------------------------------------------------------------------------------------

  async #enterStandby(reason: string): Promise<void> {
    this.#state = "standby";
    this.#standbyReason = reason;
    await this.#openStandby();
    if (this.#state !== "standby") {
      // Stopped or fenced while the standby server was starting.
      await this.#closeStandby();
      return;
    }
    this.#log("info", "Waiting for the single-writer lease", { holder: this.#options.identity.holder, stamp: this.#options.identity.stamp, reason });
    this.#schedule(0, () => this.#tryTakeLease());
  }

  async #tryTakeLease(): Promise<void> {
    if (this.#state !== "standby") return;
    const sinceHandover = this.#handedOverAt ? Date.now() - this.#handedOverAt : undefined;
    if (sinceHandover !== undefined && sinceHandover < this.#timings.reclaimAfterMs) {
      // Just handed over: give the newer instance time to take the lease before considering a reclaim.
      this.#schedule(this.#timings.pollMs, () => this.#tryTakeLease());
      return;
    }
    if (sinceHandover !== undefined && sinceHandover >= this.#timings.handoverSettleMs) {
      // The handover is history: from now on this instance waits like any other replica.
      this.#handedOverAt = 0;
      this.#handedOverTo = undefined;
    }
    this.#fileRequest();
    // A newer deployment is waiting: leave the lease to it rather than starting an older gateway in between. The
    // deployment we recently handed over to already had its chance; if it did not keep the lease, we reclaim first.
    const newer = this.#newerRequests().find((request) => request.stamp !== this.#handedOverTo);
    if (newer) {
      this.#standbyReason = `a newer deployment (${newer.holder}) is taking over`;
      this.#schedule(this.#timings.pollMs, () => this.#tryTakeLease());
      return;
    }
    let lease: Lease | undefined;
    try {
      lease = Lease.tryAcquire(this.#leaseFile, this.#options.identity);
    } catch (error) {
      if (error instanceof LeaseStorageError) {
        this.#log("error", error.message);
        this.#standbyReason = `the data volume does not support the locks the ${this.#subject} needs`;
        await this.#closeStandby();
        this.#removeRequest();
        this.#finish(EXIT.storage);
        return;
      }
      throw error;
    }
    if (!lease) {
      this.#schedule(this.#timings.pollMs, () => this.#tryTakeLease());
      return;
    }
    if (this.#handedOverAt) {
      // Nobody newer kept the lease after we handed it over: serve again, and do not hand over to them for a while.
      if (this.#handedOverTo !== undefined) this.#refused.set(this.#handedOverTo, Date.now() + this.#timings.refuseAfterReclaimMs);
      this.#log("warn", `No newer ${this.#subject} kept the lease after the handover; reclaiming it`, { generation: lease.generation, refused: this.#handedOverTo });
      this.#handedOverAt = 0;
      this.#handedOverTo = undefined;
    }
    this.#lease = lease;
    this.#removeRequest();
    await this.#startGateway();
  }

  #fileRequest(): void {
    try {
      const temporary = `${this.#requestFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ stamp: this.#options.identity.stamp, holder: this.#options.identity.holder, at: new Date().toISOString() }));
      renameSync(temporary, this.#requestFile);
    } catch (error) {
      this.#log("warn", "Could not file a takeover request", { error: (error as Error).message });
    }
  }

  #removeRequest(): void {
    rmSync(this.#requestFile, { force: true });
  }

  /** Fresh takeover requests from deployments newer than ours that we have not refused, newest first. */
  #newerRequests(): TakeoverRequest[] {
    const now = Date.now();
    for (const [stamp, until] of this.#refused) if (until <= now) this.#refused.delete(stamp);
    let names: string[];
    try {
      names = readdirSync(this.#requestsDir);
    } catch {
      return [];
    }
    const requests: TakeoverRequest[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.#requestsDir, name);
      try {
        if (now - statSync(file).mtimeMs > this.#timings.requestTtlMs) continue;
        const request = JSON.parse(readFileSync(file, "utf8")) as Partial<TakeoverRequest>;
        if (typeof request.stamp !== "string" || typeof request.holder !== "string") continue;
        if (compareStamps(request.stamp, this.#options.identity.stamp) <= 0) continue;
        if (this.#refused.has(request.stamp)) continue;
        requests.push({ stamp: request.stamp, holder: request.holder });
      } catch {
        // Being written or removed: look again on the next heartbeat.
      }
    }
    return requests.sort((a, b) => compareStamps(b.stamp, a.stamp));
  }

  async #openStandby(): Promise<void> {
    if (this.#standby) return;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const body = JSON.stringify({
        error: { code: "capability_unavailable", message: `The ${this.#subject} is not serving on this instance yet: ${this.#standbyReason}. Retry shortly.` },
        status: "standby",
      });
      res.writeHead(503, { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store", connection: "close" });
      res.end(req.method === "HEAD" ? undefined : body);
    });
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nretry-after: 5\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#standby = server;
  }

  async #closeStandby(): Promise<void> {
    const server = this.#standby;
    this.#standby = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Holding -----------------------------------------------------------------------------------------------------

  async #startGateway(): Promise<void> {
    const lease = this.#lease!;
    this.#state = "starting";
    await this.#closeStandby();
    if (this.#state !== "starting") return; // stopped meanwhile; stop() released the lease
    const [command, ...args] = this.#options.command;
    if (!command) throw new Error(`No ${this.#subject} command was given.`);
    this.#log("info", `Took the single-writer lease; starting the ${this.#subject}`, { generation: lease.generation, holder: this.#options.identity.holder });
    const posix = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: this.#options.cwd,
      env: { ...(this.#options.env ?? process.env), MANAGED_COPILOT_LEASE_GENERATION: String(lease.generation) },
      stdio: "inherit",
      // Its own process group, so its descendants (the shared runtime) can be signalled and awaited with it.
      detached: posix,
    });
    this.#child = child;
    this.#group = posix && child.pid !== undefined ? child.pid : undefined;
    this.#childExit = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumbers[signal] ?? 15) : 1)));
      child.once("error", (error) => {
        this.#log("error", `The ${this.#subject} process could not start`, { error: error.message });
        resolve(1);
      });
    });
    void this.#childExit.then((code) => this.#onChildExit(child, code));
    this.#state = "serving";
    this.#schedule(this.#timings.heartbeatMs, () => this.#heartbeat());
  }

  async #onChildExit(child: ChildProcess, code: number): Promise<void> {
    if (this.#child !== child) return;
    this.#child = undefined;
    if (this.#state !== "serving" && this.#state !== "starting") return; // stop, handover, and fencing handle their own exits
    this.#state = "stopping";
    this.#log(code === 0 ? "info" : "error", `The ${this.#subject} exited; releasing the lease`, { code });
    this.#clearTimer();
    await this.#reapGroup();
    this.#releaseLease();
    this.#removeRequest();
    this.#finish(code);
  }

  async #heartbeat(): Promise<void> {
    if (this.#state !== "serving") return;
    try {
      this.#lease!.heartbeat();
    } catch (error) {
      this.#log("error", `Lost the single-writer lease; stopping the ${this.#subject} immediately`, { error: (error as Error).message });
      await this.#fence("the lease could not be renewed");
      return;
    }
    const newer = this.#newerRequests();
    if (newer.length > 0) {
      await this.#handOver(newer[0]!);
      return;
    }
    this.#schedule(this.#timings.heartbeatMs, () => this.#heartbeat());
  }

  async #handOver(request: TakeoverRequest): Promise<void> {
    this.#state = "handing-over";
    this.#log("info", `A newer deployment is waiting; handing the ${this.#subject} over`, { to: request.holder, stamp: request.stamp, generation: this.#lease?.generation });
    await this.#stopChild();
    if (this.#state !== "handing-over") return; // stopped or fenced meanwhile; they released the lease
    this.#releaseLease();
    this.#handedOverAt = Date.now();
    this.#handedOverTo = request.stamp;
    await this.#enterStandby(`handed over to a newer deployment (${request.holder})`);
  }

  /** Kills the process group without a grace period and exits: another holder may already be writing. */
  async #fence(reason: string): Promise<void> {
    if (this.#state === "stopped" || this.#fencing) return;
    this.#fencing = true;
    this.#state = "stopping";
    this.#clearTimer();
    // Even while a graceful stop (stop() or a handover) is waiting for the process to exit.
    this.#signal("SIGKILL");
    if (this.#child && this.#childExit) await this.#childExit;
    await this.#reapGroup();
    this.#releaseLease();
    this.#removeRequest();
    await this.#closeStandby();
    this.#log("error", `Fenced: the ${this.#subject} was stopped`, { reason });
    this.#finish(EXIT.fenced);
  }

  /** SIGTERM, then SIGKILL after the grace period; resolves once the whole process group has exited. Shared by concurrent callers. */
  #stopChild(): Promise<void> {
    this.#stopping ??= this.#terminate().finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #terminate(): Promise<void> {
    const child = this.#child;
    const exited = this.#childExit;
    if (child && exited && child.exitCode === null && child.signalCode === null) {
      this.#signal("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.#timings.stopGraceMs);
      });
      const outcome = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        this.#log("warn", `The ${this.#subject} did not stop in time; killing it`, { graceMs: this.#timings.stopGraceMs });
        this.#signal("SIGKILL");
        await exited;
      }
    }
    await this.#reapGroup();
  }

  /** Signals the supervised process group (POSIX), or the process itself. */
  #signal(signal: NodeJS.Signals): void {
    if (this.#group !== undefined) {
      try {
        process.kill(-this.#group, signal);
        return;
      } catch {
        // The group is gone; signal the process directly below in case it is not.
      }
    }
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  }

  /** Kills whatever is left of the process group (descendants can outlive the process) and waits until none runs. */
  #reapGroup(): Promise<void> {
    this.#reaping ??= this.#killGroup().finally(() => {
      this.#reaping = undefined;
    });
    return this.#reaping;
  }

  async #killGroup(): Promise<void> {
    const group = this.#group;
    if (group === undefined) return;
    const started = Date.now();
    let warned = false;
    for (;;) {
      // Signal before looking: a process with a fatal signal pending cannot fork, so once the group is signalled, a
      // scan that finds no member is final. (A scan alone can miss a child forked while it ran.)
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // No member left to signal.
      }
      await delay(50);
      if (!groupAlive(group)) break;
      // Keep the lease until they are gone, however long that takes: a process stuck in I/O may still write.
      if (!warned && Date.now() - started > 10_000) {
        warned = true;
        this.#log("warn", `Processes started by the ${this.#subject} have not exited yet; keeping the lease until they do`, { group });
      }
    }
    if (this.#group === group) this.#group = undefined;
  }
  #releaseLease(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }
}

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
