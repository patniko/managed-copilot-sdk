// What the game tells Downhill's server as it's played (`POST /api/game/events`): rides, tricks, crashes, and the shop.
// The server checks each event and sends it on as an OpenTelemetry log record, so it streams into Incident Commander
// with the server's own logs and the shop's checkouts. Checkout outcomes go to `POST /api/shop/events` instead.
import type { RiderId } from "./support.js";

export const GAME_EVENT_TYPES = ["ride_started", "checkpoint", "trick", "crash", "ride_finished", "shop_opened", "cart_added"] as const;
export type GameEventType = (typeof GAME_EVENT_TYPES)[number];

interface GameEventBase {
  readonly rider: RiderId;
  /** When it happened in the browser, ms since the epoch. */
  readonly at: number;
  /** The world being ridden (id and name), for ride events. */
  readonly world?: string;
  readonly worldName?: string;
  /** The autopilot rode it (playtests), not a person. */
  readonly bot?: boolean;
}

export type GameEvent =
  | (GameEventBase & { readonly type: "ride_started" })
  | (GameEventBase & { readonly type: "checkpoint"; readonly checkpoint: number; readonly total: number })
  | (GameEventBase & { readonly type: "trick"; readonly title: string; readonly points: number; readonly combo: number; readonly perfect: boolean })
  | (GameEventBase & { readonly type: "crash"; readonly reason: string; readonly kmh?: number })
  | (GameEventBase & { readonly type: "ride_finished"; readonly seconds: number; readonly score: number; readonly tricks: number; readonly crashes: number })
  | (GameEventBase & { readonly type: "shop_opened" })
  | (GameEventBase & { readonly type: "cart_added"; readonly sku: string });

/** The body of `POST /api/game/events`: a batch of events, oldest first. */
export interface GameEventsRequest {
  readonly events: readonly GameEvent[];
}

/** The most events in one request. */
export const MAX_GAME_EVENTS = 25;
