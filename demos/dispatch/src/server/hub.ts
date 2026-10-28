import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/types.js";

type Listener = (event: ServerEvent) => void;

/** Fans server events out to browsers over server-sent events and to in-process listeners. */
export class EventHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #listeners = new Set<Listener>();
  readonly #keepAlive: NodeJS.Timeout;

  constructor(keepAliveMs = 15_000) {
    this.#keepAlive = setInterval(() => {
      for (const client of this.#clients) client.write(": keep-alive\n\n");
    }, keepAliveMs);
    this.#keepAlive.unref();
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Takes over the response as an SSE stream; `initial` events are sent first. */
  attach(req: IncomingMessage, res: ServerResponse, initial: readonly ServerEvent[] = []): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    for (const event of initial) res.write(serialize(event));
    this.#clients.add(res);
    const remove = () => this.#clients.delete(res);
    req.on("close", remove);
    res.on("error", remove);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    const payload = serialize(event);
    for (const client of this.#clients) client.write(payload);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break fan-out.
      }
    }
  }

  close(): void {
    clearInterval(this.#keepAlive);
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    this.#listeners.clear();
  }
}

function serialize(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
