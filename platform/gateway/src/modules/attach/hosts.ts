import { randomUUID } from "node:crypto";
import { ATTACH_CLOSE_CODES, ManagedCopilotError } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { SessionRuntime } from "./types.js";

/** One attached client's relay to a host's listener. */
export interface AttachedBridge {
  /** Stops relaying at once (nothing more is forwarded either way) and closes the client with `code`. Idempotent. */
  close(code: number, reason: string): void;
  /** Resolves when the client's socket has closed. */
  readonly ended: Promise<void>;
}

/** A runtime-supervised AHP listener that advertises exactly one session (its own `computeId` catalog). */
export interface AhpHost {
  readonly sessionId: string;
  readonly hostId: string;
  readonly sessionUri: string;
  readonly runtime: SessionRuntime;
  readonly port: number;
  /** The listener's connection token. Memory only: never returned to callers or logged. */
  readonly token: string;
  readonly bridges: Set<AttachedBridge>;
  /** When its runtime lookup started (`AhpHosts.mark()` order), to tell hosts from before a lifecycle event. */
  readonly resolvedAt: number;
  closed: boolean;
  idleTimer: NodeJS.Timeout | undefined;
  /** `host.dispose` on the runtime that started the host, once disposal began (shared by every caller). */
  disposal: Promise<void> | undefined;
}

interface HostStartResult {
  readonly hostId: string;
  readonly url?: string;
  readonly token?: string;
}

interface HostPublishResult {
  readonly sessionId: string;
  readonly sessionUri: string;
}

/** WebSocket close code for attachments ended by the platform (deleted, runtime stopped). */
export const CLOSE_SESSION_GONE = ATTACH_CLOSE_CODES.sessionGone;

const MOVING = "The session is moving into a sandbox. Reconnecting.";
/** How long a new host waits for the previous one on the same catalog to stop. */
const DISPOSAL_WAIT_MS = 5_000;

