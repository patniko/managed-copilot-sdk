/**
 * The conversation's sandboxes. The assistant's environment is an orchestrator (spec section 17), so its agent can
 * start workers: each one a session of an isolated environment, in its own sandbox. This module follows them with the
 * public SDK only, and never attaches a client to a worker (an attached client would answer the worker's prompts):
 *
 * - `managed.workers(session).list()` for each sandbox's state, refreshed on `worker.*` platform events, when the
 *   agent's sandbox tools finish, and every few seconds while one is working;
 * - `managed.sessions.get(worker.id)` for its sandbox, and `managed.artifacts(worker.id)` for the files it published
 *   from `/workspace/outputs`. Images are copied here, so charts stay in the chat after a sandbox is deleted;
 * - when each start or follow-up card's work ended, from those listings (kept in the store, so the chat shows the
 *   same timings after a restart).
 */
import type { ServerResponse } from "node:http";
import { isManagedCopilotError, type ArtifactInfo, type ManagedCopilot, type PlatformEvent, type WorkerInfo } from "@managed-copilot/sdk";
import type { SandboxEnvironmentView, SandboxesView, SandboxOutputView, SandboxRunView, SandboxWorkerView, WorkerItem } from "../shared/protocol.js";
import { sandboxEnvironments } from "./environments.js";
import { HttpError } from "./http.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import type { SandboxOutputRecord, SandboxRunRecord, Store } from "./store.js";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
/** Images up to this size are copied here and shown in the chat. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Other outputs are downloaded through this server, up to this size. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** While a sandbox works, its state is also checked this often (a safety net for missed events). */
const BUSY_POLL_MS = 10_000;
/** How long to wait for a finished sandbox's outputs to publish (the platform's own wait is 30 seconds). */
const PUBLICATION_WAIT_MS = 45_000;
const DEBOUNCE_MS = 250;
const RETRY_MS = 15_000;
/** Times a sandbox that couldn't be read in full (its outputs' listing, or an image copy) is read again, backing off. */
const MAX_RETRIES = 5;

export const SANDBOXES_LEGACY =
  "This conversation started before your assistant could use sandboxes. Start a new conversation (Settings → Start over) to use them.";
export const SANDBOXES_UNSUPPORTED = "This deployment can't run sandboxes, so your assistant works without them.";

type Settled = "idle" | "failed" | "stopped";
/** How a sandbox's work ended, by the platform's clock. */
interface Finish {
  readonly at: string;
  readonly state: Settled;
}

/** What one listing showed about a sandbox, by the platform's clock. */
interface Listed {
  readonly state: string;
  readonly messages: number;
  /** When it last changed state (a working sandbox: when it started on its latest message). */
  readonly at: string;
  /** The event subscription it was requested on: it can be older than events received on a later one. */
  readonly epoch: number;
}

/** A finish a `worker.idle` or `worker.failed` event reported, and the event subscription it arrived on. */
interface Reported extends Finish {
  readonly epoch: number;
}

/** What listings (and the events they place) showed about one sandbox. */
interface WorkerFacts {
  /** How the work for each message ended (by message number, from 1), as first seen. */
  readonly finished: Map<number, Finish>;
  /** Its task never reached it: it failed or was stopped while starting. */
  undelivered?: Finish;
  /** The latest listing: it places the finish events that follow it. */
  last?: Listed;
  /** Every finish its events reported, in the order they arrived. */
  readonly reported: Reported[];
}

export interface SandboxesDeps {
  readonly log: Logger;
  readonly store: Store;
  readonly platform: Platform;
  /** The conversation's environment (an orchestrator when the assistant can start sandboxes). */
  readonly environment: string;
  sessionId(): string | undefined;
  /** The start and follow-up cards in the chat, oldest first. */
  cards(): readonly WorkerItem[];
  onChange(view: SandboxesView): void;
}

type Base = Pick<SandboxesView, "enabled" | "unavailable" | "environments" | "maxWorkers">;

