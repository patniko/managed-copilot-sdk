/**
 * The person's one durable conversation. While someone has the app open, this server attaches to the session as a
 * live client (streaming, tools, approvals). When the last tab closes it detaches, so scheduled runs execute on the
 * platform and tool calls arrive through the webhook instead (spec sections 11 and 12).
 */
import type { CopilotClient, CopilotSession, PermissionHandler, PermissionRequestResult, SessionEvent, Tool } from "@github/copilot-sdk";
import { isManagedCopilotError, type ManagedCopilot } from "@managed-copilot/sdk";
import type { AttachState, ConversationStatus, TimelineItem } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { describeApproval } from "./describe.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import type { Store } from "./store.js";
import { approvalItemId, Timeline, type TimelineChange, type TimelineContext } from "./timeline.js";
import { APPROVAL_TOOLS } from "./tools/index.js";

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface ConversationDeps {
  readonly config: AssistantConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly platform: Platform;
  accountId(): number | undefined;
  tools(): Tool<any>[];
  systemMessage(): Promise<string>;
  /** The event as it stands today, for update/delete approval cards. */
  currentEvent(id: string): Promise<{ title: string; start: string; end: string } | undefined>;
  timeline: Omit<TimelineContext, "isActionable">;
  onChanges(changes: readonly TimelineChange[]): void;
  /** The timeline was rebuilt from history; broadcast a full snapshot. */
  onReset(): void;
  onStatus(status: ConversationStatus): void;
}

