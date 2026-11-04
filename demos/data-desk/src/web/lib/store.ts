import { useSyncExternalStore } from "react";
import type { AnalysisSummary, AnalysisView, AttachResponse, DatasetSummary, EnvironmentView, PlatformStatus, ServerEvent } from "../../shared/types.js";
import { api, errorMessage } from "./api.js";
import { analysisHref, homeHref, navigate, parseHash } from "./router.js";
import { toast } from "./toast.js";

export type Connection = "connecting" | "open" | "reconnecting";

/** A message the person sent that the analysis doesn't show yet. */
export interface Outgoing {
  readonly key: number;
  readonly text: string;
  /** How many of the person's messages the analysis showed when this one was sent. */
  readonly after: number;
  readonly failed?: string;
}

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  readonly environments: readonly EnvironmentView[];
  readonly datasets: readonly DatasetSummary[];
  /** Most recently updated first. */
  readonly analyses: readonly AnalysisSummary[];
  readonly views: Readonly<Record<string, AnalysisView>>;
  readonly viewErrors: Readonly<Record<string, string>>;
  readonly outgoing: Readonly<Record<string, readonly Outgoing[]>>;
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
  readonly maxUploadBytes: number;
}

const initialState: StoreState = {
  phase: "loading",
  connection: "connecting",
  environments: [],
  datasets: [],
  analyses: [],
  views: {},
  viewErrors: {},
  outgoing: {},
  attachCommand: "",
  canLaunchTerminal: false,
  maxUploadBytes: 5 * 1024 * 1024,
};

let state: StoreState = initialState;
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

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

const userTexts = (view: AnalysisView): string[] => view.items.flatMap((item) => (item.kind === "user" ? [item.text.trim()] : []));

/** Drops sent messages the analysis now shows: a message of the person's with the same text, after the ones it followed. */
export function settleOutgoing(outgoing: StoreState["outgoing"], view: AnalysisView): StoreState["outgoing"] {
  const pending = outgoing[view.id];
  if (!pending?.length) return outgoing;
  const texts = userTexts(view);
  const left = pending.filter((item) => item.failed !== undefined || !texts.slice(item.after).includes(item.text));
  if (left.length === pending.length) return outgoing;
  return left.length ? { ...outgoing, [view.id]: left } : without(outgoing, view.id);
}

// ─── Server state ────────────────────────────────────────────────────────────────────────────────────────────

async function loadState(): Promise<void> {
  try {
    const loaded = await api.state();
    setState((current) => ({
      ...current,
      phase: "ready",
      platform: loaded.platform,
      environments: loaded.environments,
      datasets: loaded.datasets,
      analyses: loaded.analyses,
      attachCommand: loaded.attachCommand,
      canLaunchTerminal: loaded.canLaunchTerminal,
      maxUploadBytes: loaded.maxUploadBytes,
    }));
  } catch (error) {
    setState((current) => (current.phase === "ready" ? current : { ...current, phase: "error", loadError: errorMessage(error) }));
  }
}

const loading = new Map<string, Promise<void>>();

/** Loads an analysis (the server resumes it first if needed). */
export function loadAnalysis(id: string): Promise<void> {
  let pending = loading.get(id);
  if (!pending) {
    pending = api
      .analysis(id)
      .then((view) => storeView(view))
      .catch((error: unknown) => {
        setState((current) => ({ ...current, viewErrors: { ...current.viewErrors, [id]: errorMessage(error) } }));
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

function storeView(view: AnalysisView): void {
  setState((current) => ({
    ...current,
    views: { ...current.views, [view.id]: view },
    viewErrors: without(current.viewErrors, view.id),
    outgoing: settleOutgoing(current.outgoing, view),
  }));
}

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case "platform": {
      const wasConnected = state.platform?.state === "connected";
      setState((current) => ({ ...current, platform: event.platform, environments: event.environments }));
      // Analyses resume on the new connection: refresh the one on screen.
      const route = parseHash(window.location.hash);
      if (!wasConnected && event.platform.state === "connected" && route.kind === "analysis") void loadAnalysis(route.id);
      return;
    }
    case "datasets":
      setState((current) => ({ ...current, datasets: event.datasets }));
      return;
    case "analyses":
      setState((current) => ({ ...current, analyses: event.analyses }));
      return;
    case "analysis":
      storeView(event.analysis);
      return;
    case "removed": {
      setState((current) => ({
        ...current,
        views: without(current.views, event.id),
        outgoing: without(current.outgoing, event.id),
        analyses: current.analyses.filter((summary) => summary.id !== event.id),
      }));
      const route = parseHash(window.location.hash);
      if (route.kind === "analysis" && route.id === event.id) navigate(homeHref(), { replace: true });
      return;
    }
  }
}

// ─── Server-sent events ──────────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES: readonly ServerEvent["type"][] = ["platform", "datasets", "analyses", "analysis", "removed"];
const CLOSED = 2;

let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1000;

function parseEvent(data: unknown): ServerEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") return parsed as ServerEvent;
  } catch {
    // Ignore malformed messages.
  }
  return undefined;
}

