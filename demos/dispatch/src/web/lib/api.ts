import type { ApprovalMode, AttachResponse, ConversationView, DispatchState, FileView } from "../../shared/types.js";

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

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
}

function isApiErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  return typeof inner === "object" && inner !== null && typeof (inner as { message?: unknown }).message === "string" && typeof (inner as { code?: unknown }).code === "string";
}

function fallbackMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 502 || status === 503 || status === 504) return "Dispatch's server is unavailable right now.";
  if (status >= 500) return `Dispatch's server hit an error (${status}).`;
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

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Can't reach Dispatch's server. Check that it's running.", "network_error", 0);
  }
  if (!response.ok) throw await toApiError(response);
  if (response.status === 202 || response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("Dispatch's server sent an unexpected response.", "invalid_response", response.status);
  }
}

const enc = encodeURIComponent;
const conversationUrl = (id: string) => `/api/conversations/${enc(id)}`;

export interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

export const api = {
  state: () => json<DispatchState>("GET", "/api/state"),
  conversation: (id: string) => json<ConversationView>("GET", conversationUrl(id)),
  create: (prompt: string, approvals: ApprovalMode) => json<ConversationView>("POST", "/api/conversations", { prompt, approvals }),
  send: (id: string, prompt: string) => json<undefined>("POST", `${conversationUrl(id)}/messages`, { prompt }),
  answer: (id: string, approvalId: string, approve: boolean, reason?: string) =>
    json<undefined>("POST", `${conversationUrl(id)}/approvals/${enc(approvalId)}`, { approve, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  settings: (id: string, approvals: ApprovalMode) => json<ConversationView>("PUT", `${conversationUrl(id)}/settings`, { approvals }),
  delete: (id: string) => json<undefined>("DELETE", conversationUrl(id)),
  files: (id: string, workerId: string) => json<{ files: FileView[]; at: string }>("GET", `${conversationUrl(id)}/workers/${enc(workerId)}/files`),
  file: (id: string, workerId: string, path: string) => json<FileContent>("GET", `${conversationUrl(id)}/workers/${enc(workerId)}/file?path=${enc(path)}`),
  attach: (sessionId: string) => json<AttachResponse>("POST", `/api/sessions/${enc(sessionId)}/attach`),
};
