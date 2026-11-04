/** The web UI's state: who's signed in, their conversations, the open conversation, and their memory. */
import { useSyncExternalStore } from "react";
import type {
  BillingInfo,
  ChatItem,
  ConversationSummary,
  ConversationView,
  MeResponse,
  MemoryItem,
  ServerEvent,
  SignInRequest,
  SignUpRequest,
  UserView,
} from "../../shared/types.js";
import { api, ApiError, handleSignedOut } from "./api.js";
import { conversationHref, navigate } from "./router.js";

export interface Outgoing {
  readonly key: string;
  readonly text: string;
  readonly messageId?: string;
  readonly failed?: string;
}

export interface Toast {
  readonly id: number;
  readonly tone: "danger" | "success" | "info";
  readonly text: string;
}

export interface State {
  /** Undefined while loading. */
  readonly me: MeResponse | undefined;
  readonly meError?: string;
  /** Why the person was signed out (their GitHub sign-in expired). */
  readonly signedOutReason?: string;
  readonly conversations: readonly ConversationSummary[];
  readonly conversationsLoaded: boolean;
  readonly views: Readonly<Record<string, ConversationView>>;
  readonly viewErrors: Readonly<Record<string, { code: string; message: string }>>;
  /** Messages sent but not yet shown by the server, per conversation ("new" on the start page). */
  readonly outgoing: Readonly<Record<string, readonly Outgoing[]>>;
  readonly memories: readonly MemoryItem[];
  readonly billing: BillingInfo | undefined;
  readonly memoryOpen: boolean;
  readonly sidebarOpen: boolean;
  readonly stream: "idle" | "open" | "reconnecting";
  readonly toasts: readonly Toast[];
}

let state: State = {
  me: undefined,
  conversations: [],
  conversationsLoaded: false,
  views: {},
  viewErrors: {},
  outgoing: {},
  memories: [],
  billing: undefined,
  memoryOpen: false,
  sidebarOpen: false,
  stream: "idle",
  toasts: [],
};

const listeners = new Set<() => void>();

function set(update: Partial<State> | ((current: State) => Partial<State>)): void {
  state = { ...state, ...(typeof update === "function" ? update(state) : update) };
  for (const listener of listeners) listener();
}

export function getState(): State {
  return state;
}

export function useStore<T>(select: (state: State) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}

// ---- toasts ----------------------------------------------------------------------------------------------------------

let toastId = 0;
export function toast(text: string, tone: Toast["tone"] = "danger"): void {
  const id = ++toastId;
  set((current) => ({ toasts: [...current.toasts.slice(-3), { id, tone, text }] }));
  setTimeout(() => dismissToast(id), tone === "danger" ? 8_000 : 4_000);
}

export function dismissToast(id: number): void {
  set((current) => ({ toasts: current.toasts.filter((item) => item.id !== id) }));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---- panels --------------------------------------------------------------------------------------------------------

export const setMemoryOpen = (memoryOpen: boolean) => set({ memoryOpen });
export const setSidebarOpen = (sidebarOpen: boolean) => set({ sidebarOpen });

// ---- sign-in -------------------------------------------------------------------------------------------------------

/**
 * Changes whenever who is signed in here changes. A reply to a request made for someone else (they signed out, and
 * maybe another person signed in, while it was on its way) is dropped, so nothing of theirs lands in the next person's view.
 */
let identity = 0;

handleSignedOut((reason) => signedOut(reason));

function signedOut(reason?: string): void {
  identity++;
  stopEvents();
  set((current) => ({
    me: current.me ? { ...current.me, user: null } : current.me,
    ...(reason ? { signedOutReason: reason } : {}),
    conversations: [],
    conversationsLoaded: false,
    views: {},
    viewErrors: {},
    outgoing: {},
    memories: [],
    billing: undefined,
    memoryOpen: false,
  }));
}

export async function loadMe(): Promise<void> {
  try {
    const me = await api.get<MeResponse>("/api/me");
    set({ me, meError: undefined });
    if (me.user) startSignedIn(me.user);
  } catch (error) {
    set({ meError: message(error) });
  }
}

/** Asks again what Front Desk offers, e.g. whether people without GitHub can chat yet (it may still be connecting). */
export async function refreshOptions(): Promise<void> {
  try {
    const { options } = await api.get<MeResponse>("/api/me");
    set((current) => (current.me ? { me: { ...current.me, options } } : {}));
  } catch {
    // The next check tries again.
  }
}

function startSignedIn(user: UserView): void {
  identity++;
  set({ billing: user.billing, signedOutReason: undefined });
  startEvents();
  void loadConversations();
}

async function finishSignIn(promise: Promise<{ user: UserView }>): Promise<void> {
  const { user } = await promise;
  set((current) => ({ me: current.me ? { ...current.me, user } : { user, options: { github: false, localGitHub: false, email: true, inviteRequired: false, appUsers: { available: false } } } }));
  navigate("/", { replace: true });
  startSignedIn(user);
}

export const signUp = (request: SignUpRequest) => finishSignIn(api.post<{ user: UserView }>("/api/auth/signup", request));
export const signIn = (request: SignInRequest) => finishSignIn(api.post<{ user: UserView }>("/api/auth/signin", request));
export const signInWithLocalGitHub = () => finishSignIn(api.post<{ user: UserView }>("/api/auth/github/local"));

export async function signOut(): Promise<void> {
  try {
    await api.post("/api/auth/signout");
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) return toast(`Couldn't sign out: ${message(error)}`);
  }
  signedOut();
  navigate("/", { replace: true });
}

