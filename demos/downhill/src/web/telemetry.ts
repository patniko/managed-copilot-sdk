// The game's side of telemetry: what the player does, batched and sent to Downhill's server (`POST /api/game/events`),
// which streams it to Incident Commander over OpenTelemetry. Fire and forget: it never holds up the game.
import type { RiderId } from '../shared/support';
import { MAX_GAME_EVENTS, type GameEvent } from '../shared/telemetry';

/** How long events wait to be sent together, ms. */
const BATCH_MS = 400;
/** Events kept while the server can't be reached; older ones are dropped. */
const MAX_QUEUED = 100;

/** A game event as the game describes it: the rider and the time are added when it's tracked. */
export type GameEventInput = GameEvent extends infer E ? (E extends unknown ? Omit<E, 'rider' | 'at'> : never) : never;

export class GameTelemetry {
  private queue: GameEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly send: (events: readonly GameEvent[]) => Promise<unknown> = postEvents) {
    addEventListener('pagehide', () => this.flush());
  }

  track(rider: RiderId, event: GameEventInput): void {
    this.queue.push({ ...event, rider, at: Date.now() } as GameEvent);
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    // The shop's events go at once, so they arrive before the checkout outcomes that follow them.
    if (event.type === 'shop_opened' || event.type === 'cart_added') this.flush();
    else this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_GAME_EVENTS);
      this.send(batch).catch((error: unknown) => console.warn('[telemetry] couldn’t send game events', error));
    }
  }
}

async function postEvents(events: readonly GameEvent[]): Promise<void> {
  const response = await fetch('/api/game/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }), keepalive: true });
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
}
