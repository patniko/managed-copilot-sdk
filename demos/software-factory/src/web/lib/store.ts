import { useEffect, useSyncExternalStore } from "react";
import { TERMINAL_STATION_STATUSES } from "../../shared/types.js";
import type {
  ActivityItem,
  ArtifactIndex,
  CreateWorkOrderRequest,
  FactoryState,
  PlatformStatus,
  ServerEvent,
  WorkOrder,
  WorkOrderSummary,
  WorkOrderTemplate,
} from "../../shared/types.js";
import { api, toErrorInfo, type ErrorInfo } from "./api.js";
import { parseTime } from "./format.js";

/** A fetched resource with stale-while-revalidate semantics. */
export interface Resource<T> {
  readonly data?: T;
  readonly loading: boolean;
  /** Needs a refetch (for example after the event stream reconnects). */
  readonly stale: boolean;
  readonly error?: ErrorInfo;
}

/** Streaming assistant text that has not been persisted as a `message` activity yet. */
export interface Draft {
  readonly messageId: string;
  readonly text: string;
}

export type Connection = "connecting" | "open" | "reconnecting";

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: ErrorInfo;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  readonly templates: readonly WorkOrderTemplate[];
  readonly attachCommand: string;
  readonly canLaunchTerminal: boolean;
  /** Newest first. */
  readonly summaries: readonly WorkOrderSummary[];
  readonly workOrders: Readonly<Record<string, Resource<WorkOrder>>>;
  /** Keyed by `activityKey(workOrderId, stationId)`. */
  readonly activity: Readonly<Record<string, Resource<readonly ActivityItem[]>>>;
  readonly drafts: Readonly<Record<string, readonly Draft[]>>;
  readonly artifacts: Readonly<Record<string, Resource<ArtifactIndex>>>;
}

