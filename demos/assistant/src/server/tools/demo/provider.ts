/**
 * The demo workspace: a stateful, seeded inbox and calendar stored in the assistant's SQLite database. It lets the
 * demo run end to end without Google credentials and is labeled as sample data everywhere it appears.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../../store.js";
import type { CalendarEvent, CalendarProvider, EventInput, EventPatch, MailMessage, MailProvider, MailSearch, MailSummary, OutgoingMail, Workspace } from "../types.js";
import { ToolError } from "../types.js";
import { seedWorkspace, type SeedOwner } from "./seed.js";

type Row = Record<string, unknown>;

const STALE_AFTER_MS = 7 * 24 * 3600_000;

export const DEMO_LABEL = "Demo workspace (sample inbox and calendar)";

function parseList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
}

function toSummary(row: Row): MailSummary {
  const fromName = typeof row.from_name === "string" && row.from_name ? row.from_name : undefined;
  const fromEmail = String(row.from_email);
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    fromEmail,
    to: parseList(row.to_json),
    subject: String(row.subject),
    snippet: snippet(String(row.body)),
    date: String(row.date),
    unread: Number(row.unread) === 1,
    important: Number(row.important) === 1,
    labels: [String(row.folder).toUpperCase(), ...parseList(row.labels_json)],
  };
}

function toEvent(row: Row): CalendarEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    start: String(row.start),
    end: String(row.end),
    allDay: Number(row.all_day) === 1,
    location: typeof row.location === "string" && row.location ? row.location : undefined,
    description: typeof row.description === "string" && row.description ? row.description : undefined,
    attendees: parseList(row.attendees_json),
    organizer: typeof row.organizer === "string" && row.organizer ? row.organizer : undefined,
  };
}

interface ParsedQuery {
  folders: Set<string> | undefined;
  unread?: boolean;
  important?: boolean;
  from: string[];
  to: string[];
  subject: string[];
  labels: string[];
  newerThan?: number;
  olderThan?: number;
  words: string[];
}

function durationMs(value: string): number | undefined {
  const match = /^(\d+)([dhmy])$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const day = 24 * 3600_000;
  return amount * (unit === "h" ? 3600_000 : unit === "d" ? day : unit === "m" ? 30 * day : 365 * day);
}

/** A useful subset of Gmail search syntax, so the same prompts work against the demo and real Gmail. */
export function parseMailQuery(query: string | undefined): ParsedQuery {
  const parsed: ParsedQuery = { folders: undefined, from: [], to: [], subject: [], labels: [], words: [] };
  const tokens = (query ?? "").match(/(\w+:)?("[^"]*"|\S+)/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/"/g, "").trim();
    if (!token) continue;
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? token.slice(colon + 1).toLowerCase() : token.toLowerCase();
    switch (key) {
      case "is":
        if (value === "unread") parsed.unread = true;
        else if (value === "read") parsed.unread = false;
        else if (value === "important" || value === "starred") parsed.important = true;
        break;
      case "in":
        if (value === "anywhere") parsed.folders = new Set(["inbox", "sent", "drafts"]);
        else if (value === "draft" || value === "drafts") parsed.folders = new Set(["drafts"]);
        else if (value === "inbox" || value === "sent") parsed.folders = new Set([value]);
        break;
      case "from":
        parsed.from.push(value);
        break;
      case "to":
        parsed.to.push(value);
        break;
      case "subject":
        parsed.subject.push(value);
        break;
      case "label":
      case "category":
        parsed.labels.push(value);
        break;
      case "newer_than":
        parsed.newerThan = durationMs(value);
        break;
      case "older_than":
        parsed.olderThan = durationMs(value);
        break;
      case "has":
      case "after":
      case "before":
        break;
      default:
        if (token.toUpperCase() !== "AND") parsed.words.push(token.toLowerCase());
    }
  }
  return parsed;
}

function matches(row: Row, query: ParsedQuery, now: number): boolean {
  const folder = String(row.folder);
  const folders = query.folders ?? new Set(["inbox", "sent"]);
  if (!folders.has(folder)) return false;
  if (query.unread !== undefined && (Number(row.unread) === 1) !== query.unread) return false;
  if (query.important && Number(row.important) !== 1) return false;
  const from = `${row.from_name ?? ""} ${row.from_email}`.toLowerCase();
  if (query.from.some((value) => !from.includes(value))) return false;
  const to = String(row.to_json).toLowerCase();
  if (query.to.some((value) => !to.includes(value))) return false;
  const subject = String(row.subject).toLowerCase();
  if (query.subject.some((value) => !subject.includes(value))) return false;
  const labels = String(row.labels_json).toLowerCase();
  if (query.labels.some((value) => !labels.includes(value))) return false;
  const date = Date.parse(String(row.date));
  if (query.newerThan !== undefined && date < now - query.newerThan) return false;
  if (query.olderThan !== undefined && date > now - query.olderThan) return false;
  const haystack = `${from} ${subject} ${String(row.body).toLowerCase()} ${labels}`;
  return query.words.every((word) => haystack.includes(word));
}

