// Platform events: an owner-scoped bus that feeds SSE `/v1/events` (with `Last-Event-ID` replay from the ledger)
// and in-process subscribers such as webhooks.
import { randomUUID } from "node:crypto";
import type { PlatformEvent, PlatformEventType } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { RequestContext } from "../../http.js";
import type { EventsService, PlatformEventMeta } from "./contracts.js";
import type { SessionLedger } from "./ledger.js";

type Listener = (event: PlatformEvent, meta: PlatformEventMeta) => void;

export class PlatformEvents implements EventsService {
  readonly #ledger: SessionLedger;
  readonly #log: Logger;
  readonly #listeners = new Set<Listener>();
  #published = 0;

  constructor(ledger: SessionLedger, log: Logger) {
    this.#ledger = ledger;
    this.#log = log;
  }

  publish(event: PlatformEvent, meta: PlatformEventMeta): void {
    try {
      this.#ledger.appendEvent(event, meta.ownerId);
      if (++this.#published % 1000 === 0) this.#ledger.pruneEvents();
    } catch (error) {
      this.#log.warn("Could not persist platform event", { type: event.type, error: (error as Error).message });
    }
    for (const listener of this.#listeners) {
      try {
        listener(event, meta);
      } catch (error) {
        this.#log.warn("Platform event listener failed", { type: event.type, error: (error as Error).message });
      }
    }
  }

  emit(type: PlatformEventType, input: { ownerId: number; sessionId?: string; environment?: string; data?: Record<string, unknown> }): PlatformEvent {
    const event: PlatformEvent = {
      id: `evt_${randomUUID()}`,
      type,
      createdAt: new Date().toISOString(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      data: input.data ?? {},
    };
    this.publish(event, { ownerId: input.ownerId });
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Serves `GET /v1/events` as server-sent events for the authenticated owner. */
  stream(ctx: RequestContext): void {
    const principal = ctx.principal!;
    const types = ctx.query.get("types")?.split(",").filter(Boolean);
    const { res, req } = ctx;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const send = (event: PlatformEvent) => {
      if (types && !types.includes(event.type)) return;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? ctx.query.get("lastEventId") ?? undefined;
    if (lastEventId) {
      for (const { event } of this.#ledger.eventsAfter(principal.accountId, lastEventId)) send(event);
    }
    const unsubscribe = this.subscribe((event, meta) => {
      if (meta.ownerId === principal.accountId) send(event);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    heartbeat.unref();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }
}
