import { useSyncExternalStore } from "react";
import type {
  ApprovalMode,
  Blueprint,
  ConversationSettings,
  ConversationSummary,
  ConversationView,
  CoordinatorInfo,
  PlatformStatus,
  ServerEvent,
  Template,
} from "../../shared/types.js";
import { api, errorMessage } from "./api.js";
import { homeHref, navigate, parseHash } from "./router.js";
import { toast } from "./toast.js";

export type Connection = "connecting" | "open" | "reconnecting";

/** A message the person sent that the conversation doesn't show yet. */
export interface Outgoing {
  readonly key: number;
  readonly text: string;
  readonly at: number;
  /** How many messages with this text the conversation showed when it was sent: one more means it arrived. */
  readonly baseline: number;
  readonly failed?: string;
}

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  readonly coordinator?: CoordinatorInfo;
  readonly blueprints: readonly Blueprint[];
  /** Most recently updated first. */
  readonly conversations: readonly ConversationSummary[];
  readonly views: Readonly<Record<string, ConversationView>>;
  readonly viewErrors: Readonly<Record<string, string>>;
  readonly outgoing: Readonly<Record<string, readonly Outgoing[]>>;
  readonly templates: readonly Template[];
  readonly defaults: ConversationSettings;
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
}

const initialState: StoreState = {
  phase: "loading",
  connection: "connecting",
  blueprints: [],
  conversations: [],
  views: {},
  viewErrors: {},
  outgoing: {},
  templates: [],
  defaults: { approvals: "ask" },
  attachCommand: "",
  canLaunchTerminal: false,
};

let state: StoreState = initialState;
const listeners = new Set<() => void>();

function setState(update: (current: StoreState) => StoreState): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): StoreState {
  return state;
}

/** Subscribes to a slice of the store. Selectors must return existing references (no new objects or arrays). */
export function useStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

// ─── Server state ────────────────────────────────────────────────────────────────────────────────────────────

async function loadState(): Promise<void> {
  try {
    const loaded = await api.state();
    setState((current) => ({
      ...current,
      phase: "ready",
      platform: loaded.platform,
      ...(loaded.coordinator ? { coordinator: loaded.coordinator } : {}),
      blueprints: loaded.blueprints,
      conversations: loaded.conversations,
      templates: loaded.templates,
      defaults: loaded.defaults,
      attachCommand: loaded.attachCommand,
      canLaunchTerminal: loaded.canLaunchTerminal,
    }));
  } catch (error) {
    setState((current) => (current.phase === "ready" ? current : { ...current, phase: "error", loadError: errorMessage(error) }));
  }
}

const loading = new Map<string, Promise<void>>();

/** Loads a conversation (the server resumes it first if needed). */
export function loadConversation(id: string): Promise<void> {
  let pending = loading.get(id);
  if (!pending) {
    pending = api
      .conversation(id)
      .then((view) => {
        setState((current) => ({
          ...current,
          views: { ...current.views, [id]: view },
          viewErrors: without(current.viewErrors, id),
          // A catch-up load (after the event stream reconnects) can carry messages whose events were missed.
          outgoing: settleOutgoing(current.outgoing, view),
        }));
      })
      .catch((error: unknown) => {
        setState((current) => ({ ...current, viewErrors: { ...current.viewErrors, [id]: errorMessage(error) } }));
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case "platform": {
      const wasConnected = state.platform?.state === "connected";
      setState((current) => ({
        ...current,
        platform: event.platform,
        blueprints: event.blueprints,
        ...(event.coordinator ? { coordinator: event.coordinator } : {}),
      }));
      // Conversations resume on the new connection: refresh the one on screen.
      const route = parseHash(window.location.hash);
      if (!wasConnected && event.platform.state === "connected" && route.kind === "conversation") void loadConversation(route.id);
      return;
    }
    case "conversations":
      setState((current) => ({ ...current, conversations: event.conversations }));
      return;
    case "conversation":
      setState((current) => ({
        ...current,
        views: { ...current.views, [event.conversation.id]: event.conversation },
        viewErrors: without(current.viewErrors, event.conversation.id),
        outgoing: settleOutgoing(current.outgoing, event.conversation),
      }));
      return;
    case "removed": {
      setState((current) => ({
        ...current,
        views: without(current.views, event.id),
        outgoing: without(current.outgoing, event.id),
        conversations: current.conversations.filter((summary) => summary.id !== event.id),
      }));
      const route = parseHash(window.location.hash);
      if (route.kind === "conversation" && route.id === event.id) navigate(homeHref(), { replace: true });
      return;
    }
  }
}

function userTextCounts(view: ConversationView | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of view?.messages ?? []) {
    if (message.role !== "user") continue;
    const text = message.content.trim();
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/**
 * Drops sent messages the conversation now shows. Counted, not timed: the browser's and the platform's clocks can
 * differ. Several pending copies of one text settle one per new arrival, oldest first.
 */
export function settleOutgoing(outgoing: StoreState["outgoing"], view: ConversationView): StoreState["outgoing"] {
  const pending = outgoing[view.id];
  if (!pending?.length) return outgoing;
  const shown = userTextCounts(view);
  const claimed = new Map<string, number>();
  const left = pending.filter((item) => {
    if (item.failed) return true;
    const used = claimed.get(item.text) ?? 0;
    if ((shown.get(item.text) ?? 0) - item.baseline - used <= 0) return true;
    claimed.set(item.text, used + 1);
    return false;
  });
  if (left.length === pending.length) return outgoing;
  return left.length ? { ...outgoing, [view.id]: left } : without(outgoing, view.id);
}

// ─── Server-sent events ──────────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES: readonly ServerEvent["type"][] = ["platform", "conversations", "conversation", "removed"];
const CLOSED = 2;

let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1000;

function parseEvent(data: unknown): ServerEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") return parsed as ServerEvent;
  } catch {
    // Ignore malformed messages.
  }
  return undefined;
}

function connectEvents(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  source?.close();
  let events: EventSource;
  try {
    events = new EventSource("/api/events");
  } catch {
    scheduleReconnect();
    return;
  }
  source = events;
  events.onopen = () => {
    backoffMs = 1000;
    setState((current) => (current.connection === "open" ? current : { ...current, connection: "open" }));
    // Anything may have changed while we weren't listening.
    void loadState();
    const route = parseHash(window.location.hash);
    if (route.kind === "conversation") void loadConversation(route.id);
  };
  events.onerror = () => {
    if (source !== events) return;
    setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
    if (events.readyState === CLOSED) scheduleReconnect();
  };
  const onMessage = (message: MessageEvent): void => {
    const event = parseEvent(message.data);
    if (event) handleServerEvent(event);
  };
  for (const type of EVENT_TYPES) events.addEventListener(type, onMessage as EventListener);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  const delay = backoffMs + Math.round(Math.random() * 400);
  backoffMs = Math.min(backoffMs * 2, 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectEvents();
  }, delay);
}

