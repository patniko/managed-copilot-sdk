import { useSyncExternalStore } from "react";
import { DEFAULT_JOB, type JobId } from "../../shared/jobs.js";
import type { LaneId } from "../../shared/lanes.js";
import type { ApiErrorBody, AppState } from "../../shared/types.js";

export type Connection = "connecting" | "open" | "reconnecting";

export interface StoreState {
  readonly app?: AppState;
  readonly connection: Connection;
  /** The server's clock minus this browser's, so lane stopwatches agree with the server. */
  readonly skew: number;
  /** The job the picker shows; follows the last race until the person picks one. */
  readonly job: JobId;
  readonly picked: boolean;
  /** A start or stop request is on its way. */
  readonly pending: boolean;
  /** Why the last start or stop failed. */
  readonly error?: string;
  /** The lane whose details are open. */
  readonly open?: LaneId;
}

let state: StoreState = { connection: "connecting", skew: 0, job: DEFAULT_JOB, picked: false, pending: false };
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

function receive(app: AppState): void {
  setState((current) => ({
    ...current,
    app,
    skew: app.serverNow - Date.now(),
    job: current.picked || !app.race ? current.job : app.race.job,
  }));
}

/** Follows the server's state over server-sent events; the browser reconnects by itself. */
export function connect(): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => setState((current) => ({ ...current, connection: "open" })));
  source.addEventListener("error", () => setState((current) => ({ ...current, connection: current.app ? "reconnecting" : "connecting" })));
  source.addEventListener("state", (event) => receive(JSON.parse((event as MessageEvent<string>).data) as AppState));
  return () => source.close();
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.ok) return;
  const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
  throw new Error(error?.error.message ?? `The server answered ${response.status}.`);
}

async function act(action: () => Promise<void>): Promise<void> {
  setState((current) => ({ ...current, pending: true, error: undefined }));
  try {
    await action();
    setState((current) => ({ ...current, pending: false }));
  } catch (error) {
    const message = error instanceof TypeError ? "Pattern Race isn't reachable. Check that it's running." : (error as Error).message;
    setState((current) => ({ ...current, pending: false, error: message }));
  }
}

export function pickJob(job: JobId): void {
  setState((current) => ({ ...current, job, picked: true, error: undefined }));
}

export function startRace(): Promise<void> {
  return act(() => post("/api/race", { job: state.job }));
}

export function stopRace(): Promise<void> {
  return act(() => post("/api/race/stop"));
}

export function openLane(lane: LaneId | undefined): void {
  setState((current) => (current.open === lane ? current : { ...current, open: lane }));
}
