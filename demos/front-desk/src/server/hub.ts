import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/types.js";

/** Live events over server-sent events, each person's only to their own browser tabs. */
export class Hub {
  readonly #clients = new Map<string, Set<ServerResponse>>();
  readonly #keepAlive: NodeJS.Timeout;
  readonly #onIdle: (userId: string) => void;

  /** `onIdle` runs when a person's last tab disconnects. */
  constructor(onIdle: (userId: string) => void = () => undefined, keepAliveMs = 15_000) {
    this.#onIdle = onIdle;
    this.#keepAlive = setInterval(() => {
      for (const set of this.#clients.values()) for (const client of set) client.write(": keep-alive\n\n");
    }, keepAliveMs);
    this.#keepAlive.unref();
  }

  count(userId: string): number {
    return this.#clients.get(userId)?.size ?? 0;
  }

  /** Takes over the response as this person's SSE stream; `initial` events go first. */
  attach(userId: string, req: IncomingMessage, res: ServerResponse, initial: readonly ServerEvent[] = []): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    for (const event of initial) res.write(serialize(event));
    let set = this.#clients.get(userId);
    if (!set) {
      set = new Set();
      this.#clients.set(userId, set);
    }
    set.add(res);
    const remove = () => {
      const current = this.#clients.get(userId);
      if (!current?.delete(res)) return;
      if (current.size === 0) {
        this.#clients.delete(userId);
        this.#onIdle(userId);
      }
    };
    req.on("close", remove);
    res.on("error", remove);
  }

  publish(userId: string, event: ServerEvent): void {
    const set = this.#clients.get(userId);
    if (!set) return;
    const payload = serialize(event);
    for (const client of set) client.write(payload);
  }

  /** Ends a person's streams (they signed out). */
  disconnect(userId: string): void {
    const set = this.#clients.get(userId);
    if (!set) return;
    this.#clients.delete(userId);
    for (const client of set) client.end();
  }

  close(): void {
    clearInterval(this.#keepAlive);
    for (const set of this.#clients.values()) for (const client of set) client.end();
    this.#clients.clear();
  }
}

function serialize(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
