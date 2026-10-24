/** Real Gmail and Google Calendar providers over their REST APIs. */
import type { Logger } from "../../log.js";
import { isoInZone, parseDateTime } from "../../time.js";
import type { CalendarEvent, CalendarProvider, EventInput, EventPatch, MailMessage, MailProvider, MailSearch, MailSummary, OutgoingMail, Workspace } from "../types.js";
import { ToolError } from "../types.js";
import { buildMime, htmlToText, toBase64Url } from "./mime.js";
import { GOOGLE_SCOPES, GoogleAuth, GoogleAuthError } from "./oauth.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";
const MAX_BODY_CHARS = 12_000;

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  organizer?: { email?: string };
}

type Fetch = typeof fetch;

/** Authorized JSON requests with one forced token refresh on 401 and friendly errors for the model. */
class GoogleApi {
  readonly #auth: GoogleAuth;
  readonly #accountId: number;
  readonly #fetch: Fetch;
  readonly #service: string;

  constructor(auth: GoogleAuth, accountId: number, service: string, fetchImpl: Fetch) {
    this.#auth = auth;
    this.#accountId = accountId;
    this.#service = service;
    this.#fetch = fetchImpl;
  }

  async request<T>(method: string, url: string, body?: unknown, options: { sideEffect?: boolean } = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await this.#auth.accessToken(this.#accountId, { forceRefresh: attempt > 0 });
      } catch (error) {
        if (error instanceof GoogleAuthError) throw new ToolError(error.message);
        throw error;
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        // A network failure after sending a side effect leaves its outcome unknown.
        throw new ToolError(`Couldn't reach ${this.#service}.`, { uncertain: options.sideEffect === true });
      }
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 204) return undefined as T;
      if (response.ok) return (await response.json()) as T;
      let reason = "";
      try {
        const payload = (await response.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
        reason = payload.error?.errors?.[0]?.reason ?? payload.error?.message ?? "";
      } catch {
        // Fall through with the status code only.
      }
      if (response.status === 401) throw new ToolError(`${this.#service} rejected the Google credentials. Reconnect Google from the Connections panel.`);
      if (response.status === 403) {
        if (/insufficient|scope|permission/i.test(reason)) {
          throw new ToolError(`Google didn't grant permission for this ${this.#service} action. Reconnect Google and allow the requested access.`);
        }
        throw new ToolError(`${this.#service} refused the request (${reason || "forbidden"}).`);
      }
      if (response.status === 404) throw new ToolError(`${this.#service} couldn't find that item. List or search again to get a current id.`);
      if (response.status === 429) throw new ToolError(`${this.#service} is rate limiting requests. Try again in a minute.`);
      if (response.status >= 500) throw new ToolError(`${this.#service} is temporarily unavailable (HTTP ${response.status}).`, { uncertain: options.sideEffect === true });
      throw new ToolError(`${this.#service} rejected the request (${reason || `HTTP ${response.status}`}).`);
    }
    throw new ToolError(`${this.#service} rejected the Google credentials. Reconnect Google from the Connections panel.`);
  }
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function splitAddresses(value: string): string[] {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function emailOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1]! : value).trim();
}

