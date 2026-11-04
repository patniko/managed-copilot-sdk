import { useSyncExternalStore } from "react";

export type Route = { readonly page: "board" } | { readonly page: "incident"; readonly id: string };

export function parseHash(hash = window.location.hash): Route {
  const match = /^#\/incidents\/([^/?#]+)/.exec(hash);
  return match ? { page: "incident", id: decodeURIComponent(match[1]!) } : { page: "board" };
}

export const boardHref = (): string => "#/";
export const incidentHref = (id: string): string => `#/incidents/${encodeURIComponent(id)}`;

export function navigate(href: string): void {
  if (window.location.hash !== href) window.location.hash = href;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** The current route. The returned object changes only when the hash does. */
let current = { hash: "", route: parseHash("") as Route };
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => {
    const hash = window.location.hash;
    if (hash !== current.hash) current = { hash, route: parseHash(hash) };
    return current.route;
  });
}
