// One Dispatch conversation: a coordinator session in the orchestrator environment, held through a stock
// CopilotSession. The coordinator decides, message by message, whether to start new workers (each in its own sandbox)
// or send work to the ones it has; this class shows those decisions and the workers they produce, and lets the person
// approve each new sandbox.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { PlatformEvent, WorkerInfo } from "@managed-copilot/sdk";
import type {
  Approval,
  CommandRecord,
  ConversationSettings,
  ConversationStatus,
  ConversationSummary,
  ConversationView,
  ExecutionStyle,
  FileView,
  WorkerState,
  WorkerView,
} from "../shared/types.js";
import { attachCommand } from "./attach.js";
import type { DispatchConfig } from "./config.js";
import { DispatchError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { CoordinatorSession, DispatchPlatform } from "./platform.js";
import { ASKING_TOOLS, mergeHistory, Transcript, type CoordinatorEvent } from "./projection.js";
import { digest, type Store } from "./store.js";

const COMMON = [
  "- Answer briefly when the work is done: a few short paragraphs or a table, saying where each result came from.",
  "- The person may decline something you ask to do, sometimes saying why. Follow their reason; without one, don't try it again unless they ask, and carry on another way or say what you'd need.",
];

const DELEGATE = [
  "You are Dispatch's coordinator. The person watches your workers live: each worker appears as a card with its sandbox, files, and state.",
  "- Give each worker a short, descriptive kebab-case name, such as `py-bench`, `node-bench`, or `report-writer`.",
  "- Always pass `environment` to start_worker: the environment whose tools and network the task needs (JavaScript needs the Node.js one, web lookups the one with web access). Don't rely on the default.",
  "- For a follow-up, prefer an existing worker whose sandbox already has the files and tools it needs. Start a new worker when the work needs another environment, should run in parallel, or would disturb a worker's state.",
  "- The person may decline a new sandbox, sometimes saying why. Follow their reason; without one, don't start it again unless they ask, and carry on with the workers you have or say what you'd need.",
  "- Answer briefly when the work is done: a few short paragraphs or a table, saying which worker produced what.",
];

const DIRECT = [
  "You are Dispatch's coordinator, working directly. The person watches live: every command you and your sub-agents run, and every file you create or edit, is listed under their message.",
  "- Do the work yourself with your shell and file tools. For independent parts that can run at the same time, start sub-agents with the task tool, in parallel, and give each a short, descriptive name.",
  "- Your sandbox keeps its files between messages: for a follow-up, build on what is already there.",
  "- Save deliverables (reports, charts, data) under /workspace/outputs so the person can open them.",
  ...COMMON,
];

const MIXED = [
  "You are Dispatch's coordinator. You can work directly in your own sandbox (with your shell and file tools, and sub-agents started with the task tool), or create workers in other environments. The person watches both live: your commands and files are listed under their message, and each worker appears as a card with its sandbox.",
  "- Give workers and sub-agents short, descriptive names. Always pass `environment` to start_worker.",
  "- Save deliverables under /workspace/outputs.",
  ...COMMON,
];

/** Added to the platform's coordinator instructions: how Dispatch's UI shows the coordinator's work, by execution style. */
export function systemMessage(style: ExecutionStyle): string {
  return (style === "direct" ? DIRECT : style === "mixed" ? MIXED : DELEGATE).join("\n");
}

/** The delegate style's addition (the original Dispatch coordinator). */
export const SYSTEM_MESSAGE = systemMessage("delegate");

/** What the person sees when they decline a sandbox, and what the coordinator is told. */
const DECLINED = "Declined in Dispatch. Don't start this worker again unless the person asks; continue with the workers you have, or say what you need.";
/** The same for a command or file change in the coordinator's own sandbox. */
const DECLINED_COMMAND = "Declined in Dispatch. Don't run this again unless the person asks; continue another way, or say what you need.";

const ACTIVE: ReadonlySet<WorkerState> = new Set(["starting", "working"]);
/** Workspace paths not worth showing as a worker's files. */
const HIDDEN = /(^|\/)(\.[^/]*|node_modules|__pycache__|\.venv|venv|site-packages)(\/|$)/;
const FILES_IN_VIEW = 150;
const FILES_LISTED = 1_000;

export interface ConversationHost {
  readonly platform: DispatchPlatform;
  readonly config: DispatchConfig;
  readonly store: Store;
  /** Something a person would see changed; the host coalesces publishing. */
  changed(conversation: Conversation): void;
  /** The session no longer exists on the platform. */
  gone(conversation: Conversation): void;
  /** Whether anyone has Dispatch open (live file listings are only fetched then). */
  watching(): boolean;
}

interface PendingApproval {
  readonly approval: Approval;
  readonly resolve: (result: PermissionRequestResult) => void;
}

type AttachState = "detached" | "attaching" | "live" | "failed";

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** A worker's workspace as Dispatch shows it: files only, without dependency and hidden folders. */
export function visibleFiles(entries: readonly { path: string; type: string; size: number; modifiedAt: string }[]): FileView[] {
  return entries
    .filter((entry) => entry.type === "file" && !HIDDEN.test(entry.path))
    .slice(0, FILES_LISTED)
    .map((entry) => ({ path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export class Conversation {
  readonly #host: ConversationHost;
  #id: string;
  #environment: string | undefined;
  #state: AttachState = "detached";
  #problem: string | undefined;
  #session: CoordinatorSession | undefined;
  #transcript: Transcript;
  #generation = 0;
  /** The attach in progress, for the generation it was started in (a detach invalidates it). */
  #attaching: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  #closed = false;
  readonly #approvals = new Map<string, PendingApproval>();
  /** Digests of messages being sent: their `user.message` can arrive before `send` returns its ID. */
  readonly #inflight = new Map<string, number>();
  #workers: WorkerInfo[] = [];
  #workersLoaded = false;
  readonly #files = new Map<string, { files: FileView[]; at: string }>();
  #refreshing: Promise<void> | undefined;
  #refreshAgain = false;
  #refreshTimer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #filesAt = 0;

  constructor(host: ConversationHost, id = "", environment?: string) {
    this.#host = host;
    this.#id = id;
    this.#environment = environment;
    this.#transcript = this.#newTranscript();
  }

  get id(): string {
    return this.#id;
  }

  /** The orchestrator environment its coordinator session lives in. */
  get environment(): string {
    return this.#environment ?? this.#host.store.get(this.#id)?.environment ?? this.#host.config.environment;
  }

  /** Its execution style: the style of the environment it was created in. */
  get style(): ExecutionStyle {
    const environment = this.environment;
    const known = this.#host.platform.styles.find((candidate) => candidate.environment === environment)?.style;
    if (known) return known;
    const entry = Object.entries(this.#host.config.environments).find(([, name]) => name === environment);
    return (entry?.[0] as ExecutionStyle | undefined) ?? "delegate";
  }

  get settings(): ConversationSettings {
    return this.#host.store.get(this.#id)?.settings ?? { approvals: this.#host.config.approvals };
  }

  get attached(): boolean {
    return this.#state === "live";
  }

  get updatedAt(): string {
    return this.#transcript.updatedAt ?? this.#host.store.get(this.#id)?.updatedAt ?? "";
  }

  #newTranscript(): Transcript {
    const isOwn = (messageId: string | undefined, content: string): boolean => {
      const key = digest(content);
      if (this.#inflight.has(key)) return true;
      const own = this.#host.store.get(this.#id)?.own ?? [];
      // Message IDs decide when both are known; the text only stands in when one is missing.
      return own.some((entry) => (messageId !== undefined && entry.id !== undefined ? entry.id === messageId : entry.digest === key));
    };
    return new Transcript(isOwn, this.#host.platform.blueprints[0]?.name);
  }

  #handlers(generation: number, onEvent: (event: SessionEvent) => void) {
    return {
      streaming: true,
      onEvent,
      onPermissionRequest: (request: PermissionRequest) => this.#onPermission(request, generation),
      systemMessage: { content: systemMessage(this.style) },
    };
  }

  /**
   * Starts a new conversation: creates the coordinator session, then sends the first message. `registered` runs once
   * the session exists, before anything is sent, so worker events can be routed to this conversation.
   */
  async start(prompt: string, settings: ConversationSettings, registered: (conversation: Conversation) => void): Promise<void> {
    const generation = ++this.#generation;
    this.#state = "attaching";
    const environment = this.environment;
    const session = await this.#host.platform.createSession(
      {
        ...this.#handlers(generation, (event) => {
          if (generation === this.#generation) this.#onEvent(event);
        }),
        model: this.#host.config.model,
      },
      environment,
    );
    this.#id = session.sessionId;
    this.#session = session;
    this.#state = "live";
    this.#workersLoaded = true;
    this.#host.store.ensure(this.#id, { settings, title: titleFrom(prompt), environment });
    registered(this);
    log.info("Started a conversation", { sessionId: this.#id, environment, approvals: settings.approvals });
    try {
      await this.send(prompt);
    } catch (error) {
      // An empty conversation isn't worth keeping; the person tries again from the home page. If the deletion fails
      // too, the next discovery finds the session and lists it.
      await this.delete().catch(() => undefined);
      this.dispose();
      throw error;
    }
  }

  /** Resumes the coordinator session on the current client, rebuilding the transcript from its history. */
  attach(): Promise<void> {
    if (this.#state === "live" || this.#closed) return Promise.resolve();
    const pending = this.#attaching;
    // An attempt a detach invalidated finishes without attaching: start one on the current client instead.
    if (pending && pending.generation === this.#generation) return pending.promise;
    const generation = ++this.#generation;
    const promise: Promise<void> = this.#attach(generation).finally(() => {
      if (this.#attaching?.promise === promise) this.#attaching = undefined;
    });
    this.#attaching = { generation, promise };
    return promise;
  }

  async #attach(generation: number): Promise<void> {
    this.#releaseApprovals();
    this.#state = "attaching";
    const transcript = this.#newTranscript();
    const buffered: SessionEvent[] = [];
    let loading = true;
    const onEvent = (event: SessionEvent) => {
      if (generation !== this.#generation) return;
      if (loading) buffered.push(event);
      else this.#onEvent(event);
    };
    let session: CoordinatorSession | undefined;
    try {
      session = await this.#host.platform.resumeSession(this.#id, { ...this.#handlers(generation, onEvent), continuePendingWork: true, suppressResumeEvent: true }, this.environment);
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      const [history, info] = await Promise.all([session.getEvents(), this.#host.platform.sessionInfo(this.#id).catch(() => undefined)]);
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      // History holds persisted events only; events delivered while it loaded go in at the time they happened.
      for (const event of mergeHistory(history, buffered)) transcript.apply(event as unknown as CoordinatorEvent);
      loading = false;
      // `session.idle` is never persisted: a turn the platform reports finished has ended, unless a new one started.
      if (transcript.busy && info?.lastTurn?.completedAt && !buffered.some((event) => event.type === "user.message")) transcript.settle(info.lastTurn.completedAt);
      this.#transcript = transcript;
      this.#session = session;
      this.#state = "live";
      this.#problem = undefined;
      // Prompts delivered again while the history loaded may have been answered elsewhere meanwhile.
      this.#reconcileApprovals();
      log.info("Attached to a conversation", { sessionId: this.#id, events: history.length });
    } catch (error) {
      await session?.disconnect().catch(() => undefined);
      if (generation !== this.#generation) return;
      if (isMissingSession(error)) {
        log.info("A conversation was deleted elsewhere", { sessionId: this.#id });
        this.dispose();
        this.#host.gone(this);
        return;
      }
      this.#state = "failed";
      this.#problem = `Couldn't open this conversation: ${errorText(error)}`;
      log.warn("Couldn't attach to a conversation", { sessionId: this.#id, error: errorText(error) });
      this.#changed();
      return;
    }
    this.#changed();
    await this.refreshWorkers();
  }

  /** The client this conversation's session lived on is gone (the platform reconnected): attach again when needed. */
  detach(): void {
    ++this.#generation;
    this.#releaseApprovals();
    this.#session = undefined;
    // A new connection is a new chance: an earlier failure to open it no longer stands.
    this.#state = "detached";
    this.#problem = undefined;
    this.#stopPolling();
  }

  /** Stops everything without touching the platform. */
  dispose(): void {
    this.#closed = true;
    this.detach();
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
  }

  /** Lets go of the session (Dispatch is shutting down); the conversation and its workers keep running. */
  async close(): Promise<void> {
    const session = this.#session;
    this.dispose();
    await session?.disconnect().catch(() => undefined);
  }

  /** Deletes the coordinator session; the platform deletes its workers and their sandboxes with it. */
  async delete(): Promise<void> {
    const session = this.#session;
    this.detach();
    await session?.disconnect().catch(() => undefined);
    try {
      await this.#host.platform.deleteSession(this.#id);
    } catch (error) {
      if (!isMissingSession(error)) {
        // The conversation still exists, detached: opening it or sending a message resumes it.
        this.#changed();
        throw new DispatchError("delete_failed", `Couldn't delete the conversation: ${errorText(error)}`, 502);
      }
    }
    this.dispose();
    log.info("Deleted a conversation", { sessionId: this.#id });
  }

  /** Sends a message. While the coordinator is working, it goes in right away (the coordinator answers between waits). */
  async send(prompt: string): Promise<string | undefined> {
    const text = prompt.trim();
    if (!text) throw new DispatchError("invalid_request", "Write a message first.");
    await this.attach();
    const session = this.#session;
    if (!session || this.#state !== "live") throw new DispatchError("unavailable", this.#problem ?? "This conversation isn't connected right now. Try again in a moment.", 503);
    const busy = this.#transcript.busy;
    const key = digest(text);
    this.#inflight.set(key, (this.#inflight.get(key) ?? 0) + 1);
    try {
      const messageId = await session.send({ prompt: text, ...(busy ? { mode: "immediate" as const } : {}) });
      this.#host.store.addOwn(this.#id, { ...(messageId ? { id: messageId } : {}), digest: key });
      return messageId || undefined;
    } catch (error) {
      throw new DispatchError("send_failed", `Your message wasn't delivered: ${errorText(error)}`, 502);
    } finally {
      const left = (this.#inflight.get(key) ?? 1) - 1;
      if (left > 0) this.#inflight.set(key, left);
      else this.#inflight.delete(key);
    }
  }

  /**
   * Answers a request: a sandbox, or a command or file change. A reason for declining goes to the coordinator, so it can
   * try another way. `rest` (commands) also approves every later command and file change for the same message.
   */
  answer(approvalId: string, approve: boolean, reason?: string, rest = false): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) throw new DispatchError("not_actionable", "This request was already answered.", 409);
    this.#approvals.delete(approvalId);
    const command = pending.approval.kind === "command";
    const why = reason?.replace(/\s+/g, " ").trim();
    const feedback = why ? `The person declined this ${command ? (pending.approval.tool === "bash" || pending.approval.tool === "write_bash" ? "command" : "file change") : "sandbox"}: ${why}` : command ? DECLINED_COMMAND : DECLINED;
    this.#transcript.markDecision(pending.approval.decisionId, approve ? "running" : "denied", approve ? undefined : feedback);
    pending.resolve(approve ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback });
    log.info(approve ? "Approved a request" : "Declined a request", {
      sessionId: this.#id,
      kind: pending.approval.kind,
      ...(command ? { tool: pending.approval.tool } : { worker: pending.approval.worker, environment: pending.approval.environment }),
      reason: why ? "given" : undefined,
    });
    const index = this.#indexOf(pending.approval);
    if (approve && rest && command && index !== undefined) {
      this.#host.store.update(this.#id, (stored) => {
        stored.approvedRest = [...new Set([...(stored.approvedRest ?? []), index])].slice(-50);
      });
      for (const [id, other] of [...this.#approvals]) if (other.approval.kind === "command" && this.#indexOf(other.approval) === index) this.answer(id, true);
    }
    this.#changed();
  }

  /** The user message a request serves, with the transcript as it is now. */
  #indexOf(approval: Approval): number | undefined {
    return this.#transcript.messageIndexOf(approval.decisionId) ?? approval.messageIndex;
  }

  setSettings(settings: ConversationSettings): void {
    this.#host.store.update(this.#id, (stored) => {
      stored.settings = { ...settings };
    });
    if (settings.approvals === "auto") for (const id of [...this.#approvals.keys()]) this.answer(id, true);
    this.#changed();
  }

  /**
   * The coordinator wants to start a worker, or (direct, mixed) it or a sub-agent wants to run a command or change a
   * file: ask the person, unless this conversation lets it go ahead freely.
   */
  async #onPermission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    // Only `start_worker` and the hands tools that run or change something ask (spec section 17); the coordinator's
    // other tools are its own platform tools.
    const sandbox = request.kind === "custom-tool" && request.toolName === "start_worker";
    const command = request.kind === "custom-tool" && typeof request.toolName === "string" && ASKING_TOOLS.has(request.toolName);
    if (!sandbox && !command) return { kind: "approve-once" };
    if (generation !== this.#generation) return { kind: "no-result" };
    // Already answered elsewhere (for example in Copilot CLI): nothing to ask.
    if (this.#transcript.isSettled(request.toolCallId)) return { kind: "no-result" };
    if (this.settings.approvals === "auto") return { kind: "approve-once" };
    const args = (request.args ?? {}) as Record<string, unknown>;
    const id = request.toolCallId ?? `request-${Date.now().toString(36)}`;
    const index = this.#transcript.messageIndexOf(request.toolCallId) ?? this.#transcript.currentIndex;
    if (command && index !== undefined && this.#host.store.get(this.#id)?.approvedRest?.includes(index)) return { kind: "approve-once" };
    // Redelivered (for example after a reconnection): the newest callback is the one that answers.
    this.#approvals.get(id)?.resolve({ kind: "no-result" });
    return await new Promise<PermissionRequestResult>((resolve) => {
      const common = {
        id,
        ...(request.toolCallId ? { decisionId: request.toolCallId } : {}),
        requestedAt: new Date().toISOString(),
        ...(index !== undefined ? { messageIndex: index } : {}),
      };
      let approval: Approval;
      if (command) {
        const tool = String(request.toolName);
        const known = this.#transcript.command(request.toolCallId);
        const text = tool === "write_bash" ? (typeof args["input"] === "string" ? args["input"] : undefined) : str(args["command"]);
        approval = {
          ...common,
          kind: "command",
          tool,
          ...(text !== undefined ? { command: text } : {}),
          ...(str(args["path"]) ? { path: str(args["path"]) } : {}),
          ...(known?.agentId ? { agentId: known.agentId } : {}),
        };
      } else {
        const environment = str(args["environment"]) ?? this.#host.platform.blueprints[0]?.name ?? "";
        approval = {
          ...common,
          kind: "sandbox",
          worker: str(args["name"]) ?? "worker",
          environment,
          task: str(args["task"]) ?? "",
          ...(str(args["agent"]) ? { agent: str(args["agent"]) } : {}),
          ...(str(args["model"]) ? { model: str(args["model"]) } : {}),
        };
      }
      this.#approvals.set(id, { approval, resolve });
      this.#transcript.markDecision(request.toolCallId, "asking");
      this.#changed();
    });
  }

  /** Lets go of waiting permission callbacks without answering; the platform keeps the prompts and delivers them again. */
  #releaseApprovals(): void {
    for (const [id, pending] of [...this.#approvals]) {
      this.#approvals.delete(id);
      pending.resolve({ kind: "no-result" });
    }
  }

  /** Drops requests answered or withdrawn elsewhere (Copilot CLI, a cancelled turn). Returns whether any were. */
  #reconcileApprovals(): boolean {
    let changed = false;
    for (const [id, pending] of [...this.#approvals]) {
      if (!this.#transcript.isSettled(pending.approval.decisionId)) continue;
      this.#approvals.delete(id);
      pending.resolve({ kind: "no-result" });
      changed = true;
    }
    return changed;
  }

  #onEvent(event: SessionEvent): void {
    let changed = this.#transcript.apply(event as unknown as CoordinatorEvent);
    if (event.type === "permission.completed" && this.#reconcileApprovals()) changed = true;
    // The turn ended: no request of it is waiting for an answer anymore.
    if ((event.type === "session.idle" || event.type === "abort") && this.#approvals.size > 0) {
      this.#releaseApprovals();
      changed = true;
    }
    if (changed && (event.type === "tool.execution_start" || event.type === "tool.execution_complete")) this.#scheduleRefresh(200);
    if (event.type === "session.idle") {
      this.#scheduleRefresh(100);
      // A coordinator's own sandboxes publish their outputs at the end of each of its turns.
      for (const worker of this.#workers) {
        if (worker.role !== "hands" || worker.state === "stopped") continue;
        void this.#loadOutputs(worker.id);
        void this.#loadFiles(worker.id);
      }
    }
    if (changed) this.#changed();
    this.#updatePolling();
  }

  /** A `worker.*` platform event for this conversation's coordinator. */
  workerEvent(event: PlatformEvent): void {
    const data = event.data as { workerId?: unknown; state?: unknown };
    if (typeof data.workerId === "string" && typeof data.state === "string") {
      const worker = this.#host.store.worker(this.#id, data.workerId);
      if (!worker?.timeline.length && data.state !== "starting") this.#host.store.recordWorkerState(this.#id, data.workerId, "starting", event.createdAt);
      this.#host.store.recordWorkerState(this.#id, data.workerId, data.state as WorkerState, event.createdAt);
    }
    this.#scheduleRefresh(150);
  }

  #scheduleRefresh(delay: number): void {
    if (this.#refreshTimer || this.#closed) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refreshWorkers();
    }, delay);
    this.#refreshTimer.unref?.();
  }

  /** Reads the coordinator's workers from the platform (one read at a time; a request during a read runs once more). */
  refreshWorkers(): Promise<void> {
    if (this.#closed || !this.#id) return Promise.resolve();
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#refreshAgain = false;
        await this.#loadWorkers();
      } while (this.#refreshAgain && !this.#closed);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #loadWorkers(): Promise<void> {
    let workers: WorkerInfo[];
    try {
      workers = await this.#host.platform.workers(this.#id);
    } catch (error) {
      if (isMissingSession(error) && !this.#closed) {
        this.dispose();
        this.#host.gone(this);
      } else log.debug("Couldn't list workers", { sessionId: this.#id, error: errorText(error) });
      return;
    }
    if (this.#closed) return;
    const store = this.#host.store;
    const before = new Map(this.#workers.map((worker) => [worker.id, worker]));
    this.#workers = [...workers].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.#workersLoaded = true;
    let changed = before.size !== workers.length;
    for (const worker of workers) {
      const previous = before.get(worker.id);
      if (!previous || previous.updatedAt !== worker.updatedAt || previous.state !== worker.state) changed = true;
      if (!store.worker(this.#id, worker.id)?.timeline.length) store.recordWorkerState(this.#id, worker.id, "starting", worker.createdAt);
      store.recordWorkerState(this.#id, worker.id, worker.state, worker.updatedAt);
      const stateChanged = previous?.state !== worker.state;
      if (worker.state === "stopped") {
        if (stateChanged) store.updateWorker(this.#id, worker.id, (stored) => stored.sandbox && (stored.sandbox.state = "deleted"));
        continue;
      }
      if (stateChanged || !store.worker(this.#id, worker.id)?.sandbox) void this.#loadSandbox(worker.id);
      if (stateChanged && (worker.state === "idle" || worker.state === "failed")) {
        void this.#loadOutputs(worker.id);
        void this.#loadFiles(worker.id);
      }
    }
    if (changed) this.#changed();
    this.#updatePolling();
  }

  async #loadSandbox(workerId: string): Promise<void> {
    try {
      const info = await this.#host.platform.sessionInfo(workerId);
      const sandbox = info.sandbox;
      if (!sandbox || this.#closed) return;
      const current = this.#host.store.worker(this.#id, workerId)?.sandbox;
      if (current?.id === sandbox.id && current.state === sandbox.state && current.size === sandbox.size) return;
      this.#host.store.updateWorker(this.#id, workerId, (stored) => {
        stored.sandbox = { id: sandbox.id, state: sandbox.state, size: sandbox.size };
      });
      this.#changed();
    } catch (error) {
      log.debug("Couldn't read a worker's sandbox", { workerId, error: errorText(error) });
    }
  }

  async #loadOutputs(workerId: string): Promise<void> {
    try {
      const artifacts = await this.#host.platform.artifacts(workerId);
      const outputs = artifacts.filter((artifact) => artifact.state === "published").map((artifact) => artifact.path);
      outputs.sort();
      if (this.#closed) return;
      this.#host.store.updateWorker(this.#id, workerId, (stored) => {
        stored.outputs = outputs;
      });
      this.#changed();
    } catch (error) {
      log.debug("Couldn't list a worker's outputs", { workerId, error: errorText(error) });
    }
  }

  async #loadFiles(workerId: string): Promise<FileView[] | undefined> {
    try {
      const files = visibleFiles(await this.#host.platform.listFiles(workerId));
      if (this.#closed) return files;
      const previous = this.#files.get(workerId)?.files;
      this.#files.set(workerId, { files, at: new Date().toISOString() });
      if (!previous || JSON.stringify(previous) !== JSON.stringify(files)) this.#changed();
      return files;
    } catch (error) {
      log.debug("Couldn't list a worker's files", { workerId, error: errorText(error) });
      return undefined;
    }
  }

  /** While the coordinator or a worker is busy, keep the workers (and, when someone is watching, their files) current. */
  #updatePolling(): void {
    const active = !this.#closed && this.#state === "live" && (this.#transcript.busy || this.#approvals.size > 0 || this.#workers.some((worker) => ACTIVE.has(worker.state)));
    if (active && !this.#poll) {
      this.#poll = setInterval(() => void this.#tick(), 3_000);
      this.#poll.unref?.();
    } else if (!active) this.#stopPolling();
  }

  #stopPolling(): void {
    if (!this.#poll) return;
    clearInterval(this.#poll);
    this.#poll = undefined;
  }

  async #tick(): Promise<void> {
    await this.refreshWorkers();
    if (!this.#host.watching() || Date.now() - this.#filesAt < this.#host.config.filesIntervalMs) return;
    this.#filesAt = Date.now();
    await Promise.all(this.#workers.filter((worker) => ACTIVE.has(worker.state)).map((worker) => this.#loadFiles(worker.id)));
  }

  /** A worker's workspace, freshly listed. Only this conversation's workers. */
  async files(workerId: string): Promise<{ files: FileView[]; at: string }> {
    const worker = this.#worker(workerId);
    if (worker.state === "stopped") return this.#files.get(workerId) ?? { files: [], at: worker.updatedAt };
    const files = await this.#loadFiles(workerId);
    if (!files) throw new DispatchError("files_unavailable", "Couldn't list this worker's files right now.", 502);
    return this.#files.get(workerId) ?? { files, at: new Date().toISOString() };
  }

  /** A text file from a worker's workspace, for preview. */
  async readFile(workerId: string, path: string): Promise<{ path: string; content: string; truncated: boolean; binary: boolean }> {
    const worker = this.#worker(workerId);
    if (worker.state === "stopped") throw new DispatchError("sandbox_deleted", "This worker was stopped; its sandbox and files are gone.", 410);
    const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.split("/").some((part) => part === ".." || part === "")) throw new DispatchError("invalid_request", "That isn't a file in the worker's workspace.");
    let content: string;
    try {
      content = await this.#host.platform.readFile(workerId, clean);
    } catch (error) {
      throw new DispatchError("file_unavailable", `Couldn't read ${clean}: ${errorText(error)}`, 502);
    }
    if (content.includes("\u0000")) return { path: clean, content: "", truncated: false, binary: true };
    const limit = 200_000;
    return { path: clean, content: content.slice(0, limit), truncated: content.length > limit, binary: false };
  }

  #worker(workerId: string): WorkerInfo {
    const worker = this.#workers.find((candidate) => candidate.id === workerId);
    if (!worker) throw new DispatchError("not_found", "This conversation has no such worker.", 404);
    return worker;
  }

  /** Every command run in one of the coordinator's own sandboxes, as the platform recorded them (`managed.exec.list`). */
  async commands(workerId: string): Promise<CommandRecord[]> {
    const worker = this.#worker(workerId);
    if (worker.role !== "hands") throw new DispatchError("invalid_request", "Only the coordinator's own sandboxes keep a list of commands; workers run theirs as agents.");
    if (worker.state === "stopped") throw new DispatchError("sandbox_deleted", "This sandbox was deleted, with its list of commands.", 410);
    let execs;
    try {
      execs = await this.#host.platform.execs(workerId);
    } catch (error) {
      throw new DispatchError("commands_unavailable", `Couldn't list the commands: ${errorText(error)}`, 502);
    }
    return execs.map((exec) => ({
      id: exec.id,
      command: exec.command,
      state: exec.state,
      ...(exec.exitCode !== undefined ? { exitCode: exec.exitCode } : {}),
      startedAt: exec.startedAt,
      ...(exec.finishedAt ? { finishedAt: exec.finishedAt } : {}),
      background: exec.background,
      tool: exec.caller?.kind === "platform" ? (exec.caller.name ?? "bash") : "api",
      ...(exec.caller?.agentId ? { agentId: exec.caller.agentId } : {}),
    }));
  }

  /** Whether `sessionId` is this conversation's coordinator or one of its workers. */
  owns(sessionId: string): boolean {
    return sessionId === this.#id || this.#workers.some((worker) => worker.id === sessionId);
  }

  #status(): ConversationStatus {
    if (this.#state === "failed" || this.#host.platform.status.state !== "connected") return "unavailable";
    if (this.#approvals.size > 0) return "asking";
    return this.#transcript.busy ? "working" : "idle";
  }

  summary(): ConversationSummary {
    const stored = this.#host.store.get(this.#id);
    const createdAt = stored?.createdAt ?? new Date().toISOString();
    const live = this.#state === "live";
    // The runtime titles a session with its first message; keep it to a line.
    const title = this.#transcript.title ?? stored?.title;
    return {
      id: this.#id,
      style: this.style,
      environment: this.environment,
      title: title ? titleFrom(title) : "New conversation",
      createdAt,
      updatedAt: this.#transcript.updatedAt ?? stored?.updatedAt ?? createdAt,
      status: this.#status(),
      messageCount: live ? this.#transcript.userMessages : (stored?.messageCount ?? 0),
      sandboxCount: this.#workersLoaded ? this.#workers.length : (stored?.sandboxCount ?? 0),
      liveSandboxes: this.#workersLoaded ? this.#workers.filter((worker) => worker.state !== "stopped").length : (stored?.liveSandboxes ?? 0),
    };
  }

  view(): ConversationView {
    const transcript = this.#transcript;
    const waiting = transcript.waiting;
    // Approvals redelivered while resuming were registered before the rebuilt transcript was in place: link them now.
    const approvals = [...this.#approvals.values()].map(({ approval }): Approval => {
      const decision = approval.decisionId ? (approval.kind === "command" ? transcript.command(approval.decisionId) : transcript.decision(approval.decisionId)) : undefined;
      const index = transcript.messageIndexOf(approval.decisionId) ?? approval.messageIndex ?? transcript.currentIndex;
      const agentId = approval.agentId ?? (approval.kind === "command" ? transcript.command(approval.decisionId)?.agentId : undefined);
      return { ...approval, ...(decision ? { requestedAt: decision.at } : {}), ...(index !== undefined ? { messageIndex: index } : {}), ...(agentId ? { agentId } : {}) };
    });
    const hands = this.#workers.filter((worker) => worker.role === "hands");
    const workers = this.#workers.filter((worker) => worker.role !== "hands");
    const resolved = transcript.resolveWorkers(workers);
    const own = this.#host.platform.styles.find((style) => style.environment === this.environment)?.subagents === "own" || hands.some((worker) => worker.agentId !== undefined);
    return {
      ...this.summary(),
      messages: transcript.messages(resolved),
      workers: this.#workers.map((worker) =>
        this.#workerView(worker, worker.role === "hands" ? transcript.handsAttribution(worker.agentId, own) : transcript.attribution(worker.id, resolved)),
      ),
      approvals,
      settings: this.settings,
      agents: transcript.agentNames(),
      approvedRest: [...(this.#host.store.get(this.#id)?.approvedRest ?? [])],
      busy: transcript.busy,
      ...(waiting ? { waiting: { workers: [...waiting.workers], since: waiting.since } } : {}),
      ...(this.#problem ? { problem: this.#problem } : {}),
      attachCommand: attachCommand(this.#id, this.#host.config.attachUrl),
    };
  }

  #workerView(worker: WorkerInfo, attribution: { createdBy?: number; sentWorkBy: number[] }): WorkerView {
    const stored = this.#host.store.worker(this.#id, worker.id);
    const files = this.#files.get(worker.id);
    return {
      id: worker.id,
      role: worker.role === "hands" ? "hands" : "worker",
      ...(worker.agentId ? { agentId: worker.agentId } : {}),
      name: worker.name,
      environment: worker.environment,
      state: worker.state,
      task: worker.task,
      ...(worker.result ? { result: worker.result } : {}),
      ...(worker.error ? { error: worker.error } : {}),
      tasks: worker.messages,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      ...(worker.agent ? { agent: worker.agent } : {}),
      ...(worker.model ? { model: worker.model } : {}),
      ...(stored?.sandbox ? { sandbox: { ...stored.sandbox } } : {}),
      ...attribution,
      outputs: stored?.outputs ?? [],
      ...(files ? { files: files.files.slice(0, FILES_IN_VIEW), filesAt: files.at } : {}),
      timeline: stored?.timeline.map((entry) => ({ ...entry })) ?? [],
    };
  }

  /** Keeps the list's last known counts and title, for when the platform is unreachable. */
  remember(): void {
    const summary = this.summary();
    const stored = this.#host.store.get(this.#id);
    if (!stored || this.#state !== "live") return;
    if (
      stored.title === summary.title &&
      stored.updatedAt === summary.updatedAt &&
      stored.messageCount === summary.messageCount &&
      stored.sandboxCount === summary.sandboxCount &&
      stored.liveSandboxes === summary.liveSandboxes
    )
      return;
    this.#host.store.update(this.#id, (record) => {
      record.title = summary.title;
      record.updatedAt = summary.updatedAt;
      record.messageCount = summary.messageCount;
      record.sandboxCount = summary.sandboxCount;
      record.liveSandboxes = summary.liveSandboxes;
    });
  }

  #changed(): void {
    if (this.#id && !this.#closed) this.#host.changed(this);
  }
}

/** A first title from the first message, until the runtime names the conversation. */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? "";
  const words = line.replace(/\s+/g, " ");
  return words.length > 64 ? `${words.slice(0, 63).replace(/\s+\S*$/, "")}…` : words || "New conversation";
}
