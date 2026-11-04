import { useCallback, useSyncExternalStore } from "react";
import { buildSearch, matchRoute, parseQuery, type Query, type QueryInput, type Route } from "./routes.js";

export interface AppLocation {
  readonly pathname: string;
  readonly search: string;
  readonly route: Route;
  readonly query: Query;
}

const listeners = new Set<() => void>();
let cachedKey: string | undefined;
let cachedLocation: AppLocation | undefined;

function snapshot(): AppLocation {
  const { pathname, search } = window.location;
  const key = `${pathname}${search}`;
  if (key !== cachedKey || !cachedLocation) {
    cachedKey = key;
    cachedLocation = { pathname, search, route: matchRoute(pathname), query: parseQuery(search) };
  }
  return cachedLocation;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("popstate", notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", notify);
  };
}

export function useLocation(): AppLocation {
  return useSyncExternalStore(subscribe, snapshot);
}

export interface NavigateOptions {
  /** Update the address without a new history entry (filters, tabs, redirects). */
  readonly replace?: boolean;
}

/** Client-side navigation within the console (History API). */
export function navigate(to: string, options: NavigateOptions = {}): void {
  const target = new URL(to, window.location.href);
  if (target.origin !== window.location.origin) {
    window.location.assign(target.href);
    return;
  }
  const next = `${target.pathname}${target.search}${target.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options.replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  notify();
}

/** Re-reads the address after code outside the router changed it with `history.replaceState`. */
export function syncLocation(): void {
  notify();
}

/** Returns a setter that merges query parameters into the current address (empty values remove a parameter). */
export function useQueryUpdater(): (changes: QueryInput, options?: NavigateOptions) => void {
  const location = useLocation();
  return useCallback(
    (changes: QueryInput, options: NavigateOptions = { replace: true }) => {
      const merged: Record<string, string | number | boolean | undefined | null> = { ...location.query };
      for (const [key, value] of Object.entries(changes)) merged[key] = value;
      navigate(`${location.pathname}${buildSearch(merged)}`, options);
    },
    [location.pathname, location.query],
  );
}

/** Whether a click should be handled by the router rather than the browser (new tab, download, ...). */
export function isPlainLeftClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}