const initialState: StoreState = {
  phase: "loading",
  connection: "connecting",
  templates: [],
  attachCommand: "",
  canLaunchTerminal: false,
  summaries: [],
  workOrders: {},
  activity: {},
  drafts: {},
  artifacts: {},
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

export function getState(): StoreState {
  return state;
}

/** Subscribes to a slice of the store. Selectors must return existing references (no new objects or arrays). */
export function useStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

export function activityKey(workOrderId: string, stationId: string): string {
  return `${workOrderId}\n${stationId}`;
}

function setEntry<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Readonly<Record<string, T>> {
  if (value === undefined) {
    if (!(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
  }
  return { ...record, [key]: value };
}

function mapEntries<T>(record: Readonly<Record<string, T>>, map: (value: T) => T): Readonly<Record<string, T>> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) next[key] = map(value);
  return next;
}

function withoutPrefix<T>(record: Readonly<Record<string, T>>, prefix: string): Readonly<Record<string, T>> {
  const keys = Object.keys(record).filter((key) => key.startsWith(prefix));
  if (keys.length === 0) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

/** True when `candidate` is strictly older than `current` (by `updatedAt`). */
function isOlder(candidate: { readonly updatedAt: string }, current: { readonly updatedAt: string }): boolean {
  const a = parseTime(candidate.updatedAt);
  const b = parseTime(current.updatedAt);
  return a !== undefined && b !== undefined && a < b;
}

export function toSummary(workOrder: WorkOrder): WorkOrderSummary {
  return {
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    createdAt: workOrder.createdAt,
    updatedAt: workOrder.updatedAt,
    startedAt: workOrder.startedAt,
    completedAt: workOrder.completedAt,
    taskCount: workOrder.taskCount,
    tests: workOrder.tests,
    error: workOrder.error,
  };
}

function sortSummaries(list: readonly WorkOrderSummary[]): readonly WorkOrderSummary[] {
  return [...list].sort(
    (a, b) => (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0) || b.number - a.number,
  );
}

function upsertSummary(
  list: readonly WorkOrderSummary[],
  summary: WorkOrderSummary,
  preferExisting = false,
): readonly WorkOrderSummary[] {
  const index = list.findIndex((item) => item.id === summary.id);
  if (index < 0) return sortSummaries([summary, ...list]);
  const existing = list[index];
  if (existing && (isOlder(summary, existing) || (preferExisting && !isOlder(existing, summary)))) return list;
  const next = [...list];
  next[index] = summary;
  return next;
}

function upsertActivityItem(items: readonly ActivityItem[], item: ActivityItem): readonly ActivityItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const existing = items[index];
  if (existing && !preferIncoming(existing, item)) return items;
  const next = [...items];
  next[index] = item;
  return next;
}

/** Tool items are re-sent when they complete; never let a late "running" copy replace a finished one. */
function preferIncoming(existing: ActivityItem, incoming: ActivityItem): boolean {
  if (existing.tool && incoming.tool) {
    const rank = (item: ActivityItem): number => (item.tool?.status === "running" ? 0 : 1);
    return rank(incoming) >= rank(existing);
  }
  return true;
}

function mergeActivity(base: readonly ActivityItem[], incoming: readonly ActivityItem[]): readonly ActivityItem[] {
  let merged = base;
  for (const item of incoming) merged = upsertActivityItem(merged, item);
  return merged;
}

const EMPTY: Resource<never> = { loading: false, stale: false };

// ─── Bookkeeping outside React state ─────────────────────────────────────────────────────────────────────────

const deletedIds = new Set<string>();
/** Activity received while a fetch for the same key is in flight; merged into the fetched list. */
const pendingActivity = new Map<string, ActivityItem[]>();
/** `key\nmessageId` of messages already persisted, so late deltas don't resurrect a draft. */
const completedMessages = new Set<string>();
/** Sequence number of the last local upsert per work order, to reconcile with `/api/state` snapshots. */
const touchedAt = new Map<string, number>();
let sequence = 0;

function rememberCompleted(id: string): void {
  completedMessages.add(id);
  if (completedMessages.size > 4000) {
    let removed = 0;
    for (const value of completedMessages) {
      completedMessages.delete(value);
      if (++removed >= 2000) break;
    }
  }
}

// ─── Applying server data ────────────────────────────────────────────────────────────────────────────────────

function applySnapshot(snapshot: FactoryState, requestedAt: number): void {
  setState((current) => {
    const local = new Map(current.summaries.map((summary) => [summary.id, summary]));
    const merged: WorkOrderSummary[] = [];
    const seen = new Set<string>();
    for (const summary of snapshot.workOrders) {
      if (deletedIds.has(summary.id)) continue;
      seen.add(summary.id);
      const mine = local.get(summary.id);
      merged.push(mine && isOlder(summary, mine) ? mine : summary);
    }
    // Keep work orders we heard about after the snapshot was requested (created while it was in flight).
    for (const summary of current.summaries) {
      if (!seen.has(summary.id) && (touchedAt.get(summary.id) ?? -1) > requestedAt) merged.push(summary);
    }
    const platformIsNewer =
      current.platform !== undefined &&
      (parseTime(current.platform.checkedAt) ?? 0) > (parseTime(snapshot.platform.checkedAt) ?? 0);
    return {
      ...current,
      phase: "ready",
      loadError: undefined,
      platform: platformIsNewer ? current.platform : snapshot.platform,
      templates: snapshot.templates,
      attachCommand: snapshot.attachCommand,
      canLaunchTerminal: snapshot.canLaunchTerminal,
      summaries: sortSummaries(merged),
    };
  });
}

/**
 * Live events arrive in order, so they win ties. REST responses (`fromRest`) only replace strictly newer data: the
 * server can emit live updates in the same millisecond as the snapshot it returns.
 */
function applyWorkOrder(workOrder: WorkOrder, fromRest = false): void {
  if (deletedIds.has(workOrder.id)) return;
  touchedAt.set(workOrder.id, ++sequence);
  setState((current) => {
    const entry = current.workOrders[workOrder.id];
    if (entry?.data && (isOlder(workOrder, entry.data) || (fromRest && !isOlder(entry.data, workOrder)))) return current;
    let drafts = current.drafts;
    for (const station of workOrder.stations) {
      if (TERMINAL_STATION_STATUSES.includes(station.status)) {
        drafts = setEntry(drafts, activityKey(workOrder.id, station.id), undefined);
      }
    }
    return {
      ...current,
      workOrders: setEntry(current.workOrders, workOrder.id, {
        data: workOrder,
        loading: entry?.loading ?? false,
        stale: false,
      }),
      summaries: upsertSummary(current.summaries, toSummary(workOrder), fromRest),
      drafts,
    };
  });
}

function applyDeleted(workOrderId: string): void {
  deletedIds.add(workOrderId);
  const prefix = `${workOrderId}\n`;
  for (const key of [...pendingActivity.keys()]) if (key.startsWith(prefix)) pendingActivity.delete(key);
  setState((current) => ({
    ...current,
    summaries: current.summaries.filter((summary) => summary.id !== workOrderId),
    // Keep a tombstone so an open view explains what happened instead of loading forever.
    workOrders: setEntry(current.workOrders, workOrderId, {
      loading: false,
      stale: false,
      error: { code: "deleted", message: "This work order was deleted.", status: 404 },
    }),
    activity: withoutPrefix(current.activity, prefix),
    drafts: withoutPrefix(current.drafts, prefix),
    artifacts: setEntry(current.artifacts, workOrderId, undefined),
  }));
}

function applyActivity(item: ActivityItem): void {
  if (deletedIds.has(item.workOrderId)) return;
  const key = activityKey(item.workOrderId, item.stationId);
  const messageId = item.id.startsWith("msg:") ? item.id.slice(4) : undefined;
  if (messageId) rememberCompleted(`${key}\n${messageId}`);
  pendingActivity.get(key)?.push(item);
  setState((current) => {
    let next = current;
    const drafts = current.drafts[key];
    if (messageId && drafts?.some((draft) => draft.messageId === messageId)) {
      const remaining = drafts.filter((draft) => draft.messageId !== messageId);
      next = { ...next, drafts: setEntry(next.drafts, key, remaining.length > 0 ? remaining : undefined) };
    }
    const resource = current.activity[key];
    if (resource?.data) {
      next = { ...next, activity: setEntry(next.activity, key, { ...resource, data: upsertActivityItem(resource.data, item) }) };
    }
    return next;
  });
}

function applyDelta(event: Extract<ServerEvent, { type: "delta" }>): void {
  if (deletedIds.has(event.workOrderId) || !event.text) return;
  const key = activityKey(event.workOrderId, event.stationId);
  if (completedMessages.has(`${key}\n${event.messageId}`)) return;
  setState((current) => {
    const drafts = current.drafts[key] ?? [];
    const index = drafts.findIndex((draft) => draft.messageId === event.messageId);
    const next =
      index >= 0
        ? drafts.map((draft, i) => (i === index ? { ...draft, text: draft.text + event.text } : draft))
        : [...drafts, { messageId: event.messageId, text: event.text }];
    return { ...current, drafts: setEntry(current.drafts, key, next) };
  });
}

function markArtifactsStale(workOrderId: string): void {
  setState((current) => {
    const resource = current.artifacts[workOrderId];
    if (!resource || resource.stale) return current;
    return { ...current, artifacts: setEntry(current.artifacts, workOrderId, { ...resource, stale: true }) };
  });
}

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case "platform":
      setState((current) => ({ ...current, platform: event.platform }));
      break;
    case "workOrder":
      applyWorkOrder(event.workOrder);
      break;
    case "workOrderDeleted":
      applyDeleted(event.workOrderId);
      break;
    case "activity":
      applyActivity(event.item);
      break;
    case "delta":
      applyDelta(event);
      break;
    case "artifacts":
      markArtifactsStale(event.workOrderId);
      break;
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────────────────────────────────────

async function loadState(): Promise<void> {
  const requestedAt = sequence;
  try {
    const snapshot = await api.state();
    applySnapshot(snapshot, requestedAt);
  } catch (error) {
    // Keep showing what we have; the full-page error is only for the first load.
    if (state.phase !== "ready") setState((current) => ({ ...current, phase: "error", loadError: toErrorInfo(error) }));
  }
}

/** Retries the initial load from the full-page error. */
export async function reloadState(): Promise<void> {
  setState((current) => (current.phase === "ready" ? current : { ...current, phase: "loading", loadError: undefined }));
  await loadState();
  if (!source || source.readyState === 2) connectEvents();
}

function canStart<T>(resource: Resource<T> | undefined, force: boolean): boolean {
  if (resource?.loading) return false;
  if (!resource) return true;
  return force || resource.stale || (resource.data === undefined && resource.error === undefined);
}

export function ensureWorkOrder(id: string, force = false): void {
  if (deletedIds.has(id) || !canStart(state.workOrders[id], force)) return;
  setState((current) => ({
    ...current,
    workOrders: setEntry(current.workOrders, id, { ...(current.workOrders[id] ?? EMPTY), loading: true }),
  }));
  api.workOrder(id).then(
    (workOrder) => {
      if (deletedIds.has(id)) return;
      touchedAt.set(id, ++sequence);
      setState((current) => {
        const previous = current.workOrders[id]?.data;
        const data = previous && !isOlder(previous, workOrder) ? previous : workOrder;
        return {
          ...current,
          workOrders: setEntry(current.workOrders, id, { data, loading: false, stale: false }),
          summaries: upsertSummary(current.summaries, toSummary(data), true),
        };
      });
    },
    (error: unknown) => {
      setState((current) => ({
        ...current,
        workOrders: setEntry(current.workOrders, id, {
          data: current.workOrders[id]?.data,
          loading: false,
          stale: false,
          error: toErrorInfo(error),
        }),
      }));
    },
  );
}

export function ensureActivity(workOrderId: string, stationId: string, force = false): void {
  const key = activityKey(workOrderId, stationId);
  if (deletedIds.has(workOrderId) || !canStart(state.activity[key], force)) return;
  pendingActivity.set(key, []);
  setState((current) => ({
    ...current,
    activity: setEntry(current.activity, key, { ...(current.activity[key] ?? EMPTY), loading: true }),
  }));
  api.activity(workOrderId, stationId).then(
    (items) => {
      const pending = pendingActivity.get(key) ?? [];
      pendingActivity.delete(key);
      if (deletedIds.has(workOrderId)) return;
      const fetched: readonly ActivityItem[] = Array.isArray(items) ? items : [];
      for (const item of fetched) {
        if (item.id.startsWith("msg:")) rememberCompleted(`${key}\n${item.id.slice(4)}`);
      }
      setState((current) => {
        const drafts = current.drafts[key];
        const completed = new Set(fetched.filter((item) => item.id.startsWith("msg:")).map((item) => item.id.slice(4)));
        const remainingDrafts = drafts?.filter((draft) => !completed.has(draft.messageId));
        return {
          ...current,
          activity: setEntry(current.activity, key, { data: mergeActivity(fetched, pending), loading: false, stale: false }),
          drafts:
            drafts && remainingDrafts && remainingDrafts.length !== drafts.length
              ? setEntry(current.drafts, key, remainingDrafts.length > 0 ? remainingDrafts : undefined)
              : current.drafts,
        };
      });
    },
    (error: unknown) => {
      pendingActivity.delete(key);
      setState((current) => ({
        ...current,
        activity: setEntry(current.activity, key, {
          data: current.activity[key]?.data,
          loading: false,
          stale: false,
          error: toErrorInfo(error),
        }),
      }));
    },
  );
}

export function ensureArtifacts(workOrderId: string, force = false): void {
  if (deletedIds.has(workOrderId) || !canStart(state.artifacts[workOrderId], force)) return;
  setState((current) => ({
    ...current,
    artifacts: setEntry(current.artifacts, workOrderId, { ...(current.artifacts[workOrderId] ?? EMPTY), loading: true }),
  }));
  api.artifacts(workOrderId).then(
    (index) => {
      if (deletedIds.has(workOrderId)) return;
      setState((current) => ({
        ...current,
        artifacts: setEntry(current.artifacts, workOrderId, { data: index, loading: false, stale: false }),
      }));
    },
    (error: unknown) => {
      setState((current) => ({
        ...current,
        artifacts: setEntry(current.artifacts, workOrderId, {
          data: current.artifacts[workOrderId]?.data,
          loading: false,
          stale: false,
          error: toErrorInfo(error),
        }),
      }));
    },
  );
}

/** Marks everything stale and reloads the factory state; visible views refetch what they show. */
function resync(): void {
  setState((current) => ({
    ...current,
    workOrders: mapEntries(current.workOrders, (resource) => ({ ...resource, stale: true })),
    activity: mapEntries(current.activity, (resource) => ({ ...resource, stale: true })),
    artifacts: mapEntries(current.artifacts, (resource) => ({ ...resource, stale: true })),
    drafts: {},
  }));
  void loadState();
}

// ─── Server-sent events ──────────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES: readonly ServerEvent["type"][] = ["platform", "workOrder", "workOrderDeleted", "activity", "delta", "artifacts"];
const CLOSED = 2;

let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1000;

function parseEvent(data: unknown): ServerEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as ServerEvent;
    }
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
    // Anything may have changed while we were not listening (or before the first connection opened).
    resync();
  };
  events.onerror = () => {
    if (source !== events) return;
    setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
    // The browser retries on its own unless the stream was closed for good (for example an HTTP error).
    if (events.readyState === CLOSED) scheduleReconnect();
  };
  const onMessage = (message: MessageEvent): void => {
    const event = parseEvent(message.data);
    if (event) handleServerEvent(event);
  };
  for (const type of EVENT_TYPES) events.addEventListener(type, onMessage as EventListener);
  events.onmessage = onMessage;
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
export function startFactory(): void {
  if (started) return;
  started = true;
  connectEvents();
  void loadState();
}

