import { useSyncExternalStore } from "react";
import { STEP_IDS, summarize, type LogLine, type PlatformStatus, type RunSummary, type RunView, type SampleInfo, type ServerEvent, type StepId, type StepLogs } from "../../shared/types.js";
import { api, errorMessage } from "./api.js";
import { homeHref, navigate, parseHash } from "./router.js";

type Connection = "connecting" | "open" | "reconnecting";

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  /** Newest first. */
  readonly runs: readonly RunSummary[];
  /** Runs this tab opened or saw change, kept current by the event stream. */
  readonly views: Readonly<Record<string, RunView>>;
  readonly logs: Readonly<Record<string, StepLogs>>;
  readonly viewErrors: Readonly<Record<string, string>>;
  readonly sample?: SampleInfo;
  readonly maxRuns: number;
}

const MAX_LINES = 500;

let state: StoreState = { phase: "loading", connection: "connecting", runs: [], views: {}, logs: {}, viewErrors: {}, maxRuns: 3 };
const listeners = new Set<() => void>();
/** The highest log line number each loaded run has, lines that arrived while its log was loading, and its latest load. */
const lastSeq = new Map<string, number>();
const pending = new Map<string, { step: StepId; line: LogLine }[]>();
const loads = new Map<string, number>();

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

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function upsertRun(current: StoreState, run: RunView): StoreState {
  // Events and fetched snapshots can arrive out of order: the higher revision is the newer view.
  if ((current.views[run.id]?.revision ?? -1) > run.revision) return current;
  const runs = [...current.runs.filter((item) => item.id !== run.id), summarize(run)].sort((a, b) => b.number - a.number);
  return { ...current, runs, views: { ...current.views, [run.id]: run } };
}

function appendLines(current: StoreState, id: string, lines: readonly { step: StepId; line: LogLine }[]): StoreState {
  const logs = current.logs[id];
  if (!logs || lines.length === 0) return current;
  let last = lastSeq.get(id) ?? 0;
  const next: Record<StepId, LogLine[]> = { ...logs } as Record<StepId, LogLine[]>;
  let changed = false;
  for (const { step, line } of lines) {
    if (line.seq <= last) continue;
    last = line.seq;
    const merged = [...next[step], line];
    next[step] = merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
    changed = true;
  }
  lastSeq.set(id, last);
  return changed ? { ...current, logs: { ...current.logs, [id]: next } } : current;
}

function handle(event: ServerEvent): void {
  switch (event.type) {
    case "platform":
      setState((current) => ({ ...current, platform: event.platform }));
      return;
    case "run":
      setState((current) => upsertRun(current, event.run));
      return;
    case "run.deleted": {
      lastSeq.delete(event.id);
      pending.delete(event.id);
      loads.delete(event.id);
      setState((current) => ({ ...current, runs: current.runs.filter((run) => run.id !== event.id), views: without(current.views, event.id), logs: without(current.logs, event.id) }));
      const route = parseHash(window.location.hash);
      if (route.kind === "run" && route.id === event.id) navigate(homeHref(), { replace: true });
      return;
    }
    case "log": {
      const waiting = pending.get(event.runId);
      if (waiting) waiting.push({ step: event.step, line: event.line });
      else setState((current) => appendLines(current, event.runId, [{ step: event.step, line: event.line }]));
      return;
    }
  }
}

async function loadState(): Promise<void> {
  const loaded = await api.state();
  setState((current) => ({ ...current, phase: "ready", platform: loaded.platform, runs: loaded.runs, sample: loaded.sample, maxRuns: loaded.maxRuns }));
}

/**
 * Loads a run with its logs. Lines streamed meanwhile are buffered and merged in by number; when loads overlap (a
 * reconnect while the page opens), only the latest one commits, and the buffer stays until it does.
 */
export async function loadRun(id: string): Promise<void> {
  const generation = (loads.get(id) ?? 0) + 1;
  loads.set(id, generation);
  if (!pending.has(id)) pending.set(id, []);
  try {
    const detail = await api.run(id);
    if (loads.get(id) !== generation) return;
    const logs = Object.fromEntries(STEP_IDS.map((step) => [step, detail.logs[step] ?? []])) as StepLogs;
    lastSeq.set(id, Math.max(0, ...STEP_IDS.flatMap((step) => logs[step].map((line) => line.seq))));
    const streamed = pending.get(id) ?? [];
    pending.delete(id);
    setState((current) => appendLines({ ...upsertRun(current, detail.run), logs: { ...current.logs, [id]: logs }, viewErrors: without(current.viewErrors, id) }, id, streamed));
  } catch (error) {
    if (loads.get(id) !== generation) return;
    pending.delete(id);
    setState((current) => ({ ...current, viewErrors: { ...current.viewErrors, [id]: errorMessage(error) } }));
  }
}

let started = false;

export function startStore(): void {
  if (started) return;
  started = true;
  loadState().catch((error: unknown) => setState((current) => ({ ...current, phase: "error", loadError: errorMessage(error) })));
  const source = new EventSource("/api/events");
  let dropped = false;
  source.onopen = () => {
    setState((current) => ({ ...current, connection: "open" }));
    if (!dropped) return;
    dropped = false;
    // Events may have been missed while disconnected: reload the list and the runs this tab has open.
    void loadState().catch(() => undefined);
    for (const id of Object.keys(state.views)) void loadRun(id);
  };
  source.onerror = () => {
    dropped = true;
    setState((current) => ({ ...current, connection: "reconnecting" }));
  };
  for (const type of ["platform", "run", "run.deleted", "log"] as const) {
    source.addEventListener(type, (message) => {
      try {
        handle(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
      } catch {
        // A malformed event is skipped; the next reload resyncs.
      }
    });
  }
}

export function retryLoad(): void {
  setState((current) => ({ ...current, phase: "loading" }));
  loadState().catch((error: unknown) => setState((current) => ({ ...current, phase: "error", loadError: errorMessage(error) })));
}