let started = false;

/** Loads `/api/state` and opens the event stream. Safe to call more than once. */
export function startDispatch(): void {
  if (started) return;
  started = true;
  connectEvents();
  void loadState();
}

// ─── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function createConversation(prompt: string, approvals: ApprovalMode): Promise<ConversationView> {
  const view = await api.create(prompt, approvals);
  setState((current) => ({
    ...current,
    views: { ...current.views, [view.id]: view },
    conversations: current.conversations.some((summary) => summary.id === view.id) ? current.conversations : [view, ...current.conversations],
  }));
  return view;
}

let outgoingKey = 0;

/** Sends a message; it shows in the conversation right away and settles when the coordinator receives it. */
export async function sendMessage(id: string, prompt: string): Promise<boolean> {
  const text = prompt.trim();
  const item: Outgoing = { key: ++outgoingKey, text, at: Date.now(), baseline: userTextCounts(state.views[id]).get(text) ?? 0 };
  setState((current) => ({ ...current, outgoing: { ...current.outgoing, [id]: [...(current.outgoing[id] ?? []), item] } }));
  try {
    await api.send(id, prompt);
    return true;
  } catch (error) {
    const failed = errorMessage(error);
    setState((current) => ({
      ...current,
      outgoing: { ...current.outgoing, [id]: (current.outgoing[id] ?? []).map((entry) => (entry.key === item.key ? { ...entry, failed } : entry)) },
    }));
    return false;
  }
}

export function dismissOutgoing(id: string, key: number): void {
  setState((current) => {
    const left = (current.outgoing[id] ?? []).filter((entry) => entry.key !== key);
    return { ...current, outgoing: left.length ? { ...current.outgoing, [id]: left } : without(current.outgoing, id) };
  });
}

export async function answerApproval(id: string, approvalId: string, approve: boolean, reason?: string): Promise<void> {
  try {
    await api.answer(id, approvalId, approve, reason);
  } catch (error) {
    toast.error("Couldn't answer the request", errorMessage(error));
    void loadConversation(id);
  }
}

export async function setApprovals(id: string, approvals: ApprovalMode): Promise<void> {
  try {
    const view = await api.settings(id, approvals);
    setState((current) => ({ ...current, views: { ...current.views, [id]: view } }));
  } catch (error) {
    toast.error("Couldn't change the setting", errorMessage(error));
  }
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await api.delete(id);
    handleServerEvent({ type: "removed", id });
    return true;
  } catch (error) {
    toast.error("Couldn't delete the conversation", errorMessage(error));
    return false;
  }
}

export async function openInCli(sessionId: string): Promise<void> {
  try {
    const result = await api.attach(sessionId);
    if (result.launched) toast.success("Opened Copilot CLI", result.message);
    else toast.info(result.message, result.command);
  } catch (error) {
    toast.error("Couldn't open Copilot CLI", errorMessage(error));
  }
}
