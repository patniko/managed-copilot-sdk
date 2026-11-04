import {
  CONSOLE_REQUEST_HEADER,
  OPERATOR_ROUTES,
  type CustomizationFile,
  type OperatorAccount,
  type OperatorAction,
  type OperatorActionResult,
  type OperatorAuditEntry,
  type OperatorConnections,
  type OperatorEnvironment,
  type OperatorEnvironments,
  type OperatorEvent,
  type OperatorIdentity,
  type OperatorInfrastructure,
  type OperatorLogEntry,
  type OperatorLogLevel,
  type OperatorOverview,
  type OperatorSandbox,
  type OperatorSchedule,
  type OperatorScheduleRuns,
  type OperatorSessionDetail,
  type OperatorSessionQuery,
  type OperatorSessionSummary,
  type OperatorWebhookDeliveryState,
  type OperatorWebhooks,
} from "@managed-copilot/protocol/operator";
import type { PlatformEventType, SandboxState } from "@managed-copilot/protocol";
import { ApiError, apiErrorFromResponse, invalidResponseError, networkError, timeoutError } from "./errors.js";
import { buildSearch, type QueryInput } from "./routes.js";

/** Requests give up after this long so a hung connection never stalls polling. */
const REQUEST_TIMEOUT_MS = 30_000;

type ErrorHandler = (error: ApiError) => void;

const handlers: { unauthorized?: ErrorHandler; forbidden?: ErrorHandler } = {};

/** The auth store listens here: any 401 signs the console out; a 403 re-checks operator access. */
export function setAuthHandlers(next: { readonly unauthorized?: ErrorHandler; readonly forbidden?: ErrorHandler }): void {
  handlers.unauthorized = next.unauthorized;
  handlers.forbidden = next.forbidden;
}

/** Routes an authentication or authorization failure to the auth store (requests made outside `request`). */
export function reportAuthError(error: ApiError): void {
  if (error.status === 401) handlers.unauthorized?.(error);
  else if (error.status === 403 && error.code === "forbidden") handlers.forbidden?.(error);
}

/** Headers every operator request carries (the cookie travels with `credentials: "same-origin"`). */
export function consoleHeaders(accept = "application/json"): Record<string, string> {
  return { accept, [CONSOLE_REQUEST_HEADER]: "1" };
}

export function abortError(): DOMException {
  return new DOMException("The request was cancelled.", "AbortError");
}

interface LinkedSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function linkSignal(signal: AbortSignal | undefined, timeoutMs: number): LinkedSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly query?: QueryInput;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Leave 401/403 to the caller (identity checks and sign-in handle them themselves). */
  readonly silentAuth?: boolean;
  readonly timeoutMs?: number;
}

