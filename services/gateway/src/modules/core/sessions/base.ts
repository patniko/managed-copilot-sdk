// The session manager's state and the pieces every layer uses: optional services, ledger tracking, and
// sanitization of what clients see.
import type { Placement } from "@managed-copilot/protocol";
import type { Logger } from "../../../log.js";
import type { ActionsService, RuntimeSessionEvent } from "../../durable/contract.js";
import {
  optionalService,
  type NetworkPolicyService,
  type SandboxPlacement,
  type SessionEventListener,
  type SessionRecord,
} from "../contracts.js";
import type { SessionLedger } from "../ledger.js";
import type { IncomingRequestContext } from "../rpc.js";
import { RuntimeUpstream, type UpstreamHandlers } from "../runtime.js";
import type { LiveSession, SessionManagerOptions } from "./types.js";
import { pathScrubber } from "./support.js";

export abstract class SessionManagerBase {
  // Implemented by later layers of SessionManager.
  protected abstract onUpstreamNotification(upstream: RuntimeUpstream, method: string, params: unknown): void;
  protected abstract onUpstreamRequest(upstream: RuntimeUpstream, method: string, params: unknown, context: IncomingRequestContext): Promise<unknown>;
  protected abstract onUpstreamClosed(upstream: RuntimeUpstream): void;
  abstract get(sessionId: string): SessionRecord | undefined;

  protected readonly options: SessionManagerOptions;
  protected readonly log: Logger;
  protected readonly ledger: SessionLedger;
  protected readonly live = new Map<string, LiveSession>();
  protected readonly listeners = new Set<SessionEventListener>();
  protected readonly sessionListeners = new Map<string, Set<SessionEventListener>>();
  protected readonly lifecycle = new Set<(event: { sessionId: string; type: "deleted" | "promoted" | "stopped" }) => void>();
  protected readonly runtimeHandlers: UpstreamHandlers;
  /** Session IDs reserved by in-flight creates. */
  protected readonly creating = new Map<string, { ownerId: number; done: Promise<unknown> }>();
  /** Session IDs whose deletion (or interrupted-create cleanup) is running in this process. */
  protected readonly deletions = new Set<string>();
  /** Interrupted-create cleanups in flight, by session ID. */
  protected readonly discards = new Map<string, Promise<void>>();
  /** Set once the gateway stops. */
  protected stopped = false;
  readonly #scrubber: ((value: unknown) => unknown) | undefined;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.log = options.log;
    this.ledger = options.ledger;
    this.#scrubber = options.sharedRuntime ? pathScrubber(options.app.config.dataDir) : undefined;
    this.runtimeHandlers = {
      onNotification: (upstream, method, params) => this.onUpstreamNotification(upstream, method, params),
      onRequest: (upstream, method, params, context) => this.onUpstreamRequest(upstream, method, params, context),
      onClose: (upstream) => this.onUpstreamClosed(upstream),
    };
  }

  /** Handlers the shared runtime's upstream uses. */
  get upstreamHandlers(): UpstreamHandlers {
    return this.runtimeHandlers;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Optional services from other modules

  protected get actions(): ActionsService | undefined {
    return this.options.app.services.actions;
  }

  protected get sandboxes(): SandboxPlacement | undefined {
    return optionalService<SandboxPlacement>(this.options.app.services, "sandboxes");
  }

  protected get policy(): NetworkPolicyService | undefined {
    return optionalService<NetworkPolicyService>(this.options.app.services, "policy");
  }

  // ------------------------------------------------------------------------------------------------------------
  // Ledger tracking and sanitization

  protected track(live: LiveSession, event: RuntimeSessionEvent): void {
    const data = event.data ?? {};
    try {
      // A session being deleted keeps that state (startup recovery finishes deletions by it), whatever events still
      // arrive for it, such as those a cutover the deletion aborted flushes.
      const state = (next: "running" | "idle") => (live.deleting ? {} : { state: next });
      switch (event.type) {
        case "user.message":
          if (!event.agentId) {
            this.ledger.update(live.id, { ...state("running"), lastTurn: { turnId: String(data["messageId"] ?? event.id), status: "running" } });
          }
          break;
        case "session.idle": {
          if (event.agentId) break;
          const record = this.get(live.id);
          const turn = record?.lastTurn;
          const status = data["aborted"] === true ? "cancelled" : turn?.status === "failed" ? "failed" : "completed";
          // A session whose deletion failed stays failed (deletable again) when a turn ends, until it runs another.
          const next = record?.state === "failed" ? {} : state("idle");
          this.ledger.update(live.id, { ...next, ...(turn ? { lastTurn: { turnId: turn.turnId, status, completedAt: new Date().toISOString() } } : {}) });
          if (record) this.options.events.emit("session.idle", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { status, incarnation: record.incarnation } });
          break;
        }
        case "session.error": {
          const record = this.get(live.id);
          if (record?.lastTurn) this.ledger.update(live.id, { lastTurn: { ...record.lastTurn, status: "failed" } });
          if (record) this.options.events.emit("session.failed", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { message: String(data["message"] ?? "Session error"), incarnation: record.incarnation } });
          break;
        }
        case "session.title_changed":
          if (typeof data["title"] === "string") this.ledger.update(live.id, { title: data["title"] });
          break;
        case "session.model_change":
          if (typeof data["newModel"] === "string") this.ledger.update(live.id, { model: data["newModel"] });
          break;
      }
    } catch (error) {
      this.log.warn("Ledger update from session event failed", { sessionId: live.id, type: event.type, error: (error as Error).message });
    }
  }

  /** Shared sessions must not leak platform host paths to clients, except with `unsafeHostTools`, which work on the host. */
  #hidesHostPaths(live: LiveSession, placement: Placement): boolean {
    return placement === "shared" && live.environment.config.unsafeHostTools !== true;
  }

  protected sanitizeEvent(live: LiveSession, event: RuntimeSessionEvent, placement: Placement = live.placement): RuntimeSessionEvent {
    if (!this.#hidesHostPaths(live, placement)) return event;
    if (event.type === "session.start" && event.data && "context" in event.data) {
      const { context: _context, ...data } = event.data;
      return { ...event, data };
    }
    if (event.type === "external_tool.requested" && event.data && "workingDirectory" in event.data) {
      const { workingDirectory: _workingDirectory, ...data } = event.data;
      return { ...event, data };
    }
    return event;
  }

  protected sanitizeResponse(live: LiveSession, result: unknown, placement: Placement = live.placement): unknown {
    if (!this.#hidesHostPaths(live, placement) || !result || typeof result !== "object") return result;
    const { workspacePath: _workspacePath, ...rest } = result as Record<string, unknown>;
    return rest;
  }

  /**
   * Replaces platform host paths in anything a shared session sends to clients (events, responses, and runtime
   * requests): the session's private directory becomes `/workspace`, any other runtime path `/platform`.
   */
  /** `placement`: where the value came from (a cutover may have moved the session since). */
  protected scrub<T>(live: LiveSession, value: T, placement: Placement = live.placement): T {
    if (!this.#hidesHostPaths(live, placement)) return value;
    const scrubber = this.#scrubber;
    return scrubber ? (scrubber(value) as T) : value;
  }

  protected emitLifecycle(sessionId: string, type: "deleted" | "promoted" | "stopped"): void {
    for (const listener of this.lifecycle) {
      try {
        listener({ sessionId, type });
      } catch (error) {
        this.log.warn("Lifecycle listener failed", { error: (error as Error).message });
      }
    }
  }
}
