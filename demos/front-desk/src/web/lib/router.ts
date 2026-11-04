/** Tiny client-side routes: `/` (a new conversation) and `/c/<id>` (one conversation). */
import { useSyncExternalStore } from "react";

export type Route = { readonly page: "home" } | { readonly page: "conversation"; readonly id: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      return { page: "conversation", id: decodeURIComponent(match[1]!) };
    } catch {
      return { page: "home" };
    }
  }
  return { page: "home" };
}

export const conversationHref = (id: string) => `/c/${encodeURIComponent(id)}`;

const listeners = new Set<() => void>();
let current = parseRoute(window.location.pathname);

window.addEventListener("popstate", () => {
  current = parseRoute(window.location.pathname);
  for (const listener of listeners) listener();
});

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (href === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  current = parseRoute(window.location.pathname);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
