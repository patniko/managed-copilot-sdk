import type { ApiError } from "../../shared/protocol";

export class ApiRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError("network", "Can't reach the assistant server. Is it still running?");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error = (payload as ApiError | undefined)?.error;
    throw new ApiRequestError(error?.code ?? "http_error", error?.message ?? `The assistant server returned HTTP ${response.status}.`);
  }
  return payload as T;
}

export const api = {
  send: (text: string) => request<{ messageId: string }>("POST", "/api/messages", { text }),
  abort: () => request("POST", "/api/abort", {}),
  decide: (id: string, decision: "approve" | "deny", feedback?: string) =>
    request("POST", `/api/approvals/${encodeURIComponent(id)}`, { decision, feedback }),
  markRead: (at: string) => request("POST", "/api/read", { at }),
  setTimeZone: (timeZone: string) => request("POST", "/api/settings", { timeZone }),
  retry: () => request("POST", "/api/retry", {}),
  addBriefing: () => request("POST", "/api/schedules/briefing", {}),
  pauseSchedule: (id: string) => request("POST", `/api/schedules/${encodeURIComponent(id)}/pause`, {}),
  resumeSchedule: (id: string) => request("POST", `/api/schedules/${encodeURIComponent(id)}/resume`, {}),
  runSchedule: (id: string) => request("POST", `/api/schedules/${encodeURIComponent(id)}/run`, {}),
  deleteSchedule: (id: string) => request("DELETE", `/api/schedules/${encodeURIComponent(id)}`),
  connectGoogle: () => request<{ url: string }>("POST", "/api/google/connect", {}),
  disconnectGoogle: () => request("POST", "/api/google/disconnect", {}),
  resetDemo: () => request("POST", "/api/demo/reset", {}),
  startOver: () => request("POST", "/api/conversation/reset", {}),
};
