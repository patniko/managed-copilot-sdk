import { ROUTES, type AccountInfo, type ScheduleInfo, type SessionInfo } from "@managed-copilot/protocol";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { HttpClient, launchAttachedCli, resolveToken, resolveUrl, validateDeploymentUrl, type AttachedCliResult } from "@managed-copilot/sdk/internal";
import { UsageError } from "./errors.js";
import { shortId, type Style } from "./output.js";

/** The SDK surface the CLI uses. */
export type ManagedApi = Pick<ManagedCopilot, "url" | "info" | "account" | "sessions" | "schedules" | "artifacts" | "promote">;

/** A connected deployment. Commands connect lazily so `--help` never needs the network. */
export interface Deployment {
  readonly url: string;
  /** REST with the caller's GitHub token, for routes the SDK does not wrap (background sign-in). */
  readonly http: Pick<HttpClient, "get" | "post" | "delete">;
  managed(): Promise<ManagedApi>;
  attach(sessionId: string): Promise<AttachedCliResult>;
}

export interface Writer {
  write(text: string): unknown;
  readonly isTTY?: boolean;
}

export interface Context {
  /** Styling for stdout. */
  readonly style: Style;
  /** Styling for stderr, which may be a terminal when stdout is not (and the other way around). */
  readonly errStyle: Style;
  readonly json: boolean;
  readonly yes: boolean;
  readonly interactive: boolean;
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly args: readonly string[];
  readonly now: () => number;
  out(line?: string): void;
  err(line?: string): void;
  confirm(question: string): Promise<boolean>;
  deployment(): Promise<Deployment>;
}

/** Connects with the same URL and token lookup as `ManagedCopilot.connect()`; the token never comes from argv. */
export async function connectDeployment(options: { readonly url?: string }): Promise<Deployment> {
  const url = validateDeploymentUrl(await resolveUrl(options.url));
  const token = await resolveToken();
  const http = new HttpClient(url, token);
  let managed: Promise<ManagedCopilot> | undefined;
  return {
    url,
    http,
    managed: () => (managed ??= ManagedCopilot.connect({ url, gitHubToken: token, clientName: "managed-copilot-cli" })),
    attach: (sessionId) => launchAttachedCli({ url, httpFor: () => http }, sessionId),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most sessions the gateway lists in one response. */
const SESSION_LIST_MAX = 1000;

/** Resolves a full session ID or any unique prefix of at least four characters (`attach 7f3a2c1`). */
export async function resolveSession(managed: ManagedApi, input: string | undefined): Promise<SessionInfo> {
  if (!input) throw new UsageError("Name a session.", "List your sessions with `npx managed-copilot sessions`.");
  if (UUID.test(input)) return managed.sessions.get(input);
  if (input.length < 4) throw new UsageError(`"${input}" is too short to identify a session; use at least 4 characters of its ID.`);
  const prefix = input.toLowerCase();
  const sessions = await managed.sessions.list({ limit: SESSION_LIST_MAX });
  const matches = sessions.filter((session) => session.id.toLowerCase().startsWith(prefix));
  if (matches.length > 1) {
    throw new UsageError(`"${input}" matches ${matches.length} sessions (${matches.slice(0, 4).map((session) => shortId(session.id)).join(", ")}). Use more characters.`);
  }
  // Only the newest sessions are listed; with that many, an older one could share the prefix.
  if (sessions.length >= SESSION_LIST_MAX) {
    throw new UsageError(`You have more than ${SESSION_LIST_MAX} sessions, so "${input}" can't be checked for uniqueness. Use the full session ID.`, "Copy it from `npx managed-copilot sessions`.");
  }
  if (matches.length === 1) return matches[0]!;
  throw new UsageError(`No session matches "${input}".`, "List your sessions with `npx managed-copilot sessions`.");
}

/** Resolves a schedule by ID, by name, or by a unique ID prefix. */
export async function resolveSchedule(managed: ManagedApi, input: string | undefined): Promise<ScheduleInfo> {
  if (!input) throw new UsageError("Name a schedule.", "List your schedules with `npx managed-copilot schedules`.");
  const schedules = await managed.schedules.list();
  const exact = schedules.find((schedule) => schedule.id === input) ?? schedules.filter((schedule) => schedule.name === input);
  if (!Array.isArray(exact)) return exact;
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new UsageError(`${exact.length} schedules are named "${input}". Use the schedule ID instead.`);
  const matches = input.length >= 4 ? schedules.filter((schedule) => schedule.id.startsWith(input)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new UsageError(`No schedule matches "${input}".`, "List your schedules with `npx managed-copilot schedules`.");
  throw new UsageError(`"${input}" matches ${matches.length} schedules. Use more characters.`);
}

export function background(http: Deployment["http"]) {
  return {
    status: () => http.get<{ account: AccountInfo; active: boolean; createdAt?: string; reason?: string }>(ROUTES.backgroundCredential),
    enable: () => http.post<{ account: AccountInfo; active: boolean; createdAt?: string }>(ROUTES.backgroundCredential, {}),
    disable: () => http.delete<{ account: AccountInfo; active: boolean; reason?: string }>(ROUTES.backgroundCredential),
  };
}
