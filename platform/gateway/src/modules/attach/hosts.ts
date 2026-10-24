import { randomUUID } from "node:crypto";
import { ATTACH_CLOSE_CODES, ManagedCopilotError } from "@managed-copilot/protocol";
import type { WebSocket } from "ws";
import type { Logger } from "../../log.js";
import type { SessionRuntime } from "./types.js";

/** A runtime-supervised AHP listener that advertises exactly one session (its own `computeId` catalog). */
export interface AhpHost {
  readonly sessionId: string;
  readonly hostId: string;
  readonly sessionUri: string;
  readonly runtime: SessionRuntime;
  readonly port: number;
  /** The listener's connection token. Memory only: never returned to callers or logged. */
  readonly token: string;
  readonly sockets: Set<WebSocket>;
  closed: boolean;
  idleTimer: NodeJS.Timeout | undefined;
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

/** WebSocket close code for attachments ended by the platform (deleted, moved, runtime stopped). */
export const CLOSE_SESSION_GONE = ATTACH_CLOSE_CODES.sessionGone;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts, reuses, and disposes per-session AHP hosts on the session's own runtime connection. A host is reused while
 * that connection lives, disposed after it has had no attached clients for `idleMs`, and re-created on demand. Starting
 * and disposing a session's host run one at a time, in order, so a release never interleaves with a start.
 */
export class AhpHosts {
  readonly #hosts = new Map<string, AhpHost>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #log: Logger;
  readonly #idleMs: number;

  constructor(log: Logger, idleMs: number) {
    this.#log = log;
    this.#idleMs = idleMs;
  }

  /** The session's host on its current runtime connection, started and published on first use. */
  ensure(sessionId: string, runtime: SessionRuntime): Promise<AhpHost> {
    return this.#serialize(sessionId, async () => {
      let host = this.#hosts.get(sessionId);
      if (!host || host.closed || host.runtime.connectionId !== runtime.connectionId) {
        if (host) await this.#dispose(host, "The session moved to a new runtime connection. Attach again.");
        host = await this.#start(sessionId, runtime);
        this.#hosts.set(sessionId, host);
      }
      // Each use restarts the idle countdown, so a ticket being redeemed keeps its host alive.
      this.#armIdle(host);
      return host;
    });
  }

  /** Records an attached client so lifecycle events can close it and idle hosts can be disposed. */
  track(host: AhpHost, socket: WebSocket): void {
    if (host.closed) {
      socket.close(CLOSE_SESSION_GONE, "The session's Copilot CLI hosting ended. Attach again.");
      return;
    }
    host.sockets.add(socket);
    this.#armIdle(host);
    socket.once("close", () => {
      host.sockets.delete(socket);
      this.#armIdle(host);
    });
  }

  /** Disposes the host after `idleMs` with no attached clients, including when its tickets are never redeemed. */
  #armIdle(host: AhpHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
    if (host.closed || host.sockets.size > 0) return;
    host.idleTimer = setTimeout(() => {
      if (host.sockets.size === 0) void this.release(host.sessionId, "idle", host);
    }, this.#idleMs);
    host.idleTimer.unref();
  }

  /** Disposes the session's host (only `only`, when given) and closes its attached clients with `reason`. */
  release(sessionId: string, reason: string, only?: AhpHost): Promise<void> {
    return this.#serialize(sessionId, async () => {
      const host = this.#hosts.get(sessionId);
      if (!host || (only && host !== only)) return;
      await this.#dispose(host, reason);
    });
  }

  async disposeAll(reason: string): Promise<void> {
    // Includes sessions whose host is still starting: their release runs after the start settles.
    const sessionIds = new Set([...this.#hosts.keys(), ...this.#queues.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.release(sessionId, reason)));
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

  async #start(sessionId: string, runtime: SessionRuntime): Promise<AhpHost> {
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
      sockets: new Set(),
      closed: false,
      idleTimer: undefined,
    };
    void runtime.closed.then(() => {
      if (host.closed) return;
      this.#log.info("Session runtime connection closed; ending its Copilot CLI attachments", { sessionId, hostId });
      void this.release(sessionId, "The session's runtime stopped. Attach again to resume it.", host);
    });
    this.#log.info("Started Copilot CLI hosting for session", { sessionId, hostId });
    return host;
  }

  async #dispose(host: AhpHost, reason: string): Promise<void> {
    if (host.closed) return;
    host.closed = true;
    if (this.#hosts.get(host.sessionId) === host) this.#hosts.delete(host.sessionId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    for (const socket of host.sockets) socket.close(CLOSE_SESSION_GONE, reason.slice(0, 120));
    host.sockets.clear();
    await Promise.race([host.runtime.request("host.dispose", { hostId: host.hostId }).catch(() => undefined), host.runtime.closed]);
    this.#log.info("Stopped Copilot CLI hosting for session", { sessionId: host.sessionId, hostId: host.hostId, reason });
  }
}
