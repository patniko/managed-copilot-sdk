/**
 * UI preview for development: run `vite` and open `/?preview` (or `/?preview=<variant>`). It replaces `fetch('/api/…')`
 * and `EventSource` with an in-memory server that speaks the real protocol (shared/protocol.ts) and simulates turns,
 * approvals, schedules, and background work, so the real app code runs unchanged on sample data. main.tsx loads it
 * only when import.meta.env.DEV is true, so it never ships.
 */
import { BeakerIcon, TriangleDownIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { ApprovalItem, BackgroundView, ConversationStatus, ScheduleView, ServerEvent, Snapshot, TimelineItem, ToolIcon, ToolItem } from "../../../shared/protocol";
import { Menu } from "../components/ui";
import { createSnapshot, PREVIEW_REPLY, VARIANTS, type Variant } from "./fixtures";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

const BUSY_REPLY = [
  "For tomorrow's **Q3 launch plan review** at 9:00 AM, I'd bring:",
  "",
  "1. Sam's latest pricing notes (from Tuesday's thread)",
  "2. The beta cohort numbers",
  "3. Two launch date options",
  "",
  "Want me to summarize Sam's last email before the meeting?",
].join("\n");

interface PreviewSource {
  open(): void;
  fail(): void;
  deliver(event: ServerEvent): void;
}

interface Turn {
  cancelled: boolean;
  discarded: boolean;
}

/** What an approved call does, described the way the server's tool rows are. */
function outcomeFor(approval: ApprovalItem): { name: string; icon: ToolIcon; running: string; done: string } {
  const subject = approval.preview.type === "event" ? (approval.preview.title ?? approval.preview.current?.title ?? "the event") : "";
  switch (approval.tool) {
    case "send_email": {
      const to = approval.title.replace(/^Send this email to (.*)\?$/, "$1");
      return { name: "send_email", icon: "send", running: `Sending an email to ${to}…`, done: `Sent an email to ${to}` };
    }
    case "create_event":
      return { name: "create_event", icon: "calendar-plus", running: `Adding “${subject}”…`, done: `Added “${subject}” to your calendar` };
    case "update_event":
      return { name: "update_event", icon: "calendar-edit", running: "Updating an event…", done: `Updated “${subject}”` };
    case "delete_event":
      return { name: "delete_event", icon: "calendar-x", running: "Cancelling an event…", done: `Cancelled “${subject}”` };
    default:
      return { name: approval.tool, icon: "tool", running: `Using ${approval.tool}…`, done: `Used ${approval.tool}` };
  }
}

class PreviewServer {
  readonly #sources = new Set<PreviewSource>();
  readonly #variant: Variant;
  #snapshot: Snapshot;
  #seq = 100;
  /** Simulated turns still running. Stop cancels them (a reply keeps what streamed); a reset also discards them. */
  readonly #turns = new Set<Turn>();
  #busyStarted = false;

  constructor(variant: Variant) {
    this.#variant = variant;
    this.#snapshot = createSnapshot(variant);
  }

  #begin(): Turn {
    const turn: Turn = { cancelled: false, discarded: false };
    this.#turns.add(turn);
    return turn;
  }

  /** A turn finished on its own: the assistant is idle once no other turn is running. */
  #end(turn: Turn): void {
    this.#turns.delete(turn);
    if (!turn.cancelled && this.#turns.size === 0) this.#status({ busy: false });
  }

  #cancelAll(discard: boolean): void {
    for (const turn of this.#turns) {
      turn.cancelled = true;
      turn.discarded = discard;
    }
    this.#turns.clear();
  }

  // ── Event stream ───────────────────────────────────────────────────────────────────────────────────────────

  attach(source: PreviewSource): void {
    this.#sources.add(source);
    setTimeout(() => {
      if (!this.#sources.has(source)) return;
      source.open();
      if (this.#variant === "loading") return;
      source.deliver({ type: "snapshot", snapshot: this.#snapshot });
      if (this.#variant === "reconnecting") setTimeout(() => source.fail(), 400);
      if (this.#variant === "busy" && !this.#busyStarted) {
        this.#busyStarted = true;
        void this.#finishBusyTurn();
      }
    }, 120);
  }

  detach(source: PreviewSource): void {
    this.#sources.delete(source);
  }

  #emit(event: ServerEvent): void {
    this.#apply(event);
    for (const source of this.#sources) source.deliver(event);
  }

  /** Keeps the server's own snapshot current, like the real server's state. */
  #apply(event: ServerEvent): void {
    const snapshot = this.#snapshot;
    switch (event.type) {
      case "snapshot":
        this.#snapshot = event.snapshot;
        return;
      case "item": {
        const index = snapshot.timeline.findIndex((item) => item.id === event.item.id);
        const timeline = [...snapshot.timeline];
        if (index === -1) timeline.push(event.item);
        else timeline[index] = event.item;
        this.#snapshot = { ...snapshot, timeline };
        return;
      }
      case "delta":
        this.#snapshot = {
          ...snapshot,
          timeline: snapshot.timeline.map((item) => (item.id === event.id && item.kind === "assistant" ? { ...item, text: item.text + event.text, streaming: true } : item)),
        };
        return;
      case "status":
        this.#snapshot = { ...snapshot, platform: event.platform, conversation: event.conversation, account: event.account ?? snapshot.account };
        return;
      case "schedules":
        this.#snapshot = { ...snapshot, schedules: event.schedules, schedulesError: event.error };
        return;
      case "background":
        this.#snapshot = { ...snapshot, background: event.background };
        return;
      case "connections":
        this.#snapshot = { ...snapshot, connections: event.connections };
        return;
      case "settings":
        this.#snapshot = { ...snapshot, settings: event.settings };
        return;
      case "read":
        this.#snapshot = { ...snapshot, lastReadAt: event.lastReadAt };
        return;
      case "agenda":
        this.#snapshot = { ...snapshot, agenda: event.agenda };
        return;
      case "offline":
        this.#snapshot = { ...snapshot, offline: event.offline };
        return;
      case "notify":
        return;
    }
  }

  #status(patch: Partial<ConversationStatus>): void {
    const { platform, conversation, account } = this.#snapshot;
    this.#emit({ type: "status", platform, conversation: { ...conversation, ...patch }, account });
  }

  // ── REST ───────────────────────────────────────────────────────────────────────────────────────────────────

  async handle(url: URL, method: string, body: unknown): Promise<Response> {
    await delay(200 + Math.random() * 200);
    let payload: Record<string, unknown> = {};
    try {
      payload = typeof body === "string" && body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      return failure(400, "invalid_json", "The request body isn't valid JSON.");
    }
    const path = url.pathname;
    if (method === "GET" && path === "/api/state") return json(this.#snapshot);
    if (method === "POST" && path === "/api/messages") return this.#send(typeof payload.text === "string" ? payload.text : "");
    if (method === "POST" && path === "/api/abort") return this.#abort();
    const approval = /^\/api\/approvals\/([^/]+)$/.exec(path);
    if (approval && method === "POST") return this.#decide(decodeURIComponent(approval[1]!), payload.decision === "approve" ? "approve" : "deny", typeof payload.feedback === "string" ? payload.feedback : undefined);
    if (method === "POST" && path === "/api/read") {
      if (typeof payload.at === "string") this.#emit({ type: "read", lastReadAt: payload.at });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/settings") {
      if (typeof payload.timeZone === "string") this.#emit({ type: "settings", settings: { timeZone: payload.timeZone } });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/retry") return this.#retry();
    if (method === "POST" && path === "/api/schedules/briefing") return this.#addBriefing();
    const schedule = /^\/api\/schedules\/([^/]+)(?:\/(pause|resume|run))?$/.exec(path);
    if (schedule && (method === "DELETE" || schedule[2])) return this.#schedule(decodeURIComponent(schedule[1]!), method === "DELETE" ? "delete" : (schedule[2] as "pause" | "resume" | "run"));
    if (method === "POST" && path === "/api/google/connect") return json({ url: "/?preview=google&google=connected" });
    if (method === "POST" && path === "/api/google/disconnect") {
      const { connections } = this.#snapshot;
      this.#emit({ type: "connections", connections: { ...connections, provider: "demo", google: { configured: true, connected: false, redirectUri: connections.google.redirectUri } } });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/demo/reset") return json({ ok: true });
    if (method === "POST" && path === "/api/conversation/reset") {
      this.#cancelAll(true);
      const { conversation } = this.#snapshot;
      this.#emit({
        type: "snapshot",
        snapshot: { ...this.#snapshot, timeline: [], lastReadAt: undefined, conversation: { ...conversation, busy: false, sessionId: undefined }, schedules: [] },
      });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/background/enable") return this.#setBackground({ state: "on", login: this.#snapshot.account?.login, since: nowIso(), checkedAt: nowIso() });
    if (method === "POST" && path === "/api/background/disable") return this.#setBackground({ state: "off", login: this.#snapshot.account?.login, checkedAt: nowIso() });
    if (method === "POST" && path === "/api/background/refresh") return json(this.#snapshot.background);
    return failure(404, "not_found", "The preview doesn't know this endpoint.");
  }

  #send(text: string): Response {
    const { platform, conversation } = this.#snapshot;
    if (!text.trim()) return failure(400, "invalid_request", "Type a message first.");
    if (platform.state !== "ready" || conversation.attach !== "live") return failure(503, "unavailable", "Your assistant isn't connected right now.");
    const id = `msg-${++this.#seq}`;
    this.#emit({ type: "item", item: { kind: "user", id, at: nowIso(), text } });
    void this.#reply(text);
    return json({ messageId: id });
  }

  async #reply(text: string): Promise<void> {
    const turn = this.#begin();
    this.#status({ busy: true });
    await delay(500);
    if (turn.cancelled) return;
    const calendar = /calendar|today|tomorrow|meet|prepare|schedule|remind/i.test(text);
    const tool = calendar
      ? { name: "list_events", icon: "calendar" as const, running: "Checking your calendar…", done: "Checked your calendar", detail: "3 events" }
      : { name: "search_email", icon: "mail" as const, running: "Searching your inbox…", done: "Searched your inbox", detail: "4 messages" };
    const toolItem: ToolItem = { kind: "tool", id: `tool-${++this.#seq}`, at: nowIso(), name: tool.name, icon: tool.icon, title: tool.running, status: "running" };
    this.#emit({ type: "item", item: toolItem });
    await delay(1400);
    if (turn.cancelled) return;
    this.#emit({ type: "item", item: { ...toolItem, title: tool.done, detail: tool.detail, status: "succeeded", endedAt: nowIso() } });
    await this.#stream(turn, PREVIEW_REPLY);
    this.#end(turn);
  }

  /** Streams a reply word by word. Stop keeps what arrived (like the real timeline); a reset drops it. */
  async #stream(turn: Turn, text: string, options: { proactive?: boolean; pace?: number } = {}): Promise<void> {
    if (turn.cancelled) return;
    const id = `reply-${++this.#seq}`;
    const at = nowIso();
    const proactive = options.proactive ?? false;
    this.#emit({ type: "item", item: { kind: "assistant", id, at, text: "", streaming: true, proactive } });
    const parts = text.split(/(\s+)/);
    let sent = "";
    for (let index = 0; index < parts.length && !turn.cancelled; index += 4) {
      const chunk = parts.slice(index, index + 4).join("");
      sent += chunk;
      this.#emit({ type: "delta", id, text: chunk });
      await delay(options.pace ?? 70);
    }
    if (!turn.discarded) this.#emit({ type: "item", item: { kind: "assistant", id, at, text: sent, streaming: false, proactive } });
  }

  async #finishBusyTurn(): Promise<void> {
    const turn = this.#begin();
    await delay(2500);
    if (turn.cancelled) return;
    const running = this.#snapshot.timeline.find((item): item is ToolItem => item.kind === "tool" && item.status === "running");
    if (running) this.#emit({ type: "item", item: { ...running, title: "Checked your calendar", detail: "3 events tomorrow", status: "succeeded", endedAt: nowIso() } });
    await this.#stream(turn, BUSY_REPLY, { pace: 260 });
    this.#end(turn);
  }

  #abort(): Response {
    this.#cancelAll(false);
    this.#emit({ type: "item", item: { kind: "notice", id: `notice-${++this.#seq}`, at: nowIso(), level: "info", text: "Stopped." } });
    this.#status({ busy: false });
    return json({ ok: true });
  }

  #decide(id: string, decision: "approve" | "deny", feedback: string | undefined): Response {
    const item = this.#snapshot.timeline.find((entry): entry is ApprovalItem => entry.kind === "approval" && entry.id === id);
    if (!item) return failure(404, "not_found", "That approval doesn't exist.");
    if (item.status !== "pending") return failure(409, "not_pending", "That request isn't waiting for you anymore.");
    const turn = this.#begin();
    this.#status({ busy: true });
    if (decision === "deny") {
      this.#emit({ type: "item", item: { ...item, status: "denied", actionable: false, decidedAt: nowIso(), feedback } });
      void (async () => {
        await delay(500);
        await this.#stream(turn, feedback ? `Okay, I won't do that. I'll keep your note in mind: “${feedback}”.` : "Okay, I won't do that.");
        this.#end(turn);
      })();
    } else {
      this.#emit({ type: "item", item: { ...item, status: "approved", actionable: false, decidedAt: nowIso() } });
      void (async () => {
        const outcome = outcomeFor(item);
        const tool: ToolItem = { kind: "tool", id: id.replace(/^approval:/, ""), at: nowIso(), name: outcome.name, icon: outcome.icon, title: outcome.running, status: "running" };
        this.#emit({ type: "item", item: tool });
        await delay(1200);
        if (turn.cancelled) return;
        this.#emit({ type: "item", item: { ...tool, title: outcome.done, status: "succeeded", endedAt: nowIso() } });
        await this.#stream(turn, `${outcome.done}. Anything else?`);
        this.#end(turn);
      })();
    }
    return json({ ok: true });
  }

  #retry(): Response {
    const { platform, conversation } = this.#snapshot;
    if (platform.state !== "ready") {
      this.#emit({ type: "status", platform: { ...platform, retryAt: new Date(Date.now() + 30_000).toISOString() }, conversation, account: this.#snapshot.account });
    } else if (conversation.attach === "error") {
      this.#status({ attach: "live", error: undefined, sessionId: crypto.randomUUID() });
    }
    return json({ ok: true });
  }

  #addBriefing(): Response {
    const { schedules, schedulesError } = this.#snapshot;
    if (schedules.some((schedule) => schedule.id === "sch-briefing")) return failure(409, "exists", "You already have a weekday morning briefing.");
    const briefing = createSnapshot("").schedules.find((schedule) => schedule.id === "sch-briefing")!;
    this.#emit({ type: "schedules", schedules: [...schedules, { ...briefing, lastRun: undefined }], error: schedulesError });
    return json({ ok: true });
  }

  #schedule(id: string, action: "pause" | "resume" | "run" | "delete"): Response {
    const { schedules, schedulesError, background } = this.#snapshot;
    const index = schedules.findIndex((schedule) => schedule.id === id);
    const schedule = schedules[index];
    if (!schedule) return failure(404, "not_found", "That schedule doesn't exist anymore.");
    if ((action === "resume" || action === "run") && background.state !== "on") return failure(409, "background_off", "Turn on background work first, so this can run while you're away.");
    if (action === "run") {
      void this.#runSchedule(schedule);
      return json({ ok: true });
    }
    const next: ScheduleView[] = [...schedules];
    if (action === "delete") next.splice(index, 1);
    else next[index] = { ...schedule, state: action === "pause" ? "paused" : "active", pausedReason: undefined };
    this.#emit({ type: "schedules", schedules: next, error: schedulesError });
    return json({ ok: true });
  }

  async #runSchedule(schedule: ScheduleView): Promise<void> {
    const turn = this.#begin();
    await delay(600);
    if (turn.cancelled) return;
    const trigger: TimelineItem = { kind: "trigger", id: `trigger-${++this.#seq}`, at: nowIso(), text: schedule.prompt, scheduleName: schedule.name };
    this.#emit({ type: "item", item: trigger });
    this.#status({ busy: true });
    await delay(700);
    await this.#stream(turn, `Here's your “${schedule.name}” update. ${PREVIEW_REPLY}`, { proactive: true });
    this.#end(turn);
  }

  #setBackground(view: BackgroundView): Response {
    this.#emit({ type: "background", background: view });
    return json(view);
  }
}

