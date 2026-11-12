// A player's chat page (`/chat/<ticket>`), which Downhill shows in a frame on its own origin: the player's ticket and
// Managed Copilot's status, live over Help Desk's event stream (narrowed to that one ticket), and the player's messages.
// Its requests go to Help Desk's own origin, so the API's cross-site check still holds.
import { useSyncExternalStore } from "react";
import type { PlatformStatus, PlayerTicket, ServerEvent } from "../../shared/types.js";
import { api, ApiError } from "./api.js";

export interface ChatState {
  /** `missing`: no such ticket; `unreachable`: Help Desk didn't answer the first load. */
  readonly phase: "loading" | "ready" | "missing" | "unreachable";
  readonly ticket?: PlayerTicket;
  /** The ticket was ended while the page was open. */
  readonly ended: boolean;
  readonly platform?: PlatformStatus;
  /** Help Desk's live event stream. */
  readonly connection: "connecting" | "open" | "reconnecting";
}

export const UNREACHABLE = "Can't reach Contoso Outdoors support right now.";

/** Applies one server event to the chat of `ticketId`. Exported for tests. */
export function reduceChat(current: ChatState, event: ServerEvent, ticketId: string): ChatState {
  switch (event.type) {
    case "platform":
      return { ...current, platform: event.platform };
    case "player":
      return event.ticket.ticketId === ticketId && !current.ended ? { ...current, phase: "ready", ticket: event.ticket } : current;
    case "players": {
      const ticket = event.players.find((candidate) => candidate.ticketId === ticketId);
      if (ticket) return current.ended ? current : { ...current, phase: "ready", ticket };
      // No longer listed: the ticket was ended.
      return current.phase === "ready" ? { ...current, ended: true } : current;
    }
    default:
      return current;
  }
}

let ticketId = "";
let state: ChatState = { phase: "loading", ended: false, connection: "connecting" };
const listeners = new Set<() => void>();

function setState(update: (current: ChatState) => ChatState): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  if (state.ended) source?.close();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChat(): ChatState {
  return useSyncExternalStore(subscribe, () => state);
}

async function load(): Promise<void> {
  try {
    const ticket = await api.player(ticketId);
    setState((current) => (current.ended ? current : { ...current, phase: "ready", ticket }));
    connect();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      setState((current) => (current.phase === "ready" ? { ...current, ended: true } : { ...current, phase: "missing" }));
      return;
    }
    setState((current) => (current.phase === "ready" ? current : { ...current, phase: "unreachable" }));
  }
}

let started = false;

/** Loads the ticket, then follows it. Safe to call more than once. */
export function startChat(id: string): void {
  if (started) return;
  started = true;
  ticketId = id;
  if (!/^[a-z0-9]{8,32}$/.test(id)) {
    setState((current) => ({ ...current, phase: "missing" }));
    return;
  }
  void load();
}

/** After Help Desk didn't answer: tries again. */
export function retryChat(): void {
  setState((current) => ({ ...current, phase: "loading" }));
  void load();
}

/** Sends a message as the player. Returns why it wasn't sent, in plain words, or nothing when it was. */
export async function sendChat(text: string): Promise<string | undefined> {
  try {
    await api.sendAsPlayer(ticketId, text);
    return undefined;
  } catch (error) {
    if (!(error instanceof ApiError)) return "Your message wasn't sent. Try again.";
    if (error.status === 404) {
      setState((current) => ({ ...current, ended: true }));
      return "This support chat has ended.";
    }
    return error.code === "network_error" ? UNREACHABLE : error.message;
  }
}

// ─── Server-sent events ──────────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES: readonly ServerEvent["type"][] = ["platform", "player", "players"];
let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1_000;

function connect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (state.ended) return;
  source?.close();
  // Each (re)connection starts with the platform's status and the ticket as it is now.
  const events = new EventSource(`/api/events?player=${encodeURIComponent(ticketId)}`);
  source = events;
  events.onopen = () => {
    backoffMs = 1_000;
    setState((current) => (current.connection === "open" ? current : { ...current, connection: "open" }));
  };
  events.onerror = () => {
    if (source !== events || state.ended) return;
    setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
    if (events.readyState === EventSource.CLOSED) scheduleReconnect();
  };
  const onMessage = (message: MessageEvent): void => {
    try {
      const event = JSON.parse(String(message.data)) as ServerEvent;
      if (typeof event?.type === "string") setState((current) => reduceChat(current, event, ticketId));
    } catch {
      // Ignore malformed messages.
    }
  };
  for (const type of EVENT_TYPES) events.addEventListener(type, onMessage as EventListener);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  const delay = backoffMs + Math.round(Math.random() * 400);
  backoffMs = Math.min(backoffMs * 2, 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}
