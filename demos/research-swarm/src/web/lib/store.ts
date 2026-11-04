import { useSyncExternalStore } from "react";
import type { AppState, Run, ServerEvent } from "../../shared/types.js";
import { api, errorMessage } from "./api.js";

export type Connection = "connecting" | "open" | "reconnecting";

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly app?: AppState;
  readonly runs: Readonly<Record<string, Run>>;
  /** Runs that couldn't be loaded, with why. */
  readonly missing: Readonly<Record<string, string>>;
}

let state: StoreState = { phase: "loading", connection: "connecting", runs: {}, missing: {} };
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

/** Subscribes to a slice of the store. Selectors must return existing references (no new objects or arrays). */
export function useStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function putRun(run: Run): void {
  setState((current) => {
    const existing = current.runs[run.id];
    if (existing && existing.updatedAt > run.updatedAt) return current;
    const { [run.id]: _gone, ...missing } = current.missing;
    return { ...current, runs: { ...current.runs, [run.id]: run }, missing };
  });
}

function onEvent(event: ServerEvent): void {
  if (event.type === "state") setState((current) => ({ ...current, app: event.state, phase: "ready" }));
  else if (event.type === "run") putRun(event.run);
  else
    setState((current) => {
      const { [event.id]: _gone, ...runs } = current.runs;
      return { ...current, runs, missing: { ...current.missing, [event.id]: "This research was deleted." } };
    });
}

let started = false;

/** Loads the app's state and follows the server's event stream (reconnecting by itself). */
export function startStore(): void {
  if (started) return;
  started = true;
  api.state().then(
    (app) => setState((current) => ({ ...current, app, phase: "ready" })),
    (error: unknown) => setState((current) => (current.phase === "ready" ? current : { ...current, phase: "error", loadError: errorMessage(error) })),
  );
  const source = new EventSource("/api/events");
  source.onopen = () => {
    const reconnected = state.connection === "reconnecting";
    setState((current) => ({ ...current, connection: "open" }));
    // Updates sent while the stream was down are gone: read the runs on screen again.
    if (reconnected) for (const id of Object.keys(state.runs)) void loadRun(id);
  };
  source.onerror = () => setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
  for (const type of ["state", "run", "removed"] as const) {
    source.addEventListener(type, (message) => {
      try {
        onEvent(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
      } catch {
        // A malformed event is skipped; the next one carries the full state again.
      }
    });
  }
}

export async function loadRun(id: string): Promise<void> {
  try {
    putRun(await api.run(id));
  } catch (error) {
    setState((current) => ({ ...current, missing: { ...current.missing, [id]: errorMessage(error) } }));
  }
}

export async function startRun(question: string): Promise<Run> {
  const run = await api.start(question);
  putRun(run);
  return run;
}

export async function stopRun(id: string): Promise<void> {
  putRun(await api.stop(id));
}

export async function removeRun(id: string): Promise<void> {
  await api.remove(id);
  onEvent({ type: "removed", id });
}