export interface DemoOwner extends SeedOwner {
  readonly accountId: number;
}

export class DemoWorkspace implements Workspace {
  readonly kind = "demo" as const;
  readonly label = DEMO_LABEL;
  readonly address: string;
  readonly mail: MailProvider;
  readonly calendar: CalendarProvider;
  readonly #store: Store;
  readonly #owner: DemoOwner;
  readonly #timeZone: () => string;
  readonly #clock: () => Date;

  constructor(store: Store, owner: DemoOwner, timeZone: () => string, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#owner = owner;
    this.#timeZone = timeZone;
    this.#clock = clock;
    this.address = owner.address;
    this.mail = {
      search: (search) => this.#search(search),
      read: (id) => this.#read(id),
      createDraft: (mail) => this.#insertOutgoing(mail, "drafts"),
      send: (mail) => this.#insertOutgoing(mail, "sent"),
    };
    this.calendar = {
      list: (range) => this.#list(range),
      get: (id) => this.#get(id),
      create: (input) => this.#create(input),
      update: (id, patch) => this.#update(id, patch),
      remove: (id) => this.#remove(id),
    };
  }

  /**
   * When the sample data was generated, seeding it first if needed. It is refreshed once it is a week old, and when the
   * person's time zone changes (sample meetings sit in local working hours).
   */
  ensureSeeded(now: Date = this.#clock()): string {
    const row = this.#store.db.prepare("SELECT seeded_at, time_zone FROM demo_meta WHERE account_id = ?").get(this.#owner.accountId) as Row | undefined;
    const seededAt = typeof row?.seeded_at === "string" ? row.seeded_at : undefined;
    if (seededAt && now.getTime() - Date.parse(seededAt) < STALE_AFTER_MS && row?.time_zone === this.#timeZone()) return seededAt;
    return this.reset(now);
  }

  /** Replaces the sample inbox and calendar with fresh data relative to `now`. */
  reset(now: Date = this.#clock()): string {
    const timeZone = this.#timeZone();
    const { mail, events } = seedWorkspace(now, timeZone, this.#owner);
    const account = this.#owner.accountId;
    const seededAt = now.toISOString();
    this.#store.transaction(() => {
      const db = this.#store.db;
      db.prepare("DELETE FROM demo_mail WHERE account_id = ?").run(account);
      db.prepare("DELETE FROM demo_events WHERE account_id = ?").run(account);
      const insertMail = db.prepare(
        `INSERT INTO demo_mail (id, account_id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body, date, unread, important, labels_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of mail) {
        insertMail.run(
          `${account}:${m.id}`,
          account,
          m.threadId,
          m.folder,
          m.fromName,
          m.fromEmail,
          JSON.stringify(m.to),
          JSON.stringify(m.cc),
          m.subject,
          m.body,
          m.date.toISOString(),
          m.unread ? 1 : 0,
          m.important ? 1 : 0,
          JSON.stringify(m.labels),
        );
      }
      const insertEvent = db.prepare(
        `INSERT INTO demo_events (id, account_id, title, start, end, all_day, location, description, attendees_json, organizer, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of events) {
        insertEvent.run(
          `${account}:${e.id}`,
          account,
          e.title,
          e.start.toISOString(),
          e.end.toISOString(),
          e.allDay ? 1 : 0,
          e.location ?? null,
          e.description ?? null,
          JSON.stringify(e.attendees),
          e.organizer ?? null,
          seededAt,
        );
      }
      db.prepare(
        "INSERT INTO demo_meta (account_id, seeded_at, time_zone) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET seeded_at = excluded.seeded_at, time_zone = excluded.time_zone",
      ).run(account, seededAt, timeZone);
    });
    return seededAt;
  }

  // Row IDs are prefixed with the account so two people's demo data never collide; tools see the short form.
  #rowId(id: string): string {
    return `${this.#owner.accountId}:${id}`;
  }

