import { CONSOLE_PATH, type OperatorView } from "@managed-copilot/protocol/operator";

/** List views reachable at `/console/<view>`. */
export const LIST_VIEWS = [
  "infrastructure",
  "environments",
  "sessions",
  "connections",
  "sandboxes",
  "schedules",
  "webhooks",
  "actions",
  "accounts",
  "events",
  "logs",
  "audit",
] as const satisfies readonly OperatorView[];

export type ListView = (typeof LIST_VIEWS)[number];

export type Route =
  | { readonly kind: "overview" }
  | { readonly kind: ListView }
  | { readonly kind: "environment"; readonly name: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "signin" }
  | { readonly kind: "not-found"; readonly path: string };

export type Query = Readonly<Record<string, string>>;
export type QueryInput = Readonly<Record<string, string | number | boolean | undefined | null>>;

function isListView(value: string): value is ListView {
  return (LIST_VIEWS as readonly string[]).includes(value);
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Encodes one path segment of a console URL. */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Maps a pathname under `/console` to a route. Anything unrecognized is `not-found`. */
export function matchRoute(pathname: string): Route {
  const notFound: Route = { kind: "not-found", path: pathname };
  if (pathname !== CONSOLE_PATH && !pathname.startsWith(`${CONSOLE_PATH}/`)) return notFound;
  const rawSegments = pathname.slice(CONSOLE_PATH.length).split("/").filter((segment) => segment !== "");
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const decoded = safeDecode(raw);
    if (decoded === undefined || decoded === "") return notFound;
    segments.push(decoded);
  }
  const [first, second, ...rest] = segments;
  if (first === undefined) return { kind: "overview" };
  if (rest.length > 0) return notFound;
  if (first === "signin" && second === undefined) return { kind: "signin" };
  if (first === "overview" && second === undefined) return { kind: "overview" };
  if (!isListView(first)) return notFound;
  if (second === undefined) return { kind: first };
  if (first === "environments") return { kind: "environment", name: second };
  if (first === "sessions") return { kind: "session", id: second };
  return notFound;
}

export function parseQuery(search: string): Query {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)) query[key] = value;
  return query;
}

/** `?a=1&b=two`, skipping empty values; "" when nothing is left. */
export function buildSearch(query: QueryInput | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function routePath(route: Route): string {
  switch (route.kind) {
    case "overview":
      return `${CONSOLE_PATH}/`;
    case "environment":
      return `${CONSOLE_PATH}/environments/${encodeSegment(route.name)}`;
    case "session":
      return `${CONSOLE_PATH}/sessions/${encodeSegment(route.id)}`;
    case "signin":
      return `${CONSOLE_PATH}/signin`;
    case "not-found":
      return route.path;
    default:
      return `${CONSOLE_PATH}/${route.kind}`;
  }
}

export function href(route: Route, query?: QueryInput): string {
  return `${routePath(route)}${buildSearch(query)}`;
}

export const hrefs = {
  overview: (): string => href({ kind: "overview" }),
  view: (view: ListView, query?: QueryInput): string => href({ kind: view }, query),
  environment: (name: string, query?: QueryInput): string => href({ kind: "environment", name }, query),
  session: (id: string, query?: QueryInput): string => href({ kind: "session", id }, query),
};

/**
 * Where an attention item or another view reference points: the detail page for views that have one (sessions,
 * environments) when an ID is given, otherwise the view's list.
 */
export function viewHref(view: OperatorView, id?: string): string {
  if (view === "overview") return hrefs.overview();
  if (id && view === "sessions") return hrefs.session(id);
  if (id && view === "environments") return hrefs.environment(id);
  return hrefs.view(view);
}

/** The navigation entry a route belongs to (detail pages highlight their list). */
export function routeView(route: Route): OperatorView | undefined {
  switch (route.kind) {
    case "environment":
      return "environments";
    case "session":
      return "sessions";
    case "signin":
    case "not-found":
      return undefined;
    default:
      return route.kind;
  }
}
