// Runs the gateway only while holding the single-writer lease on its data directory.
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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  pollMs: 1_000,
  heartbeatMs: 5_000,
  requestTtlMs: 30_000,
  stopGraceMs: 25_000,
  reclaimAfterMs: 60_000,
  refuseAfterReclaimMs: 10 * 60_000,
};

export interface SupervisorOptions {
  /** The gateway's data directory; the lease lives in `<dataDir>/.lease/`. */
  readonly dataDir: string;
  readonly identity: LeaseIdentity;
  /** Gateway command line, e.g. ["node", "dist/main.js"]. */
  readonly command: readonly string[];
  /** The gateway's port. The standby server answers on it while this instance does not hold the lease. */
  readonly port: number;
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

const consoleLogger: Logger = (level, message, fields) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [lease] ${message}${fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}`;
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #timings: SupervisorTimings;
  readonly #log: Logger;
  readonly #leaseFile: string;
  readonly #requestsDir: string;
  readonly #requestFile: string;
  #state: SupervisorState = "standby";
  #lease: Lease | undefined;
  #child: ChildProcess | undefined;
  #childExit: Promise<number> | undefined;
  #standby: Server | undefined;
  #standbyReason = "waiting for the previous gateway instance to stop";
  #timer: NodeJS.Timeout | undefined;
  #refused = new Map<string, number>();
  #handedOverAt = 0;
  #handedOverTo: string | undefined;
  #done!: (code: number) => void;
  readonly #finished: Promise<number>;

  constructor(options: SupervisorOptions) {
    this.#options = options;
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
    await this.#enterStandby("waiting for the previous gateway instance to stop");
    return this.#finished;
  }

  /** Stops the gateway (SIGTERM, then SIGKILL after the grace period), releases the lease, and resolves run(). */
  async stop(reason = "stop requested"): Promise<void> {
    if (this.#state === "stopping" || this.#state === "stopped") return;
    this.#state = "stopping";
    this.#log("info", "Stopping", { reason });
    this.#clearTimer();
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
    this.#log("info", "Waiting for the single-writer lease", { holder: this.#options.identity.holder, stamp: this.#options.identity.stamp, reason });
    this.#schedule(0, () => this.#tryTakeLease());
  }

  async #tryTakeLease(): Promise<void> {
    if (this.#state !== "standby") return;
    const handingOverSince = this.#handedOverAt;
    if (handingOverSince && Date.now() - handingOverSince < this.#timings.reclaimAfterMs) {
      // Just handed over: give the newer instance time to take the lease before considering a reclaim.
      this.#schedule(this.#timings.pollMs, () => this.#tryTakeLease());
      return;
    }
    if (!handingOverSince) {
      this.#fileRequest();
      // A newer deployment is waiting too: leave the lease to it rather than starting an older gateway in between.
      const newer = this.#newerRequests()[0];
      if (newer) {
        this.#standbyReason = `a newer deployment (${newer.holder}) is taking over`;
        this.#schedule(this.#timings.pollMs, () => this.#tryTakeLease());
        return;
      }
    }
    let lease: Lease | undefined;
    try {
      lease = Lease.tryAcquire(this.#leaseFile, this.#options.identity);
    } catch (error) {
      if (error instanceof LeaseStorageError) {
        this.#log("error", error.message);
        this.#standbyReason = "the data volume does not support the locks the gateway needs";
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
    if (handingOverSince) {
      // Nobody newer kept the lease after we handed it over: serve again, and do not hand over to them for a while.
      if (this.#handedOverTo !== undefined) this.#refused.set(this.#handedOverTo, Date.now() + this.#timings.refuseAfterReclaimMs);
      this.#log("warn", "No newer gateway kept the lease after the handover; reclaiming it", { generation: lease.generation, refused: this.#handedOverTo });
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
        error: { code: "capability_unavailable", message: `The gateway is not serving on this instance yet: ${this.#standbyReason}. Retry shortly.` },
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
    const [command, ...args] = this.#options.command;
    if (!command) throw new Error("No gateway command was given.");
    this.#log("info", "Took the single-writer lease; starting the gateway", { generation: lease.generation, holder: this.#options.identity.holder });
    const child = spawn(command, args, {
      cwd: this.#options.cwd,
      env: { ...(this.#options.env ?? process.env), MANAGED_COPILOT_LEASE_GENERATION: String(lease.generation) },
      stdio: "inherit",
    });
    this.#child = child;
    this.#childExit = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumbers[signal] ?? 15) : 1)));
      child.once("error", (error) => {
        this.#log("error", "The gateway process could not start", { error: error.message });
        resolve(1);
      });
    });
    void this.#childExit.then((code) => this.#onChildExit(child, code));
    this.#state = "serving";
    this.#schedule(this.#timings.heartbeatMs, () => this.#heartbeat());
  }

  #onChildExit(child: ChildProcess, code: number): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    if (this.#state !== "serving" && this.#state !== "starting") return; // stop, handover, and fencing handle their own exits
    this.#log(code === 0 ? "info" : "error", "The gateway exited; releasing the lease", { code });
    this.#clearTimer();
    this.#releaseLease();
    this.#finish(code);
  }

  async #heartbeat(): Promise<void> {
    if (this.#state !== "serving") return;
    try {
      this.#lease!.heartbeat();
    } catch (error) {
      this.#log("error", "Lost the single-writer lease; stopping the gateway immediately", { error: (error as Error).message });
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
    this.#log("info", "A newer deployment is waiting; handing the gateway over", { to: request.holder, stamp: request.stamp, generation: this.#lease?.generation });
    await this.#stopChild();
    this.#releaseLease();
    this.#handedOverAt = Date.now();
    this.#handedOverTo = request.stamp;
    await this.#enterStandby(`handed over to a newer deployment (${request.holder})`);
  }

  /** Kills the gateway without a grace period and exits: another holder may already be writing. */
  async #fence(reason: string): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    this.#clearTimer();
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await this.#childExit;
    }
    this.#releaseLease();
    this.#removeRequest();
    await this.#closeStandby();
    this.#log("error", "Fenced: the gateway was stopped", { reason });
    this.#finish(EXIT.fenced);
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const exited = this.#childExit!;
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.#timings.stopGraceMs).unref());
    if ((await Promise.race([exited, timeout])) === "timeout") {
      this.#log("warn", "The gateway did not stop in time; killing it", { graceMs: this.#timings.stopGraceMs });
      child.kill("SIGKILL");
      await exited;
    }
  }

  #releaseLease(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }
}

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
