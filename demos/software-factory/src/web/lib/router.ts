import { useSyncExternalStore } from "react";

export type WorkOrderTab = "floor" | "plan" | "artifacts" | "deliverable";

export const WORK_ORDER_TABS: readonly WorkOrderTab[] = ["floor", "plan", "artifacts", "deliverable"];

export type Query = Readonly<Record<string, string>>;

export type Route =
  | { readonly kind: "home" }
  | { readonly kind: "workOrder"; readonly id: string; readonly tab: WorkOrderTab; readonly query: Query };

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
  const search = queryStart >= 0 ? raw.slice(queryStart + 1) : "";
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) query[key] = value;
  const [first, id, tabSegment] = segments;
  if (first === "wo" && id) {
    const tab = WORK_ORDER_TABS.find((candidate) => candidate === tabSegment) ?? "floor";
    return { kind: "workOrder", id, tab, query };
  }
  return { kind: "home" };
}

/** Like encodeURIComponent but keeps `:`, `/` and `@` readable (station ids and paths). */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/").replace(/%40/gi, "@");
}

export function buildQuery(query: Readonly<Record<string, string | number | undefined>> | undefined): string {
  if (!query) return "";
  return Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeQueryValue(String(value))}`)
    .join("&");
}

export function homeHref(): string {
  return "#/";
}

export function workOrderHref(
  id: string,
  tab: WorkOrderTab = "floor",
  query?: Readonly<Record<string, string | number | undefined>>,
): string {
  const path = `#/wo/${encodeURIComponent(id)}${tab === "floor" ? "" : `/${tab}`}`;
  const search = buildQuery(query);
  return search ? `${path}?${search}` : path;
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
