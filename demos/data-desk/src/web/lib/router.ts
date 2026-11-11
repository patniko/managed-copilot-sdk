import { useSyncExternalStore } from "react";
import { parseHash, type Route } from "../../shared/routes.js";

export { analysisHref, homeHref, parseHash, type Route } from "../../shared/routes.js";
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