// ---- conversations -------------------------------------------------------------------------------------------------

const byRecent = (a: ConversationSummary, b: ConversationSummary) => b.updatedAt.localeCompare(a.updatedAt);

export async function loadConversations(): Promise<void> {
  const who = identity;
  try {
    const conversations = await api.get<ConversationSummary[]>("/api/conversations");
    if (who !== identity) return;
    set({ conversations: [...conversations].sort(byRecent), conversationsLoaded: true });
  } catch (error) {
    if (who !== identity || (error instanceof ApiError && error.status === 401)) return;
    set({ conversationsLoaded: true });
    toast(`Couldn't load your conversations: ${message(error)}`);
  }
}

/** Drops "Sending…" placeholders for messages a loaded transcript already shows. */
function withoutDelivered(outgoing: State["outgoing"], conversationId: string, items: readonly ChatItem[]): State["outgoing"] {
  const pending = outgoing[conversationId];
  if (!pending?.length) return outgoing;
  const shown = new Set(items.map((item) => item.id));
  const next = pending.filter((item) => !item.messageId || !shown.has(item.messageId));
  return next.length === pending.length ? outgoing : { ...outgoing, [conversationId]: next };
}

export async function openConversation(id: string): Promise<void> {
  const who = identity;
  set((current) => {
    const viewErrors = { ...current.viewErrors };
    delete viewErrors[id];
    return { viewErrors };
  });
  try {
    const view = await api.get<ConversationView>(`/api/conversations/${encodeURIComponent(id)}`);
    if (who !== identity) return;
    set((current) => ({ views: { ...current.views, [id]: view }, outgoing: withoutDelivered(current.outgoing, id, view.items) }));
  } catch (error) {
    if (who !== identity || (error instanceof ApiError && error.status === 401)) return;
    const code = error instanceof ApiError ? error.code : "error";
    set((current) => {
      // Not (or no longer) this person's: forget anything kept for it.
      const gone = error instanceof ApiError && (error.status === 404 || error.status === 410);
      const views = { ...current.views };
      const outgoing = { ...current.outgoing };
      if (gone) {
        delete views[id];
        delete outgoing[id];
      }
      return { views, outgoing, viewErrors: { ...current.viewErrors, [id]: { code, message: message(error) } } };
    });
  }
}

function addOutgoing(key: string, item: Outgoing): void {
  set((current) => ({ outgoing: { ...current.outgoing, [key]: [...(current.outgoing[key] ?? []), item] } }));
}

function updateOutgoing(key: string, itemKey: string, patch: Partial<Outgoing> | null): void {
  set((current) => {
    const list = current.outgoing[key] ?? [];
    const next = patch === null ? list.filter((item) => item.key !== itemKey) : list.map((item) => (item.key === itemKey ? { ...item, ...patch } : item));
    return { outgoing: { ...current.outgoing, [key]: next } };
  });
}

export function dismissOutgoing(conversationId: string, itemKey: string): void {
  updateOutgoing(conversationId, itemKey, null);
}

let outgoingKey = 0;

/** Starts a conversation with its first message; resolves false (keeping the text) when it couldn't. */
export async function startConversation(prompt: string): Promise<boolean> {
  const who = identity;
  const key = `out-${++outgoingKey}`;
  addOutgoing("new", { key, text: prompt });
  try {
    const { conversation, messageId } = await api.post<{ conversation: ConversationSummary; messageId: string }>("/api/conversations", { prompt });
    if (who !== identity) return false;
    updateOutgoing("new", key, null);
    set((current) => ({
      conversations: [conversation, ...current.conversations.filter((item) => item.id !== conversation.id)].sort(byRecent),
      views: current.views[conversation.id] ? current.views : { ...current.views, [conversation.id]: { ...conversation, items: [] } },
    }));
    if (!getState().views[conversation.id]?.items.some((item) => item.id === messageId)) addOutgoing(conversation.id, { key, text: prompt, messageId });
    navigate(conversationHref(conversation.id));
    return true;
  } catch (error) {
    if (who !== identity) return false;
    updateOutgoing("new", key, null);
    if (!(error instanceof ApiError && error.status === 401)) toast(message(error));
    return false;
  }
}

