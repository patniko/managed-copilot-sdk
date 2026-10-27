/**
 * The person's one durable conversation. While someone has the app open, this server attaches to the session as a
 * live client (streaming, tools, approvals). When the last tab closes it detaches, so scheduled runs execute on the
 * platform and tool calls arrive through the webhook instead (spec sections 11 and 12).
 */
import type { CopilotClient, CopilotSession, PermissionRequest, PermissionRequestResult, SessionEvent, Tool } from "@github/copilot-sdk";
import { isManagedCopilotError, type ManagedCopilot } from "@managed-copilot/sdk";
import type { AttachState, ConversationStatus, TimelineItem } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { describeApproval } from "./describe.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import type { Store } from "./store.js";
import { approvalItemId, Timeline, type TimelineChange, type TimelineContext } from "./timeline.js";
import { PERSON_APPROVES } from "./tools/index.js";

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface ConversationDeps {
  readonly config: AssistantConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly platform: Platform;
  accountId(): number | undefined;
  tools(): Tool<any>[];
  /** The system message for the session about to be resumed (its ID) or created (undefined). */
  systemMessage(sessionId: string | undefined): Promise<string>;
  /** The event as it stands today, for update/delete approval cards. */
  currentEvent(id: string): Promise<{ title: string; start: string; end: string } | undefined>;
  /** Why this conversation can't start sandboxes right now, if it can't: a start is then refused without asking. */
  sandboxBlocked?(): string | undefined;
  timeline: Omit<TimelineContext, "isActionable">;
  onChanges(changes: readonly TimelineChange[]): void;
  /** The timeline was rebuilt from history; broadcast a full snapshot. */
  onReset(): void;
  onStatus(status: ConversationStatus): void;
  /** The conversation's session ID was found, created, or forgotten. */
  onSessionChanged(): void;
}

export class UserFacingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isMissingSession(error: unknown): boolean {
  return isManagedCopilotError(error, "not_found") || /not found|no such session|unknown session/i.test(errorMessage(error));
}

export class Conversation {
  readonly timeline: Timeline;
  readonly #deps: ConversationDeps;
  readonly #resolvers = new Map<string, (result: PermissionRequestResult) => void>();
  #state: AttachState = "detached";
  #error: string | undefined;
  #client: CopilotClient | undefined;
  #session: CopilotSession | undefined;
  #attaching: Promise<void> | undefined;
  #detaching: Promise<void> | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  /** Bumped whenever a connection is started or dropped; callbacks from an older connection check it and stand down. */
  #generation = 0;

