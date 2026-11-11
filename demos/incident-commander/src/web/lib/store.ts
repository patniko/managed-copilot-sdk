import { useSyncExternalStore } from "react";
import type { AppSettings, IncidentSummary, IncidentView, IntegrationsView, PlatformStatus, ServerEvent } from "../../shared/types.js";
import { api, errorMessage } from "./api.js";

export type Connection = "connecting" | "open" | "reconnecting";

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  readonly integrations?: IntegrationsView;
  readonly settings?: AppSettings;
  /** Newest first. */
  readonly incidents: readonly IncidentSummary[];
  readonly views: Readonly<Record<string, IncidentView>>;
  readonly viewErrors: Readonly<Record<string, string>>;
}

let state: StoreState = { phase: "loading", connection: "connecting", incidents: [], views: {}, viewErrors: {} };
const listeners = new Set<() => void>();

function setState(update: (current: StoreState) => StoreState): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A slice of the store. Selectors must return existing references (no new objects or arrays). */
export function useStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

async function loadState(): Promise<void> {
  try {
    const loaded = await api.state();
    setState((current) => ({ ...current, phase: "ready", platform: loaded.platform, integrations: loaded.integrations, settings: loaded.settings, incidents: loaded.incidents }));
  } catch (error) {
    setState((current) => (current.phase === "ready" ? current : { ...current, phase: "error", loadError: errorMessage(error) }));
  }
}

/** Loads an incident's full view (the event stream keeps it current afterwards). */
export async function loadIncident(id: string): Promise<void> {
  try {
    const view = await api.incident(id);
    setState((current) => ({ ...current, views: { ...current.views, [id]: view }, viewErrors: without(current.viewErrors, id) }));
  } catch (error) {
    setState((current) => ({ ...current, viewErrors: { ...current.viewErrors, [id]: errorMessage(error) } }));
  }
}

function apply(event: ServerEvent): void {
  setState((current) => {
    switch (event.type) {
      case "platform":
        return { ...current, platform: event.platform };
      case "integrations":
        return { ...current, integrations: event.integrations };
      case "settings":
        return { ...current, settings: event.settings };
      case "incidents":
        return { ...current, phase: "ready", incidents: event.incidents };
      case "incident":
        return { ...current, views: { ...current.views, [event.incident.id]: event.incident }, viewErrors: without(current.viewErrors, event.incident.id) };
      case "removed":
        return { ...current, incidents: current.incidents.filter((incident) => incident.id !== event.id), views: without(current.views, event.id) };
    }
  });
}

let source: EventSource | undefined;

/** Loads the state and follows the server's event stream; a reconnect reloads what was open. */
export function connect(): void {
  if (source) return;
  void loadState();
  source = new EventSource("/api/events");
  for (const type of ["platform", "integrations", "settings", "incidents", "incident", "removed"] as const) {
    source.addEventListener(type, (message) => {
      try {
        apply(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
      } catch {
        // A malformed event is skipped; the next one carries the full state again.
      }
    });
  }
  source.addEventListener("open", () => {
    const reconnected = state.connection === "reconnecting";
    setState((current) => ({ ...current, connection: "open" }));
    if (reconnected) {
      void loadState();
      for (const id of Object.keys(state.views)) void loadIncident(id);
    }
  });
  source.addEventListener("error", () => setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" })));
}