function decodeBody(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

export function extractBody(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBody(plain.body?.data);
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(decodeBody(html.body?.data));
  return decodeBody(payload?.body?.data);
}

function toSummary(message: GmailMessage): MailSummary {
  const from = header(message.payload, "From");
  const labels = message.labelIds ?? [];
  const dateHeader = header(message.payload, "Date");
  const date = message.internalDate ? new Date(Number(message.internalDate)) : new Date(dateHeader || Date.now());
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    fromEmail: emailOf(from),
    to: splitAddresses(header(message.payload, "To")),
    subject: header(message.payload, "Subject") || "(no subject)",
    snippet: message.snippet ?? "",
    date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    unread: labels.includes("UNREAD"),
    important: labels.includes("IMPORTANT") || labels.includes("STARRED"),
    labels,
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

class GmailProvider implements MailProvider {
  readonly #api: GoogleApi;

  constructor(api: GoogleApi) {
    this.#api = api;
  }

  async search(search: MailSearch): Promise<MailSummary[]> {
    const params = new URLSearchParams({ maxResults: String(search.max) });
    if (search.query?.trim()) params.set("q", search.query.trim());
    const list = await this.#api.request<{ messages?: { id: string }[] }>("GET", `${GMAIL}/messages?${params}`);
    const ids = (list.messages ?? []).map((m) => m.id);
    const metadata = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Subject", "Date"]) metadata.append("metadataHeaders", name);
    const messages = await mapLimit(ids, 5, (id) => this.#api.request<GmailMessage>("GET", `${GMAIL}/messages/${encodeURIComponent(id)}?${metadata}`));
    return messages.map(toSummary);
  }

  async read(id: string): Promise<MailMessage> {
    const message = await this.#api.request<GmailMessage>("GET", `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    const body = extractBody(message.payload);
    return {
      ...toSummary(message),
      cc: splitAddresses(header(message.payload, "Cc")),
      body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[message truncated]` : body,
    };
  }

  async #compose(mail: OutgoingMail): Promise<{ raw: string; threadId?: string }> {
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let threadId: string | undefined;
    if (mail.replyToId) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["Message-ID", "References"]) params.append("metadataHeaders", name);
      const original = await this.#api.request<GmailMessage>("GET", `${GMAIL}/messages/${encodeURIComponent(mail.replyToId)}?${params}`);
      threadId = original.threadId;
      inReplyTo = header(original.payload, "Message-ID") || undefined;
      const priorReferences = header(original.payload, "References");
      references = [priorReferences, inReplyTo].filter(Boolean).join(" ") || undefined;
    }
    const raw = toBase64Url(buildMime({ to: mail.to, cc: mail.cc, subject: mail.subject, body: mail.body, inReplyTo, references }));
    return { raw, threadId };
  }

  async createDraft(mail: OutgoingMail): Promise<{ id: string }> {
    const { raw, threadId } = await this.#compose(mail);
    const draft = await this.#api.request<{ id: string }>("POST", `${GMAIL}/drafts`, { message: { raw, ...(threadId ? { threadId } : {}) } }, { sideEffect: true });
    return { id: draft.id };
  }

  async send(mail: OutgoingMail): Promise<{ id: string; threadId?: string }> {
    const { raw, threadId } = await this.#compose(mail);
    const sent = await this.#api.request<{ id: string; threadId?: string }>("POST", `${GMAIL}/messages/send`, { raw, ...(threadId ? { threadId } : {}) }, { sideEffect: true });
    return { id: sent.id, threadId: sent.threadId };
  }
}

function toCalendarEvent(event: GoogleEvent, calendarTimeZone: string | undefined): CalendarEvent {
  const allDay = !event.start?.dateTime && Boolean(event.start?.date);
  const instant = (value: { dateTime?: string; date?: string } | undefined): string => {
    if (value?.dateTime) return new Date(value.dateTime).toISOString();
    if (value?.date) return parseDateTime(value.date, calendarTimeZone ?? "UTC").toISOString();
    return new Date().toISOString();
  };
  return {
    id: event.id,
    title: event.summary || "(no title)",
    start: instant(event.start),
    end: instant(event.end),
    allDay,
    location: event.location || undefined,
    description: event.description ? event.description.slice(0, 2000) : undefined,
    attendees: (event.attendees ?? []).filter((a) => !a.self && a.email).map((a) => a.email!),
    organizer: event.organizer?.email,
    link: event.htmlLink,
  };
}

class GoogleCalendarProvider implements CalendarProvider {
  readonly #api: GoogleApi;

  constructor(api: GoogleApi) {
    this.#api = api;
  }

  async list(range: { start: Date; end: Date; query?: string; max?: number }): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: range.start.toISOString(),
      timeMax: range.end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(range.max ?? 100),
    });
    if (range.query?.trim()) params.set("q", range.query.trim());
    const result = await this.#api.request<{ items?: GoogleEvent[]; timeZone?: string }>("GET", `${CALENDAR}/events?${params}`);
    return (result.items ?? []).filter((e) => e.status !== "cancelled").map((e) => toCalendarEvent(e, result.timeZone));
  }

  async get(id: string): Promise<CalendarEvent> {
    return toCalendarEvent(await this.#api.request<GoogleEvent>("GET", `${CALENDAR}/events/${encodeURIComponent(id)}`), undefined);
  }

  async create(input: EventInput, timeZone: string): Promise<CalendarEvent> {
    const body = {
      summary: input.title,
      location: input.location,
      description: input.description,
      start: { dateTime: isoInZone(input.start, timeZone), timeZone },
      end: { dateTime: isoInZone(input.end, timeZone), timeZone },
      attendees: (input.attendees ?? []).map((email) => ({ email })),
    };
    return toCalendarEvent(await this.#api.request<GoogleEvent>("POST", `${CALENDAR}/events?sendUpdates=all`, body, { sideEffect: true }), timeZone);
  }

  async update(id: string, patch: EventPatch, timeZone: string): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.start) body.start = { dateTime: isoInZone(patch.start, timeZone), timeZone };
    if (patch.end) body.end = { dateTime: isoInZone(patch.end, timeZone), timeZone };
    if (patch.attendees) body.attendees = patch.attendees.map((email) => ({ email }));
    const updated = await this.#api.request<GoogleEvent>("PATCH", `${CALENDAR}/events/${encodeURIComponent(id)}?sendUpdates=all`, body, { sideEffect: true });
    return toCalendarEvent(updated, timeZone);
  }

  async remove(id: string): Promise<void> {
    await this.#api.request<void>("DELETE", `${CALENDAR}/events/${encodeURIComponent(id)}?sendUpdates=all`, undefined, { sideEffect: true });
  }
}

export class GoogleWorkspace implements Workspace {
  readonly kind = "google" as const;
  readonly label: string;
  readonly address: string;
  readonly mail: MailProvider;
  readonly calendar: CalendarProvider;

  constructor(auth: GoogleAuth, accountId: number, email: string | undefined, _log: Logger, fetchImpl: Fetch = fetch) {
    this.address = email ?? "me";
    this.label = `Google${email ? ` (${email})` : ""}`;
    const gmail = new GmailProvider(new GoogleApi(auth, accountId, "Gmail", fetchImpl));
    const calendar = new GoogleCalendarProvider(new GoogleApi(auth, accountId, "Google Calendar", fetchImpl));
    const requireScope = (scope: string, what: string) => {
      if (!auth.hasScope(accountId, scope)) throw new ToolError(`Google access to ${what} wasn't granted. Reconnect Google and allow it.`);
    };
    this.mail = {
      search: (search) => (requireScope(GOOGLE_SCOPES.gmailRead, "read mail"), gmail.search(search)),
      read: (id) => (requireScope(GOOGLE_SCOPES.gmailRead, "read mail"), gmail.read(id)),
      createDraft: (mail) => (requireScope(GOOGLE_SCOPES.gmailCompose, "draft and send mail"), gmail.createDraft(mail)),
      send: (mail) => (requireScope(GOOGLE_SCOPES.gmailCompose, "draft and send mail"), gmail.send(mail)),
    };
    this.calendar = {
      list: (range) => (requireScope(GOOGLE_SCOPES.calendarEvents, "your calendar"), calendar.list(range)),
      get: (id) => (requireScope(GOOGLE_SCOPES.calendarEvents, "your calendar"), calendar.get(id)),
      create: (input, tz) => (requireScope(GOOGLE_SCOPES.calendarEvents, "your calendar"), calendar.create(input, tz)),
      update: (id, patch, tz) => (requireScope(GOOGLE_SCOPES.calendarEvents, "your calendar"), calendar.update(id, patch, tz)),
      remove: (id) => (requireScope(GOOGLE_SCOPES.calendarEvents, "your calendar"), calendar.remove(id)),
    };
  }
}