export class UserFacingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Conversation {
  readonly timeline: Timeline;
  readonly #deps: ConversationDeps;
  readonly #resolvers = new Map<string, (result: PermissionRequestResult) => void>();
  #state: AttachState = "detached";
  #error: string | undefined;
  #client: CopilotClient | undefined;
  #session: CopilotSession | undefined;
  #unsubscribe: (() => void) | undefined;
  #attaching: Promise<void> | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
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
    this.#attaching ??= this.#attach().finally(() => (this.#attaching = undefined));
    return this.#attaching;
  }

  async #attach(): Promise<void> {
    const managed = this.#deps.platform.managed;
    const accountId = this.#deps.accountId();
    if (!managed || accountId === undefined) throw new UserFacingError("platform_unavailable", "Managed Copilot isn't connected yet.");
    const generation = ++this.#generation;
    this.#setState("attaching");
    let client: CopilotClient | undefined;
    try {
      client = await managed.client(this.#deps.config.environment);
      const systemMessage = { content: await this.#deps.systemMessage() };
      const shared = {
        tools: this.#deps.tools(),
        onPermissionRequest: this.#onPermissionRequest,
        streaming: true,
        systemMessage,
        // The platform's durable schedule_task is the only scheduler; the runtime's in-process one would not survive restarts.
        manageScheduleEnabled: false,
      };
      let session: CopilotSession | undefined;
      let sessionId = this.#deps.store.getUser(accountId)?.sessionId ?? (await this.#discover(managed));
      if (sessionId) {
        try {
          session = await client.resumeSession(sessionId, { ...shared, continuePendingWork: true, suppressResumeEvent: true });
        } catch (error) {
          if (!isManagedCopilotError(error, "not_found") && !/not found|no such session|unknown session/i.test(errorMessage(error))) throw error;
          this.#deps.log.warn("Stored conversation no longer exists; starting a new one", { sessionId });
          this.#deps.store.setSessionId(accountId, undefined);
          sessionId = undefined;
        }
      }
      if (!session) {
        session = await client.createSession({ ...shared, model: this.#deps.config.model });
        this.#deps.store.setSessionId(accountId, session.sessionId);
        this.#deps.log.info("Started a new conversation", { sessionId: session.sessionId });
      }
      if (generation !== this.#generation) {
        await session.disconnect().catch(() => undefined);
        await client.stop().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#session = session;
      // Subscribe before reading history so nothing is missed; the timeline dedupes by event ID.
      const buffered: SessionEvent[] = [];
      let loading = true;
      this.#unsubscribe = session.on((event) => {
        if (loading) buffered.push(event);
        else this.#onEvent(event);
      });
      const history = await session.getEvents();
      this.timeline.replaceAll(history);
      loading = false;
      for (const event of buffered) this.timeline.apply(event);
      this.#setState("live");
      this.#deps.onReset();
      this.#startHeartbeat(generation);
      this.#deps.log.info("Attached to the conversation", { sessionId: session.sessionId, events: history.length });
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#session = undefined;
      this.#client = undefined;
      await client?.stop().catch(() => undefined);
      const message = errorMessage(error);
      this.#setState("error", message);
      this.#deps.log.error("Couldn't attach to the conversation", { error: message });
      throw error instanceof UserFacingError ? error : new UserFacingError("attach_failed", message);
    }
  }

  /** Finds this person's existing conversation on the platform when local state was lost. */
  async #discover(managed: ManagedCopilot): Promise<string | undefined> {
    try {
      const sessions = await managed.sessions.list({ environment: this.#deps.config.environment });
      const candidate = sessions
        .filter((s) => !s.scheduleId && !["deleting", "deleted", "failed"].includes(s.state))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      if (candidate) {
        this.#deps.log.info("Found an existing conversation on the platform", { sessionId: candidate.id });
        const accountId = this.#deps.accountId();
        if (accountId !== undefined) this.#deps.store.setSessionId(accountId, candidate.id);
      }
      return candidate?.id;
    } catch (error) {
      this.#deps.log.warn("Couldn't list sessions to find the conversation", { error: errorMessage(error) });
      return undefined;
    }
  }

  #onEvent(event: SessionEvent): void {
    const changes = this.timeline.apply(event);
    if (changes.length) this.#deps.onChanges(changes);
    if (changes.some((change) => change.type === "busy")) this.#deps.onStatus(this.status);
  }

  /** Native permission callback: consequential tools wait for the person's decision in chat. */
  readonly #onPermissionRequest: PermissionHandler = async (request) => {
    if (request.kind !== "custom-tool") {
      return { kind: "reject", feedback: "This assistant only uses its own mail, calendar, and scheduling tools." };
    }
    if (!APPROVAL_TOOLS.has(request.toolName)) return { kind: "approve-once" };
    const id = approvalItemId(request);
    const existing = this.timeline.get(id);
    if (existing?.kind === "approval" && existing.status !== "pending") {
      // Already decided (for example a replay after reconnecting); repeat the recorded decision.
      return existing.status === "approved" ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback: existing.feedback ?? "The person declined." };
    }
    const args = (request.args ?? {}) as Record<string, unknown>;
    let current: { title: string; start: string; end: string } | undefined;
    if ((request.toolName === "update_event" || request.toolName === "delete_event") && typeof args.id === "string") {
      current = await this.#deps.currentEvent(args.id).catch(() => undefined);
    }
    const description = describeApproval(request.toolName, args, this.#deps.timeline.timeZone(), current);
    return await new Promise<PermissionRequestResult>((resolve) => {
      this.#resolvers.set(id, resolve);
      const item: TimelineItem = {
        kind: "approval",
        id,
        at: existing?.at ?? new Date().toISOString(),
        tool: request.toolName,
        title: description.title,
        preview: description.preview,
        status: "pending",
        actionable: true,
      };
      this.#deps.onChanges([this.timeline.set(item)]);
      this.#deps.onStatus(this.status);
    });
  };

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
      return await session.send({ prompt: text });
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

  #teardown(): void {
    this.#generation++;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // Pending approvals stay pending on the platform and are delivered again on the next attach.
    this.#resolvers.clear();
    const client = this.#client;
    this.#client = undefined;
    this.#session = undefined;
    if (client) void client.forceStop().catch(() => undefined);
    const changes = this.timeline.refresh();
    if (changes.length) this.#deps.onChanges(changes);
  }

  /** Detaches without stopping the session: accepted work keeps running on the platform. */
  async detach(reason: string): Promise<void> {
    await this.#attaching?.catch(() => undefined);
    if (this.#state !== "live" && this.#state !== "error" && this.#state !== "reconnecting") return;
    const session = this.#session;
    const client = this.#client;
    this.#generation++;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#resolvers.clear();
    this.#session = undefined;
    this.#client = undefined;
    await session?.disconnect().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    const changes = this.timeline.refresh();
    if (changes.length) this.#deps.onChanges(changes);
    this.#setState("detached");
    this.#deps.log.info("Detached from the conversation; the platform keeps running scheduled work", { reason });
  }

  /** Called when the platform connection is replaced, so a later attach starts fresh. */
  reset(): void {
    if (this.#state === "detached") return;
    this.#teardown();
    this.#setState("detached");
  }
}