// ─── Mutations ───────────────────────────────────────────────────────────────────────────────────────────────

export async function createWorkOrder(request: CreateWorkOrderRequest): Promise<WorkOrder> {
  const workOrder = await api.createWorkOrder(request);
  applyWorkOrder(workOrder, true);
  return workOrder;
}

export async function cancelWorkOrder(id: string): Promise<WorkOrder> {
  const workOrder = await api.cancelWorkOrder(id);
  applyWorkOrder(workOrder, true);
  return workOrder;
}

export async function retryWorkOrder(id: string): Promise<WorkOrder> {
  const workOrder = await api.retryWorkOrder(id);
  applyWorkOrder(workOrder, true);
  // Stations restart with new sessions: refetch what the views show.
  const prefix = `${id}\n`;
  setState((current) => {
    const activity: Record<string, Resource<readonly ActivityItem[]>> = { ...current.activity };
    for (const [key, resource] of Object.entries(current.activity)) {
      if (key.startsWith(prefix)) activity[key] = { ...resource, stale: true };
    }
    const artifacts = current.artifacts[id];
    return {
      ...current,
      activity,
      artifacts: artifacts ? setEntry(current.artifacts, id, { ...artifacts, stale: true }) : current.artifacts,
      drafts: withoutPrefix(current.drafts, prefix),
    };
  });
  return workOrder;
}

