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
 * that connection lives, disposed after it has had no attached clients for `idleMs`, and re-created on demand.
 */
export class AhpHosts {
  readonly #hosts = new Map<string, Promise<AhpHost>>();
  readonly #log: Logger;
  readonly #idleMs: number;

  constructor(log: Logger, idleMs: number) {
    this.#log = log;
    this.#idleMs = idleMs;
  }

  /** The session's host on its current runtime connection, started and published on first use. Calls are serialized per session. */
  ensure(sessionId: string, runtime: SessionRuntime): Promise<AhpHost> {
    const previous = this.#hosts.get(sessionId);
    const next = (async () => {
      const host = previous ? await previous.catch(() => undefined) : undefined;
      if (host && !host.closed && host.runtime.connectionId === runtime.connectionId) return host;
      if (host && !host.closed) await this.#dispose(host, "The session moved to a new runtime connection. Attach again.");
      return this.#start(sessionId, runtime);
    })();
    this.#hosts.set(sessionId, next);
    next.catch(() => {
      if (this.#hosts.get(sessionId) === next) this.#hosts.delete(sessionId);
    });
    return next;
  }

  /** Records an attached client so lifecycle events can close it and idle hosts can be disposed. */
  track(host: AhpHost, socket: WebSocket): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
    host.sockets.add(socket);
    socket.once("close", () => {
      host.sockets.delete(socket);
      if (host.sockets.size > 0 || host.closed) return;
      host.idleTimer = setTimeout(() => {
        if (host.sockets.size === 0) void this.release(host.sessionId, "idle", host);
      }, this.#idleMs);
      host.idleTimer.unref();
    });
  }

  /** Disposes the session's host and closes its attached clients with `reason`. */
  async release(sessionId: string, reason: string, only?: AhpHost): Promise<void> {
    const current = this.#hosts.get(sessionId);
    if (!current) return;
    const host = await current.catch(() => undefined);
    if (!host || (only && host !== only)) return;
    if (this.#hosts.get(sessionId) === current) this.#hosts.delete(sessionId);
    await this.#dispose(host, reason);
  }

  async disposeAll(reason: string): Promise<void> {
    await Promise.all([...this.#hosts.keys()].map((sessionId) => this.release(sessionId, reason)));
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
    if (host.idleTimer) clearTimeout(host.idleTimer);
    for (const socket of host.sockets) socket.close(CLOSE_SESSION_GONE, reason.slice(0, 120));
    host.sockets.clear();
    await Promise.race([host.runtime.request("host.dispose", { hostId: host.hostId }).catch(() => undefined), host.runtime.closed]);
    this.#log.info("Stopped Copilot CLI hosting for session", { sessionId: host.sessionId, hostId: host.hostId, reason });
  }
}