function createEventSource(server: PreviewServer) {
  return class PreviewEventSource extends EventTarget implements PreviewSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      server.attach(this);
    }

    open(): void {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    }

    /** The connection dropped; a real EventSource keeps retrying, and the preview leaves it retrying. */
    fail(): void {
      if (this.readyState === 2) return;
      this.readyState = 0;
      const event = new Event("error");
      this.onerror?.(event);
      this.dispatchEvent(event);
    }

    deliver(event: ServerEvent): void {
      if (this.readyState !== 1) return;
      const message = new MessageEvent("message", { data: JSON.stringify(event) });
      this.onmessage?.(message);
      this.dispatchEvent(message);
    }

    close(): void {
      this.readyState = 2;
      server.detach(this);
    }
  };
}

/** The header's "Preview data" label: says the page shows sample data, and switches between sample states. */
function PreviewMenu({ variant }: { variant: Variant }) {
  return (
    <Menu
      label="Preview data"
      heading="Preview data: pick a sample state"
      align="start"
      width="w-72"
      items={VARIANTS.map((option) => ({
        key: option.id || "conversation",
        label: option.label,
        description: option.description,
        checked: option.id === variant,
        onSelect: () => window.location.assign(option.id ? `/?preview=${option.id}` : "/?preview"),
      }))}
      renderTrigger={(trigger) => (
        <button
          type="button"
          className="Label Label--attention shrink-0 cursor-pointer"
          title="This page shows sample data, not your assistant. Pick another sample state."
          aria-label="Preview data: pick a sample state"
          data-testid="preview-label"
          {...trigger}
        >
          <BeakerIcon />
          <span className="hidden sm:inline">Preview data</span>
          <TriangleDownIcon />
        </button>
      )}
    />
  );
}

/** Installs the preview and returns the header label that marks the page as sample data. */
export function installPreview(): ReactNode {
  const requested = new URLSearchParams(window.location.search).get("preview") ?? "";
  const variant: Variant = VARIANTS.find((option) => option.id === requested)?.id ?? "";
  const server = new PreviewServer(variant);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      return server.handle(url, method, init?.body);
    }
    return realFetch(input, init);
  };
  Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: createEventSource(server) });
  document.documentElement.dataset.preview = variant || "conversation";
  return <PreviewMenu variant={variant} />;
}
