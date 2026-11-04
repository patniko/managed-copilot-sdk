import { useSyncExternalStore } from "react";

export type Route = { readonly kind: "home" } | { readonly kind: "run"; readonly id: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash: string): Route {
  const [first, id] = (hash.startsWith("#") ? hash.slice(1) : hash).split("/").filter(Boolean).map(safeDecode);
  return first === "r" && id ? { kind: "run", id } : { kind: "home" };
}

export const homeHref = (): string => "#/";
export const runHref = (id: string): string => `#/r/${encodeURIComponent(id)}`;

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

export function navigate(href: string): void {
  if (href !== window.location.hash) window.location.hash = href;
}
