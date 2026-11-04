import { useSyncExternalStore } from "react";

export type Route = { readonly kind: "home" } | { readonly kind: "run"; readonly id: string };

export function parseHash(hash: string): Route {
  const [first, id] = hash.replace(/^#/, "").split("?")[0]!.split("/").filter(Boolean);
  if (first === "runs" && id) {
    try {
      return { kind: "run", id: decodeURIComponent(id) };
    } catch {
      return { kind: "home" };
    }
  }
  return { kind: "home" };
}

export const homeHref = (): string => "#/";
export const runHref = (id: string): string => `#/runs/${encodeURIComponent(id)}`;

const listeners = new Set<() => void>();
let cachedHash: string | undefined;
let cachedRoute: Route = { kind: "home" };

function currentRoute(): Route {
  if (window.location.hash !== cachedHash) {
    cachedHash = window.location.hash;
    cachedRoute = parseHash(cachedHash);
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

/** Navigates to a `#/...` href; `replace` skips the history entry. */
export function navigate(href: string, options: { readonly replace?: boolean } = {}): void {
  if (href === window.location.hash) return;
  if (options.replace) {
    window.history.replaceState(window.history.state, "", href);
    notify();
  } else {
    window.location.hash = href;
  }
}
