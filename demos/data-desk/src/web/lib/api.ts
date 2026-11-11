import type { AnalysisView, AttachResponse, DatasetSummary, DeskState, RowsPage, SendToFactoryRequest, SendToFactoryResponse } from "../../shared/types.js";

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
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

function isApiErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  return typeof inner === "object" && inner !== null && typeof (inner as { message?: unknown }).message === "string" && typeof (inner as { code?: unknown }).code === "string";
}

function fallbackMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 502 || status === 503 || status === 504) return "Data Desk's server is unavailable right now.";
  if (status >= 500) return `Data Desk's server hit an error (${status}).`;
  return `Request failed (${status}).`;
}

async function request<T>(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { Accept: "application/json", ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}), cache: "no-store" });
  } catch {
    throw new ApiError("Can't reach Data Desk's server. Check that it's running.", "network_error", 0);
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (isApiErrorBody(body)) throw new ApiError(body.error.message, body.error.code, response.status);
    throw new ApiError(fallbackMessage(response.status), `http_${response.status}`, response.status);
  }
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("Data Desk's server sent an unexpected response.", "invalid_response", response.status);
  }
}

const json = <T>(method: string, url: string, body?: unknown) =>
  request<T>(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

const enc = encodeURIComponent;
const analysisUrl = (id: string) => `/api/analyses/${enc(id)}`;

/** Where the UI loads an analysis's published file from. */
export const outputUrl = (id: string, path: string, version: number, download = false): string =>
  `${analysisUrl(id)}/output?path=${enc(path)}&v=${version}${download ? "&download=1" : ""}`;

export const api = {
  state: () => json<DeskState>("GET", "/api/state"),
  rows: (datasetId: string, offset: number, limit: number) => json<RowsPage>("GET", `/api/datasets/${enc(datasetId)}/rows?offset=${offset}&limit=${limit}`),
  upload: (file: File) => request<DatasetSummary>("POST", "/api/datasets", { body: file, headers: { "Content-Type": "text/csv", "X-File-Name": enc(file.name) } }),
  create: (datasetId: string) => json<AnalysisView>("POST", "/api/analyses", { datasetId }),
  analysis: (id: string) => json<AnalysisView>("GET", analysisUrl(id)),
  send: (id: string, prompt: string) => json<undefined>("POST", `${analysisUrl(id)}/messages`, { prompt }),
  move: (id: string, approve: boolean) => json<AnalysisView>("POST", `${analysisUrl(id)}/move`, { approve }),
  stop: (id: string) => json<undefined>("POST", `${analysisUrl(id)}/stop`),
  delete: (id: string) => json<undefined>("DELETE", analysisUrl(id)),
  attach: (id: string) => json<AttachResponse>("POST", `${analysisUrl(id)}/attach`),
  factory: (id: string, request: SendToFactoryRequest) => json<SendToFactoryResponse>("POST", `${analysisUrl(id)}/factory`, request),
};
