// One Data Desk analysis: a dataset and a session in the promotable environment, held through a stock CopilotSession.
// The session starts on the shared runtime and answers with Data Desk's tools. When a request needs code, the agent
// asks to move (the platform's `request_sandbox` tool), the person approves here, and the platform moves the same
// session into its own sandbox, where this class copies the dataset before the agent's first command runs.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { PlatformEvent, SessionInfo } from "@managed-copilot/sdk";
import type { AnalysisSummary, AnalysisView, ChatItem, MoveRequest, OutputFile, Placement, ResultView } from "../shared/types.js";
import type { Dataset, Datasets } from "./datasets.js";
import type { DeskConfig } from "./config.js";
import { DeskError, errorText, isMissingSession } from "./errors.js";
import { routingView } from "./factory.js";
import type { Insight, TableOrigin } from "./handoff.js";
import { log } from "./log.js";
import type { DeskPlatform, DeskSession } from "./platform.js";
import { mergeHistory, MOVE_TOOL, Transcript, type DeskEvent } from "./projection.js";
import { digest, type StoredAnalysis, type Store, type StoredRouting } from "./store.js";
import { dataTools, systemMessage } from "./tools.js";

/** What the agent is told when the person keeps the session on the shared runtime. */
export const DECLINED = "The person chose not to move into a sandbox for this. Don't ask again unless they do: answer with Data Desk's tools, or say what you'd need.";
/** Anything but commands and files in the sandbox. */
export const NOT_AVAILABLE = "Data Desk's sandbox has no network or other services. Work with Python's standard library on the files in /workspace.";
const COPY_FAILED = "Couldn't copy the dataset into the sandbox.";
/** An upload dropped for newer ones, or a file that can't be read. */
const DATASET_GONE = "This analysis's dataset isn't available anymore.";
const CHART = /\.(svg|png|jpe?g|gif|webp)$/i;
const OUTPUT_CACHE = 24;
/** After a turn, published outputs are listed again in case their event was missed. */
const OUTPUT_CHECKS_MS = [500, 2_500, 7_000];

export interface AnalysisHost {
  readonly platform: DeskPlatform;
  readonly config: DeskConfig;
  readonly store: Store;
  readonly datasets: Datasets;
  /** Something a person would see changed; the host coalesces publishing. */
  changed(analysis: Analysis): void;
  /** The session no longer exists on the platform. */
  gone(analysis: Analysis): void;
}

type AttachState = "detached" | "attaching" | "live" | "failed";

interface PendingMove {
  readonly request: MoveRequest;
  readonly resolve: (result: PermissionRequestResult) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export class Analysis {
  readonly #host: AnalysisHost;
  #id: string;
  #state: AttachState = "detached";
  #problem: string | undefined;
  #session: DeskSession | undefined;
  #transcript: Transcript;
  #generation = 0;
  /** The attach in progress, for the generation it was started in (a detach invalidates it). */
  #attaching: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  #closed = false;
  #pendingMove: PendingMove | undefined;
  /** When the person approved the move, until it finished. */
  #movingSince: string | undefined;
  #uploading: Promise<boolean> | undefined;
  #outputs: OutputFile[] = [];
  readonly #outputCache = new Map<string, Uint8Array>();
  /** Where the platform last said the session runs. */
  #placement: SessionInfo["placement"] | undefined;
  #sandboxId: string | undefined;
  /** Digests of messages being sent: their `user.message` can arrive before `send` returns. */
  readonly #inflight = new Map<string, number>();
  readonly #timers = new Set<NodeJS.Timeout>();
  /** A usage read is scheduled. */
  #usagePending = false;

  constructor(host: AnalysisHost, id = "") {
    this.#host = host;
    this.#id = id;
    this.#transcript = this.#newTranscript();
  }

  get id(): string {
    return this.#id;
  }

  get #stored(): StoredAnalysis | undefined {
    return this.#host.store.get(this.#id);
  }

  get dataset(): Dataset | undefined {
    const stored = this.#stored;
    return stored ? this.#host.datasets.get(stored.datasetId) : undefined;
  }

