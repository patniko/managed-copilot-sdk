// One Dispatch conversation: a coordinator session in the orchestrator environment, held through a stock
// CopilotSession. The coordinator decides, message by message, whether to start new workers (each in its own sandbox)
// or send work to the ones it has; this class shows those decisions and the workers they produce, and lets the person
// approve each new sandbox.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { PlatformEvent, WorkerInfo } from "@managed-copilot/sdk";
import type { Approval, ConversationSettings, ConversationStatus, ConversationSummary, ConversationView, FileView, WorkerState, WorkerView } from "../shared/types.js";
import { attachCommand } from "./attach.js";
import type { DispatchConfig } from "./config.js";
import { DispatchError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { CoordinatorSession, DispatchPlatform } from "./platform.js";
import { Transcript, type CoordinatorEvent } from "./projection.js";
import { digest, type Store } from "./store.js";

/** Added to the platform's coordinator instructions: how Dispatch's UI shows the coordinator's work. */
export const SYSTEM_MESSAGE = [
  "You are Dispatch's coordinator. The person watches your workers live: each worker appears as a card with its sandbox, files, and state.",
  "- Give each worker a short, descriptive kebab-case name, such as `py-bench`, `node-bench`, or `report-writer`.",
  "- Always pass `environment` to start_worker: the environment whose tools and network the task needs (JavaScript needs the Node.js one, web lookups the one with web access). Don't rely on the default.",
  "- For a follow-up, prefer an existing worker whose sandbox already has the files and tools it needs. Start a new worker when the work needs another environment, should run in parallel, or would disturb a worker's state.",
  "- The person may decline a new sandbox, sometimes saying why. Follow their reason; without one, don't start it again unless they ask, and carry on with the workers you have or say what you'd need.",
  "- Answer briefly when the work is done: a few short paragraphs or a table, saying which worker produced what.",
].join("\n");

/** What the person sees when they decline a sandbox, and what the coordinator is told. */
const DECLINED = "Declined in Dispatch. Don't start this worker again unless the person asks; continue with the workers you have, or say what you need.";

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
  #state: AttachState = "detached";
  #problem: string | undefined;
  #session: CoordinatorSession | undefined;
  #transcript: Transcript;
  #generation = 0;
  #attaching: Promise<void> | undefined;
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

  constructor(host: ConversationHost, id = "") {
    this.#host = host;
    this.#id = id;
    this.#transcript = this.#newTranscript();
  }

  get id(): string {
    return this.#id;
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
      return own.some((entry) => (messageId !== undefined && entry.id === messageId) || entry.digest === key);
    };
    return new Transcript(isOwn, this.#host.platform.blueprints[0]?.name);
  }

  #handlers(generation: number, onEvent: (event: SessionEvent) => void) {
    return {
      streaming: true,
      onEvent,
      onPermissionRequest: (request: PermissionRequest) => this.#onPermission(request, generation),
      systemMessage: { content: SYSTEM_MESSAGE },
    };
  }

  /**
   * Starts a new conversation: creates the coordinator session, then sends the first message. `registered` runs once
   * the session exists, before anything is sent, so worker events can be routed to this conversation.
   */
  async start(prompt: string, settings: ConversationSettings, registered: (conversation: Conversation) => void): Promise<void> {
    const generation = ++this.#generation;
    this.#state = "attaching";
    const session = await this.#host.platform.createSession({
      ...this.#handlers(generation, (event) => {
        if (generation === this.#generation) this.#onEvent(event);
      }),
      model: this.#host.config.model,
    });
    this.#id = session.sessionId;
    this.#session = session;
    this.#state = "live";
    this.#workersLoaded = true;
    this.#host.store.ensure(this.#id, { settings, title: titleFrom(prompt) });
    registered(this);
    log.info("Started a conversation", { sessionId: this.#id, approvals: settings.approvals });
    try {
      await this.send(prompt);
    } catch (error) {
      // An empty conversation isn't worth keeping; the person tries again from the home page.
      await this.delete().catch(() => undefined);
      throw error;
    }
  }

  /** Resumes the coordinator session on the current client, rebuilding the transcript from its history. */
  attach(): Promise<void> {
    if (this.#state === "live" || this.#closed) return Promise.resolve();
    this.#attaching ??= this.#attach().finally(() => {
      this.#attaching = undefined;
    });
    return this.#attaching;
  }

  async #attach(): Promise<void> {
    const generation = ++this.#generation;
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
      session = await this.#host.platform.resumeSession(this.#id, { ...this.#handlers(generation, onEvent), continuePendingWork: true, suppressResumeEvent: true });
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      const [history, info] = await Promise.all([session.getEvents(), this.#host.platform.sessionInfo(this.#id).catch(() => undefined)]);
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      for (const event of history) transcript.apply(event as unknown as CoordinatorEvent);
      loading = false;
      for (const event of buffered) transcript.apply(event as unknown as CoordinatorEvent);
      // A turn the platform already ended (for example cut by a runtime restart) has no idle event in the history.
      if (transcript.busy && info?.lastTurn?.completedAt && !buffered.some((event) => event.type === "user.message")) {
        transcript.busy = false;
        transcript.waiting = undefined;
      }
      this.#transcript = transcript;
      this.#session = session;
      this.#state = "live";
      this.#problem = undefined;
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
    if (this.#state !== "failed") this.#state = "detached";
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
    this.dispose();
    await session?.disconnect().catch(() => undefined);
    try {
      await this.#host.platform.deleteSession(this.#id);
    } catch (error) {
      if (!isMissingSession(error)) throw new DispatchError("delete_failed", `Couldn't delete the conversation: ${errorText(error)}`, 502);
    }
    log.info("Deleted a conversation", { sessionId: this.#id });
  }

  /** Sends a message. While the coordinator is working, it goes in right away (the coordinator answers between waits). */
  async send(prompt: string): Promise<void> {
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
    } catch (error) {
      throw new DispatchError("send_failed", `Your message wasn't delivered: ${errorText(error)}`, 502);
    } finally {
      const left = (this.#inflight.get(key) ?? 1) - 1;
      if (left > 0) this.#inflight.set(key, left);
      else this.#inflight.delete(key);
    }
  }

  /** Answers a sandbox request. A reason for declining goes to the coordinator, so it can try another way. */
  answer(approvalId: string, approve: boolean, reason?: string): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) throw new DispatchError("not_actionable", "This sandbox request was already answered.", 409);
    this.#approvals.delete(approvalId);
    const why = reason?.replace(/\s+/g, " ").trim();
    const feedback = why ? `The person declined this sandbox: ${why}` : DECLINED;
    this.#transcript.markDecision(pending.approval.decisionId, approve ? "running" : "denied", approve ? undefined : feedback);
    pending.resolve(approve ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback });
    log.info(approve ? "Approved a sandbox" : "Declined a sandbox", { sessionId: this.#id, worker: pending.approval.worker, environment: pending.approval.environment, reason: why ? "given" : undefined });
    this.#changed();
  }

  setSettings(settings: ConversationSettings): void {
    this.#host.store.update(this.#id, (stored) => {
      stored.settings = { ...settings };
    });
    if (settings.approvals === "auto") for (const id of [...this.#approvals.keys()]) this.answer(id, true);
    this.#changed();
  }

  /** The coordinator wants to start a worker: ask the person, unless this conversation creates sandboxes freely. */
  async #onPermission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    // Only `start_worker` asks (spec section 17); the coordinator's other tools are its own platform tools.
    if (request.kind !== "custom-tool" || request.toolName !== "start_worker") return { kind: "approve-once" };
    if (generation !== this.#generation) return { kind: "no-result" };
    if (this.settings.approvals === "auto") return { kind: "approve-once" };
    const args = (request.args ?? {}) as Record<string, unknown>;
    const id = request.toolCallId ?? `request-${Date.now().toString(36)}`;
    // Redelivered (for example after a reconnection): the newest callback is the one that answers.
    this.#approvals.get(id)?.resolve({ kind: "no-result" });
    return await new Promise<PermissionRequestResult>((resolve) => {
      const environment = str(args["environment"]) ?? this.#host.platform.blueprints[0]?.name ?? "";
      const index = this.#transcript.messageIndexOf(request.toolCallId) ?? this.#transcript.currentIndex;
      const approval: Approval = {
        id,
        ...(request.toolCallId ? { decisionId: request.toolCallId } : {}),
        worker: str(args["name"]) ?? "worker",
        environment,
        task: str(args["task"]) ?? "",
        ...(str(args["agent"]) ? { agent: str(args["agent"]) } : {}),
        ...(str(args["model"]) ? { model: str(args["model"]) } : {}),
        requestedAt: new Date().toISOString(),
        ...(index !== undefined ? { messageIndex: index } : {}),
      };
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

  #onEvent(event: SessionEvent): void {
    const changed = this.#transcript.apply(event as unknown as CoordinatorEvent);
    if (changed && (event.type === "tool.execution_start" || event.type === "tool.execution_complete")) this.#scheduleRefresh(200);
    if (event.type === "session.idle") this.#scheduleRefresh(100);
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
      const decision = approval.decisionId ? transcript.decision(approval.decisionId) : undefined;
      const index = transcript.messageIndexOf(approval.decisionId) ?? approval.messageIndex ?? transcript.currentIndex;
      return { ...approval, ...(decision ? { requestedAt: decision.at } : {}), ...(index !== undefined ? { messageIndex: index } : {}) };
    });
    return {
      ...this.summary(),
      messages: transcript.messages(),
      workers: this.#workers.map((worker) => this.#workerView(worker)),
      approvals,
      settings: this.settings,
      busy: transcript.busy,
      ...(waiting ? { waiting: { workers: [...waiting.workers], since: waiting.since } } : {}),
      ...(this.#problem ? { problem: this.#problem } : {}),
      attachCommand: attachCommand(this.#id, this.#host.config.attachUrl),
    };
  }

  #workerView(worker: WorkerInfo): WorkerView {
    const stored = this.#host.store.worker(this.#id, worker.id);
    const files = this.#files.get(worker.id);
    return {
      id: worker.id,
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
      ...this.#transcript.attribution(worker),
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
