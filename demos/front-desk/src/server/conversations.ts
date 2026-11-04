/**
 * Each person's conversations: one Managed Copilot session per conversation, created and resumed with that person's
 * own connection and memory tools. Front Desk checks ownership in its own records before every operation, and the
 * platform checks it again for the session itself.
 */
import { randomUUID } from "node:crypto";
import type { CopilotSession, PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/protocol";
import { LIMITS, type ConversationSummary, type ConversationView, type PlatformRecord, type ServerEvent } from "../shared/types.js";
import type { FrontDeskConfig } from "./config.js";
import { AppError, notFound } from "./errors.js";
import type { Hub } from "./hub.js";
import { log } from "./log.js";
import { today, type People } from "./people.js";
import { describePlatformError, managedErrorOf, type PersonalConnection, type Platform } from "./platform.js";
import type { ConversationRecord, Store, UserRecord } from "./store.js";
import { isMemoryTool, memoryTools } from "./tools.js";
import { Transcript, type TranscriptChange } from "./transcript.js";

/** A turn with no events for this long is reported as stopped (the runtime that ran it may be gone). */
const STALLED_TURN_MS = 5 * 60_000;
const WATCH_INTERVAL_MS = 30_000;

interface Live {
  readonly id: string;
  readonly userId: string;
  readonly session: CopilotSession;
  readonly transcript: Transcript;
  readonly connection: PersonalConnection;
  readonly generation: number;
}

export interface ConversationsDeps {
  readonly store: Store;
  readonly platform: Platform;
  readonly people: People;
  readonly hub: Hub;
  readonly config: FrontDeskConfig;
  /** A person's GitHub sign-in stopped working: forget it so they're asked to sign in again. */
  readonly onSignInExpired?: (userId: string) => void;
}

/** The agent's instructions. Its name is the person's, from their own account, never from another person's data. */
export function instructions(user: UserRecord, at = new Date()): string {
  const date = at.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return [
    `You are Front Desk, a friendly and capable assistant in a web app that many different people use. You're talking with ${user.name}.`,
    "Each person's conversations and memory are private. You can only see this person's conversations and memory, never anyone else's. If they ask about someone else's information, explain that you can't see it.",
    "Memory: call `recall` when an answer may depend on something this person told you before (their preferences or details about them), `remember` when they ask you to remember something or share a lasting preference, and `forget` when they ask you to forget something. Say briefly what you saved or forgot.",
    "You have no web access, files, or shell. If a request needs them, say so briefly and help as well as you can.",
    "Be concise and warm. Use Markdown (lists, tables, code blocks) when it helps.",
    `Today is ${date} (UTC).`,
  ].join("\n");
}

export function titleFrom(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text || "New conversation";
}

function checkPrompt(value: unknown): string {
  const prompt = String(value ?? "").trim();
  if (!prompt) throw new AppError("empty_message", "Write a message first.");
  if (prompt.length > LIMITS.prompt) throw new AppError("message_too_long", `Keep messages under ${LIMITS.prompt.toLocaleString("en-US")} characters.`);
  return prompt;
}

const busy = () => new AppError("busy", "Front Desk is still answering. Wait for it to finish, or stop it first.", 409);

/** The platform's own record of a session, as Front Desk shows it. */
function platformRecord(info: SessionInfo): PlatformRecord {
  const inference = info.inference;
  return {
    ownerKind: info.owner.kind ?? "github",
    owner: info.owner.login,
    ...(inference ? { inference: inference.route === "foundry" ? { route: "foundry" as const, foundry: inference.foundry } : { route: "copilot" as const } } : {}),
    ...(info.model ? { model: info.model } : {}),
  };
}

/** Only Front Desk's own memory tools may run; the shared environment offers nothing else that acts. */
const permit: PermissionHandler = (request) => {
  const tool = (request as { toolName?: unknown }).toolName;
  if (request.kind === "custom-tool" && typeof tool === "string" && isMemoryTool(tool)) return { kind: "approve-once" };
  return { kind: "reject", feedback: "Front Desk's assistant only uses its memory tools." };
};

export class Conversations {
  readonly #deps: ConversationsDeps;
  readonly #live = new Map<string, Live>();
  readonly #opening = new Map<string, Promise<Live>>();
  readonly #watch: NodeJS.Timeout;
  #generation = 0;

  constructor(deps: ConversationsDeps) {
    this.#deps = deps;
    this.#watch = setInterval(() => void this.#check(), WATCH_INTERVAL_MS);
    this.#watch.unref();
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  list(user: UserRecord): ConversationSummary[] {
    return this.#deps.store.listConversations(user.id).map((record) => this.#summary(record));
  }

  async view(user: UserRecord, id: string): Promise<ConversationView> {
    const record = this.#owned(user, id);
    const live = await this.#ensureLive(user, record);
    const platform = await live.connection
      .sessionInfo(id)
      .then(platformRecord)
      .catch(() => undefined);
    return { ...this.#summary(record), items: live.transcript.items, ...(platform ? { platform } : {}) };
  }

  // ---- changes -----------------------------------------------------------------------------------------------------

  async create(user: UserRecord, rawPrompt: unknown): Promise<{ conversation: ConversationSummary; messageId: string }> {
    const prompt = checkPrompt(rawPrompt);
    const day = this.#countMessage(user);
    let delivered = false;
    try {
      const person = await this.#deps.people.person(user);
      const connection = await this.#deps.platform.open(person).catch((error: unknown) => Promise.reject(this.#fail(user, error)));
      const client = await connection.client().catch((error: unknown) => Promise.reject(this.#fail(user, error, connection)));
      const generation = ++this.#generation;
      const transcript = new Transcript();
      let live: Live | undefined;
      const early: SessionEvent[] = [];
      const onEvent = (event: SessionEvent) => {
        if (live) this.#apply(live, event);
        else early.push(event);
      };
      const route = connection.route;
      let session: CopilotSession;
      try {
        // Our own ID, so events that arrive while the session is being created already have a conversation.
        session = await client.createSession({ ...this.#sessionConfig(user, onEvent), sessionId: randomUUID(), ...(route.model ? { model: route.model } : {}) });
      } catch (error) {
        throw this.#fail(user, error, connection);
      }
      const id = session.sessionId;
      const record = this.#deps.store.addConversation({
        id,
        userId: user.id,
        title: titleFrom(prompt),
        environment: route.environment,
        route: route.route,
        ...(route.model ? { model: route.model } : {}),
      });
      live = { id, userId: user.id, session, transcript, connection, generation };
      this.#live.set(id, live);
      for (const event of early) this.#apply(live, event);
      this.#publish(user.id, { type: "conversation", conversation: this.#summary(record) });
      log.info("Started a conversation", { user: user.id, conversation: id, route: route.route, environment: route.environment });
      const messageId = await this.#deliver(user, live, prompt);
      delivered = true;
      return { conversation: this.#summary(this.#deps.store.getConversation(user.id, id) ?? record), messageId };
    } finally {
      if (day && !delivered) this.#deps.store.uncountMessage(user.id, day);
      if (day) this.#publishBilling(user);
    }
  }

  async send(user: UserRecord, id: string, rawPrompt: unknown): Promise<{ messageId: string }> {
    const prompt = checkPrompt(rawPrompt);
    const record = this.#owned(user, id);
    if (this.#live.get(id)?.transcript.busy) throw busy();
    const day = this.#countMessage(user);
    let delivered = false;
    try {
      let live = await this.#ensureLive(user, record);
      if (live.transcript.busy) throw busy();
      let messageId: string;
      try {
        messageId = await this.#deliver(user, live, prompt);
      } catch (error) {
        // The connection behind the session may be gone (the platform restarted, or the bridge exited): reconnect once.
        if (!(error instanceof AppError) || (error.code !== "platform_error" && error.code !== "platform_unavailable")) throw error;
        log.warn("Sending failed; reconnecting and trying once more", { user: user.id, conversation: id, error: error.message });
        await this.release(user.id);
        live = await this.#ensureLive(user, record);
        messageId = await this.#deliver(user, live, prompt);
      }
      delivered = true;
      this.#deps.store.touchConversation(user.id, id);
      return { messageId };
    } finally {
      if (day && !delivered) this.#deps.store.uncountMessage(user.id, day);
      if (day) this.#publishBilling(user);
    }
  }

  async stop(user: UserRecord, id: string): Promise<void> {
    this.#owned(user, id);
    const live = this.#live.get(id);
    if (!live?.transcript.busy) return;
    try {
      await live.session.abort();
    } catch (error) {
      throw this.#fail(user, error, live.connection);
    }
    // The runtime doesn't always report a stop; settle the conversation if nothing arrives soon.
    setTimeout(() => {
      if (this.#live.get(id) === live && live.transcript.busy) this.#changes(live, live.transcript.settle("Stopped."));
    }, 4_000).unref();
  }

  async delete(user: UserRecord, id: string): Promise<void> {
    const record = this.#owned(user, id);
    const live = this.#live.get(id);
    if (live) await this.#drop(live);
    try {
      const person = await this.#deps.people.person(user);
      const connection = await this.#deps.platform.open(person);
      await connection.deleteSession(record.id);
    } catch (error) {
      const managed = managedErrorOf(error);
      // Already gone from the platform: finish deleting it here.
      if (managed?.code !== "not_found") throw this.#fail(user, error);
    }
    this.#deps.store.deleteConversation(user.id, id);
    this.#publish(user.id, { type: "conversation.deleted", id });
    log.info("Deleted a conversation", { user: user.id, conversation: id });
  }

  /** Lets go of everything live for a person (they signed out, or went idle). Sessions keep running on the platform. */
  async release(userId: string): Promise<void> {
    const mine = [...this.#live.values()].filter((live) => live.userId === userId);
    await Promise.all(mine.map((live) => this.#drop(live)));
    await this.#deps.platform.release(userId);
  }

  async close(): Promise<void> {
    clearInterval(this.#watch);
    await Promise.all([...this.#live.values()].map((live) => this.#drop(live)));
    await this.#deps.platform.closeAll();
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  #owned(user: UserRecord, id: string): ConversationRecord {
    const record = this.#deps.store.getConversation(user.id, id);
    if (!record) throw notFound();
    return record;
  }

  #summary(record: ConversationRecord): ConversationSummary {
    const live = this.#live.get(record.id);
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      route: record.route,
      ...(record.model ? { model: record.model } : {}),
      busy: live?.transcript.busy ?? false,
    };
  }

  #sessionConfig(user: UserRecord, onEvent: (event: SessionEvent) => void) {
    return {
      systemMessage: { mode: "replace" as const, content: instructions(user) },
      tools: memoryTools({ store: this.#deps.store, userId: user.id, onChange: () => this.#publishMemories(user.id) }),
      streaming: true,
      onPermissionRequest: permit,
      onEvent,
    };
  }

  /** Counts a message against the daily allowance of people Front Desk pays for. Returns the day it counted on. */
  #countMessage(user: UserRecord): string | undefined {
    if (!this.#deps.people.appPays(user)) return undefined;
    const day = today();
    const limit = this.#deps.config.dailyMessageLimit;
    if (!this.#deps.store.countMessage(user.id, day, limit)) {
      throw new AppError("daily_limit", `You've used today's ${limit} messages. Your allowance starts again at midnight UTC.`, 429);
    }
    return day;
  }

  async #deliver(user: UserRecord, live: Live, prompt: string): Promise<string> {
    // Busy before sending: a turn can end (or fail) before `send` returns, and that must not leave it marked busy.
    this.#changes(live, live.transcript.markBusy());
    try {
      return await live.session.send({ prompt });
    } catch (error) {
      this.#changes(live, live.transcript.settle());
      throw this.#fail(user, error, live.connection);
    }
  }

  async #ensureLive(user: UserRecord, record: ConversationRecord): Promise<Live> {
    const live = this.#live.get(record.id);
    if (live) return live;
    let opening = this.#opening.get(record.id);
    if (!opening) {
      opening = this.#resume(user, record).finally(() => this.#opening.delete(record.id));
      this.#opening.set(record.id, opening);
    }
    return opening;
  }

  async #resume(user: UserRecord, record: ConversationRecord): Promise<Live> {
    const person = await this.#deps.people.person(user);
    const connection = await this.#deps.platform.open(person).catch((error: unknown) => Promise.reject(this.#fail(user, error)));
    if (connection.route.environment !== record.environment) {
      throw new AppError("route_changed", "This conversation started in a different place than your account uses now, so Front Desk can't continue it.", 409);
    }
    const client = await connection.client().catch((error: unknown) => Promise.reject(this.#fail(user, error, connection)));
    const generation = ++this.#generation;
    const transcript = new Transcript();
    let live: Live | undefined;
    const early: SessionEvent[] = [];
    const onEvent = (event: SessionEvent) => {
      if (live) this.#apply(live, event);
      else early.push(event);
    };
    let session: CopilotSession;
    let history: SessionEvent[];
    try {
      session = await client.resumeSession(record.id, { ...this.#sessionConfig(user, onEvent), continuePendingWork: true, suppressResumeEvent: true });
      history = await session.getEvents();
    } catch (error) {
      if (managedErrorOf(error)?.code === "not_found") {
        // Deleted on the platform (for example from the operator console): forget it here too.
        this.#deps.store.deleteConversation(user.id, record.id);
        this.#publish(user.id, { type: "conversation.deleted", id: record.id });
        throw new AppError("gone", "This conversation no longer exists on Managed Copilot.", 410);
      }
      throw this.#fail(user, error, connection);
    }
    transcript.replaceAll(history);
    live = { id: record.id, userId: user.id, session, transcript, connection, generation };
    this.#live.set(record.id, live);
    for (const event of early) this.#apply(live, event);
    return live;
  }

  #apply(live: Live, event: SessionEvent): void {
    if (this.#live.get(live.id) !== live) return;
    this.#changes(live, live.transcript.apply(event));
  }

  #changes(live: Live, changes: readonly TranscriptChange[]): void {
    for (const change of changes) {
      switch (change.type) {
        case "item":
          this.#publish(live.userId, { type: "item", conversationId: live.id, item: change.item });
          break;
        case "delta":
          this.#publish(live.userId, { type: "delta", conversationId: live.id, itemId: change.itemId, delta: change.delta });
          break;
        case "busy":
        case "title": {
          const record =
            change.type === "title" ? this.#deps.store.touchConversation(live.userId, live.id, titleFrom(change.title)) : this.#deps.store.getConversation(live.userId, live.id);
          if (record) this.#publish(live.userId, { type: "conversation", conversation: this.#summary(record) });
          break;
        }
        case "memory":
          this.#publishMemories(live.userId);
          break;
      }
    }
  }

  async #drop(live: Live): Promise<void> {
    if (this.#live.get(live.id) === live) this.#live.delete(live.id);
    await live.session.disconnect().catch(() => undefined);
  }

  /** Describes a failure for the person, and handles one that means their GitHub sign-in ended. */
  #fail(user: UserRecord, error: unknown, connection?: PersonalConnection): AppError {
    const who = { kind: user.kind === "github" ? ("github" as const) : ("app" as const), ...(user.githubLogin ? { login: user.githubLogin } : {}) };
    const described = describePlatformError(error, who, connection?.route);
    if (described.code === "github_sign_in_expired") {
      this.#deps.onSignInExpired?.(user.id);
      void this.release(user.id);
    }
    if (described.status >= 500) log.warn("Managed Copilot call failed", { user: user.id, code: described.code, error: described.message });
    return described;
  }

  #publish(userId: string, event: ServerEvent): void {
    this.#deps.hub.publish(userId, event);
  }

  #publishMemories(userId: string): void {
    const memories = this.#deps.store.listMemories(userId).map(({ id, text, createdAt }) => ({ id, text, createdAt }));
    this.#publish(userId, { type: "memories", memories });
  }

  #publishBilling(user: UserRecord): void {
    this.#publish(user.id, { type: "billing", billing: this.#deps.people.billing(user) });
  }

  /** Every 30 s: report turns that stopped arriving, and let go of people who left. */
  async #check(): Promise<void> {
    const now = Date.now();
    const byUser = new Map<string, Live[]>();
    for (const live of this.#live.values()) {
      if (live.transcript.busy && now - live.transcript.lastActivity > STALLED_TURN_MS) {
        this.#changes(live, live.transcript.settle("This answer stopped arriving. Send your message again."));
      }
      byUser.set(live.userId, [...(byUser.get(live.userId) ?? []), live]);
    }
    for (const [userId, lives] of byUser) {
      const quiet = lives.every((live) => !live.transcript.busy && now - live.transcript.lastActivity > this.#deps.config.idleCloseMs);
      if (this.#deps.hub.count(userId) === 0 && quiet) {
        log.info("Closing an idle person's connection", { user: userId, conversations: lives.length });
        await this.release(userId).catch(() => undefined);
        continue;
      }
      // A connection that stopped answering is reopened on the person's next request; their tabs see the reconnect.
      const connection = lives[0]!.connection;
      try {
        await connection.ping();
      } catch (error) {
        log.warn("Lost a person's connection to Managed Copilot; it reconnects on their next request", { user: userId, error: (error as Error).message });
        await Promise.all(lives.map((live) => this.#drop(live)));
        await this.#deps.platform.release(userId).catch(() => undefined);
        for (const live of lives) {
          const record = this.#deps.store.getConversation(userId, live.id);
          if (record) this.#publish(userId, { type: "conversation", conversation: this.#summary(record) });
        }
      }
    }
  }
}
