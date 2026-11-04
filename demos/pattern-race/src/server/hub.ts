import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppState } from "../shared/types.js";

/** Sends the app's state to browsers over server-sent events: the whole state each time, a few times a second at most. */
export class StateHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #keepAlive: NodeJS.Timeout;
  readonly #read: () => AppState;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #last = 0;

  constructor(read: () => AppState, options: { intervalMs?: number; keepAliveMs?: number } = {}) {
    this.#read = read;
    this.#intervalMs = options.intervalMs ?? 200;
    this.#keepAlive = setInterval(() => {
      for (const client of this.#clients) client.write(": keep-alive\n\n");
    }, options.keepAliveMs ?? 15_000);
    this.#keepAlive.unref();
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Takes over the response as an SSE stream that starts with the current state. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(serialize(this.#read()));
    this.#clients.add(res);
    const remove = () => this.#clients.delete(res);
    req.on("close", remove);
    res.on("error", remove);
  }

  /** Something changed: send the state now, or once the interval since the last send has passed. */
  changed(): void {
    if (this.#timer) return;
    const wait = Math.max(0, this.#last + this.#intervalMs - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#last = Date.now();
      if (this.#clients.size === 0) return;
      const payload = serialize(this.#read());
      for (const client of this.#clients) client.write(payload);
    }, wait);
    this.#timer.unref?.();
  }

  close(): void {
    clearInterval(this.#keepAlive);
    if (this.#timer) clearTimeout(this.#timer);
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }
}

function serialize(state: AppState): string {
  return `event: state\ndata: ${JSON.stringify(state)}\n\n`;
}
