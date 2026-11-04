import type { AppState, Run } from "../../shared/types.js";

/** A failed API call with the server's plain-words message (never a stack trace). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Can't reach Research Swarm's server. Check that it's running.", 0);
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as { error?: { message?: unknown } } | undefined;
    const message = typeof error?.error?.message === "string" ? error.error.message : response.status === 404 ? "Not found." : `Research Swarm's server answered ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const runUrl = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

export const api = {
  state: () => json<AppState>("GET", "/api/state"),
  run: (id: string) => json<Run>("GET", runUrl(id)),
  start: (question: string) => json<Run>("POST", "/api/runs", { question }),
  stop: (id: string) => json<Run>("POST", `${runUrl(id)}/stop`, {}),
  remove: (id: string) => json<undefined>("DELETE", runUrl(id)),
  reportHref: (id: string) => `${runUrl(id)}/report.md`,
};
