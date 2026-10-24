/**
 * The assistant server's composition root: one person's durable conversation on Managed Copilot, their tools and
 * connections, schedules, offline work, and the API the web UI uses.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Tool } from "@github/copilot-sdk";
import type { AccountInfo, VerifiedWebhookEvent } from "@managed-copilot/sdk";
import type { AgendaView, ConnectionsView, DecisionRequest, OfflineView, ScheduleView, SendMessageRequest, ServerEvent, Snapshot } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { Conversation, UserFacingError } from "./conversation.js";
import { EffectLedger } from "./effects.js";
import { EventHub, HttpError, redirect, Router, type RequestContext } from "./http.js";
import { createLogger, errorMessage, type Logger } from "./log.js";
import { OfflineWorker } from "./offline.js";
import { Platform } from "./platform.js";
import { Schedules } from "./schedules.js";
import { loadOrCreateDevSealingKey, Sealer } from "./seal.js";
import { Store } from "./store.js";
import { addDays, dayKey, isValidTimeZone, startOfDay, systemTimeZone } from "./time.js";
import type { TimelineChange } from "./timeline.js";
import { DemoWorkspace } from "./tools/demo/provider.js";
import { GoogleAuth, GoogleAuthError } from "./tools/google/oauth.js";
import { GoogleWorkspace } from "./tools/google/workspace.js";
import { createTools, systemInstructions } from "./tools/index.js";
import type { Workspace } from "./tools/types.js";

const AGENDA_REFRESH_MS = 5 * 60_000;
const CALENDAR_TOOLS = new Set(["create_event", "update_event", "delete_event"]);

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>~]|\[(.*?)\]\(.*?\)/g, (match, label: string | undefined) => label ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export class Assistant {
  readonly config: AssistantConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly platform: Platform;
  readonly googleAuth: GoogleAuth;
  readonly hub = new EventHub();
  readonly conversation: Conversation;
  readonly schedules: Schedules;
  readonly offline: OfflineWorker;
  readonly #effects: EffectLedger;
  #account: AccountInfo | undefined;
  #demo: DemoWorkspace | undefined;
  #agenda: AgendaView | undefined;
  #viewers = 0;
  #browserTimeZone: string | undefined;
  #detachTimer: NodeJS.Timeout | undefined;
  #attachTimer: NodeJS.Timeout | undefined;
  #attachFailures = 0;
  #pollTimer: NodeJS.Timeout | undefined;
  #agendaTimer: NodeJS.Timeout | undefined;
  #schedulesTimer: NodeJS.Timeout | undefined;

  constructor(config: AssistantConfig, log: Logger = createLogger("assistant")) {
    this.config = config;
    this.log = log;
    this.store = new Store(join(config.dataDir, "assistant.db"));
    if (!config.sealingKey) log.warn("ASSISTANT_SEALING_KEY is not set; using a generated development key in the data directory");
    const sealer = Sealer.fromSecret(config.sealingKey ?? loadOrCreateDevSealingKey(config.dataDir));
    this.platform = new Platform(config, log.child("platform"));
    this.googleAuth = new GoogleAuth({ client: config.google, redirectUri: `${config.publicUrl}/api/google/callback`, store: this.store, sealer, log: log.child("google") });
    this.#effects = new EffectLedger(this.store);
    this.offline = new OfflineWorker({
      config,
      log: log.child("offline"),
      store: this.store,
      platform: this.platform,
      sessionId: () => this.conversation.sessionId,
      live: () => this.conversation.live,
      tools: (via) => this.#tools(via),
      onChange: (view) => this.#broadcast({ type: "offline", offline: view }),
      onEvent: (event) => this.#onPlatformEvent(event),
    });
    this.conversation = new Conversation({
      config,
      log: log.child("conversation"),
      store: this.store,
      platform: this.platform,
      accountId: () => this.#account?.id,
      tools: () => this.#tools(),
      systemMessage: async () => {
        const account = this.#requireAccount();
        return systemInstructions({ name: account.name ?? account.login });
      },
      currentEvent: async (id) => {
        const event = await (await this.workspace()).calendar.get(id, this.timeZone());
        return { title: event.title, start: event.start, end: event.end };
      },
      timeline: {
        timeZone: () => this.timeZone(),
        scheduleNameFor: (_messageId, text) => this.schedules.nameFor(text),
        isOffline: (id) => this.offline.isOffline(id),
      },
      onChanges: (changes) => this.#onTimelineChanges(changes),
      onReset: () => this.#broadcastSnapshot(),
      onStatus: () => this.#broadcastStatus(),
      onSessionChanged: () => void this.schedules.refresh(),
    });
    this.schedules = new Schedules({
      config,
      log: log.child("schedules"),
      platform: this.platform,
      sessionId: () => this.conversation.sessionId,
      timeZone: () => this.timeZone(),
      onChange: (schedules, error) => {
        this.#broadcast({ type: "schedules", schedules, error });
        // Trigger pills replayed before the schedules were known get their names now.
        const changes = this.conversation.timeline.refresh();
        if (changes.length) this.#onTimelineChanges(changes);
      },
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  start(): void {
    const last = this.store.db.prepare("SELECT account_id, login, name FROM users ORDER BY updated_at DESC LIMIT 1").get() as
      | { account_id: number; login: string; name: string | null }
      | undefined;
    if (last) this.#account = { id: last.account_id, login: last.login, name: last.name ?? undefined };
    this.platform.onStatus((status) => {
      if (status.state === "ready") void this.#onPlatformReady();
      else this.conversation.reset();
      this.#broadcastStatus();
    });
    this.platform.start();
    this.#pollTimer = setInterval(() => {
      if (this.platform.status.state !== "ready") return;
      if (!this.conversation.live) void this.offline.reconcile("interval");
    }, this.config.pollIntervalMs);
    this.#pollTimer.unref();
    this.#agendaTimer = setInterval(() => {
      if (this.#viewers > 0) void this.refreshAgenda();
    }, AGENDA_REFRESH_MS);
    this.#agendaTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#pollTimer);
    clearInterval(this.#agendaTimer);
    clearTimeout(this.#detachTimer);
    clearTimeout(this.#schedulesTimer);
    clearTimeout(this.#attachTimer);
    this.hub.close();
    await this.conversation.detach("server stopping").catch(() => undefined);
    await this.platform.stop();
    this.store.close();
  }

  async #onPlatformReady(): Promise<void> {
    const managed = this.platform.managed;
    if (!managed) return;
    const account = managed.account;
    if (this.#account?.id !== account.id) this.#demo = undefined;
    this.#account = account;
    this.store.upsertUser({ id: account.id, login: account.login, name: account.name });
    this.#rememberBrowserTimeZone();
    this.#broadcastStatus();
    this.#broadcast({ type: "connections", connections: this.connections() });
    // Know the conversation (even with no tab open) before listing its schedules and answering its webhooks.
    await this.conversation.ensureKnown().catch((error) => this.log.warn("Couldn't find the conversation yet", { error: errorMessage(error) }));
    await this.schedules.refresh();
    void this.refreshAgenda();
    if (this.#viewers > 0) this.#ensureAttached();
    else await this.offline.reconcile("platform ready");
  }

  #onPlatformEvent(event: VerifiedWebhookEvent): void {
    this.log.info("Platform event", { type: event.type, sessionId: event.sessionId });
    if (event.type === "schedule.run_started" && !this.conversation.live) this.#ensureAttached();
    if (event.type.startsWith("schedule.") || event.type === "session.idle") void this.schedules.refresh();
    if (event.type === "session.idle") void this.refreshAgenda();
  }

  // ---- viewers and attach policy -----------------------------------------------------------------------------------

  /** Attaches while someone is watching, retrying with backoff if it fails (for example, a platform hiccup). */
  #ensureAttached(): void {
    clearTimeout(this.#attachTimer);
    this.#attachTimer = undefined;
    if (this.#viewers === 0 || this.platform.status.state !== "ready") return;
    this.conversation.attach().then(
      () => {
        this.#attachFailures = 0;
      },
      () => {
        if (this.#viewers === 0 || this.conversation.live) return;
        const delay = Math.min(60_000, 5_000 * 2 ** this.#attachFailures++);
        this.#attachTimer = setTimeout(() => this.#ensureAttached(), delay);
        this.#attachTimer.unref();
      },
    );
  }

  #viewerJoined(): void {
    this.#viewers++;
    clearTimeout(this.#detachTimer);
    this.#detachTimer = undefined;
    this.#ensureAttached();
  }

  #viewerLeft(): void {
    this.#viewers = Math.max(0, this.#viewers - 1);
    if (this.#viewers > 0) return;
    clearTimeout(this.#detachTimer);
    this.#detachTimer = setTimeout(() => {
      if (this.#viewers > 0) return;
      void this.conversation
        .detach("no open tabs", { unless: () => this.#viewers > 0 })
        .then(() => {
          if (!this.conversation.live) return this.offline.reconcile("detached");
        })
        .catch((error) => this.log.warn("Detach failed", { error: errorMessage(error) }));
    }, this.config.detachAfterMs);
    this.#detachTimer.unref();
  }

  /** Remembers the browser's time zone, so work done with no tab open uses it too. */
  #rememberBrowserTimeZone(): void {
    const timeZone = this.#browserTimeZone;
    if (!timeZone || !this.#account) return;
    if (this.store.getUser(this.#account.id)?.detectedTimeZone !== timeZone) this.store.setDetectedTimeZone(this.#account.id, timeZone);
  }

  // ---- identity, workspace, tools ----------------------------------------------------------------------------------

  #requireAccount(): AccountInfo {
    if (!this.#account) throw new UserFacingError("platform_unavailable", "Connect to Managed Copilot first so the assistant knows who you are.");
    return this.#account;
  }

  timeZone(): string {
    const user = this.#account ? this.store.getUser(this.#account.id) : undefined;
    return user?.timeZone ?? user?.detectedTimeZone ?? this.#browserTimeZone ?? systemTimeZone();
  }

  #demoWorkspace(account: AccountInfo): DemoWorkspace {
    this.#demo ??= new DemoWorkspace(
      this.store,
      { accountId: account.id, name: account.name ?? account.login, address: `${account.login.toLowerCase()}@example.com` },
      () => this.timeZone(),
    );
    return this.#demo;
  }

  /** Google when connected (never silently falling back to sample data if it fails), otherwise the demo workspace. */
  async workspace(): Promise<Workspace> {
    const account = this.#requireAccount();
    const google = this.store.getGoogle(account.id);
    if (google) return new GoogleWorkspace(this.googleAuth, account.id, google.email, this.log.child("google"));
    return this.#demoWorkspace(account);
  }

  #tools(via?: "webhook" | "poll"): Tool<any>[] {
    return createTools({
      workspace: () => this.workspace(),
      timeZone: () => this.timeZone(),
      effects: this.#effects,
      log: this.log.child("tools"),
      onCall: via ? (toolCallId, tool) => this.offline.recordCall(toolCallId, tool, via) : undefined,
    });
  }

  connections(): ConnectionsView {
    const account = this.#account;
    const google = account ? this.store.getGoogle(account.id) : undefined;
    const seeded = account ? (this.store.db.prepare("SELECT seeded_at FROM demo_meta WHERE account_id = ?").get(account.id) as { seeded_at: string } | undefined) : undefined;
    return {
      provider: google ? "google" : "demo",
      google: {
        configured: this.googleAuth.configured,
        connected: google !== undefined,
        email: google?.email,
        status: google?.status,
        scopes: google?.scopes,
        connectedAt: google?.connectedAt,
        redirectUri: this.googleAuth.redirectUri,
      },
      demo: { seededAt: seeded?.seeded_at, address: account ? `${account.login.toLowerCase()}@example.com` : "you@example.com" },
    };
  }

  async refreshAgenda(): Promise<void> {
    if (!this.#account) return;
    const timeZone = this.timeZone();
    const now = new Date();
    try {
      const workspace = await this.workspace();
      if (workspace instanceof DemoWorkspace) workspace.ensureSeeded(now);
      const events = await workspace.calendar.list({ start: startOfDay(now, timeZone), end: addDays(now, 7, timeZone), max: 60 });
      this.#agenda = {
        date: dayKey(now, timeZone),
        events: events.map((event) => ({ id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay, location: event.location })),
      };
    } catch (error) {
      this.#agenda = { date: dayKey(now, timeZone), events: [], error: errorMessage(error) };
    }
    this.#broadcast({ type: "agenda", agenda: this.#agenda });
    this.#broadcast({ type: "connections", connections: this.connections() });
  }

  // ---- broadcasting ------------------------------------------------------------------------------------------------

  snapshot(): Snapshot {
    const user = this.#account ? this.store.getUser(this.#account.id) : undefined;
    return {
      account: this.#account,
      platform: this.platform.status,
      conversation: this.conversation.status,
      timeline: this.conversation.timeline.list(),
      lastReadAt: user?.lastReadAt,
      connections: this.connections(),
      schedules: this.schedules.list as ScheduleView[],
      schedulesError: this.schedules.error,
      settings: { timeZone: this.timeZone() },
      offline: this.offline.view() as OfflineView,
      agenda: this.#agenda,
    };
  }

  #broadcast(event: ServerEvent): void {
    this.hub.broadcast(event);
  }

  #broadcastSnapshot(): void {
    this.#broadcast({ type: "snapshot", snapshot: this.snapshot() });
  }

  #broadcastStatus(): void {
    this.#broadcast({ type: "status", platform: this.platform.status, conversation: this.conversation.status, account: this.#account });
  }

  #onTimelineChanges(changes: readonly TimelineChange[]): void {
    for (const change of changes) {
      switch (change.type) {
        case "item":
          this.#broadcast({ type: "item", item: change.item });
          if (change.item.kind === "tool" && change.item.status === "succeeded" && CALENDAR_TOOLS.has(change.item.name)) void this.refreshAgenda();
          break;
        case "delta":
          this.#broadcast({ type: "delta", id: change.id, text: change.text });
          break;
        case "schedules-changed":
          clearTimeout(this.#schedulesTimer);
          this.#schedulesTimer = setTimeout(() => void this.schedules.refresh(), 300);
          break;
        case "proactive":
          this.#broadcast({ type: "notify", title: "Your assistant", body: plainText(change.text).slice(0, 180), itemId: change.itemId });
          break;
        case "busy":
          break;
      }
    }
  }

  // ---- HTTP API ----------------------------------------------------------------------------------------------------

  routes(router: Router): void {
    const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof UserFacingError) throw new HttpError(error.code === "not_found" ? 404 : 409, error.code, error.message);
        if (error instanceof GoogleAuthError) throw new HttpError(400, error.code, error.message);
        throw error;
      }
    };

    router.add("GET", "/healthz", () => ({ ok: true, platform: this.platform.status.state, conversation: this.conversation.state }));

    router.add(
      "GET",
      "/api/events",
      (ctx) => {
        const tz = ctx.url.searchParams.get("tz");
        if (tz && isValidTimeZone(tz)) {
          this.#browserTimeZone = tz;
          this.#rememberBrowserTimeZone();
        }
        this.hub.open(ctx.res, () => this.#viewerLeft());
        this.hub.send(ctx.res, { type: "snapshot", snapshot: this.snapshot() });
        this.#viewerJoined();
      },
      // Opening the stream attaches the conversation and sets the time zone, so only this app's pages may open it.
      { sameOrigin: true },
    );

    router.add("GET", "/api/state", () => this.snapshot(), { sameOrigin: true });

    router.add("POST", "/api/messages", async (ctx) =>
      run(async () => {
        const { text } = await ctx.json<SendMessageRequest>();
        const message = typeof text === "string" ? text.trim() : "";
        if (!message) throw new HttpError(400, "empty_message", "Type a message first.");
        if (message.length > 8000) throw new HttpError(400, "message_too_long", "That message is too long (8,000 characters at most).");
        if (this.platform.status.state !== "ready") throw new HttpError(503, "platform_unavailable", this.platform.status.message ?? "Managed Copilot isn't connected yet.");
        const messageId = await this.conversation.send(message);
        return { messageId };
      }),
    );

    router.add("POST", "/api/abort", async () => run(async () => (await this.conversation.abort(), { ok: true })));

    router.add("POST", "/api/approvals/:id", async (ctx) =>
      run(async () => {
        const { decision, feedback } = await ctx.json<DecisionRequest>();
        if (decision !== "approve" && decision !== "deny") throw new HttpError(400, "invalid_decision", "Choose approve or deny.");
        this.conversation.decide(ctx.params.id!, decision, typeof feedback === "string" ? feedback.slice(0, 1000) : undefined);
        return { ok: true };
      }),
    );

    router.add("POST", "/api/read", async (ctx) =>
      run(async () => {
        const account = this.#requireAccount();
        const { at } = await ctx.json<{ at?: string }>();
        if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new HttpError(400, "invalid_time", "Expected an ISO timestamp.");
        const current = this.store.getUser(account.id)?.lastReadAt;
        if (!current || Date.parse(at) > Date.parse(current)) {
          this.store.setLastReadAt(account.id, at);
          this.#broadcast({ type: "read", lastReadAt: at });
        }
        return { ok: true };
      }),
    );

    router.add("POST", "/api/settings", async (ctx) =>
      run(async () => {
        const account = this.#requireAccount();
        const { timeZone } = await ctx.json<{ timeZone?: string }>();
        if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) throw new HttpError(400, "invalid_time_zone", "Pick a valid time zone.");
        this.store.setTimeZone(account.id, timeZone);
        this.#broadcast({ type: "settings", settings: { timeZone } });
        void this.refreshAgenda();
        void this.schedules.refresh();
        return { ok: true };
      }),
    );

    router.add("POST", "/api/retry", async () => {
      this.#attachFailures = 0;
      if (this.platform.status.state !== "ready") await this.platform.connect();
      else await this.conversation.attach().catch(() => undefined);
      return { ok: true };
    });

    router.add("POST", "/api/conversation/reset", async () =>
      run(async () => {
        const previous = this.conversation.sessionId;
        // Schedules that target the old conversation would fail once it is deleted.
        for (const schedule of this.schedules.list) await this.schedules.remove(schedule.id).catch(() => undefined);
        await this.conversation.startOver();
        this.offline.reset();
        this.#ensureAttached();
        void this.schedules.refresh();
        return { ok: true, previous };
      }),
    );

    router.add("POST", "/api/schedules/briefing", async () => run(() => this.schedules.addMorningBriefing()));
    router.add("POST", "/api/schedules/:id/pause", async (ctx) => run(() => this.schedules.pause(ctx.params.id!)));
    router.add("POST", "/api/schedules/:id/resume", async (ctx) => run(() => this.schedules.resume(ctx.params.id!)));
    router.add("POST", "/api/schedules/:id/run", async (ctx) => run(() => this.schedules.runNow(ctx.params.id!, randomUUID())));
    router.add("DELETE", "/api/schedules/:id", async (ctx) => run(() => this.schedules.remove(ctx.params.id!)));

    router.add("POST", "/api/google/connect", async () => run(() => ({ url: this.googleAuth.beginAuthorization(this.#requireAccount().id) })));

    router.add("GET", "/api/google/callback", async (ctx: RequestContext) => {
      try {
        const result = await this.googleAuth.completeAuthorization(ctx.url.searchParams);
        this.#broadcast({ type: "connections", connections: this.connections() });
        void this.refreshAgenda();
        redirect(ctx.res, `/?google=${result.missingScopes.length ? "partial" : "connected"}`);
      } catch (error) {
        const code = error instanceof GoogleAuthError ? error.code : "failed";
        this.log.warn("Google sign-in did not complete", { code, error: errorMessage(error) });
        redirect(ctx.res, `/?google=${encodeURIComponent(code)}`);
      }
    });

    router.add("POST", "/api/google/disconnect", async () =>
      run(async () => {
        await this.googleAuth.disconnect(this.#requireAccount().id);
        this.#broadcast({ type: "connections", connections: this.connections() });
        void this.refreshAgenda();
        return { ok: true };
      }),
    );

    router.add("POST", "/api/demo/reset", async () =>
      run(async () => {
        const account = this.#requireAccount();
        this.#demoWorkspace(account).reset();
        this.#broadcast({ type: "connections", connections: this.connections() });
        await this.refreshAgenda();
        return { ok: true };
      }),
    );

    // Signed platform webhooks (no browser origin; verified by HMAC signature instead).
    router.add("POST", "/api/copilot-events", (ctx) => this.offline.handleWebhook(ctx), { sameOrigin: false });
  }
}
