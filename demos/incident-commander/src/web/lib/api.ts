import type { ApiErrorBody, AppSettings, AppState, CreatedIncident, DecisionRequest, IncidentView, NoteRequest, SettingsRequest } from "../../shared/types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  } catch {
    throw new ApiError(0, "unreachable", "Incident Commander isn't reachable. Is it still running?");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(response.status, body?.error.code ?? "error", body?.error.message ?? `The request failed (HTTP ${response.status}).`);
  }
  if (response.status === 204 || response.status === 202) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  state: () => request<AppState>("/api/state"),
  incident: (id: string) => request<IncidentView>(`/api/incidents/${encodeURIComponent(id)}`),
  simulate: () => post<CreatedIncident>("/api/simulate"),
  settings: (settings: SettingsRequest) => request<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  decide: (id: string, decision: DecisionRequest) => post<void>(`/api/incidents/${encodeURIComponent(id)}/decision`, decision),
  note: (id: string, note: NoteRequest) => post<void>(`/api/incidents/${encodeURIComponent(id)}/notes`, note),
  remove: (id: string) => request<void>(`/api/incidents/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
