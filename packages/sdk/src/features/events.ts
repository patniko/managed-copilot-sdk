// Owner: core workstream. Subscribes to `GET /v1/events` (server-sent events) for `managed.on(...)`.
import { ROUTES, type PlatformEvent } from "@managed-copilot/protocol";
import { timings } from "../http.js";
import type { ManagedContext } from "../types.js";

const streams = new WeakMap<ManagedContext, AbortController>();

/** Dispatches one platform event to `managed.on(type)` and `managed.on("*")` handlers. */
export function dispatchEvent(ctx: ManagedContext, event: PlatformEvent): void {
  for (const key of [event.type, "*"] as const) {
    for (const handler of ctx.listeners.get(key) ?? []) {
      try {
        handler(event);
      } catch {
        // A failing handler must not stop delivery to the others.
      }
    }
  }
}

/** Parses an SSE byte stream into events. */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const message: { id?: string; event?: string; data: string } = { data: "" };
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
          if (field === "id") message.id = value;
          else if (field === "event") message.event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length === 0) continue;
        message.data = data.join("\n");
        yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Starts the event stream on first subscription; reconnects with backoff and `Last-Event-ID`. The connection is
 * bounded, and a stream that stays silent for three of the gateway's 15 s heartbeats (a gateway being replaced, a
 * proxy holding a dead connection) is dropped and resumed. Never throws.
 */
export function ensureEventStream(ctx: ManagedContext): void {
  if (streams.has(ctx)) return;
  const controller = new AbortController();
  streams.set(ctx, controller);
  ctx.disposables.add(() => {
    controller.abort();
    streams.delete(ctx);
  });
  void (async () => {
    let lastEventId: string | undefined;
    let delay = timings.eventsRetryMs;
    while (!controller.signal.aborted) {
      try {
        const response = await ctx.http.fetch("GET", ROUTES.events, {
          headers: { accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
          signal: controller.signal,
          timeoutMs: timings.connectMs,
          idleTimeoutMs: timings.eventsIdleMs,
        });
        if (!response.body) throw new Error("The event stream has no body");
        delay = timings.eventsRetryMs;
        for await (const message of parseEventStream(response.body)) {
          if (message.id) lastEventId = message.id;
          try {
            dispatchEvent(ctx, JSON.parse(message.data) as PlatformEvent);
          } catch {
            // Skip malformed events.
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}
