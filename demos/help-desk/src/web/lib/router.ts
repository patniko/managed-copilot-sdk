import { useSyncExternalStore } from "react";

export type Route = { readonly kind: "wall" } | { readonly kind: "customer"; readonly id: string };

export function parseHash(hash: string): Route {
  const [first, id] = (hash.startsWith("#") ? hash.slice(1) : hash).split("/").filter(Boolean);
  if (first === "c" && id) {
    try {
      return { kind: "customer", id: decodeURIComponent(id) };
    } catch {
      return { kind: "wall" };
    }
  }
  return { kind: "wall" };
}

export const wallHref = (): string => "#/";
export const customerHref = (id: string): string => `#/c/${encodeURIComponent(id)}`;

const listeners = new Set<() => void>();
let cachedHash: string | undefined;
let cachedRoute: Route = { kind: "wall" };

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
