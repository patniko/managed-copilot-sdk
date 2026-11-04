import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/types.js";

/** Fans server events out to browsers over server-sent events. */
export class EventHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #keepAlive: NodeJS.Timeout;

  constructor(keepAliveMs = 15_000) {
    this.#keepAlive = setInterval(() => {
      for (const client of this.#clients) client.write(": keep-alive\n\n");
    }, keepAliveMs);
    this.#keepAlive.unref();
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

  publish(event: ServerEvent): void {
    const payload = serialize(event);
    for (const client of this.#clients) client.write(payload);
  }

  close(): void {
    clearInterval(this.#keepAlive);
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }
}

function serialize(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
