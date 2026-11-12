import type { BugArea, ClassificationMethod, ClassificationRun, HelpDeskState, RunInfo, SoftwareIssue } from "../../shared/types.js";

/** A failed API call with the server's friendly message (never a stack trace). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
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
    throw new ApiError("Can't reach the Help Desk server. Check that it's running.", "network_error", 0);
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined;
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : response.status >= 500 ? "The Help Desk server is unavailable right now." : `Request failed (${response.status}).`;
    throw new ApiError(message, typeof parsed?.error?.code === "string" ? parsed.error.code : `http_${response.status}`, response.status);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => json<HelpDeskState>("GET", "/api/state"),
  simulate: (size: number) => json<RunInfo>("POST", "/api/simulation", { size }),
  end: () => json<undefined>("DELETE", "/api/simulation"),
  classify: (size: number, method: ClassificationMethod) => json<ClassificationRun>("POST", "/api/classification", { size, method }),
  send: (customerId: string, text: string) => json<undefined>("POST", `/api/tickets/${enc(customerId)}/messages`, { text }),
  answer: (customerId: string, approvalId: string, approve: boolean) => json<undefined>("POST", `/api/tickets/${enc(customerId)}/approvals/${enc(approvalId)}`, { approve }),
  routeIssue: (area: BugArea) => json<SoftwareIssue>("POST", `/api/issues/${enc(area)}/route`),
  forget: (id: string) => json<undefined>("DELETE", `/api/knowledge/${enc(id)}`),
  decide: (id: string, approve: boolean) => json<undefined>("POST", `/api/knowledge/proposals/${enc(id)}`, { approve }),
};