  get updatedAt(): string {
    const stored = this.#stored;
    const times = [this.#transcript.updatedAt, stored?.updatedAt, stored?.createdAt].filter((value): value is string => Boolean(value));
    return times.sort().at(-1) ?? "";
  }

  get placement(): Placement {
    if (this.#stored?.move || this.#placement === "sandbox" || this.#transcript.moved) return "sandbox";
    if (this.#movingSince || this.#transcript.moving) return "moving";
    return "shared";
  }

  #newTranscript(): Transcript {
    return new Transcript((content) => {
      const key = digest(content);
      return this.#inflight.has(key) || (this.#stored?.own ?? []).includes(key);
    });
  }

  #sessionConfig(dataset: Dataset, generation: number, onEvent: (event: SessionEvent) => void) {
    return {
      model: this.#host.config.model,
      streaming: true,
      tools: dataTools({ dataset }),
      systemMessage: { content: systemMessage(dataset) },
      onPermissionRequest: (request: PermissionRequest) => this.#onPermission(request, generation),
      onEvent,
    };
  }

  /**
   * Starts an analysis: creates its session on the shared runtime. `registered` runs once the session exists, so
   * platform events can be routed to it.
   */
  async start(dataset: Dataset, registered: (analysis: Analysis) => void): Promise<void> {
    const generation = ++this.#generation;
    this.#state = "attaching";
    const session = await this.#host.platform.createSession(
      this.#sessionConfig(dataset, generation, (event) => {
        if (generation === this.#generation) this.#onEvent(event);
      }),
    );
    this.#id = session.sessionId;
    this.#session = session;
    this.#state = "live";
    this.#placement = "shared";
    this.#host.store.add({ id: this.#id, datasetId: dataset.summary.id, title: dataset.summary.name });
    registered(this);
    log.info("Started an analysis", { sessionId: this.#id, dataset: dataset.summary.id });
  }

  /** Resumes the session on the current client, rebuilding the transcript from its history. */
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
    this.#releaseMove();
    this.#state = "attaching";
    const dataset = this.dataset;
    if (!dataset) {
      this.#state = "failed";
      this.#problem = DATASET_GONE;
      this.#changed();
      return;
    }
    const transcript = this.#newTranscript();
    const buffered: SessionEvent[] = [];
    let loading = true;
    const onEvent = (event: SessionEvent) => {
      if (generation !== this.#generation) return;
      if (loading) buffered.push(event);
      else this.#onEvent(event);
    };
    let session: DeskSession | undefined;
    try {
      session = await this.#host.platform.resumeSession(this.#id, { ...this.#sessionConfig(dataset, generation, onEvent), continuePendingWork: true, suppressResumeEvent: true });
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      const [history, info] = await Promise.all([session.getEvents(), this.#host.platform.sessionInfo(this.#id).catch(() => undefined)]);
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      // History holds persisted events only; events delivered while it loaded go in at the time they happened.
      for (const event of mergeHistory(history, buffered)) transcript.apply(event as unknown as DeskEvent);
      loading = false;
      // `session.idle` is never persisted: a turn the platform reports finished has ended, unless a new one started.
      if (transcript.busy && info?.lastTurn?.status !== "running" && !buffered.some((event) => event.type === "user.message")) transcript.settle();
      this.#transcript = transcript;
      this.#session = session;
      this.#state = "live";
      this.#problem = undefined;
      if (info) this.#notePlacement(info);
      // A move request delivered again while the history loaded may have been answered elsewhere meanwhile.
      if (this.#pendingMove && this.#transcript.isSettled(this.#pendingMove.request.id)) this.#releaseMove();
      log.info("Attached to an analysis", { sessionId: this.#id, events: history.length });
    } catch (error) {
      await session?.disconnect().catch(() => undefined);
      if (generation !== this.#generation) return;
      if (isMissingSession(error)) {
        log.info("An analysis was deleted elsewhere", { sessionId: this.#id });
        this.dispose();
        this.#host.gone(this);
        return;
      }
      this.#state = "failed";
      this.#problem = `Couldn't open this analysis: ${errorText(error)}`;
      log.warn("Couldn't attach to an analysis", { sessionId: this.#id, error: errorText(error) });
      this.#changed();
      return;
    }
    this.#changed();
    void this.#refreshUsage();
    if (this.placement === "sandbox") {
      void this.#refreshOutputs();
      // Moved while Data Desk wasn't watching (for example from Copilot CLI): the dataset still goes in.
      if (!this.#stored?.uploadedAt) void this.#ensureDataset();
    }
  }

  /** The client this session lived on is gone (the platform reconnected): attach again when needed. */
  detach(): void {
    ++this.#generation;
    this.#releaseMove();
    this.#session = undefined;
    this.#state = "detached";
    this.#problem = undefined;
  }

  /** Stops everything without touching the platform. */
  dispose(): void {
    this.#closed = true;
    this.detach();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Lets go of the session (Data Desk is shutting down); the session and its sandbox keep running. */
  async close(): Promise<void> {
    const session = this.#session;
    this.dispose();
    await session?.disconnect().catch(() => undefined);
  }

  /** Deletes the session; the platform deletes its sandbox with it. */
  async delete(): Promise<void> {
    const session = this.#session;
    this.detach();
    await session?.disconnect().catch(() => undefined);
    try {
      await this.#host.platform.deleteSession(this.#id);
    } catch (error) {
      if (!isMissingSession(error)) {
        this.#changed();
        throw new DeskError("delete_failed", `Couldn't delete the analysis: ${errorText(error)}`, 502);
      }
    }
    this.dispose();
    log.info("Deleted an analysis", { sessionId: this.#id });
  }

  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new DeskError("invalid_request", "Write a message first.");
    await this.attach();
    const session = this.#session;
    if (!session || this.#state !== "live") throw new DeskError("unavailable", this.#problem ?? "This analysis isn't connected right now. Try again in a moment.", 503);
    if (this.#pendingMove) throw new DeskError("needs_answer", "Copilot is waiting for your answer: move into a sandbox, or not now.", 409);
    const key = digest(text);
    this.#inflight.set(key, (this.#inflight.get(key) ?? 0) + 1);
    try {
      await session.send({ prompt: text });
      this.#host.store.addOwn(this.#id, text);
      this.#host.store.update(this.#id, (stored) => {
        stored.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      throw new DeskError("send_failed", `Your message wasn't delivered: ${errorText(error)}`, 502);
    } finally {
      const left = (this.#inflight.get(key) ?? 1) - 1;
      if (left > 0) this.#inflight.set(key, left);
      else this.#inflight.delete(key);
    }
  }

  /** Stops the turn in progress. */
  async stop(): Promise<void> {
    const session = this.#session;
    if (!session || this.#state !== "live") throw new DeskError("unavailable", "This analysis isn't connected right now.", 503);
    try {
      await session.abort();
    } catch (error) {
      throw new DeskError("stop_failed", `Couldn't stop: ${errorText(error)}`, 502);
    }
  }

  /** The person's answer to the agent's request to move into a sandbox. */
  answerMove(approve: boolean): void {
    const pending = this.#pendingMove;
    if (!pending) throw new DeskError("not_actionable", "There's no sandbox request waiting. It may have been answered already.", 409);
    this.#pendingMove = undefined;
    if (approve) this.#movingSince = new Date().toISOString();
    pending.resolve(approve ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback: DECLINED });
    log.info(approve ? "Approved the move into a sandbox" : "Kept the analysis on the shared runtime", { sessionId: this.#id });
    this.#changed();
  }

  /**
   * The agent wants to move (ask the person), or, in the sandbox, to run a command or write a file: the dataset goes
   * in first, so even its first command finds it.
   */
  async #onPermission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    if (request.kind === "custom-tool") {
      if (request.toolName !== MOVE_TOOL) return { kind: "approve-once" };
      if (generation !== this.#generation) return { kind: "no-result" };
      // Already answered elsewhere (for example in Copilot CLI): nothing to ask.
      if (this.#transcript.isSettled(request.toolCallId)) return { kind: "no-result" };
      const args = (request.args ?? {}) as Record<string, unknown>;
      const reason = typeof args["reason"] === "string" ? args["reason"].replace(/\s+/g, " ").trim().slice(0, 300) : "";
      // Delivered again (for example after a reconnection): the newest callback is the one that answers.
      this.#pendingMove?.resolve({ kind: "no-result" });
      return await new Promise<PermissionRequestResult>((resolve) => {
        this.#pendingMove = { request: { id: request.toolCallId ?? `move-${Date.now().toString(36)}`, reason, requestedAt: new Date().toISOString() }, resolve };
        this.#changed();
      });
    }
    if (request.kind === "shell" || request.kind === "write" || request.kind === "read") {
      await this.#ensureDataset();
      return { kind: "approve-once" };
    }
    return { kind: "reject", feedback: NOT_AVAILABLE };
  }

  /** Lets go of a waiting move request without answering; the platform keeps it and delivers it again. */
  #releaseMove(): void {
    const pending = this.#pendingMove;
    if (!pending) return;
    this.#pendingMove = undefined;
    pending.resolve({ kind: "no-result" });
  }

  /** Copies the dataset into the sandbox once (concurrent callers wait for the same copy). Resolves whether it's there. */
  #ensureDataset(): Promise<boolean> {
    if (this.#stored?.uploadedAt) return Promise.resolve(true);
    this.#uploading ??= this.#upload().finally(() => {
      this.#uploading = undefined;
    });
    return this.#uploading;
  }

  async #upload(): Promise<boolean> {
    const dataset = this.dataset;
    if (!dataset) {
      this.#problem = DATASET_GONE;
      this.#changed();
      return false;
    }
    const path = `data/${dataset.summary.fileName}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = dataset.bytes();
        await this.#host.platform.writeFile(this.#id, path, bytes);
        this.#host.store.update(this.#id, (stored) => {
          stored.uploadedAt = new Date().toISOString();
        });
        log.info("Copied the dataset into the sandbox", { sessionId: this.#id, path, bytes: bytes.length });
        if (this.#problem === COPY_FAILED) {
          this.#problem = undefined;
          this.#changed();
        }
        return true;
      } catch (error) {
        if (attempt >= 3 || this.#closed) {
          log.warn("Couldn't copy the dataset into the sandbox", { sessionId: this.#id, error: errorText(error) });
          this.#problem = COPY_FAILED;
          this.#changed();
          return false;
        }
        await delay(1_000 * attempt);
      }
    }
  }

  #onEvent(event: SessionEvent): void {
    let changed = this.#transcript.apply(event as unknown as DeskEvent);
    // Answered elsewhere (Copilot CLI), or the turn ended: the request isn't waiting for this app anymore.
    if (this.#pendingMove && (this.#transcript.isSettled(this.#pendingMove.request.id) || event.type === "session.idle" || event.type === "abort")) {
      this.#releaseMove();
      changed = true;
    }
    if (this.#movingSince && !this.#transcript.moving && this.#transcript.isSettled(this.#transcript.lastMoveId)) {
      this.#movingSince = undefined;
      changed = true;
    }
    if (event.type === "tool.execution_complete" && (event.data as { toolCallId?: unknown }).toolCallId === this.#transcript.lastMoveId) void this.#refreshPlacement();
    // Each model reply may have counted a premium request: keep the count live during the turn.
    if (event.type === "assistant.message") this.#refreshUsageSoon();
    if (event.type === "session.idle") {
      void this.#refreshUsage();
      void this.#refreshPlacement();
      if (this.placement === "sandbox") for (const wait of OUTPUT_CHECKS_MS) this.#later(wait, () => void this.#refreshOutputs());
    }
    if (changed) this.#changed();
  }

  /** A platform event for this session. */
  platformEvent(event: PlatformEvent): void {
    switch (event.type) {
      case "session.promoted": {
        const data = event.data as { durationMs?: unknown };
        this.#placement = "sandbox";
        this.#sandboxId = event.sandboxId ?? this.#sandboxId;
        this.#movingSince = undefined;
        this.#host.store.update(this.#id, (stored) => {
          stored.move = { at: event.createdAt, sandboxId: event.sandboxId ?? "", ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}) };
        });
        log.info("The analysis moved into its sandbox", { sessionId: this.#id, sandboxId: event.sandboxId, durationMs: data.durationMs });
        void this.#ensureDataset();
        void this.#refreshUsage(true);
        this.#changed();
        return;
      }
      case "artifact.published":
        void this.#refreshOutputs();
        return;
      case "session.deleted":
        this.dispose();
        this.#host.gone(this);
        return;
      default:
        return;
    }
  }

  #later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#closed) run();
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
  }

  /** Reads the usage shortly, once for a burst of replies. */
  #refreshUsageSoon(): void {
    if (this.#usagePending) return;
    this.#usagePending = true;
    this.#later(400, () => {
      this.#usagePending = false;
      void this.#refreshUsage();
    });
  }

  #notePlacement(info: SessionInfo): void {
    this.#placement = info.placement;
    if (info.sandbox?.id) this.#sandboxId = info.sandbox.id;
  }

  async #refreshPlacement(): Promise<void> {
    try {
      const info = await this.#host.platform.sessionInfo(this.#id);
      const before = `${this.#placement}|${this.#sandboxId}`;
      this.#notePlacement(info);
      if (`${this.#placement}|${this.#sandboxId}` !== before) this.#changed();
    } catch (error) {
      log.debug("Couldn't read the session's placement", { sessionId: this.#id, error: errorText(error) });
    }
  }

  /** Reads the session's premium requests; `atMove` also records them as the shared runtime's share. */
  async #refreshUsage(atMove = false): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      const premiumRequests = (await session.rpc.usage.getMetrics()).totalPremiumRequestCost;
      const usage = this.#stored?.usage;
      if (usage?.premiumRequests === premiumRequests && (!atMove || usage.beforeMove !== undefined)) return;
      this.#host.store.update(this.#id, (stored) => {
        const beforeMove = stored.usage?.beforeMove ?? (atMove ? premiumRequests : undefined);
        stored.usage = { premiumRequests, ...(beforeMove !== undefined ? { beforeMove } : {}) };
      });
      this.#changed();
    } catch (error) {
      log.debug("Couldn't read the session's usage", { sessionId: this.#id, error: errorText(error) });
    }
  }

  async #refreshOutputs(): Promise<void> {
    try {
      const artifacts = await this.#host.platform.outputs(this.#id);
      const outputs: OutputFile[] = artifacts
        .filter((artifact) => artifact.state === "published")
        .map((artifact) => ({
          path: artifact.path,
          version: artifact.version,
          size: artifact.size,
          ...(artifact.publishedAt ? { publishedAt: artifact.publishedAt } : {}),
          kind: CHART.test(artifact.path) ? ("chart" as const) : ("file" as const),
        }))
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.path.localeCompare(b.path));
      if (JSON.stringify(outputs) === JSON.stringify(this.#outputs)) return;
      this.#outputs = outputs;
      this.#changed();
    } catch (error) {
      log.debug("Couldn't list the session's outputs", { sessionId: this.#id, error: errorText(error) });
    }
  }

  /** A published output's bytes (cached per version). */
  async readOutput(path: string): Promise<{ file: OutputFile; bytes: Uint8Array }> {
    if (!this.#outputs.some((output) => output.path === path) && this.placement === "sandbox") await this.#refreshOutputs();
    const file = this.#outputs.find((output) => output.path === path);
    if (!file) throw new DeskError("not_found", "That file isn't one of this analysis's outputs.", 404);
    const key = `${file.path}@${file.version}`;
    let bytes = this.#outputCache.get(key);
    if (!bytes) {
      try {
        bytes = await this.#host.platform.readOutput(this.#id, file.path, file.version);
      } catch (error) {
        throw new DeskError("output_unavailable", `Couldn't read ${file.path}: ${errorText(error)}`, 502);
      }
      this.#outputCache.set(key, bytes);
      if (this.#outputCache.size > OUTPUT_CACHE) this.#outputCache.delete(this.#outputCache.keys().next().value!);
    }
    return { file, bytes };
  }

  #changed(): void {
    if (this.#id && !this.#closed) this.#host.changed(this);
  }

  /**
   * What a hand-off to Software Factory draws on: the tables Copilot made and how it made them, its latest complete
   * answer and the question before it, and the conversation's last item (where the hand-off shows).
   */
  handoff(): { readonly results: readonly ResultView[]; readonly origins: ReadonlyMap<string, TableOrigin>; readonly answer?: Insight; readonly lastItemId?: string } {
    const items = this.#transcript.items;
    const origins = new Map<string, TableOrigin>();
    for (const item of items) if (item.kind === "step" && item.resultId) origins.set(item.resultId, { tool: item.tool, ...(item.detail ? { detail: item.detail } : {}) });
    let answer: Insight | undefined;
    for (let index = items.length - 1; index >= 0 && !answer; index--) {
      const item = items[index]!;
      if (item.kind !== "assistant" || item.streaming || !item.text.trim()) continue;
      const question = items.slice(0, index).findLast((candidate) => candidate.kind === "user");
      answer = { text: item.text.trim(), ...(question?.kind === "user" ? { question: question.text.trim() } : {}) };
    }
    const last = items.at(-1);
    return { results: this.#transcript.results, origins, ...(answer ? { answer } : {}), ...(last ? { lastItemId: last.id } : {}) };
  }

  summary(): AnalysisSummary {
    const stored = this.#stored;
    return {
      id: this.#id,
      title: stored?.title ?? this.dataset?.summary.name ?? "Analysis",
      datasetId: stored?.datasetId ?? "",
      placement: this.placement,
      createdAt: stored?.createdAt ?? "",
      updatedAt: this.updatedAt,
      busy: this.#transcript.busy,
      needsYou: this.#pendingMove !== undefined,
      charts: this.#outputs.filter((output) => output.kind === "chart").length,
    };
  }

  view(): AnalysisView {
    const stored = this.#stored;
    const move = stored?.move;
    const dataset = this.dataset?.summary;
    const routings = stored?.factory ?? [];
    return {
      ...this.summary(),
      ...(dataset ? { dataset } : {}),
      model: this.#host.config.model,
      items: withRoutings(withMove(this.#transcript.items, move), routings),
      results: this.#transcript.results.slice(-20),
      outputs: this.#outputs,
      ...(this.#pendingMove ? { moveRequest: this.#pendingMove.request } : {}),
      ...(move?.sandboxId || this.#sandboxId ? { sandboxId: move?.sandboxId || this.#sandboxId } : {}),
      ...(move ? { movedAt: move.at, ...(move.durationMs !== undefined ? { moveMs: move.durationMs } : {}) } : {}),
      ...(this.#movingSince && this.placement === "moving" ? { movingSince: this.#movingSince } : {}),
      ...(stored?.usage ? { usage: stored.usage } : {}),
      ...(routings.length ? { factory: routings.map(routingView) } : {}),
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }
}

/**
 * The transcript with the move's details: the marker its `request_sandbox` call left gets the sandbox and how long the
 * move took. A move the agent didn't ask for (`managed.promote`, or `managed-copilot promote`) gets a marker at its time.
 */
export function withMove(items: readonly ChatItem[], move: StoredAnalysis["move"]): ChatItem[] {
  if (!move) return [...items];
  const details = { ...(move.sandboxId ? { sandboxId: move.sandboxId } : {}), ...(move.durationMs !== undefined ? { durationMs: move.durationMs } : {}) };
  if (items.some((item) => item.kind === "moved")) return items.map((item) => (item.kind === "moved" ? { ...item, ...details } : item));
  const marker: ChatItem = { kind: "moved", id: `moved-${move.at}`, at: move.at, ...details };
  const index = items.findIndex((item) => Date.parse(item.at) > Date.parse(move.at));
  return index < 0 ? [...items, marker] : [...items.slice(0, index), marker, ...items.slice(index)];
}

/**
 * The transcript with a line for each thing the person sent to Software Factory: right after the item that was last
 * when it was sent (clocks can differ between Data Desk and the runtime), or at its time when that item isn't there.
 */
export function withRoutings(items: readonly ChatItem[], routings: readonly StoredRouting[]): ChatItem[] {
  const out = [...items];
  for (const routing of [...routings].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    const line: ChatItem = { kind: "factory", id: `factory-${routing.workOrderId}`, at: routing.sentAt, routing: routingView(routing) };
    let index = routing.after ? out.findIndex((item) => item.id === routing.after) : -1;
    if (index >= 0) {
      index += 1;
      while (out[index]?.kind === "factory") index += 1;
    } else {
      index = out.findIndex((item) => Date.parse(item.at) > Date.parse(routing.sentAt));
      if (index < 0) index = out.length;
    }
    out.splice(index, 0, line);
  }
  return out;
}
