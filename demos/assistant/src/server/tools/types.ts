/** Mail and calendar providers behind the assistant's tools: real Google APIs, or the labeled demo workspace. */

export interface MailSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly snippet: string;
  /** ISO timestamp. */
  readonly date: string;
  readonly unread: boolean;
  readonly important: boolean;
  readonly labels: readonly string[];
}

export interface MailMessage extends MailSummary {
  readonly cc: readonly string[];
  readonly body: string;
}

export interface OutgoingMail {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** Message being replied to; keeps the reply in its thread. */
  readonly replyToId?: string;
}

export interface MailSearch {
  /** Gmail search syntax (`from:`, `is:unread`, `newer_than:2d`, ...) plus free text. */
  readonly query?: string;
  readonly max: number;
}

export interface MailProvider {
  search(search: MailSearch): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
  createDraft(mail: OutgoingMail): Promise<{ id: string }>;
  send(mail: OutgoingMail): Promise<{ id: string; threadId?: string }>;
}

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  /** ISO timestamps; all-day events use local midnight boundaries. */
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /** All-day events only: first day and the day after the last (`YYYY-MM-DD`, end exclusive), as the calendar records them. */
  readonly startDate?: string;
  readonly endDate?: string;
  /** True when the event doesn't block time (shown as free, or the person declined it). */
  readonly free?: boolean;
  readonly location?: string;
  readonly description?: string;
  readonly attendees: readonly string[];
  readonly organizer?: string;
  readonly link?: string;
}

export interface EventInput {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly attendees?: readonly string[];
  readonly location?: string;
  readonly description?: string;
}

export interface EventPatch {
  readonly title?: string;
  readonly start?: Date;
  readonly end?: Date;
  readonly attendees?: readonly string[];
  readonly location?: string;
  readonly description?: string;
}

export interface CalendarProvider {
  list(range: { start: Date; end: Date; query?: string; max?: number }): Promise<CalendarEvent[]>;
  /** One event; `timeZone` places all-day events when the calendar doesn't say. */
  get(id: string, timeZone: string): Promise<CalendarEvent>;
  create(input: EventInput, timeZone: string): Promise<CalendarEvent>;
  update(id: string, patch: EventPatch, timeZone: string): Promise<CalendarEvent>;
  remove(id: string): Promise<void>;
}

/** The person's connected workspace: which provider answers mail and calendar tools right now. */
export interface Workspace {
  readonly kind: "google" | "demo";
  /** Shown to the model and the person, e.g. "Demo workspace (sample data)" or "Google (you@gmail.com)". */
  readonly label: string;
  /** The person's own address, used to explain "to me" and to skip self in attendee lists. */
  readonly address: string;
  readonly mail: MailProvider;
  readonly calendar: CalendarProvider;
}

/** A failure the model should see and explain to the person (never a stack trace). */
export class ToolError extends Error {
  /** True when the action may already have happened, so it must not be retried blindly. */
  readonly uncertain: boolean;

  constructor(message: string, options: { uncertain?: boolean } = {}) {
    super(message);
    this.name = "ToolError";
    this.uncertain = options.uncertain ?? false;
  }
}
