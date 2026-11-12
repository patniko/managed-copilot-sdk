import { useSyncExternalStore } from "react";

export type Route = { readonly kind: "wall" } | { readonly kind: "customer"; readonly id: string } | { readonly kind: "player"; readonly id: string };

export function parseHash(hash: string): Route {
  const [first, id] = (hash.startsWith("#") ? hash.slice(1) : hash).split("/").filter(Boolean);
  if ((first === "c" || first === "p") && id) {
    try {
      return { kind: first === "c" ? "customer" : "player", id: decodeURIComponent(id) };
    } catch {
      return { kind: "wall" };
    }
  }
  return { kind: "wall" };
}

export const wallHref = (): string => "#/";
export const customerHref = (id: string): string => `#/c/${encodeURIComponent(id)}`;
/** A player ticket on the wall (the operator's view). */
export const playerHref = (ticketId: string): string => `#/p/${encodeURIComponent(ticketId)}`;

/**
 * The ticket of a player's chat page (`/chat/<ticket>`, which the game shows in a frame), or nothing on the wall's pages.
 * A chat path without a usable ticket gives "" (the page says there's no such chat).
 */
export function chatTicketId(pathname: string): string | undefined {
  const match = /^\/chat(?:\/([^/]*))?\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return "";
  }
}

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
