import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/types.js";

/** Which browser sign-in a stream belongs to (a hash of its cookie), and whether that sign-in is still valid. */
export interface StreamAuth {
  readonly session: string;
  readonly active: () => boolean;
}

interface Stream extends StreamAuth {
  readonly res: ServerResponse;
}

/** Live events over server-sent events, each person's only to their own signed-in browser tabs. */
export class Hub {
  readonly #clients = new Map<string, Set<Stream>>();
  readonly #keepAlive: NodeJS.Timeout;
  readonly #onIdle: (userId: string) => void;

  /** `onIdle` runs when a person's last tab disconnects. */
  constructor(onIdle: (userId: string) => void = () => undefined, keepAliveMs = 15_000) {
    this.#onIdle = onIdle;
    this.#keepAlive = setInterval(() => this.sweep(), keepAliveMs);
    this.#keepAlive.unref();
  }

  count(userId: string): number {
    return this.#clients.get(userId)?.size ?? 0;
  }

  /** Takes over the response as this person's SSE stream; `initial` events go first. */
  attach(userId: string, req: IncomingMessage, res: ServerResponse, auth: StreamAuth, initial: readonly ServerEvent[] = []): void {
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
    const stream: Stream = { res, session: auth.session, active: auth.active };
    set.add(stream);
    const remove = () => this.#remove(userId, stream);
    req.on("close", remove);
    res.on("error", remove);
  }

  publish(userId: string, event: ServerEvent): void {
    const set = this.#clients.get(userId);
    if (!set) return;
    const payload = serialize(event);
    for (const stream of set) stream.res.write(payload);
  }

  /** Ends the streams of one browser sign-in (it signed out), even while the person is signed in elsewhere. */
  disconnectSession(session: string): void {
    for (const [userId, set] of [...this.#clients]) {
      for (const stream of [...set]) if (stream.session === session) this.#end(userId, stream);
    }
  }

  /** Ends a person's streams (they signed out everywhere). */
  disconnect(userId: string): void {
    for (const stream of [...(this.#clients.get(userId) ?? [])]) this.#end(userId, stream);
  }

  /** Keeps streams open, and ends those whose sign-in ended (it expired, or was removed) since they opened. */
  sweep(): void {
    for (const [userId, set] of [...this.#clients]) {
      for (const stream of [...set]) {
        if (stream.active()) stream.res.write(": keep-alive\n\n");
        else this.#end(userId, stream);
      }
    }
  }

  close(): void {
    clearInterval(this.#keepAlive);
    for (const set of this.#clients.values()) for (const stream of set) stream.res.end();
    this.#clients.clear();
  }

  #end(userId: string, stream: Stream): void {
    this.#remove(userId, stream);
    stream.res.end();
  }

  #remove(userId: string, stream: Stream): void {
    const current = this.#clients.get(userId);
    if (!current?.delete(stream)) return;
    if (current.size === 0) {
      this.#clients.delete(userId);
      this.#onIdle(userId);
    }
  }
}

function serialize(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