/** One operator API request. Resolves with the parsed JSON body; rejects with an `ApiError` (or an `AbortError`). */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, signal, silentAuth = false } = options;
  const headers = consoleHeaders();
  if (body !== undefined) headers["content-type"] = "application/json";
  const linked = linkSignal(signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const fail = (): never => {
    if (signal?.aborted) throw abortError();
    if (linked.timedOut()) throw timeoutError();
    throw networkError();
  };
  try {
    let response: Response;
    try {
      response = await fetch(`${path}${buildSearch(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        signal: linked.signal,
      });
    } catch {
      return fail();
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return fail();
    }
    if (!response.ok) {
      const error = apiErrorFromResponse(response.status, text, response.headers.get("retry-after"));
      if (!silentAuth) reportAuthError(error);
      throw error;
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw invalidResponseError();
    }
  } finally {
    linked.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** List routes answer with an array; tolerate a `{ <name>: [...] }` wrapper too. */
export function unwrapList<T>(body: unknown, ...keys: readonly string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (isRecord(body)) {
    for (const key of [...keys, "items", "data"]) {
      const value = body[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  throw invalidResponseError();
}

function requireRecord<T>(body: unknown): T {
  if (!isRecord(body)) throw invalidResponseError();
  return body as T;
}

function looksLikeIdentity(value: unknown): value is OperatorIdentity {
  return isRecord(value) && isRecord(value["account"]) && typeof value["account"]["login"] === "string" && typeof value["grant"] === "string";
}

function actionResult(body: unknown): OperatorActionResult | undefined {
  return isRecord(body) && typeof body["message"] === "string" ? (body as unknown as OperatorActionResult) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Identity and sign-in

export async function getIdentity(signal?: AbortSignal): Promise<OperatorIdentity> {
  const body = await request<unknown>(OPERATOR_ROUTES.me, { signal, silentAuth: true });
  if (!looksLikeIdentity(body)) throw invalidResponseError();
  return body;
}

/** Redeems a one-time ticket for the console session cookie. Returns the identity when the gateway includes it. */
export async function redeemTicket(ticket: string): Promise<OperatorIdentity | undefined> {
  const body = await request<unknown>(OPERATOR_ROUTES.consoleSession, { method: "POST", body: { ticket }, silentAuth: true });
  if (looksLikeIdentity(body)) return body;
  if (isRecord(body) && looksLikeIdentity(body["identity"])) return body["identity"];
  return undefined;
}

export async function endConsoleSession(): Promise<void> {
  await request<unknown>(OPERATOR_ROUTES.consoleSession, { method: "DELETE", silentAuth: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Control plane

export async function getOverview(signal?: AbortSignal): Promise<OperatorOverview> {
  return requireRecord<OperatorOverview>(await request<unknown>(OPERATOR_ROUTES.overview, { signal }));
}

export async function getInfrastructure(signal?: AbortSignal): Promise<OperatorInfrastructure> {
  return requireRecord<OperatorInfrastructure>(await request<unknown>(OPERATOR_ROUTES.infrastructure, { signal }));
}

export async function getEnvironments(signal?: AbortSignal): Promise<OperatorEnvironments> {
  return requireRecord<OperatorEnvironments>(await request<unknown>(OPERATOR_ROUTES.environments, { signal }));
}

export async function getEnvironment(name: string, signal?: AbortSignal): Promise<OperatorEnvironment> {
  return requireRecord<OperatorEnvironment>(await request<unknown>(OPERATOR_ROUTES.environment(name), { signal }));
}

export async function getEnvironmentFile(name: string, path: string, signal?: AbortSignal): Promise<CustomizationFile> {
  return requireRecord<CustomizationFile>(await request<unknown>(OPERATOR_ROUTES.environmentFile(name), { query: { path }, signal }));
}

export interface AuditQuery {
  readonly limit?: number;
}

export async function listAudit(query: AuditQuery, signal?: AbortSignal): Promise<OperatorAuditEntry[]> {
  return unwrapList<OperatorAuditEntry>(await request<unknown>(OPERATOR_ROUTES.audit, { query: { ...query }, signal }), "entries", "audit");
}

// ---------------------------------------------------------------------------------------------------------------
// Data plane

export async function listSessions(query: OperatorSessionQuery, signal?: AbortSignal): Promise<OperatorSessionSummary[]> {
  return unwrapList<OperatorSessionSummary>(await request<unknown>(OPERATOR_ROUTES.sessions, { query: { ...query }, signal }), "sessions");
}

export async function getSession(id: string, signal?: AbortSignal): Promise<OperatorSessionDetail> {
  return requireRecord<OperatorSessionDetail>(await request<unknown>(OPERATOR_ROUTES.session(id), { signal }));
}

export async function getConnections(signal?: AbortSignal): Promise<OperatorConnections> {
  return requireRecord<OperatorConnections>(await request<unknown>(OPERATOR_ROUTES.connections, { signal }));
}

export interface SandboxQuery {
  readonly state?: SandboxState;
  readonly owner?: string;
  readonly limit?: number;
}

export async function listSandboxes(query: SandboxQuery, signal?: AbortSignal): Promise<OperatorSandbox[]> {
  return unwrapList<OperatorSandbox>(await request<unknown>(OPERATOR_ROUTES.sandboxes, { query: { ...query }, signal }), "sandboxes");
}

export async function listSchedules(signal?: AbortSignal): Promise<OperatorSchedule[]> {
  return unwrapList<OperatorSchedule>(await request<unknown>(OPERATOR_ROUTES.schedules, { signal }), "schedules");
}

export async function getScheduleRuns(id: string, signal?: AbortSignal): Promise<OperatorScheduleRuns> {
  return requireRecord<OperatorScheduleRuns>(await request<unknown>(OPERATOR_ROUTES.scheduleRuns(id), { signal }));
}

export interface WebhookQuery {
  readonly state?: OperatorWebhookDeliveryState;
  readonly limit?: number;
}

export async function getWebhooks(query: WebhookQuery, signal?: AbortSignal): Promise<OperatorWebhooks> {
  return requireRecord<OperatorWebhooks>(await request<unknown>(OPERATOR_ROUTES.webhooks, { query: { ...query }, signal }));
}

export interface ActionQuery {
  /** `open` (the default), `attention`, `all`, or one action state. */
  readonly state?: string;
  readonly session?: string;
  readonly limit?: number;
}

export async function listActions(query: ActionQuery, signal?: AbortSignal): Promise<OperatorAction[]> {
  return unwrapList<OperatorAction>(await request<unknown>(OPERATOR_ROUTES.actions, { query: { ...query }, signal }), "actions");
}

export async function listAccounts(signal?: AbortSignal): Promise<OperatorAccount[]> {
  return unwrapList<OperatorAccount>(await request<unknown>(OPERATOR_ROUTES.accounts, { signal }), "accounts");
}

export interface EventQuery {
  readonly limit?: number;
  readonly type?: PlatformEventType;
}

export async function listEvents(query: EventQuery, signal?: AbortSignal): Promise<OperatorEvent[]> {
  return unwrapList<OperatorEvent>(await request<unknown>(OPERATOR_ROUTES.events, { query: { ...query }, signal }), "events");
}

export interface LogQuery {
  readonly level?: OperatorLogLevel;
  readonly limit?: number;
}

export async function listLogs(query: LogQuery, signal?: AbortSignal): Promise<OperatorLogEntry[]> {
  return unwrapList<OperatorLogEntry>(await request<unknown>(OPERATOR_ROUTES.logs, { query: { ...query }, signal }), "logs", "entries");
}

// ---------------------------------------------------------------------------------------------------------------
// Guarded operator actions (each is audited by the gateway)

export async function stopSandbox(sessionId: string): Promise<OperatorActionResult | undefined> {
  return actionResult(await request<unknown>(OPERATOR_ROUTES.sandboxStop(sessionId), { method: "POST", body: {} }));
}

export async function probeSandboxes(): Promise<OperatorActionResult | undefined> {
  return actionResult(await request<unknown>(OPERATOR_ROUTES.sandboxesProbe, { method: "POST", body: {} }));
}

export async function pauseSchedule(id: string, reason?: string): Promise<OperatorActionResult | undefined> {
  const trimmed = reason?.trim();
  return actionResult(await request<unknown>(OPERATOR_ROUTES.schedulePause(id), { method: "POST", body: trimmed ? { reason: trimmed } : {} }));
}

export async function resumeSchedule(id: string): Promise<OperatorActionResult | undefined> {
  return actionResult(await request<unknown>(OPERATOR_ROUTES.scheduleResume(id), { method: "POST", body: {} }));
}

export async function retryWebhookDelivery(deliveryId: string): Promise<OperatorActionResult | undefined> {
  return actionResult(await request<unknown>(OPERATOR_ROUTES.webhookRetry(deliveryId), { method: "POST", body: {} }));
}