  constructor(deps: ConversationDeps) {
    this.#deps = deps;
    this.timeline = new Timeline({ ...deps.timeline, isActionable: (id) => this.#resolvers.has(id) });
  }

  get state(): AttachState {
    return this.#state;
  }

  get live(): boolean {
    return this.#state === "live";
  }

  get sessionId(): string | undefined {
    const accountId = this.#deps.accountId();
    return this.#session?.sessionId ?? (accountId !== undefined ? this.#deps.store.getUser(accountId)?.sessionId : undefined);
  }

  get status(): ConversationStatus {
    return { attach: this.#state, busy: this.timeline.busy, sessionId: this.sessionId, model: this.#deps.config.model, error: this.#error };
  }

  #setState(state: AttachState, error?: string): void {
    this.#state = state;
    this.#error = error;
    this.#deps.onStatus(this.status);
  }

  /** Attaches as a live client: resume the stored conversation (or find or create it) and load its history. */
  attach(): Promise<void> {
    if (this.#state === "live") return Promise.resolve();
    if (!this.#attaching) {
      const attempt: Promise<void> = (async () => {
        // A detach that is still closing the previous connection finishes first; this attach then starts fresh.
        await this.#detaching;
        if (this.#state !== "live") await this.#attach();
      })().finally(() => {
        if (this.#attaching === attempt) this.#attaching = undefined;
      });
      this.#attaching = attempt;
    }
    return this.#attaching;
  }

  async #attach(): Promise<void> {
    const managed = this.#deps.platform.managed;
    const accountId = this.#deps.accountId();
    if (!managed || accountId === undefined) throw new UserFacingError("platform_unavailable", "Managed Copilot isn't connected yet.");
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.#setState("attaching");
    let client: CopilotClient | undefined;
    let session: CopilotSession | undefined;
    // Registered with the session config, so events are captured from the moment the session exists. Until history
    // has loaded they are buffered; the timeline dedupes them against history by event ID.
    const buffered: SessionEvent[] = [];
    let loading = true;
    const onEvent = (event: SessionEvent) => {
      if (!current()) return;
      if (loading) buffered.push(event);
      else this.#onEvent(event);
    };
    const abandon = async () => {
      await session?.disconnect().catch(() => undefined);
      await client?.stop().catch(() => undefined);
    };
    let history: SessionEvent[] | undefined;
    try {
      client = await managed.client(this.#deps.config.environment);
      const shared = {
        tools: this.#deps.tools(),
        onPermissionRequest: (request: PermissionRequest) => this.#onPermissionRequest(request, generation),
        onEvent,
        streaming: true,
        // The platform's durable schedule_task is the only scheduler; the runtime's in-process one would not survive restarts.
        manageScheduleEnabled: false,
      };
      const sessionId = this.#deps.store.getUser(accountId)?.sessionId ?? (await this.#discover(managed, accountId));
      if (sessionId) {
        try {
          const systemMessage = { content: await this.#deps.systemMessage(sessionId) };
          session = await client.resumeSession(sessionId, { ...shared, systemMessage, continuePendingWork: true, suppressResumeEvent: true });
        } catch (error) {
          if (!isMissingSession(error)) throw error;
          this.#deps.log.warn("Stored conversation no longer exists; starting a new one", { sessionId });
          this.#deps.store.setSessionId(accountId, undefined);
        }
      }
      if (!current()) return await abandon();
      if (!session) {
        session = await client.createSession({ ...shared, systemMessage: { content: await this.#deps.systemMessage(undefined) }, model: this.#deps.config.model });
        this.#deps.store.setSessionId(accountId, session.sessionId);
        this.#deps.log.info("Started a new conversation", { sessionId: session.sessionId });
        this.#deps.onSessionChanged();
      }
      if (!current()) return await abandon();
      history = await session.getEvents();
      if (!current()) return await abandon();
    } catch (error) {
      await abandon();
      // A newer attach, detach, or reset owns the state now.
      if (!current()) return;
      const message = errorMessage(error);
      this.#setState("error", message);
      this.#deps.log.error("Couldn't attach to the conversation", { error: message });
      throw error instanceof UserFacingError ? error : new UserFacingError("attach_failed", message);
    }
    if (!session || !client || !history) return;
    this.timeline.replaceAll(history);
    loading = false;
    const changes = buffered.flatMap((event) => this.timeline.apply(event));
    this.#client = client;
    this.#session = session;
    this.#setState("live");
    this.#deps.onReset();
    // The snapshot already carries every item. Still run the side effects (agenda and schedule refreshes,
    // notifications), re-sending items in their final state so an early version never rolls the snapshot back.
    const effects: TimelineChange[] = [];
    const resent = new Set<string>();
    for (const change of changes) {
      if (change.type === "delta") continue;
      if (change.type !== "item") {
        effects.push(change);
        continue;
      }
      if (resent.has(change.item.id)) continue;
      resent.add(change.item.id);
      const item = this.timeline.get(change.item.id);
      if (item) effects.push({ type: "item", item });
    }
    if (effects.length) this.#deps.onChanges(effects);
    this.#startHeartbeat(generation);
    this.#deps.log.info("Attached to the conversation", { sessionId: session.sessionId, events: history.length });
  }

  /**
   * Finds this person's existing conversation on the platform when local state was lost. A failed lookup is an error:
   * starting a new conversation instead would orphan the real one and its schedules.
   */
  async #discover(managed: ManagedCopilot, accountId: number): Promise<string | undefined> {
    let sessions: Awaited<ReturnType<ManagedCopilot["sessions"]["list"]>>;
    try {
      sessions = await managed.sessions.list({ environment: this.#deps.config.environment });
    } catch (error) {
      throw new UserFacingError("discovery_failed", `Couldn't look up your conversation on Managed Copilot: ${errorMessage(error)}`);
    }
    const candidate = sessions
      .filter((s) => !s.scheduleId && !["deleting", "deleted", "failed"].includes(s.state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (!candidate) return undefined;
    this.#deps.log.info("Found an existing conversation on the platform", { sessionId: candidate.id });
    this.#deps.store.setSessionId(accountId, candidate.id);
    this.#deps.onSessionChanged();
    return candidate.id;
  }

  /** Makes sure the conversation's session ID is known without attaching, so webhooks and polling can answer for it. */
  async ensureKnown(): Promise<string | undefined> {
    const managed = this.#deps.platform.managed;
    const accountId = this.#deps.accountId();
    if (!managed || accountId === undefined) return undefined;
    return this.#deps.store.getUser(accountId)?.sessionId ?? (await this.#discover(managed, accountId));
  }

  #onEvent(event: SessionEvent): void {
    const changes = this.timeline.apply(event);
    for (const change of changes) {
      // Settled elsewhere (cancelled with its turn, or expired): nothing is waiting for this person's answer anymore.
      if (change.type === "item" && change.item.kind === "approval" && change.item.status !== "pending") this.#release(change.item.id);
    }
    if (changes.length) this.#deps.onChanges(changes);
    if (changes.some((change) => change.type === "busy")) this.#deps.onStatus(this.status);
  }

  /** Native permission callback: consequential tools and new sandboxes wait for the person's decision in chat. */
  async #onPermissionRequest(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    if (request.kind !== "custom-tool") {
      return { kind: "reject", feedback: "This assistant only uses its own mail, calendar, scheduling, and sandbox tools." };
    }
    if (!PERSON_APPROVES.has(request.toolName)) return { kind: "approve-once" };
    if (request.toolName === "start_worker") {
      // Nothing to ask the person when a sandbox couldn't start anyway; the reason goes to the model instead.
      const blocked = this.#deps.sandboxBlocked?.();
      if (blocked) return { kind: "reject", feedback: blocked };
    }
    const id = approvalItemId(request);
    const decided = this.timeline.get(id);
    if (request.toolCallId && decided?.kind === "approval" && (decided.status === "approved" || decided.status === "denied")) {
      // The same tool call was already decided on this connection (a redelivered request); repeat that decision.
      return decided.status === "approved" ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback: decided.feedback ?? "The person declined." };
    }
    const args = (request.args ?? {}) as Record<string, unknown>;
    let current: { title: string; start: string; end: string } | undefined;
    if ((request.toolName === "update_event" || request.toolName === "delete_event") && typeof args.id === "string") {
      current = await this.#deps.currentEvent(args.id).catch(() => undefined);
    }
    // The connection may have been replaced while the event was looked up; the platform delivers the request again.
    if (generation !== this.#generation) return { kind: "no-result" };
    const latest = this.timeline.get(id);
    if (latest?.kind === "approval" && latest.status !== "pending") return { kind: "no-result" };
    const description = describeApproval(request.toolName, args, this.#deps.timeline.timeZone(), current, this.#deps.timeline.sandboxEnvironment);
    this.timeline.enrichApproval(id, description);
    return await new Promise<PermissionRequestResult>((resolve) => {
      this.#release(id);
      this.#resolvers.set(id, resolve);
      const item: TimelineItem = {
        kind: "approval",
        id,
        at: latest?.at ?? new Date().toISOString(),
        tool: request.toolName,
        title: description.title,
        preview: description.preview,
        status: "pending",
        actionable: true,
      };
      this.#deps.onChanges([this.timeline.set(item)]);
      this.#deps.onStatus(this.status);
    });
  }

  /** Lets go of a waiting permission callback without answering; the request stays pending on the platform. */
  #release(id: string): void {
    const resolve = this.#resolvers.get(id);
    if (!resolve) return;
    this.#resolvers.delete(id);
    resolve({ kind: "no-result" });
  }

  #releaseAll(): void {
    for (const id of [...this.#resolvers.keys()]) this.#release(id);
  }

  /** Applies the person's decision on an approval card. */
  decide(id: string, decision: "approve" | "deny", feedback?: string): void {
    const resolve = this.#resolvers.get(id);
    const item = this.timeline.get(id);
    if (!resolve || item?.kind !== "approval") {
      throw new UserFacingError("not_actionable", "This request is no longer waiting for a decision.");
    }
    this.#resolvers.delete(id);
    const note = feedback?.trim() || undefined;
    this.#deps.onChanges([this.timeline.set({ ...item, status: decision === "approve" ? "approved" : "denied", actionable: false, decidedAt: new Date().toISOString(), feedback: note })]);
    resolve(
      decision === "approve"
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: note ? `The person declined: ${note}` : "The person declined. Don't retry unless they ask." },
    );
  }

  async send(text: string): Promise<string> {
    await this.attach();
    const session = this.#session;
    if (!session) throw new UserFacingError("not_attached", "The conversation isn't connected.");
    try {
      // While a turn runs (for example, waiting for a sandbox), the message goes to it right away instead of queuing
      // behind it, so the assistant can answer it before the work finishes.
      return await session.send({ prompt: text, ...(this.timeline.busy ? { mode: "immediate" as const } : {}) });
    } catch (error) {
      this.#lost(`send failed: ${errorMessage(error)}`);
      throw new UserFacingError("send_failed", `Your message wasn't delivered: ${errorMessage(error)}`);
    }
  }

  async abort(): Promise<void> {
    await this.#session?.abort();
  }

  #startHeartbeat(generation: number): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      const client = this.#client;
      if (!client || generation !== this.#generation) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("heartbeat timed out")), HEARTBEAT_TIMEOUT_MS);
      });
      Promise.race([client.ping("assistant"), timeout])
        .catch((error) => {
          if (generation === this.#generation) this.#lost(`heartbeat failed: ${errorMessage(error)}`);
        })
        .finally(() => clearTimeout(timer));
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  /** The live connection died (gateway restart, network): drop it; the owner reattaches when the platform is back. */
  #lost(reason: string): void {
    if (this.#state !== "live") return;
    this.#deps.log.warn("Lost the live connection to the conversation", { reason });
    this.#teardown();
    this.#setState("reconnecting", "Reconnecting to Managed Copilot…");
    void this.#deps.platform.reconnect(reason);
  }

  /** Drops the current connection's state; returns what needs closing. */
  #drop(): { session: CopilotSession | undefined; client: CopilotClient | undefined } {
    const dropped = { session: this.#session, client: this.#client };
    this.#generation++;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    // Pending approvals stay pending on the platform and are delivered again on the next attach.
    this.#releaseAll();
    this.#session = undefined;
    this.#client = undefined;
    return dropped;
  }

  #teardown(): void {
    const { client } = this.#drop();
    if (client) void client.forceStop().catch(() => undefined);
    const changes = this.timeline.refresh();
    if (changes.length) this.#deps.onChanges(changes);
  }

  /**
   * Detaches without stopping the session: accepted work keeps running on the platform. `unless` is checked again once
   * any attach in progress has finished (for example, a tab opened again meanwhile).
   */
  async detach(reason: string, options: { unless?: () => boolean } = {}): Promise<void> {
    await this.#attaching?.catch(() => undefined);
    if (options.unless?.()) return;
    if (this.#state !== "live" && this.#state !== "error" && this.#state !== "reconnecting") return;
    const { session, client } = this.#drop();
    this.#setState("detached");
    const closing = (async () => {
      await session?.disconnect().catch(() => undefined);
      await client?.stop().catch(() => undefined);
    })();
    const tracked: Promise<void> = closing.finally(() => {
      if (this.#detaching === tracked) this.#detaching = undefined;
    });
    this.#detaching = tracked;
    await tracked;
    const changes = this.timeline.refresh();
    if (changes.length) this.#deps.onChanges(changes);
    this.#deps.log.info("Detached from the conversation; the platform keeps running scheduled work", { reason });
  }

  /** Called when the platform connection is replaced, so a later attach starts fresh. */
  reset(): void {
    // An attach in progress belongs to the old platform connection; the next attach starts over.
    this.#attaching = undefined;
    if (this.#state === "detached") return;
    this.#teardown();
    this.#setState("detached");
  }

  /** Forgets this conversation and starts a new one on the next attach. The old session is deleted on the platform. */
  async startOver(): Promise<string | undefined> {
    const accountId = this.#deps.accountId();
    const old = this.sessionId;
    await this.detach("starting a new conversation");
    if (accountId !== undefined) this.#deps.store.setSessionId(accountId, undefined);
    this.timeline.clear();
    this.#deps.onReset();
    this.#deps.onSessionChanged();
    if (old) {
      await this.#deps.platform.managed?.sessions.delete(old).catch((error) => this.#deps.log.warn("Couldn't delete the previous conversation", { sessionId: old, error: errorMessage(error) }));
    }
    return old;
  }
}
