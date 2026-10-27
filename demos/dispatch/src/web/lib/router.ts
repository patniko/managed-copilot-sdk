import { useSyncExternalStore } from "react";

export type ConversationTab = "environments" | "timeline";

export type Route =
  | { readonly kind: "home" }
  | { readonly kind: "conversation"; readonly id: string; readonly tab: ConversationTab; readonly worker?: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryStart = raw.indexOf("?");
  const path = queryStart >= 0 ? raw.slice(0, queryStart) : raw;
  const query = new URLSearchParams(queryStart >= 0 ? raw.slice(queryStart + 1) : "");
  const [first, id, tab] = path.split("/").filter(Boolean).map(safeDecode);
  if (first === "c" && id) {
    const worker = query.get("worker") ?? undefined;
    return { kind: "conversation", id, tab: tab === "timeline" ? "timeline" : "environments", ...(worker ? { worker } : {}) };
  }
  return { kind: "home" };
}

export function homeHref(): string {
  return "#/";
}

export function conversationHref(id: string, options: { readonly tab?: ConversationTab; readonly worker?: string } = {}): string {
  const path = `#/c/${encodeURIComponent(id)}${options.tab === "timeline" ? "/timeline" : ""}`;
  return options.worker ? `${path}?worker=${encodeURIComponent(options.worker)}` : path;
}

const listeners = new Set<() => void>();
let cachedHash: string | undefined;
let cachedRoute: Route = { kind: "home" };

function currentRoute(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("hashchange", notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("hashchange", notify);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute);
}

/** Navigates to a `#/...` href. `replace` updates the URL without adding a history entry. */
export function navigate(href: string, options: { readonly replace?: boolean } = {}): void {
  const target = href.startsWith("#") ? href : `#${href}`;
  if (target === window.location.hash) return;
  if (options.replace) {
    window.history.replaceState(window.history.state, "", target);
    notify();
  } else {
    window.location.hash = target;
  }
}