/** How a release ends the session's attached clients. */
export interface ReleaseOptions {
  /** Only release this host, not a newer one for the same session. */
  readonly only?: AhpHost;
  /** Only release a host whose runtime lookup started at or before this `mark()`. */
  readonly resolvedBy?: number;
  /** Close code for attached clients: `moved` when the session continues elsewhere. Defaults to `sessionGone`. */
  readonly code?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function moving(sessionId: string): ManagedCopilotError {
  return new ManagedCopilotError("session_busy", "This session is moving into a sandbox. Attach again when the move finishes.", { sessionId });
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Starts, reuses, and disposes per-session AHP hosts on the session's own runtime connection. A host is reused while
 * that connection lives, disposed after it has had no attached clients for `idleMs`, and re-created on demand. Starting
 * and disposing a session's host run one at a time, in order, so a release never interleaves with a start.
 *
 * A promotion fences a session (`fence` .. `unfence`): its relays stop, its host is disposed on the runtime it ran on,
 * and every start, attach, or relay that began before the fence is refused when it completes (each fence and unfence
 * bumps the session's epoch), so nothing reaches the runtime the session is leaving.
 */
export class AhpHosts {
  readonly #hosts = new Map<string, AhpHost>();
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Hosts whose `host.start`/`host.publishSession` is in flight, so a fence can wait for them and dispose them. */
  readonly #starting = new Map<string, Set<Promise<AhpHost | undefined>>>();
  readonly #fenced = new Set<string>();
  readonly #epochs = new Map<string, number>();
  /** The latest disposal per session: a runtime refuses a second host for a catalog whose host is still stopping. */
  readonly #disposals = new Map<string, Promise<void>>();
  /** Counts runtime resolutions, so a lifecycle event can release exactly the hosts resolved before it. */
  #resolutions = 0;
  readonly #log: Logger;
  readonly #idleMs: number;

  constructor(log: Logger, idleMs: number) {
    this.#log = log;
    this.#idleMs = idleMs;
  }

  isFenced(sessionId: string): boolean {
    return this.#fenced.has(sessionId);
  }

  /** Changes at every fence and unfence: work that captured an older epoch must not reach the runtime. */
  epoch(sessionId: string): number {
    return this.#epochs.get(sessionId) ?? 0;
  }

  /** The session's live host, if any. */
  current(sessionId: string): AhpHost | undefined {
    const host = this.#hosts.get(sessionId);
    return host && !host.closed ? host : undefined;
  }

  /** A point in the order runtime lookups start: hosts looked up by now have `resolvedAt <= mark()`. */
  mark(): number {
    return this.#resolutions;
  }

  /**
   * The session's host on its current runtime connection, started and published on first use. `currentRuntime` is
   * resolved in the session's queue, after any earlier release, so a lifecycle change is never undone by a stale runtime.
   */
  ensure(sessionId: string, currentRuntime: () => Promise<SessionRuntime>): Promise<AhpHost> {
    if (this.#fenced.has(sessionId)) return Promise.reject(moving(sessionId));
    return this.#serialize(sessionId, async () => {
      // Ordered when the lookup starts: `sessions.runtime()` may pick the runtime before an event and return after it.
      const resolvedAt = ++this.#resolutions;
      const runtime = await currentRuntime();
      // A runtime resolved before a fence is the one the session is leaving.
      if (this.#fenced.has(sessionId)) throw moving(sessionId);
      const epoch = this.epoch(sessionId);
      let host = this.#hosts.get(sessionId);
      if (!host || host.closed || host.runtime.connectionId !== runtime.connectionId) {
        if (host) await this.#dispose(host, "The session moved to a new runtime. Reconnecting.", ATTACH_CLOSE_CODES.moved).catch(() => undefined);
        // A fence that timed out may still be stopping the previous host on this runtime.
        await this.#settled(sessionId);
        // Fenced while waiting: nothing may start on the runtime the session is leaving. From here to the start's
        // registration in `#starting` is one synchronous step, so a later fence sees the start and waits for it.
        if (this.#fenced.has(sessionId) || this.epoch(sessionId) !== epoch) throw moving(sessionId);
        host = await this.#startTracked(sessionId, runtime, resolvedAt);
        if (this.#fenced.has(sessionId) || this.epoch(sessionId) !== epoch) {
          // Fenced while starting: it must not stay on the runtime the session is leaving (the fence waits for this).
          await this.#dispose(host, MOVING, ATTACH_CLOSE_CODES.moved).catch(() => undefined);
          throw moving(sessionId);
        }
        this.#hosts.set(sessionId, host);
      }
      // Each use restarts the idle countdown, so a ticket being redeemed keeps its host alive.
      this.#armIdle(host);
      return host;
    });
  }

  /** Records an attached client's relay so lifecycle events and fences can close it. False when the host is gone. */
  track(host: AhpHost, bridge: AttachedBridge): boolean {
    if (host.closed || this.#fenced.has(host.sessionId)) {
      bridge.close(this.#fenced.has(host.sessionId) ? ATTACH_CLOSE_CODES.moved : CLOSE_SESSION_GONE, this.#fenced.has(host.sessionId) ? MOVING : "The session's Copilot CLI hosting ended. Attach again.");
      return false;
    }
    host.bridges.add(bridge);
    this.#armIdle(host);
    void bridge.ended.then(() => {
      host.bridges.delete(bridge);
      this.#armIdle(host);
    });
    return true;
  }

  /**
   * Promotion participant fence: from now on nothing from attach reaches the session's runtime. Relays stop at once
   * (clients are told the session moved and reconnect through the SDK relay), then the host, including one still
   * starting, is disposed on the runtime that started it. Resolves once that runtime confirmed: its listener is gone,
   * so nothing relayed earlier can still arrive. A failed `host.dispose` rejects, failing the move before the checkpoint.
   * Never waits on core's session routing (the session's queue may be waiting on it).
   */
  async fence(sessionId: string, signal: AbortSignal): Promise<void> {
    this.#fenced.add(sessionId);
    this.#bump(sessionId);
    const disposals: Promise<void>[] = [];
    const host = this.#hosts.get(sessionId);
    if (host) disposals.push(this.#dispose(host, MOVING, ATTACH_CLOSE_CODES.moved));
    for (const starting of this.#starting.get(sessionId) ?? []) {
      disposals.push(starting.then((started) => (started ? this.#dispose(started, MOVING, ATTACH_CLOSE_CODES.moved) : undefined)));
    }
    await abortable(Promise.all(disposals), signal);
  }

  /** Ends a fence. The next attach starts a new host through a fresh `sessions.runtime()`. */
  unfence(sessionId: string): void {
    this.#fenced.delete(sessionId);
    this.#bump(sessionId);
  }

  /** Disposes the host after `idleMs` with no attached clients, including when its tickets are never redeemed. */
  #armIdle(host: AhpHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
    if (host.closed || host.bridges.size > 0) return;
    host.idleTimer = setTimeout(() => {
      if (host.bridges.size === 0) void this.release(host.sessionId, "idle", { only: host });
    }, this.#idleMs);
    host.idleTimer.unref();
  }

  /** Disposes the session's host and closes its attached clients with `reason`. */
  release(sessionId: string, reason: string, { only, resolvedBy, code = CLOSE_SESSION_GONE }: ReleaseOptions = {}): Promise<void> {
    return this.#serialize(sessionId, async () => {
      const host = this.#hosts.get(sessionId);
      if (!host || (only && host !== only) || (resolvedBy !== undefined && host.resolvedAt > resolvedBy)) return;
      await this.#dispose(host, reason, code).catch(() => undefined);
    });
  }

  async disposeAll(reason: string): Promise<void> {
    // Includes sessions whose host is still starting: their release runs after the start settles.
    const sessionIds = new Set([...this.#hosts.keys(), ...this.#queues.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.release(sessionId, reason)));
  }

  #bump(sessionId: string): void {
    this.#epochs.set(sessionId, this.epoch(sessionId) + 1);
  }

  /** Waits (bounded) for the session's latest host disposal, whatever its outcome. */
  async #settled(sessionId: string): Promise<void> {
    const disposal = this.#disposals.get(sessionId);
    if (!disposal) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([disposal.catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, DISPOSAL_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** Runs `task` after every earlier start or release of this session has settled. */
  #serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(sessionId, settled);
    void settled.then(() => {
      if (this.#queues.get(sessionId) === settled) this.#queues.delete(sessionId);
    });
    return result;
  }

  #startTracked(sessionId: string, runtime: SessionRuntime, resolvedAt: number): Promise<AhpHost> {
    const started = this.#start(sessionId, runtime, resolvedAt);
    const settled = started.then(
      (host) => host,
      () => undefined,
    );
    let inFlight = this.#starting.get(sessionId);
    if (!inFlight) this.#starting.set(sessionId, (inFlight = new Set()));
    inFlight.add(settled);
    void settled.then(() => {
      inFlight.delete(settled);
      if (inFlight.size === 0 && this.#starting.get(sessionId) === inFlight) this.#starting.delete(sessionId);
    });
    return started;
  }

  async #start(sessionId: string, runtime: SessionRuntime, resolvedAt: number): Promise<AhpHost> {
    const hostId = randomUUID();
    let started: HostStartResult;
    try {
      started = await runtime.request<HostStartResult>("host.start", {
        hostId,
        authentication: { mode: "none" },
        // A catalog of its own, so the listener advertises this session and nothing else from the runtime.
        computeId: `mc-session-${sessionId}`,
        localServer: { hostname: "127.0.0.1", port: 0 },
        allowCreatingNewSessions: false,
      });
    } catch (error) {
      throw new ManagedCopilotError("capability_unavailable", `This session's runtime could not start Copilot CLI hosting: ${describe(error)}`);
    }
    const dispose = () => runtime.request("host.dispose", { hostId }).catch(() => undefined);
    const port = started.url ? Number(new URL(started.url).port) : Number.NaN;
    if (!started.token || !Number.isInteger(port) || port <= 0) {
      await dispose();
      throw new ManagedCopilotError("capability_unavailable", "This session's runtime did not open a token-protected local listener for Copilot CLI.");
    }
    let published: HostPublishResult;
    try {
      published = await runtime.request<HostPublishResult>("host.publishSession", { hostId, sessionId });
    } catch (error) {
      await dispose();
      throw new ManagedCopilotError("capability_unavailable", `This session's runtime could not publish it for Copilot CLI: ${describe(error)}`);
    }
    const host: AhpHost = {
      sessionId,
      hostId,
      sessionUri: published.sessionUri,
      runtime,
      port,
      token: started.token,
      bridges: new Set(),
      resolvedAt,
      closed: false,
      idleTimer: undefined,
      disposal: undefined,
    };
    void runtime.closed.then(() => {
      if (host.closed) return;
      this.#log.info("Session runtime connection closed; ending its Copilot CLI attachments", { sessionId, hostId });
      void this.release(sessionId, "The session's runtime stopped. Attach again to resume it.", { only: host });
    });
    this.#log.info("Started Copilot CLI hosting for session", { sessionId, hostId });
    return host;
  }

  /**
   * Closes the host's clients and disposes it on the runtime that started it, once (concurrent callers share the
   * outcome). Rejects when the runtime refuses `host.dispose` while still connected; the listener may still be open.
   */
  #dispose(host: AhpHost, reason: string, code: number = CLOSE_SESSION_GONE): Promise<void> {
    if (host.disposal) return host.disposal;
    host.closed = true;
    if (this.#hosts.get(host.sessionId) === host) this.#hosts.delete(host.sessionId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    for (const bridge of host.bridges) bridge.close(code, reason.slice(0, 120));
    host.bridges.clear();
    host.disposal = (async () => {
      const failure = await Promise.race([
        host.runtime.request("host.dispose", { hostId: host.hostId }).then(
          () => undefined,
          (error: unknown) => error ?? new Error("host.dispose failed"),
        ),
        // A closed runtime connection stops its hosts with it.
        host.runtime.closed.then(() => undefined),
      ]);
      if (failure !== undefined) {
        this.#log.warn("Could not stop Copilot CLI hosting for session", { sessionId: host.sessionId, hostId: host.hostId, error: describe(failure) });
        throw new ManagedCopilotError("upstream_unavailable", `The session's runtime did not stop Copilot CLI hosting: ${describe(failure)}`, { sessionId: host.sessionId });
      }
      this.#log.info("Stopped Copilot CLI hosting for session", { sessionId: host.sessionId, hostId: host.hostId, reason });
    })();
    const disposal = host.disposal;
    this.#disposals.set(host.sessionId, disposal);
    void disposal.then(
      () => this.#forgetDisposal(host.sessionId, disposal),
      () => this.#forgetDisposal(host.sessionId, disposal),
    );
    return disposal;
  }

  #forgetDisposal(sessionId: string, disposal: Promise<void>): void {
    if (this.#disposals.get(sessionId) === disposal) this.#disposals.delete(sessionId);
  }
}