export async function deleteWorkOrder(id: string): Promise<void> {
  await api.deleteWorkOrder(id);
  applyDeleted(id);
}

// ─── Hooks ───────────────────────────────────────────────────────────────────────────────────────────────────

export function useWorkOrder(id: string | undefined): Resource<WorkOrder> | undefined {
  const resource = useStore((current) => (id ? current.workOrders[id] : undefined));
  const stale = resource?.stale ?? false;
  useEffect(() => {
    if (id) ensureWorkOrder(id);
  }, [id, stale]);
  return resource;
}

const NO_DRAFTS: readonly Draft[] = [];

export function useActivity(
  workOrderId: string,
  stationId: string | undefined,
): { readonly resource: Resource<readonly ActivityItem[]> | undefined; readonly drafts: readonly Draft[] } {
  const key = stationId ? activityKey(workOrderId, stationId) : undefined;
  const resource = useStore((current) => (key ? current.activity[key] : undefined));
  const drafts = useStore((current) => (key ? current.drafts[key] : undefined)) ?? NO_DRAFTS;
  const stale = resource?.stale ?? false;
  useEffect(() => {
    if (stationId) ensureActivity(workOrderId, stationId);
  }, [workOrderId, stationId, stale]);
  return { resource, drafts };
}

export function useArtifactIndex(workOrderId: string, enabled = true): Resource<ArtifactIndex> | undefined {
  const resource = useStore((current) => current.artifacts[workOrderId]);
  const stale = resource?.stale ?? false;
  useEffect(() => {
    if (enabled) ensureArtifacts(workOrderId);
  }, [workOrderId, stale, enabled]);
  return resource;
}
