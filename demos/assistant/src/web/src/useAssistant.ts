import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ServerEvent, Snapshot, TimelineItem, UserItem } from "../../shared/protocol";
import { api, ApiRequestError } from "./api";

export interface PendingMessage {
  readonly localId: string;
  readonly text: string;
  readonly at: string;
  readonly messageId?: string;
  readonly failed?: string;
}

export interface Toast {
  readonly id: number;
  readonly tone: "info" | "success" | "error";
  readonly text: string;
}

export interface AssistantState {
  /** The browser's event stream to the assistant server. */
  readonly stream: "connecting" | "open" | "reconnecting";
  readonly snapshot: Snapshot | undefined;
  readonly items: readonly TimelineItem[];
  readonly pending: readonly PendingMessage[];
  readonly toasts: readonly Toast[];
  /** The first unread item when this view loaded, kept stable while you read. */
  readonly unreadAnchor: string | undefined;
}

type Action =
  | { type: "server"; event: ServerEvent }
  | { type: "stream"; state: AssistantState["stream"] }
  | { type: "pending.add"; message: PendingMessage }
  | { type: "pending.update"; localId: string; patch: Partial<PendingMessage> }
  | { type: "pending.remove"; localId: string }
  | { type: "toast.add"; toast: Toast }
  | { type: "toast.remove"; id: number }
  | { type: "unread.clear" };

const UNREAD_KINDS = new Set<TimelineItem["kind"]>(["assistant", "approval", "trigger"]);

export function isUnread(item: TimelineItem, lastReadAt: string | undefined): boolean {
  if (!UNREAD_KINDS.has(item.kind)) return false;
  return !lastReadAt || Date.parse(item.at) > Date.parse(lastReadAt);
}

function upsert(items: readonly TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function reducer(state: AssistantState, action: Action): AssistantState {
  switch (action.type) {
    case "stream":
      return { ...state, stream: action.state };
    case "pending.add":
      return { ...state, pending: [...state.pending, action.message] };
    case "pending.update":
      return { ...state, pending: state.pending.map((m) => (m.localId === action.localId ? { ...m, ...action.patch } : m)) };
    case "pending.remove":
      return { ...state, pending: state.pending.filter((m) => m.localId !== action.localId) };
    case "toast.add":
      return { ...state, toasts: [...state.toasts.slice(-3), action.toast] };
    case "toast.remove":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "unread.clear":
      return { ...state, unreadAnchor: undefined };
    case "server":
      return applyServerEvent(state, action.event);
  }
}

function dropDelivered(pending: readonly PendingMessage[], items: readonly TimelineItem[]): PendingMessage[] {
  const ids = new Set(items.map((item) => item.id));
  const texts = new Set(items.filter((item): item is UserItem => item.kind === "user").map((item) => item.text.trim()));
  return pending.filter((message) => !(message.messageId && ids.has(message.messageId)) && !(message.failed === undefined && message.messageId && texts.has(message.text.trim())));
}

function applyServerEvent(state: AssistantState, event: ServerEvent): AssistantState {
  const snapshot = state.snapshot;
  switch (event.type) {
    case "snapshot": {
      const items = event.snapshot.timeline;
      const firstUnread = items.find((item) => isUnread(item, event.snapshot.lastReadAt));
      return { ...state, snapshot: event.snapshot, items, pending: dropDelivered(state.pending, items), unreadAnchor: firstUnread?.id };
    }
    case "item": {
      const items = upsert(state.items, event.item);
      return { ...state, items, pending: event.item.kind === "user" ? dropDelivered(state.pending, items) : state.pending };
    }
    case "delta":
      return {
        ...state,
        items: state.items.map((item) => (item.id === event.id && item.kind === "assistant" ? { ...item, text: item.text + event.text, streaming: true } : item)),
      };
    default:
      if (!snapshot) return state;
  }
  switch (event.type) {
    case "status":
      return { ...state, snapshot: { ...snapshot, platform: event.platform, conversation: event.conversation, account: event.account ?? snapshot.account } };
    case "schedules":
      return { ...state, snapshot: { ...snapshot, schedules: event.schedules, schedulesError: event.error } };
    case "connections":
      return { ...state, snapshot: { ...snapshot, connections: event.connections } };
    case "offline":
      return { ...state, snapshot: { ...snapshot, offline: event.offline } };
    case "agenda":
      return { ...state, snapshot: { ...snapshot, agenda: event.agenda } };
    case "settings":
      return { ...state, snapshot: { ...snapshot, settings: event.settings } };
    case "read":
      return { ...state, snapshot: { ...snapshot, lastReadAt: event.lastReadAt } };
    default:
      return state;
  }
}

let toastSeq = 0;
let localSeq = 0;

function notify(title: string, body: string, tag?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const notification = new Notification(title, { body, tag, icon: "/favicon.svg" });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app unread badge still shows.
  }
}

