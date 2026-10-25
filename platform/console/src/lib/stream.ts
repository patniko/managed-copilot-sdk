import { OPERATOR_ROUTES, type OperatorEvent, type OperatorLogEntry } from "@managed-copilot/protocol/operator";
import { useSyncExternalStore } from "react";
import { consoleHeaders, reportAuthError } from "./api.js";
import { backoffDelay } from "./backoff.js";
import { ApiError, apiErrorFromResponse, invalidResponseError, networkError } from "./errors.js";
import { isOperatorEvent, isOperatorLogEntry, mergeEvents, mergeLogs } from "./feed.js";
import { refreshActive, setPollingPaused } from "./poll.js";
import { SseParser, type SseMessage } from "./sse.js";

/**
 * The operator live stream (`GET /v1/operator/stream`): platform events and gateway log lines as server-sent events.
 * Read with `fetch` (EventSource cannot send the console request header), reconnected with backoff, and paused while
 * the console sits in the background or the operator pauses live updates.
 */
export type StreamStatus = "off" | "connecting" | "live" | "reconnecting" | "paused";

export interface StreamStatusSnapshot {
  readonly status: StreamStatus;
  /** When the next reconnect attempt starts (`reconnecting`). */
  readonly retryAt: number | undefined;
  /** Why the last connection ended. */
  readonly error: string | undefined;
  readonly connectedAt: number | undefined;
  /** The operator paused live updates (stream and auto-refresh). */
  readonly userPaused: boolean;
}

export interface StreamData {
  /** Live platform events received since the console connected, oldest first (capped). */
  readonly events: readonly OperatorEvent[];
  /** Live log entries, in sequence order (capped). */
  readonly logs: readonly OperatorLogEntry[];
}

export const MAX_LIVE_EVENTS = 500;
export const MAX_LIVE_LOGS = 1000;
/** Three missed `: ping` heartbeats (every ~15 s) means the connection is dead even if the socket is not. */
const IDLE_TIMEOUT_MS = 45_000;
/** How long opening the stream may take before the attempt is abandoned and retried. */
const OPEN_TIMEOUT_MS = 20_000;
/** A connection that stayed up this long resets the backoff. */
const HEALTHY_AFTER_MS = 10_000;
/** Keep streaming this long after the tab goes to the background. */
const BACKGROUND_GRACE_MS = 30_000;
const FLUSH_INTERVAL_MS = 200;

let statusSnapshot: StreamStatusSnapshot = { status: "off", retryAt: undefined, error: undefined, connectedAt: undefined, userPaused: false };
let dataSnapshot: StreamData = { events: [], logs: [] };
const statusListeners = new Set<() => void>();
const dataListeners = new Set<() => void>();

let wanted = false;
let userPaused = false;
let backgrounded = false;
let loopToken = 0;
let current: AbortController | undefined;
let wake: (() => void) | undefined;
let lastEventId: string | undefined;
let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEvents: OperatorEvent[] = [];
let pendingLogs: OperatorLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(next: Partial<StreamStatusSnapshot>): void {
  statusSnapshot = { ...statusSnapshot, ...next, userPaused };
  for (const listener of statusListeners) listener();
}

function flush(): void {
  flushTimer = undefined;
  if (pendingEvents.length === 0 && pendingLogs.length === 0) return;
  dataSnapshot = {
    events: pendingEvents.length > 0 ? mergeEvents([dataSnapshot.events, pendingEvents], MAX_LIVE_EVENTS) : dataSnapshot.events,
    logs: pendingLogs.length > 0 ? mergeLogs([dataSnapshot.logs, pendingLogs], MAX_LIVE_LOGS) : dataSnapshot.logs,
  };
  pendingEvents = [];
  pendingLogs = [];
  for (const listener of dataListeners) listener();
}

function dispatch(message: SseMessage): void {
  if (message.event !== "platform" && message.event !== "log") return;
  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return;
  }
  if (message.event === "platform" && isOperatorEvent(payload)) pendingEvents.push(payload);
  else if (message.event === "log" && isOperatorLogEntry(payload)) pendingLogs.push(payload);
  else return;
  flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
}

function shouldRun(): boolean {
  return wanted && !userPaused && !backgrounded;
}

function sleep(ms: number, token: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      if (wake === done) wake = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake = done;
    if (token !== loopToken) done();
  });
}

async function readBody(body: ReadableStream<Uint8Array>, controller: AbortController, onIdle: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let watchdog = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      for (const message of parser.push(decoder.decode(value, { stream: true }))) dispatch(message);
      if (parser.lastEventId !== undefined) lastEventId = parser.lastEventId;
    }
  } finally {
    clearTimeout(watchdog);
    if (!controller.signal.aborted) void reader.cancel().catch(() => undefined);
  }
}

