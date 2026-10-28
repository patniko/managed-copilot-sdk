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
  /** The runtime's ID for it, once the send returned: it settles when the conversation shows that ID. */
  readonly messageId?: string;
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

/**
 * Drops sent messages the conversation now shows, matched by the runtime's message ID (not by text, which can repeat,
 * or by time, since the browser's and the platform's clocks can differ). A message still being sent has no ID yet.
 */
export function settleOutgoing(outgoing: StoreState["outgoing"], view: ConversationView): StoreState["outgoing"] {
  const pending = outgoing[view.id];
  if (!pending?.length) return outgoing;
  const shown = new Set(view.messages.flatMap((message) => (message.role === "user" && message.messageId ? [message.messageId] : [])));
  const left = pending.filter((item) => item.failed !== undefined || item.messageId === undefined || !shown.has(item.messageId));
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
  const item: Outgoing = { key: ++outgoingKey, text: prompt.trim(), at: Date.now() };
  setState((current) => ({ ...current, outgoing: { ...current.outgoing, [id]: [...(current.outgoing[id] ?? []), item] } }));
  try {
    const sent = await api.send(id, prompt);
    setState((current) => {
      const pending = current.outgoing[id] ?? [];
      // Without an ID to match, the message can't be recognized when it arrives: stop showing it as pending.
      const updated = sent?.messageId ? pending.map((entry) => (entry.key === item.key ? { ...entry, messageId: sent.messageId } : entry)) : pending.filter((entry) => entry.key !== item.key);
      const outgoing = updated.length ? { ...current.outgoing, [id]: updated } : without(current.outgoing, id);
      // The conversation may already show it (its event can arrive before the send returns).
      const view = current.views[id];
      return { ...current, outgoing: view ? settleOutgoing(outgoing, view) : outgoing };
    });
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