  #publicId(rowId: unknown): string {
    const text = String(rowId);
    const prefix = `${this.#owner.accountId}:`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  async #search(search: MailSearch): Promise<MailSummary[]> {
    this.ensureSeeded();
    const query = parseMailQuery(search.query);
    const rows = this.#store.db.prepare("SELECT * FROM demo_mail WHERE account_id = ? ORDER BY date DESC").all(this.#owner.accountId) as Row[];
    const now = Date.now();
    return rows
      .filter((row) => matches(row, query, now))
      .slice(0, search.max)
      .map((row) => ({ ...toSummary(row), id: this.#publicId(row.id) }));
  }

  async #read(id: string): Promise<MailMessage> {
    this.ensureSeeded();
    const row = this.#store.db.prepare("SELECT * FROM demo_mail WHERE id = ? AND account_id = ?").get(this.#rowId(id), this.#owner.accountId) as Row | undefined;
    if (!row) throw new ToolError(`No message with id "${id}". Search the inbox first to get message ids.`);
    return { ...toSummary(row), id, cc: parseList(row.cc_json), body: String(row.body) };
  }

  async #insertOutgoing(mail: OutgoingMail, folder: "sent" | "drafts"): Promise<{ id: string; threadId: string }> {
    this.ensureSeeded();
    let threadId = `thr_${randomUUID().slice(0, 8)}`;
    if (mail.replyToId) {
      const original = this.#store.db.prepare("SELECT thread_id FROM demo_mail WHERE id = ? AND account_id = ?").get(this.#rowId(mail.replyToId), this.#owner.accountId) as Row | undefined;
      if (!original) throw new ToolError(`No message with id "${mail.replyToId}" to reply to.`);
      threadId = String(original.thread_id);
    }
    const id = `msg_${randomUUID().slice(0, 8)}`;
    this.#store.db
      .prepare(
        `INSERT INTO demo_mail (id, account_id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body, date, unread, important, labels_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]')`,
      )
      .run(
        this.#rowId(id),
        this.#owner.accountId,
        threadId,
        folder,
        this.#owner.name,
        this.#owner.address,
        JSON.stringify(mail.to),
        JSON.stringify(mail.cc ?? []),
        mail.subject,
        mail.body,
        new Date().toISOString(),
      );
    return { id, threadId };
  }

  async #list(range: { start: Date; end: Date; query?: string; max?: number }): Promise<CalendarEvent[]> {
    this.ensureSeeded();
    const rows = this.#store.db
      .prepare("SELECT * FROM demo_events WHERE account_id = ? AND start < ? AND end > ? ORDER BY start")
      .all(this.#owner.accountId, range.end.toISOString(), range.start.toISOString()) as Row[];
    const query = range.query?.toLowerCase().trim();
    return rows
      .map((row) => ({ ...toEvent(row), id: this.#publicId(row.id) }))
      .filter((event) => !query || `${event.title} ${event.description ?? ""} ${event.location ?? ""} ${event.attendees.join(" ")}`.toLowerCase().includes(query))
      .slice(0, range.max ?? 100);
  }

  async #get(id: string): Promise<CalendarEvent> {
    this.ensureSeeded();
    const row = this.#store.db.prepare("SELECT * FROM demo_events WHERE id = ? AND account_id = ?").get(this.#rowId(id), this.#owner.accountId) as Row | undefined;
    if (!row) throw new ToolError(`No calendar event with id "${id}". List events first to get event ids.`);
    return { ...toEvent(row), id };
  }

  async #create(input: EventInput): Promise<CalendarEvent> {
    this.ensureSeeded();
    const id = `evt_${randomUUID().slice(0, 8)}`;
    this.#store.db
      .prepare(
        `INSERT INTO demo_events (id, account_id, title, start, end, all_day, location, description, attendees_json, organizer, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#rowId(id),
        this.#owner.accountId,
        input.title,
        input.start.toISOString(),
        input.end.toISOString(),
        input.location ?? null,
        input.description ?? null,
        JSON.stringify(input.attendees ?? []),
        this.#owner.address,
        new Date().toISOString(),
      );
    return this.#get(id);
  }

  async #update(id: string, patch: EventPatch): Promise<CalendarEvent> {
    const current = await this.#get(id);
    const next = {
      title: patch.title ?? current.title,
      start: patch.start?.toISOString() ?? current.start,
      end: patch.end?.toISOString() ?? current.end,
      location: patch.location ?? current.location ?? null,
      description: patch.description ?? current.description ?? null,
      attendees: patch.attendees ?? current.attendees,
    };
    if (Date.parse(next.end) <= Date.parse(next.start)) throw new ToolError("The event must end after it starts.");
    this.#store.db
      .prepare("UPDATE demo_events SET title = ?, start = ?, end = ?, location = ?, description = ?, attendees_json = ?, updated_at = ? WHERE id = ? AND account_id = ?")
      .run(next.title, next.start, next.end, next.location, next.description, JSON.stringify(next.attendees), new Date().toISOString(), this.#rowId(id), this.#owner.accountId);
    return this.#get(id);
  }

  async #remove(id: string): Promise<void> {
    await this.#get(id);
    this.#store.db.prepare("DELETE FROM demo_events WHERE id = ? AND account_id = ?").run(this.#rowId(id), this.#owner.accountId);
  }
}