export function useAssistant() {
  const [state, dispatch] = useReducer(reducer, { stream: "connecting", snapshot: undefined, items: [], pending: [], toasts: [], unreadAnchor: undefined });
  const lastEventAt = useRef(Date.now());

  const toast = useCallback((tone: Toast["tone"], text: string) => {
    const id = ++toastSeq;
    dispatch({ type: "toast.add", toast: { id, tone, text } });
    setTimeout(() => dispatch({ type: "toast.remove", id }), tone === "error" ? 7000 : 4000);
  }, []);

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const source = new EventSource(`/api/events?tz=${encodeURIComponent(tz)}`);
    source.onopen = () => dispatch({ type: "stream", state: "open" });
    source.onerror = () => dispatch({ type: "stream", state: "reconnecting" });
    source.onmessage = (message) => {
      lastEventAt.current = Date.now();
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "notify") notify(event.title, event.body, event.itemId);
      dispatch({ type: "server", event });
    };
    return () => source.close();
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (success) toast("success", success);
        return result;
      } catch (error) {
        toast("error", error instanceof ApiRequestError ? error.message : "Something went wrong.");
        return undefined;
      }
    },
    [toast],
  );

  const actions = useMemo(
    () => ({
      send: async (text: string) => {
        const localId = `local-${++localSeq}`;
        dispatch({ type: "pending.add", message: { localId, text, at: new Date().toISOString() } });
        try {
          const { messageId } = await api.send(text);
          dispatch({ type: "pending.update", localId, patch: { messageId } });
        } catch (error) {
          dispatch({ type: "pending.update", localId, patch: { failed: error instanceof ApiRequestError ? error.message : "Not delivered." } });
        }
      },
      retrySend: async (message: PendingMessage) => {
        dispatch({ type: "pending.remove", localId: message.localId });
        const localId = `local-${++localSeq}`;
        dispatch({ type: "pending.add", message: { localId, text: message.text, at: new Date().toISOString() } });
        try {
          const { messageId } = await api.send(message.text);
          dispatch({ type: "pending.update", localId, patch: { messageId } });
        } catch (error) {
          dispatch({ type: "pending.update", localId, patch: { failed: error instanceof ApiRequestError ? error.message : "Not delivered." } });
        }
      },
      discard: (localId: string) => dispatch({ type: "pending.remove", localId }),
      abort: () => run(() => api.abort()),
      decide: (id: string, decision: "approve" | "deny", feedback?: string) => run(() => api.decide(id, decision, feedback)),
      markRead: (at: string) => void api.markRead(at).catch(() => undefined),
      clearUnreadAnchor: () => dispatch({ type: "unread.clear" }),
      setTimeZone: (timeZone: string) => run(() => api.setTimeZone(timeZone), "Time zone updated"),
      retry: () => run(() => api.retry()),
      addBriefing: () => run(() => api.addBriefing(), "Weekday morning briefing added"),
      pauseSchedule: (id: string) => run(() => api.pauseSchedule(id), "Paused"),
      resumeSchedule: (id: string) => run(() => api.resumeSchedule(id), "Resumed"),
      runSchedule: (id: string) => run(() => api.runSchedule(id), "Running now. The result will appear in the chat."),
      deleteSchedule: (id: string) => run(() => api.deleteSchedule(id), "Deleted"),
      connectGoogle: async () => {
        const result = await run(() => api.connectGoogle());
        if (result?.url) window.location.assign(result.url);
      },
      disconnectGoogle: () => run(() => api.disconnectGoogle(), "Google disconnected. Using the demo workspace."),
      resetDemo: () => run(() => api.resetDemo(), "Demo inbox and calendar reset"),
      toast,
    }),
    [run, toast],
  );

  return { state, actions };
}

export type AssistantActions = ReturnType<typeof useAssistant>["actions"];
