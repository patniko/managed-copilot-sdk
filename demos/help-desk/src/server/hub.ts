import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlayerTicket, ServerEvent } from "../shared/types.js";

/** What one client gets of an event: the event, a narrower one, or nothing. */
export type EventView = (event: ServerEvent) => ServerEvent | undefined;

/** Fans server events out to browsers over server-sent events. */
export class EventHub {
  /** Each client, and what it gets of each event (everything, without a view). */
  readonly #clients = new Map<ServerResponse, EventView | undefined>();
  readonly #keepAlive: NodeJS.Timeout;

  constructor(keepAliveMs = 15_000) {
    this.#keepAlive = setInterval(() => {
      for (const client of this.#clients.keys()) client.write(": keep-alive\n\n");
    }, keepAliveMs);
    this.#keepAlive.unref();
  }

  /** Takes over the response as an SSE stream; `initial` events are sent first, then what `view` lets through. */
  attach(req: IncomingMessage, res: ServerResponse, initial: readonly ServerEvent[] = [], view?: EventView): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    for (const event of initial) {
      const shown = view ? view(event) : event;
      if (shown) res.write(serialize(shown));
    }
    this.#clients.set(res, view);
    const remove = () => this.#clients.delete(res);
    req.on("close", remove);
    res.on("error", remove);
  }

  publish(event: ServerEvent): void {
    const payload = serialize(event);
    for (const [client, view] of this.#clients) {
      if (!view) {
        client.write(payload);
        continue;
      }
      const shown = view(event);
      if (shown) client.write(shown === event ? payload : serialize(shown));
    }
  }

  close(): void {
    clearInterval(this.#keepAlive);
    for (const client of this.#clients.keys()) client.end();
    this.#clients.clear();
  }
}

/** A player's ticket as the player sees it: without the team's notes to the agent, or the known issue it was matched with. */
export function playerFacing(ticket: PlayerTicket): PlayerTicket {
  const { knownIssue: _team, ...rest } = ticket;
  return { ...rest, items: ticket.items.filter((item) => item.kind !== "message" || item.from !== "team") };
}

/** A player's chat page: the platform's status and their own ticket (`playerFacing`), never anyone else's conversation. */
export function playerView(ticketId: string): EventView {
  return (event) => {
    switch (event.type) {
      case "platform":
        return event;
      case "player":
        return event.ticket.ticketId === ticketId ? { type: "player", ticket: playerFacing(event.ticket) } : undefined;
      case "players":
        return { type: "players", players: event.players.filter((ticket) => ticket.ticketId === ticketId).map(playerFacing) };
      default:
        return undefined;
    }
  };
}

function serialize(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
