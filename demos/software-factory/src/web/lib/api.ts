import type {
  ActivityItem,
  ArtifactIndex,
  AttachResponse,
  CreateWorkOrderRequest,
  FactoryState,
  WorkOrder,
} from "../../shared/types.js";

/** A failed API call with the server's friendly message (never a stack trace). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof ApiError) return { code: error.code, message: error.message, status: error.status };
  return { code: "unexpected", message: "Something went wrong. Please try again.", status: 0 };
}

export function errorMessage(error: unknown): string {
  return toErrorInfo(error).message;
}

function isApiErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  return (
    typeof inner === "object" &&
    inner !== null &&
    typeof (inner as { message?: unknown }).message === "string" &&
    typeof (inner as { code?: unknown }).code === "string"
  );
}

function fallbackMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 409) return "That action conflicts with the work order's current state.";
  if (status === 502 || status === 503 || status === 504) return "The factory server is unavailable right now.";
  if (status >= 500) return `The factory server hit an error (${status}).`;
  return `Request failed (${status}).`;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isApiErrorBody(body)) return new ApiError(body.error.message, body.error.code, response.status);
  return new ApiError(fallbackMessage(response.status), `http_${response.status}`, response.status);
}

const NETWORK_ERROR_MESSAGE = "Can't reach the factory server. Check that it's running.";

async function send(method: string, url: string, body?: unknown, accept = "application/json"): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? { Accept: accept } : { Accept: accept, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, "network_error", 0);
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await send(method, url, body);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("The factory server sent an unexpected response.", "invalid_response", response.status);
  }
}

const enc = encodeURIComponent;

export function workOrderUrl(id: string): string {
  return `/api/work-orders/${enc(id)}`;
}

export function bundleUrl(workOrderId: string): string {
  return `${workOrderUrl(workOrderId)}/bundle.zip`;
}

export function artifactContentUrl(workOrderId: string, stationId: string, path: string, version?: number): string {
  const params = new URLSearchParams({ stationId, path });
  if (version !== undefined) params.set("version", String(version));
  return `${workOrderUrl(workOrderId)}/artifacts/content?${params.toString()}`;
}

export const api = {
  state: () => json<FactoryState>("GET", "/api/state"),
  workOrder: (id: string) => json<WorkOrder>("GET", workOrderUrl(id)),
  createWorkOrder: (request: CreateWorkOrderRequest) => json<WorkOrder>("POST", "/api/work-orders", request),
  deleteWorkOrder: (id: string) => json<undefined>("DELETE", workOrderUrl(id)),
  cancelWorkOrder: (id: string) => json<WorkOrder>("POST", `${workOrderUrl(id)}/cancel`),
  retryWorkOrder: (id: string) => json<WorkOrder>("POST", `${workOrderUrl(id)}/retry`),
  activity: (id: string, stationId?: string) =>
    json<ActivityItem[]>("GET", `${workOrderUrl(id)}/activity${stationId ? `?stationId=${enc(stationId)}` : ""}`),
  artifacts: (id: string) => json<ArtifactIndex>("GET", `${workOrderUrl(id)}/artifacts`),
  async artifactContent(workOrderId: string, stationId: string, path: string, version?: number): Promise<string> {
    const response = await send("GET", artifactContentUrl(workOrderId, stationId, path, version), undefined, "text/plain, */*");
    return response.text();
  },
  attach: (sessionId: string) => json<AttachResponse>("POST", `/api/sessions/${enc(sessionId)}/attach`),
};
