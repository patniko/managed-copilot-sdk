// All of the person's Dispatch conversations: the orchestrator environment's sessions, rediscovered from Managed
// Copilot after every connection, so the list survives Dispatch restarts (and losing its data directory).
import type { SessionInfo } from "@managed-copilot/sdk";
import { TEMPLATES } from "../shared/catalog.js";
import type { ApprovalMode, ConversationSettings, ConversationSummary, ConversationView, DispatchState, ServerEvent } from "../shared/types.js";
import { attachCommandTemplate, canLaunchTerminal } from "./attach.js";
import type { DispatchConfig } from "./config.js";
import { Conversation, type ConversationHost } from "./conversation.js";
import { DispatchError, errorText, isMissingSession } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { DispatchPlatform } from "./platform.js";
import type { Store } from "./store.js";

/** Conversations resumed right after connecting, so their approvals and progress continue; others resume when opened. */
const ATTACH_ON_CONNECT = 8;
const MAX_PROMPT = 20_000;
const PUBLISH_MS = 120;
const LIST_MS = 400;
const REMOVED_LIMIT = 500;

export class ConversationManager implements ConversationHost {
  readonly platform: DispatchPlatform;
  readonly config: DispatchConfig;
  readonly store: Store;
  readonly #hub: EventHub;
  readonly #conversations = new Map<string, Conversation>();
  readonly #publishing = new Map<string, NodeJS.Timeout>();
  #listTimer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  /** Conversations removed by this process (deleted, or found gone): a list read before that must not bring them back. */
  readonly #removed = new Set<string>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(platform: DispatchPlatform, config: DispatchConfig, store: Store, hub: EventHub) {
    this.platform = platform;
    this.config = config;
    this.store = store;
    this.#hub = hub;
  }

  start(): void {
    // Known conversations show right away, from Dispatch's records; the platform confirms them once connected.
    for (const stored of this.store.list()) this.#conversations.set(stored.id, new Conversation(this, stored.id));
    this.#unsubscribe.push(
      this.platform.onConnected(() => void this.sync()),
      this.platform.onStatus(() => {
        this.#hub.publish(this.#platformEvent());
        this.#publishList();
      }),
      this.platform.onWorkerEvent((event) => {
        const conversation = event.sessionId ? this.#conversations.get(event.sessionId) : undefined;
        conversation?.workerEvent(event);
      }),
    );
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    for (const timer of this.#publishing.values()) clearTimeout(timer);
    this.#publishing.clear();
    if (this.#listTimer) clearTimeout(this.#listTimer);
    for (const conversation of this.#conversations.values()) conversation.remember();
    await Promise.all([...this.#conversations.values()].map((conversation) => conversation.close()));
    this.store.flush();
  }

  /** After every (re)connection: sessions on the previous client are gone, and the list may have changed elsewhere. */
  sync(): Promise<void> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      do {
        this.#syncAgain = false;
        await this.#sync();
      } while (this.#syncAgain);
    })().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    for (const conversation of this.#conversations.values()) conversation.detach();
    // Only what existed before the list was read can be judged by it: a conversation created or deleted meanwhile
    // isn't in the snapshot (or still is).
    const before = new Set(this.#conversations.values());
    let sessions: SessionInfo[] | undefined;
    try {
      sessions = await this.platform.listSessions(this.config.environment);
    } catch (error) {
      log.warn("Couldn't list conversations on Managed Copilot", { error: errorText(error) });
    }
    if (sessions) {
      const existing = new Map(sessions.filter((session) => session.state !== "deleting" && session.state !== "deleted").map((session) => [session.id, session]));
      // The list is capped, so absence isn't deletion: look each missing conversation up, and drop only confirmed ones.
      const missing = [...this.#conversations].filter(([id, conversation]) => !existing.has(id) && before.has(conversation));
      for (let index = 0; index < missing.length; index += 8) {
        await Promise.all(
          missing.slice(index, index + 8).map(async ([id, conversation]) => {
            if (!(await this.#confirmGone(id)) || this.#conversations.get(id) !== conversation) return;
            log.info("A conversation no longer exists on Managed Copilot", { sessionId: id });
            conversation.dispose();
            this.gone(conversation);
          }),
        );
      }
      for (const session of existing.values()) {
        if (this.#conversations.has(session.id) || this.#removed.has(session.id)) continue;
        this.store.ensure(session.id, { settings: { approvals: this.config.approvals }, createdAt: session.createdAt, ...(session.title ? { title: session.title } : {}) });
        this.#conversations.set(session.id, new Conversation(this, session.id));
      }
    }
    this.#publishList();
    const recent = this.#sorted().slice(0, ATTACH_ON_CONNECT);
    for (const conversation of recent) await conversation.attach();
    await Promise.all([...this.#conversations.values()].filter((conversation) => !recent.includes(conversation)).map((conversation) => conversation.refreshWorkers()));
    this.#publishList();
  }

  #sorted(): Conversation[] {
    return [...this.#conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Whether a session is definitely gone: not found, or being deleted. An error that says neither keeps it. */
  async #confirmGone(sessionId: string): Promise<boolean> {
    try {
      const info = await this.platform.sessionInfo(sessionId);
      return info.state === "deleting" || info.state === "deleted";
    } catch (error) {
      return isMissingSession(error);
    }
  }

  summaries(): ConversationSummary[] {
    return this.#sorted().map((conversation) => conversation.summary());
  }

  state(): DispatchState {
    return {
      platform: this.platform.status,
      ...(this.platform.coordinator ? { coordinator: this.platform.coordinator } : {}),
      blueprints: this.platform.blueprints,
      conversations: this.summaries(),
      templates: TEMPLATES,
      defaults: { approvals: this.config.approvals },
      attachCommand: attachCommandTemplate(this.config.attachUrl),
      canLaunchTerminal: canLaunchTerminal(),
    };
  }

  /** What a browser gets when it connects to the event stream. */
  initialEvents(): ServerEvent[] {
    return [this.#platformEvent(), { type: "conversations", conversations: this.summaries() }];
  }

  #platformEvent(): ServerEvent {
    return { type: "platform", platform: this.platform.status, ...(this.platform.coordinator ? { coordinator: this.platform.coordinator } : {}), blueprints: this.platform.blueprints };
  }

  #require(id: string): Conversation {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new DispatchError("not_found", "There's no such conversation. It may have been deleted.", 404);
    return conversation;
  }

  #requireConnected(): void {
    if (this.platform.status.state !== "connected") throw new DispatchError("platform_unavailable", this.platform.status.message ?? "Managed Copilot isn't connected yet.", 503);
  }

  async create(prompt: string, approvals: ApprovalMode | undefined): Promise<ConversationView> {
    this.#requireConnected();
    const text = validPrompt(prompt);
    const settings: ConversationSettings = { approvals: approvals ?? this.config.approvals };
    const conversation = new Conversation(this);
    try {
      await conversation.start(text, settings, (started) => this.#conversations.set(started.id, started));
    } catch (error) {
      if (conversation.id) {
        this.#conversations.delete(conversation.id);
        this.store.remove(conversation.id);
        this.#hub.publish({ type: "removed", id: conversation.id });
      }
      throw error instanceof DispatchError ? error : new DispatchError("create_failed", `Couldn't start the conversation: ${errorText(error)}`, 502);
    }
    this.#publishList();
    return conversation.view();
  }

  /** A conversation with its transcript: resumed first if it isn't yet. */
  async view(id: string): Promise<ConversationView> {
    const conversation = this.#require(id);
    if (this.platform.status.state === "connected") await conversation.attach();
    return conversation.view();
  }

  async send(id: string, prompt: string): Promise<string | undefined> {
    this.#requireConnected();
    return this.#require(id).send(validPrompt(prompt));
  }

  answer(id: string, approvalId: string, approve: boolean, reason?: string): void {
    this.#require(id).answer(approvalId, approve, reason);
  }

  setSettings(id: string, settings: ConversationSettings): ConversationView {
    const conversation = this.#require(id);
    conversation.setSettings(settings);
    return conversation.view();
  }

  async delete(id: string): Promise<void> {
    this.#requireConnected();
    const conversation = this.#require(id);
    await conversation.delete();
    this.gone(conversation);
  }

  async files(id: string, workerId: string) {
    this.#requireConnected();
    return this.#require(id).files(workerId);
  }

  async readFile(id: string, workerId: string, path: string) {
    this.#requireConnected();
    return this.#require(id).readFile(workerId, path);
  }

  /** Whether a session may be attached from Dispatch: a conversation's coordinator or one of its workers. */
  owns(sessionId: string): boolean {
    return [...this.#conversations.values()].some((conversation) => conversation.owns(sessionId));
  }

  // ConversationHost

  changed(conversation: Conversation): void {
    const id = conversation.id;
    if (!this.#publishing.has(id)) {
      const timer = setTimeout(() => {
        this.#publishing.delete(id);
        if (this.#conversations.get(id) !== conversation) return;
        conversation.remember();
        this.#hub.publish({ type: "conversation", conversation: conversation.view() });
      }, PUBLISH_MS);
      timer.unref?.();
      this.#publishing.set(id, timer);
    }
    this.#publishList();
  }

  gone(conversation: Conversation): void {
    const id = conversation.id;
    if (this.#conversations.get(id) !== conversation) return;
    this.#conversations.delete(id);
    this.#removed.add(id);
    // Bounded: only lists read around the time of a removal matter.
    if (this.#removed.size > REMOVED_LIMIT) this.#removed.delete(this.#removed.values().next().value!);
    const timer = this.#publishing.get(id);
    if (timer) clearTimeout(timer);
    this.#publishing.delete(id);
    this.store.remove(id);
    this.#hub.publish({ type: "removed", id });
    this.#publishList();
  }

  watching(): boolean {
    return this.#hub.clientCount > 0;
  }

  #publishList(): void {
    if (this.#listTimer) return;
    this.#listTimer = setTimeout(() => {
      this.#listTimer = undefined;
      this.#hub.publish({ type: "conversations", conversations: this.summaries() });
    }, LIST_MS);
    this.#listTimer.unref?.();
  }
}

function validPrompt(prompt: unknown): string {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) throw new DispatchError("invalid_request", "Write a message first.");
  if (text.length > MAX_PROMPT) throw new DispatchError("invalid_request", `Keep messages under ${MAX_PROMPT.toLocaleString("en-US")} characters.`);
  return text;
}