async function loop(token: number): Promise<void> {
  let attempt = 0;
  while (token === loopToken && shouldRun()) {
    const controller = new AbortController();
    current = controller;
    setStatus({ status: attempt === 0 ? "connecting" : "reconnecting", retryAt: undefined });
    let openedAt: number | undefined;
    let idle = false;
    let openTimedOut = false;
    let failure: ApiError | undefined;
    // Until the stream is open (headers in, or an error body read), a stalled request is abandoned and retried.
    const openTimer = setTimeout(() => {
      openTimedOut = true;
      controller.abort();
    }, OPEN_TIMEOUT_MS);
    try {
      const headers = consoleHeaders("text/event-stream");
      if (lastEventId) headers["last-event-id"] = lastEventId;
      let response: Response;
      try {
        response = await fetch(OPERATOR_ROUTES.stream, { headers, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw networkError();
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        clearTimeout(openTimer);
        const error = apiErrorFromResponse(response.status, text, response.headers.get("retry-after"));
        reportAuthError(error);
        if (response.status === 401) {
          stopStream();
          return;
        }
        throw error;
      }
      clearTimeout(openTimer);
      if (!response.body) throw invalidResponseError();
      openedAt = Date.now();
      setStatus({ status: "live", connectedAt: openedAt, error: undefined, retryAt: undefined });
      await readBody(response.body, controller, () => {
        idle = true;
        controller.abort();
      });
    } catch (error) {
      if (token !== loopToken || !shouldRun()) return;
      failure = error instanceof ApiError ? error : undefined;
    } finally {
      clearTimeout(openTimer);
      if (current === controller) current = undefined;
    }
    if (token !== loopToken || !shouldRun()) return;
    attempt = openedAt !== undefined && Date.now() - openedAt >= HEALTHY_AFTER_MS ? 1 : attempt + 1;
    const delay = Math.max(backoffDelay(attempt), (failure?.retryAfterSeconds ?? 0) * 1000);
    const reason = idle
      ? "The live stream stopped sending heartbeats."
      : openTimedOut
        ? "The gateway didn't open the live stream in time."
        : failure
          ? failure.message
          : openedAt !== undefined
            ? "The gateway closed the live stream."
            : "Couldn't open the live stream.";
    setStatus({ status: "reconnecting", retryAt: Date.now() + delay, error: reason });
    await sleep(delay, token);
  }
}

function connect(): void {
  if (!shouldRun() || current) return;
  const token = ++loopToken;
  void loop(token);
}

function disconnect(status: StreamStatus): void {
  loopToken += 1;
  current?.abort();
  current = undefined;
  wake?.();
  setStatus({ status, retryAt: undefined });
}

/** Starts streaming once signed in. */
export function startStream(): void {
  wanted = true;
  backgrounded = typeof document !== "undefined" && document.visibilityState === "hidden";
  connect();
}

/** Stops streaming and forgets everything received (sign-out). */
export function stopStream(): void {
  wanted = false;
  disconnect("off");
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  pendingEvents = [];
  pendingLogs = [];
  lastEventId = undefined;
  dataSnapshot = { events: [], logs: [] };
  for (const listener of dataListeners) listener();
  if (userPaused) {
    userPaused = false;
    setPollingPaused(false);
    setStatus({});
  }
}

/** Retries a waiting reconnect immediately. */
export function reconnectNow(): void {
  if (statusSnapshot.status === "reconnecting") wake?.();
  else connect();
}

/** Pauses or resumes live updates: the stream and every view's auto-refresh. */
export function setLiveUpdatesPaused(paused: boolean): void {
  if (userPaused === paused) return;
  userPaused = paused;
  setPollingPaused(paused);
  if (paused) disconnect("paused");
  else {
    setStatus({});
    refreshActive();
    connect();
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (backgroundTimer === undefined && wanted) {
        backgroundTimer = setTimeout(() => {
          backgroundTimer = undefined;
          if (document.visibilityState !== "hidden" || !wanted) return;
          backgrounded = true;
          if (!userPaused) disconnect("paused");
        }, BACKGROUND_GRACE_MS);
      }
      return;
    }
    if (backgroundTimer !== undefined) clearTimeout(backgroundTimer);
    backgroundTimer = undefined;
    if (backgrounded) {
      backgrounded = false;
      connect();
    }
  });
}

export function useStreamStatus(): StreamStatusSnapshot {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => statusSnapshot,
  );
}

export function useStreamData(): StreamData {
  return useSyncExternalStore(
    (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    () => dataSnapshot,
  );
}