/** Timestamps compared as text must share one format. */
function iso(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

function extension(path: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

/** The image type to serve a file as, or undefined when it isn't an image the chat shows. */
export function imageType(path: string, contentType?: string): string | undefined {
  const byExtension = IMAGE_TYPES[extension(path)];
  if (byExtension) return byExtension;
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  return declared && Object.values(IMAGE_TYPES).includes(declared) ? declared : undefined;
}

function friendly(error: unknown): string {
  const message = errorMessage(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export class Sandboxes {
  readonly #deps: SandboxesDeps;
  #view: SandboxesView = { enabled: false, environments: [], workers: [], runs: {} };
  #base: Base = { enabled: false, environments: [] };
  #workers: readonly WorkerInfo[] = [];
  /** Session ID → its type, from the platform (a conversation started before sandboxes is `shared`). */
  readonly #types = new Map<string, string>();
  readonly #sandboxStates = new Map<string, string>();
  /** The worker `updatedAt` its sandbox and outputs were last read at; read again when it changes. */
  readonly #inspected = new Map<string, string>();
  /** Workers that published or changed since they were last read. */
  readonly #dirty = new Set<string>();
  /** The worker `updatedAt` whose publication was awaited from a refresh, so each finished run is awaited once. */
  readonly #awaited = new Map<string, string>();
  /** Workers whose publication is being awaited right now. */
  readonly #publishing = new Set<string>();
  /** Per worker: how each of its messages' work ended, as far as listings showed it. */
  readonly #facts = new Map<string, WorkerFacts>();
  /** Per worker: reads that failed (a listing of its outputs or an image copy) at its current state. */
  readonly #failures = new Map<string, { readonly updatedAt: string; readonly count: number }>();
  #refreshing: Promise<void> | undefined;
  #again = false;
  #timer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #retries = 0;
  /** Changes when the conversation is replaced, so work begun for the old one writes nothing afterwards. */
  #generation = 0;
  /** Changes on every subscription to worker events: events sent between two subscriptions may be missed. */
  #epoch = 0;
  #listeners: (() => void)[] = [];
  #stopped = false;

  constructor(deps: SandboxesDeps) {
    this.#deps = deps;
  }

  get view(): SandboxesView {
    return this.#view;
  }

  /** A sandbox environment by name; no name means the default one. */
  environment(name: string | undefined): SandboxEnvironmentView | undefined {
    const environments = this.#currentBase().environments;
    return name === undefined ? (environments.find((environment) => environment.default) ?? environments[0]) : environments.find((environment) => environment.name === name);
  }

  /** Whether a resumed (`sessionId`) or new (undefined) session can start sandboxes, for the agent's instructions. */
  async canStart(sessionId: string | undefined): Promise<boolean> {
    const managed = this.#deps.platform.managed;
    if (!this.#currentBase().enabled || !managed) return false;
    if (!sessionId) return true;
    return (await this.#sessionType(managed, sessionId).catch(() => undefined)) === "orchestrator";
  }

  /** Why the conversation can't start a sandbox right now, if it can't. */
  blocked(): string | undefined {
    const base = this.#currentBase();
    if (base.unavailable) return base.unavailable.reason;
    const sessionId = this.#deps.sessionId();
    const type = sessionId ? this.#types.get(sessionId) : undefined;
    return type !== undefined && type !== "orchestrator" ? SANDBOXES_LEGACY : undefined;
  }

  /** Follows worker events on this connection (call again after reconnecting: closing a connection drops them). */
  listen(managed: ManagedCopilot): void {
    for (const off of this.#listeners.splice(0)) off();
    this.#epoch++;
    // Events missed while disconnected (a publication, a finished run) are found by reading every sandbox again.
    this.#inspected.clear();
    this.#awaited.clear();
    const onWorker = (event: PlatformEvent) => this.#onWorkerEvent(event);
    for (const type of ["worker.started", "worker.idle", "worker.failed", "worker.stopped"] as const) this.#listeners.push(managed.on(type, onWorker));
    this.#listeners.push(managed.on("artifact.published", (event) => this.#onPublished(event)));
  }

  #onWorkerEvent(event: PlatformEvent): void {
    const sessionId = this.#deps.sessionId();
    if (!sessionId || event.sessionId !== sessionId) return;
    const { workerId, state } = event.data as { workerId?: unknown; state?: unknown };
    if (typeof workerId !== "string") return;
    // Events mostly prompt a fresh listing, which says how work ended. A finish is placed on a message only by a
    // listing that saw the sandbox working on it, asked for on the same subscription (see #place); any other (for
    // example one that arrives late, after the stream reconnected) is left to listings.
    if (state === "idle" || state === "failed") {
      const facts = this.#factsOf(workerId);
      facts.reported.push({ at: iso(event.createdAt), state, epoch: this.#epoch });
      if (facts.last) this.#place(facts, facts.last);
      this.#awaitPublication(workerId);
    }
    this.#dirty.add(workerId);
    this.schedule();
  }

  #onPublished(event: PlatformEvent): void {
    if (!event.sessionId) return;
    // Possibly a sandbox not listed yet: marking it costs nothing if it isn't one of this conversation's.
    this.#dirty.add(event.sessionId);
    if (this.#workers.length === 0 || this.#workers.some((worker) => worker.id === event.sessionId)) this.schedule();
  }

  /** A sandbox tool finished (for example a wait, which returns once outputs published): read every sandbox again. */
  changed(): void {
    for (const worker of this.#workers) this.#dirty.add(worker.id);
    this.schedule();
  }

  /**
   * Copies a finished sandbox's images as soon as they publish (publication follows the end of its run). The agent may
   * stop the sandbox right after reading its report, and stopping deletes its files, so this doesn't wait for the next
   * refresh. Bounded, and one wait per sandbox at a time.
   */
  #awaitPublication(workerId: string): void {
    const managed = this.#deps.platform.managed;
    const coordinatorId = this.#deps.sessionId();
    if (!managed || !coordinatorId || this.#stopped || this.#publishing.has(workerId)) return;
    const generation = this.#generation;
    const current = () => this.#current(coordinatorId, generation);
    this.#publishing.add(workerId);
    void (async () => {
      try {
        const publication = await managed.artifacts(workerId).waitForPublication({ timeoutMs: PUBLICATION_WAIT_MS });
        if (current()) await this.#record(managed, coordinatorId, workerId, publication.artifacts, current);
      } catch (error) {
        this.#deps.log.debug("Couldn't wait for a sandbox's outputs", { workerId, error: errorMessage(error) });
      } finally {
        this.#publishing.delete(workerId);
        if (current()) {
          this.#dirty.add(workerId);
          this.schedule();
        }
      }
    })();
  }

  /** Refreshes shortly, once for a burst of events and tool results. */
  schedule(delay = DEBOUNCE_MS): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh();
    }, delay);
    this.#timer.unref();
  }

  refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;
      return this.#refreshing;
    }
    const run: Promise<void> = (async () => {
      try {
        do {
          this.#again = false;
          await this.#refresh();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#refreshing = undefined;
      }
    })();
    this.#refreshing = run;
    return run;
  }

  /** Whether the conversation's environment can start sandboxes on this deployment (kept while disconnected). */
  #currentBase(): Base {
    const info = this.#deps.platform.managed?.info;
    if (!info) return this.#base;
    const coordinator = info.environments.find((environment) => environment.name === this.#deps.environment);
    if (!coordinator || coordinator.type !== "orchestrator") this.#base = { enabled: false, environments: [] };
    else {
      const environments = sandboxEnvironments(info, coordinator);
      this.#base = info.capabilities.includes("orchestrator")
        ? { enabled: true, environments, maxWorkers: coordinator.maxWorkers }
        : { enabled: false, unavailable: { reason: SANDBOXES_UNSUPPORTED }, environments, maxWorkers: coordinator.maxWorkers };
    }
    return this.#base;
  }

  async #sessionType(managed: ManagedCopilot, sessionId: string): Promise<string> {
    const known = this.#types.get(sessionId);
    if (known) return known;
    const { type } = await managed.sessions.get(sessionId);
    this.#types.set(sessionId, type);
    return type;
  }

  /** Whether work begun for `sessionId` in `generation` is still about the current conversation. */
  #current(sessionId: string, generation: number): boolean {
    return !this.#stopped && generation === this.#generation && sessionId === this.#deps.sessionId();
  }

  async #refresh(): Promise<void> {
    clearTimeout(this.#poll);
    this.#poll = undefined;
    const managed = this.#deps.platform.managed;
    const base = this.#currentBase();
    const sessionId = this.#deps.sessionId();
    if (!managed) return this.#set({ ...this.#view, ...base });
    if (!sessionId || !base.enabled) {
      this.#workers = [];
      return this.#set({ ...base, workers: [], runs: {} });
    }
    // The conversation may be replaced while this waits on the platform: then the next refresh does its work.
    const generation = this.#generation;
    const current = () => this.#current(sessionId, generation);
    try {
      const type = await this.#sessionType(managed, sessionId);
      if (!current()) return;
      if (type !== "orchestrator") {
        this.#workers = [];
        return this.#set({ ...base, enabled: false, unavailable: { reason: SANDBOXES_LEGACY, startOver: true }, workers: [], runs: {} });
      }
      const epoch = this.#epoch;
      const workers = await managed.workers(sessionId).list();
      if (!current()) return;
      this.#workers = workers;
      for (const worker of workers) this.#observe(worker, epoch);
      await Promise.all(workers.map((worker) => this.#inspect(managed, sessionId, worker, current)));
      if (!current()) return;
      this.#track(sessionId, workers);
      this.#set({ ...base, workers: this.#workerViews(sessionId, workers), runs: this.#runs(sessionId) });
      const busy = workers.some((worker) => worker.state === "starting" || worker.state === "working");
      const unread = workers.some((worker) => worker.state !== "stopped" && this.#dirty.has(worker.id));
      if (!unread) this.#retries = 0;
      const delay = busy ? BUSY_POLL_MS : unread && this.#retries < MAX_RETRIES ? RETRY_MS * 2 ** this.#retries++ : undefined;
      if (delay !== undefined) {
        this.#poll = setTimeout(() => void this.refresh(), delay);
        this.#poll.unref();
      }
    } catch (error) {
      if (!current()) return;
      this.#deps.log.debug("Couldn't refresh the sandboxes", { error: errorMessage(error) });
      // Keep showing what was known; try again shortly.
      this.#set({ ...this.#view, ...base, error: `Couldn't check your sandboxes: ${friendly(error)}` });
      this.schedule(RETRY_MS);
    }
  }

  /** Reads a sandbox's own state and published outputs when they may have changed, and copies new images. */
  async #inspect(managed: ManagedCopilot, coordinatorId: string, worker: WorkerInfo, current: () => boolean): Promise<void> {
    if (worker.state === "stopped") {
      this.#sandboxStates.delete(worker.id);
      return;
    }
    const busy = worker.state === "starting" || worker.state === "working";
    // A finished run's outputs may still be publishing (or published while events were missed): wait for them once.
    if (!busy && this.#awaited.get(worker.id) !== worker.updatedAt) {
      this.#awaited.set(worker.id, worker.updatedAt);
      this.#awaitPublication(worker.id);
    }
    if (!busy && !this.#dirty.has(worker.id) && this.#inspected.get(worker.id) === worker.updatedAt) return;
    this.#dirty.delete(worker.id);
    const [info, artifacts] = await Promise.all([
      managed.sessions.get(worker.id).catch(() => undefined),
      busy ? Promise.resolve(undefined) : managed.artifacts(worker.id).list({ versions: "all" }).catch(() => undefined),
    ]);
    if (!current()) return;
    if (info?.sandbox) this.#sandboxStates.set(worker.id, info.sandbox.state);
    if (busy) return;
    // What couldn't be read (its outputs' listing, or an image copy) is read again on a later refresh.
    if (!artifacts) return this.#unread(worker);
    if (await this.#record(managed, coordinatorId, worker.id, artifacts, current)) {
      this.#inspected.set(worker.id, worker.updatedAt);
      this.#failures.delete(worker.id);
    } else if (current()) this.#unread(worker);
  }

  /** A sandbox couldn't be read in full: read it again later, a few times at most until it changes or publishes. */
  #unread(worker: WorkerInfo): void {
    const before = this.#failures.get(worker.id);
    const count = before?.updatedAt === worker.updatedAt ? before.count + 1 : 1;
    this.#failures.set(worker.id, { updatedAt: worker.updatedAt, count });
    if (count < MAX_RETRIES) this.#dirty.add(worker.id);
    // Given up at this state: polls skip it until it changes or publishes again.
    else this.#inspected.set(worker.id, worker.updatedAt);
  }

  /**
   * Records a sandbox's published outputs and copies the images not copied yet. False if a copy failed, or the
   * conversation was replaced meanwhile (`current`), which stops it writing.
   */
  async #record(managed: ManagedCopilot, coordinatorId: string, workerId: string, artifacts: readonly ArtifactInfo[], current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    const published = artifacts.filter((artifact) => artifact.state === "published");
    this.#deps.store.recordOutputs(
      published.map((artifact) => ({
        artifactId: artifact.id,
        coordinatorId,
        workerId,
        path: artifact.path,
        version: artifact.version,
        size: artifact.size,
        contentType: artifact.contentType,
        publishedAt: artifact.publishedAt ? iso(artifact.publishedAt) : undefined,
      })),
    );
    let copied = true;
    for (const artifact of published) {
      if (!imageType(artifact.path, artifact.contentType) || artifact.size > MAX_IMAGE_BYTES || this.#deps.store.output(artifact.id)?.cached) continue;
      try {
        const bytes = await managed.artifacts(workerId).readBytes(artifact.path, { version: artifact.version });
        if (!current()) return false;
        this.#deps.store.cacheOutput(artifact.id, bytes);
      } catch (error) {
        copied = false;
        this.#deps.log.debug("Couldn't copy a sandbox image", { workerId, path: artifact.path, error: errorMessage(error) });
      }
    }
    return copied;
  }

  /** Starts timing the chat's cards that aren't timed yet (a card's work starts when its tool call returns). */
  #registerRuns(coordinatorId: string, workers: readonly WorkerInfo[]): void {
    for (const card of this.#deps.cards()) {
      if (card.status !== "succeeded") continue;
      this.#deps.store.startRun({ cardId: card.id, coordinatorId, workerName: card.worker, workerId: card.workerId ?? this.#workerFor(workers, card)?.id, startedAt: iso(card.endedAt ?? card.at) });
    }
  }

  #factsOf(workerId: string): WorkerFacts {
    let facts = this.#facts.get(workerId);
    if (!facts) this.#facts.set(workerId, (facts = { finished: new Map(), reported: [] }));
    return facts;
  }

  /**
   * A listing that saw the sandbox working on message m (since `at`) was asked for after its event subscription began,
   * and m was still unfinished then, so m's finish can't have been missed on that subscription: m's is the first
   * finish reported on it from `at` on (earlier messages finished before m started, and later ones can't start before
   * m ends). If that first one is from the very millisecond m started, it may be the previous message's, so which is
   * m's is left to listings. Finishes received on another subscription can't be placed by it: events between
   * subscriptions may be missed.
   */
  #place(facts: WorkerFacts, listed: Listed): void {
    if (listed.state !== "working" || listed.messages === 0 || facts.finished.has(listed.messages)) return;
    let first: Reported | undefined;
    for (const finish of facts.reported) if (finish.epoch === listed.epoch && finish.at >= listed.at && (!first || finish.at < first.at)) first = finish;
    if (first && first.at > listed.at) facts.finished.set(listed.messages, { at: first.at, state: first.state });
  }

  /** Remembers what a listing shows about a sandbox's messages: which one's work finished, when, and how. */
  #observe(worker: WorkerInfo, epoch: number): void {
    const facts = this.#factsOf(worker.id);
    const at = iso(worker.updatedAt);
    // A message the platform took back (it couldn't be delivered) never ran: forget what was said about it.
    for (const message of facts.finished.keys()) if (message > worker.messages) facts.finished.delete(message);
    if (worker.messages === 0 && (worker.state === "failed" || worker.state === "stopped")) facts.undelivered ??= { at, state: worker.state };
    else if (worker.messages > 0 && (worker.state === "idle" || worker.state === "failed") && !facts.finished.has(worker.messages)) {
      facts.finished.set(worker.messages, { at, state: worker.state });
    }
    // Stopped for good with a single message that an idle event reported finished: that ended the message, even if no
    // listing saw it working (it finished and was stopped just after a restart or a reconnect). Only work that ran
    // goes idle; a task the platform took back only fails, so an idle report can't be the delivery it replaced.
    const idle = facts.reported.find((finish) => finish.state === "idle" && finish.at <= at);
    if (idle && worker.state === "stopped" && worker.messages === 1 && !facts.finished.has(1)) facts.finished.set(1, { at: idle.at, state: "idle" });
    facts.last = { state: worker.state, messages: worker.messages, at, epoch };
    this.#place(facts, facts.last);
  }

  /**
   * Times each card's work: from its tool call until its sandbox finished the card's message. Cards are matched to
   * the sandbox's messages by number, never by comparing the platform's clock with the one that timed the cards (they
   * can differ); a time is only kept between its card's start and the next card's.
   */
  #track(coordinatorId: string, workers: readonly WorkerInfo[]): void {
    const store = this.#deps.store;
    this.#registerRuns(coordinatorId, workers);
    const byWorker = new Map<string, SandboxRunRecord[]>();
    for (const run of store.runs(coordinatorId)) if (run.workerId) byWorker.set(run.workerId, [...(byWorker.get(run.workerId) ?? []), run]);
    for (const [workerId, list] of byWorker) {
      const listing = workers.find((worker) => worker.id === workerId);
      const facts = this.#facts.get(workerId);
      // A start whose task never reached the sandbox has no message, so the cards after it count from the first.
      const shift = facts?.undelivered ? 1 : 0;
      list.forEach((run, index) => {
        if (run.finishedAt) return;
        const next = list[index + 1];
        const end = this.#endOf(index + 1 - shift, next, listing, facts);
        if (!end) return;
        let at = end.at > run.startedAt ? end.at : run.startedAt;
        if (next && at > next.startedAt) at = next.startedAt;
        store.finishRun(run.cardId, at, end.state);
      });
    }
  }

  /**
   * How the work for a card's message ended, as far as is known: as a listing (or the event right after one) saw it;
   * else by the next card, since a follow-up only reaches a sandbox that finished; else by the sandbox moving on or
   * being stopped for good, which cuts short what was under way.
   */
  #endOf(message: number, next: SandboxRunRecord | undefined, listing: WorkerInfo | undefined, facts: WorkerFacts | undefined): Finish | undefined {
    const seen = message === 0 ? facts?.undelivered : facts?.finished.get(message);
    if (seen) return seen;
    if (next) return { at: next.startedAt, state: "idle" };
    if (!listing) return undefined;
    if (listing.messages > message) return { at: iso(listing.updatedAt), state: "idle" };
    if (listing.state === "stopped") return { at: iso(listing.updatedAt), state: "stopped" };
    return undefined;
  }

  /** The sandbox a card is about when its tool result didn't name it: the newest one by that name started by then. */
  #workerFor(workers: readonly WorkerInfo[], card: WorkerItem): WorkerInfo | undefined {
    const by = Date.parse(card.endedAt ?? card.at) + 5_000;
    const named = workers.filter((worker) => worker.name === card.worker && Date.parse(worker.createdAt) <= by);
    const sameTask = card.action === "start" ? named.filter((worker) => worker.task.trim() === card.text.trim()) : [];
    return (sameTask.length > 0 ? sameTask : named).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  }

  #runs(coordinatorId: string): Record<string, SandboxRunView> {
    const runs: Record<string, SandboxRunView> = {};
    for (const run of this.#deps.store.runs(coordinatorId)) {
      runs[run.cardId] = { workerId: run.workerId, startedAt: run.startedAt, finishedAt: run.finishedAt, outcome: run.outcome };
    }
    return runs;
  }

  #workerViews(coordinatorId: string, workers: readonly WorkerInfo[]): SandboxWorkerView[] {
    const outputs = new Map<string, SandboxOutputView[]>();
    for (const record of this.#deps.store.outputs(coordinatorId)) {
      outputs.set(record.workerId, [...(outputs.get(record.workerId) ?? []), outputView(record)]);
    }
    return workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      environment: worker.environment,
      state: worker.state,
      messages: worker.messages,
      error: worker.error,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      sandboxState: worker.state === "stopped" ? undefined : this.#sandboxStates.get(worker.id),
      outputs: outputs.get(worker.id) ?? [],
    }));
  }

  #set(view: SandboxesView): void {
    const changed = JSON.stringify(view) !== JSON.stringify(this.#view);
    this.#view = view;
    if (changed) this.#deps.onChange(view);
  }

  /** Serves one published output: an image inline, anything else as a download. Only this conversation's. */
  async serveOutput(res: ServerResponse, artifactId: string): Promise<void> {
    const record = this.#deps.store.output(artifactId);
    if (!record || record.coordinatorId !== this.#deps.sessionId()) throw new HttpError(404, "not_found", "That file isn't available.");
    const image = imageType(record.path, record.contentType);
    let bytes = this.#deps.store.outputBytes(artifactId);
    if (!bytes) {
      const managed = this.#deps.platform.managed;
      if (!managed) throw new HttpError(503, "platform_unavailable", "Managed Copilot isn't connected.");
      if (record.size > (image ? MAX_IMAGE_BYTES : MAX_DOWNLOAD_BYTES)) throw new HttpError(413, "too_large", "That file is too large to open here.");
      try {
        bytes = await managed.artifacts(record.workerId).readBytes(record.path, { version: record.version });
      } catch (error) {
        if (isManagedCopilotError(error, "not_found")) throw new HttpError(410, "gone", "That sandbox was deleted, and its files with it.");
        throw new HttpError(502, "unavailable", `Couldn't get the file: ${friendly(error)}`);
      }
      if (image && bytes.length <= MAX_IMAGE_BYTES) this.#deps.store.cacheOutput(artifactId, bytes);
    }
    const name = record.path.split("/").pop() || "output";
    res.writeHead(200, {
      "content-type": image ?? "application/octet-stream",
      "content-length": bytes.length,
      "content-disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      // A sandbox wrote this file: opened on its own page it runs no script and can't reach this app.
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=86400",
    });
    res.end(bytes);
  }

  /** The conversation was replaced: its sandboxes went with it on the platform, so forget them here too. */
  reset(previousSessionId: string | undefined): void {
    this.#generation++;
    if (previousSessionId) this.#deps.store.clearSandboxes(previousSessionId);
    clearTimeout(this.#poll);
    this.#poll = undefined;
    this.#retries = 0;
    this.#workers = [];
    this.#inspected.clear();
    this.#awaited.clear();
    this.#facts.clear();
    this.#failures.clear();
    this.#dirty.clear();
    this.#sandboxStates.clear();
    this.#set({ ...this.#currentBase(), workers: [], runs: {} });
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#poll);
    for (const off of this.#listeners.splice(0)) off();
  }
}

export function outputView(record: SandboxOutputRecord): SandboxOutputView {
  return {
    id: record.artifactId,
    path: record.path,
    version: record.version,
    size: record.size,
    contentType: record.contentType,
    publishedAt: record.publishedAt,
    image: imageType(record.path, record.contentType) !== undefined && record.size <= MAX_IMAGE_BYTES,
    url: `/api/sandboxes/outputs/${encodeURIComponent(record.artifactId)}`,
  };
}