export async function sendMessage(conversationId: string, prompt: string): Promise<boolean> {
  const who = identity;
  const key = `out-${++outgoingKey}`;
  addOutgoing(conversationId, { key, text: prompt });
  try {
    const { messageId } = await api.post<{ messageId: string }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { prompt });
    if (who !== identity) return false;
    if (getState().views[conversationId]?.items.some((item) => item.id === messageId)) updateOutgoing(conversationId, key, null);
    else updateOutgoing(conversationId, key, { messageId });
    return true;
  } catch (error) {
    if (who !== identity) return false;
    updateOutgoing(conversationId, key, { failed: message(error) });
    return false;
  }
}

export async function stopConversation(conversationId: string): Promise<void> {
  const who = identity;
  try {
    await api.post(`/api/conversations/${encodeURIComponent(conversationId)}/stop`);
  } catch (error) {
    if (who === identity) toast(`Couldn't stop it: ${message(error)}`);
  }
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const who = identity;
  try {
    await api.delete(`/api/conversations/${encodeURIComponent(conversationId)}`);
    if (who !== identity) return;
    removeConversation(conversationId);
    toast("Conversation deleted.", "success");
  } catch (error) {
    if (who === identity) toast(`Couldn't delete it: ${message(error)}`);
  }
}

function removeConversation(id: string): void {
  set((current) => {
    const views = { ...current.views };
    delete views[id];
    return { conversations: current.conversations.filter((item) => item.id !== id), views };
  });
  if (window.location.pathname === conversationHref(id)) navigate("/", { replace: true });
}

// ---- memory --------------------------------------------------------------------------------------------------------

export async function deleteMemory(id: string): Promise<void> {
  const who = identity;
  try {
    await api.delete(`/api/memories/${encodeURIComponent(id)}`);
  } catch (error) {
    if (who === identity) toast(`Couldn't remove it: ${message(error)}`);
  }
}

export async function clearMemories(): Promise<void> {
  const who = identity;
  try {
    await api.delete("/api/memories");
  } catch (error) {
    if (who === identity) toast(`Couldn't clear your memory: ${message(error)}`);
  }
}

// ---- live events ---------------------------------------------------------------------------------------------------

let source: EventSource | undefined;

function startEvents(): void {
  stopEvents();
  const events = new EventSource("/api/events");
  source = events;
  let opened = false;
  events.onopen = () => {
    if (source !== events) return;
    // After a reconnect, catch up on anything missed while the stream was down.
    if (opened) {
      void loadConversations();
      const open = window.location.pathname.match(/^\/c\/([^/]+)/)?.[1];
      if (open) void openConversation(decodeURIComponent(open));
    }
    opened = true;
    set({ stream: "open" });
  };
  events.onerror = () => {
    if (source !== events) return;
    set({ stream: "reconnecting" });
    // A closed stream (signed out elsewhere) needs a fresh check of who is signed in.
    if (events.readyState === EventSource.CLOSED) void loadMe();
  };
  for (const type of ["conversation", "conversation.deleted", "item", "delta", "memories", "billing"] as const) {
    events.addEventListener(type, (event) => {
      if (source !== events) return;
      try {
        apply(JSON.parse((event as MessageEvent<string>).data) as ServerEvent);
      } catch {
        // A malformed event is skipped; the next full load corrects the view.
      }
    });
  }
}

function stopEvents(): void {
  source?.close();
  source = undefined;
  set({ stream: "idle" });
}

function upsertItem(items: readonly ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function apply(event: ServerEvent): void {
  switch (event.type) {
    case "conversation": {
      const summary = event.conversation;
      set((current) => {
        const view = current.views[summary.id];
        return {
          conversations: [summary, ...current.conversations.filter((item) => item.id !== summary.id)].sort(byRecent),
          ...(view ? { views: { ...current.views, [summary.id]: { ...view, ...summary } } } : {}),
        };
      });
      break;
    }
    case "conversation.deleted":
      removeConversation(event.id);
      break;
    case "item":
      set((current) => {
        const view = current.views[event.conversationId];
        if (!view) return {};
        const outgoing = current.outgoing[event.conversationId];
        const settled = event.item.kind === "user" && outgoing?.some((item) => item.messageId === event.item.id);
        return {
          views: { ...current.views, [event.conversationId]: { ...view, items: upsertItem(view.items, event.item) } },
          ...(settled ? { outgoing: { ...current.outgoing, [event.conversationId]: outgoing!.filter((item) => item.messageId !== event.item.id) } } : {}),
        };
      });
      break;
    case "delta":
      set((current) => {
        const view = current.views[event.conversationId];
        if (!view) return {};
        const items = view.items.map((item) => (item.id === event.itemId && item.kind === "assistant" ? { ...item, text: item.text + event.delta, streaming: true } : item));
        return { views: { ...current.views, [event.conversationId]: { ...view, items } } };
      });
      break;
    case "memories":
      set({ memories: event.memories });
      break;
    case "billing":
      set((current) => ({
        billing: event.billing,
        ...(current.me?.user ? { me: { ...current.me, user: { ...current.me.user, billing: event.billing } } } : {}),
      }));
      break;
  }
}