function connectEvents(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  source?.close();
  let events: EventSource;
  try {
    events = new EventSource("/api/events");
  } catch {
    scheduleReconnect();
    return;
  }
  source = events;
  events.onopen = () => {
    backoffMs = 1000;
    setState((current) => (current.connection === "open" ? current : { ...current, connection: "open" }));
    // Anything may have changed while we weren't listening.
    void loadState();
    const route = parseHash(window.location.hash);
    if (route.kind === "analysis") void loadAnalysis(route.id);
  };
  events.onerror = () => {
    if (source !== events) return;
    setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
    if (events.readyState === CLOSED) scheduleReconnect();
  };
  const onMessage = (message: MessageEvent): void => {
    const event = parseEvent(message.data);
    if (event) handleServerEvent(event);
  };
  for (const type of EVENT_TYPES) events.addEventListener(type, onMessage as EventListener);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  const delay = backoffMs + Math.round(Math.random() * 400);
  backoffMs = Math.min(backoffMs * 2, 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectEvents();
  }, delay);
}

let started = false;

/** Loads `/api/state` and opens the event stream. Safe to call more than once. */
export function startDesk(): void {
  if (started) return;
  started = true;
  connectEvents();
  void loadState();
}

// ─── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Starts an analysis of a dataset and opens it. */
export async function createAnalysis(datasetId: string): Promise<boolean> {
  try {
    const view = await api.create(datasetId);
    setState((current) => ({
      ...current,
      views: { ...current.views, [view.id]: view },
      analyses: current.analyses.some((summary) => summary.id === view.id) ? current.analyses : [view, ...current.analyses],
    }));
    navigate(analysisHref(view.id));
    return true;
  } catch (error) {
    toast.error("Couldn't start the analysis", errorMessage(error));
    return false;
  }
}

/** Uploads a CSV file and starts an analysis of it. */
export async function uploadAndAnalyze(file: File): Promise<boolean> {
  if (file.size > state.maxUploadBytes) {
    toast.error("That file is too large", `Upload a CSV file up to ${Math.round(state.maxUploadBytes / (1024 * 1024))} MB.`);
    return false;
  }
  try {
    const dataset = await api.upload(file);
    setState((current) => (current.datasets.some((item) => item.id === dataset.id) ? current : { ...current, datasets: [...current.datasets, dataset] }));
    return await createAnalysis(dataset.id);
  } catch (error) {
    toast.error("Couldn't add that file", errorMessage(error));
    return false;
  }
}

let outgoingKey = 0;

/** Sends a message; it shows right away and settles when the analysis shows it. */
export async function sendMessage(id: string, prompt: string): Promise<boolean> {
  const view = state.views[id];
  const item: Outgoing = { key: ++outgoingKey, text: prompt.trim(), after: view ? userTexts(view).length : 0 };
  setState((current) => ({ ...current, outgoing: { ...current.outgoing, [id]: [...(current.outgoing[id] ?? []), item] } }));
  try {
    await api.send(id, prompt);
    return true;
  } catch (error) {
    const failed = errorMessage(error);
    setState((current) => ({
      ...current,
      outgoing: { ...current.outgoing, [id]: (current.outgoing[id] ?? []).map((entry) => (entry.key === item.key ? { ...entry, failed } : entry)) },
    }));
    return false;
  }
}

export function dismissOutgoing(id: string, key: number): void {
  setState((current) => {
    const left = (current.outgoing[id] ?? []).filter((entry) => entry.key !== key);
    return { ...current, outgoing: left.length ? { ...current.outgoing, [id]: left } : without(current.outgoing, id) };
  });
}

export async function answerMove(id: string, approve: boolean): Promise<void> {
  try {
    storeView(await api.move(id, approve));
  } catch (error) {
    toast.error("Couldn't answer", errorMessage(error));
    void loadAnalysis(id);
  }
}

export async function stopTurn(id: string): Promise<void> {
  try {
    await api.stop(id);
  } catch (error) {
    toast.error("Couldn't stop", errorMessage(error));
  }
}

export async function deleteAnalysis(id: string): Promise<boolean> {
  try {
    await api.delete(id);
    handleServerEvent({ type: "removed", id });
    return true;
  } catch (error) {
    toast.error("Couldn't delete the analysis", errorMessage(error));
    return false;
  }
}

/** Opens the session in Copilot CLI; answers with the command when this machine can't open a window for it. */
export async function openInCli(id: string): Promise<AttachResponse | undefined> {
  try {
    const result = await api.attach(id);
    if (result.launched) toast.success("Copilot CLI is open", result.message);
    return result;
  } catch (error) {
    toast.error("Couldn't open Copilot CLI", errorMessage(error));
    return undefined;
  }
}
