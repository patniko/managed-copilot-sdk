/** Human-facing titles for tool activity and approval prompts, shared by live events and rebuilt history. */
import type { ApprovalPreview, ToolIcon, ToolStatus } from "../shared/protocol.js";
import { describeCron } from "./cron.js";
import { formatWhen, parseDateTime } from "./time.js";

type Args = Record<string, unknown>;

function asArgs(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** "Sam Rivera" from "Sam Rivera <sam@x>", or the address. */
export function displayName(address: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(address);
  return named ? named[1]!.trim() : address.trim();
}

export function people(addresses: readonly string[]): string {
  const names = addresses.map(displayName);
  if (names.length === 0) return "nobody";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

function quote(value: string, max = 60): string {
  const trimmed = value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return `“${trimmed}”`;
}

/** Parses a tool's text result as JSON when possible. */
export function parseResult(content: string | undefined): Args | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : undefined;
  } catch {
    return undefined;
  }
}

function when(value: unknown, timeZone: string): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    return formatWhen(parseDateTime(raw, timeZone), timeZone);
  } catch {
    return raw;
  }
}

/** Finds a schedule ID in a scheduling tool's result (JSON or text such as "Scheduled sch_123 for ..."). */
export function scheduleIdFrom(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const parsed = parseResult(content);
  const fromJson = text(parsed?.scheduleId) ?? text(parsed?.id) ?? text(asArgs(parsed?.schedule).id);
  if (fromJson) return fromJson;
  const match = /\b((?:sch|schedule)[_-][A-Za-z0-9_-]{4,})\b/.exec(content) ?? /\bid[:= ]+["']?([A-Za-z0-9_-]{6,})/i.exec(content);
  return match?.[1];
}

/** "stretch-water-reminder" → "Stretch water reminder"; names with spaces are kept as written. */
export function humanizeName(name: string): string {
  if (/\s/.test(name) || !/[-_]/.test(name)) return name;
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function scheduleSummary(args: Args, timeZone: string, at: Date): string {
  const name = (text(args.name) && humanizeName(text(args.name)!)) ?? text(args.prompt) ?? "a task";
  const cron = text(args.cron);
  if (cron) return `${quote(name)} · ${describeCron(cron)}`;
  const runAt = text(args.runAt);
  if (runAt) return `${quote(name)} · ${when(runAt, timeZone)}`;
  const delay = typeof args.delaySeconds === "number" ? args.delaySeconds : undefined;
  if (delay !== undefined) return `${quote(name)} · ${formatWhen(new Date(at.getTime() + delay * 1000), timeZone)}`;
  return quote(name);
}

export interface ToolDescription {
  readonly title: string;
  readonly icon: ToolIcon;
  readonly detail?: string;
}

/** Runtime-internal or noisy tools that the chat does not show. */
export const HIDDEN_TOOLS = new Set(["get_current_time", "report_intent", "task_complete", "think", "update_todo"]);

export function describeTool(name: string, rawArgs: unknown, status: ToolStatus, resultContent: string | undefined, timeZone: string, at: Date): ToolDescription {
  const args = asArgs(rawArgs);
  const result = status === "succeeded" ? parseResult(resultContent) : undefined;
  const done = status !== "running";
  const failed = status === "failed";
  const count = typeof result?.count === "number" ? result.count : undefined;
  switch (name) {
    case "search_email": {
      const query = text(args.query);
      const subject = query ? ` for ${quote(query, 40)}` : "";
      return {
        icon: "mail",
        title: done ? (failed ? `Couldn't search your inbox${subject}` : `Searched your inbox${subject}`) : `Searching your inbox${subject}…`,
        detail: count !== undefined ? `${count} message${count === 1 ? "" : "s"}` : undefined,
      };
    }
    case "read_email": {
      const subject = text(result?.subject);
      return { icon: "mail", title: done ? (failed ? "Couldn't open an email" : `Read ${subject ? quote(subject) : "an email"}`) : "Reading an email…" };
    }
    case "draft_email": {
      const to = people(list(args.to));
      return { icon: "draft", title: done ? (failed ? `Couldn't save a draft to ${to}` : `Saved a draft to ${to}`) : `Drafting an email to ${to}…`, detail: text(args.subject) };
    }
    case "send_email": {
      const to = people(list(args.to));
      return { icon: "send", title: done ? (failed ? `Didn't send the email to ${to}` : `Sent an email to ${to}`) : `Sending an email to ${to}…`, detail: text(args.subject) };
    }
    case "list_events": {
      const from = when(args.start, timeZone);
      return {
        icon: "calendar",
        title: done ? (failed ? "Couldn't read your calendar" : "Checked your calendar") : "Checking your calendar…",
        detail: [from ? `from ${from}` : undefined, count !== undefined ? `${count} event${count === 1 ? "" : "s"}` : undefined].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "find_free_time": {
      const minutes = typeof args.durationMinutes === "number" ? `${args.durationMinutes}-minute ` : "";
      const suggestions = Array.isArray(result?.suggestions) ? result.suggestions.length : undefined;
      return {
        icon: "clock",
        title: done ? (failed ? "Couldn't check your availability" : `Found ${suggestions ?? "some"} open ${minutes}slot${suggestions === 1 ? "" : "s"}`) : `Looking for ${minutes}openings…`,
      };
    }
    case "create_event": {
      const title = text(args.title) ?? "an event";
      return {
        icon: "calendar-plus",
        title: done ? (failed ? `Didn't add ${quote(title)}` : `Added ${quote(title)} to your calendar`) : `Adding ${quote(title)}…`,
        detail: when(args.start, timeZone),
      };
    }
    case "update_event": {
      const event = asArgs(result?.event);
      const title = text(event.title) ?? text(args.title);
      return {
        icon: "calendar-edit",
        title: done ? (failed ? "Didn't update the event" : `Updated ${title ? quote(title) : "an event"}`) : "Updating an event…",
        detail: text(event.when) ?? when(args.start, timeZone),
      };
    }
    case "delete_event": {
      const title = text(result?.title);
      return { icon: "calendar-x", title: done ? (failed ? "Didn't cancel the event" : `Cancelled ${title ? quote(title) : "an event"}`) : "Cancelling an event…" };
    }
    case "schedule_task": {
      const recurring = Boolean(text(args.cron));
      return {
        icon: recurring ? "repeat" : "bell",
        title: done ? (failed ? "Couldn't schedule that" : recurring ? "Set up a recurring task" : "Set a reminder") : "Scheduling…",
        detail: scheduleSummary(args, timeZone, at),
      };
    }
    case "list_schedules":
      return { icon: "clock", title: done ? "Checked your scheduled tasks" : "Checking your scheduled tasks…" };
    case "cancel_schedule":
      return { icon: "clock", title: done ? (failed ? "Couldn't cancel the scheduled task" : "Cancelled a scheduled task") : "Cancelling a scheduled task…" };
    default:
      return { icon: "tool", title: done ? `Used ${name}` : `Using ${name}…` };
  }
}

export interface ApprovalDescription {
  readonly title: string;
  readonly preview: ApprovalPreview;
}

function isoOrRaw(value: unknown, timeZone: string): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    return parseDateTime(raw, timeZone).toISOString();
  } catch {
    return raw;
  }
}

/** The approval card for a consequential tool call: the exact message or event the person is approving. */
export function describeApproval(tool: string, rawArgs: unknown, timeZone: string, current?: { title: string; start: string; end: string }): ApprovalDescription {
  const args = asArgs(rawArgs);
  switch (tool) {
    case "send_email":
      return {
        title: `Send this email to ${people(list(args.to))}?`,
        preview: { type: "email", to: list(args.to), cc: list(args.cc), subject: text(args.subject) ?? "(no subject)", body: typeof args.body === "string" ? args.body : "" },
      };
    case "create_event":
      return {
        title: "Add this event to your calendar?",
        preview: {
          type: "event",
          action: "create",
          title: text(args.title),
          start: isoOrRaw(args.start, timeZone),
          end: isoOrRaw(args.end, timeZone),
          attendees: list(args.attendees),
          location: text(args.location),
          description: text(args.description),
          timeZone,
        },
      };
    case "update_event":
      return {
        title: current ? `Change ${quote(current.title)}?` : "Change this event?",
        preview: {
          type: "event",
          action: "update",
          title: text(args.title),
          start: isoOrRaw(args.start, timeZone),
          end: isoOrRaw(args.end, timeZone),
          attendees: Array.isArray(args.attendees) ? list(args.attendees) : undefined,
          location: text(args.location),
          description: text(args.description),
          current,
          timeZone,
        },
      };
    case "delete_event":
      return {
        title: current ? `Cancel ${quote(current.title)}?` : "Cancel this event?",
        preview: { type: "event", action: "delete", current, timeZone },
      };
    default:
      return { title: `Allow ${tool}?`, preview: { type: "generic", summary: JSON.stringify(args, null, 2).slice(0, 2000) } };
  }
}
