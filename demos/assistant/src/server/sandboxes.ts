/**
 * The conversation's sandboxes. The assistant's environment is an orchestrator (spec section 17), so its agent can
 * start workers: each one a session of an isolated environment, in its own sandbox. This module follows them with the
 * public SDK only, and never attaches a client to a worker (an attached client would answer the worker's prompts):
 *
 * - `managed.workers(session).list()` for each sandbox's state, refreshed on `worker.*` platform events, when the
 *   agent's sandbox tools finish, and every few seconds while one is working;
 * - `managed.sessions.get(worker.id)` for its sandbox, and `managed.artifacts(worker.id)` for the files it published
 *   from `/workspace/outputs`. Images are copied here, so charts stay in the chat after a sandbox is deleted;
 * - when each start or follow-up card's work ended, from those events and states (kept in the store, so the chat
 *   shows the same timings after a restart).
 */
import type { ServerResponse } from "node:http";
import { isManagedCopilotError, type ArtifactInfo, type ManagedCopilot, type PlatformEvent, type WorkerInfo } from "@managed-copilot/sdk";
import type { SandboxEnvironmentView, SandboxesView, SandboxOutputView, SandboxRunView, SandboxWorkerView, WorkerItem } from "../shared/protocol.js";
import { sandboxEnvironments } from "./environments.js";
import { HttpError } from "./http.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import type { SandboxOutputRecord, Store } from "./store.js";

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

export const SANDBOXES_LEGACY =
  "This conversation started before your assistant could use sandboxes. Start a new conversation (Settings → Start over) to use them.";
export const SANDBOXES_UNSUPPORTED = "This deployment can't run sandboxes, so your assistant works without them.";

const SETTLED = new Set(["idle", "failed", "stopped"]);
type Settled = "idle" | "failed" | "stopped";

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
  #refreshing: Promise<void> | undefined;
  #again = false;
  #timer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
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
    if (typeof state === "string" && SETTLED.has(state)) this.#deps.store.finishRuns(workerId, iso(event.createdAt), state as Settled);
    if (state === "idle" || state === "failed") this.#awaitPublication(workerId);
    this.#dirty.add(workerId);
    this.schedule();
  }

  #onPublished(event: PlatformEvent): void {
    if (!event.sessionId || !this.#workers.some((worker) => worker.id === event.sessionId)) return;
    this.#dirty.add(event.sessionId);
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
    this.#publishing.add(workerId);
    void (async () => {
      try {
        const publication = await managed.artifacts(workerId).waitForPublication({ timeoutMs: PUBLICATION_WAIT_MS });
        if (coordinatorId === this.#deps.sessionId()) await this.#record(managed, coordinatorId, workerId, publication.artifacts);
      } catch (error) {
        this.#deps.log.debug("Couldn't wait for a sandbox's outputs", { workerId, error: errorMessage(error) });
      } finally {
        this.#publishing.delete(workerId);
        this.#dirty.add(workerId);
        this.schedule();
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
    try {
      if ((await this.#sessionType(managed, sessionId)) !== "orchestrator") {
        this.#workers = [];
        return this.#set({ ...base, enabled: false, unavailable: { reason: SANDBOXES_LEGACY, startOver: true }, workers: [], runs: {} });
      }
      const workers = await managed.workers(sessionId).list();
      // The conversation was replaced meanwhile: its refresh is the next one's to do.
      if (sessionId !== this.#deps.sessionId() || this.#stopped) return;
      this.#workers = workers;
      await Promise.all(workers.map((worker) => this.#inspect(managed, sessionId, worker)));
      this.#track(sessionId, workers);
      this.#set({ ...base, workers: this.#workerViews(sessionId, workers), runs: this.#runs(sessionId) });
      const busy = workers.some((worker) => worker.state === "starting" || worker.state === "working");
      if (busy && !this.#stopped) {
        this.#poll = setTimeout(() => void this.refresh(), BUSY_POLL_MS);
        this.#poll.unref();
      }
    } catch (error) {
      this.#deps.log.debug("Couldn't refresh the sandboxes", { error: errorMessage(error) });
      // Keep showing what was known; try again shortly.
      this.#set({ ...this.#view, ...base, error: `Couldn't check your sandboxes: ${friendly(error)}` });
      this.schedule(RETRY_MS);
    }
  }

  /** Reads a sandbox's own state and published outputs when they may have changed, and copies new images. */
  async #inspect(managed: ManagedCopilot, coordinatorId: string, worker: WorkerInfo): Promise<void> {
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
    if (info?.sandbox) this.#sandboxStates.set(worker.id, info.sandbox.state);
    if (busy) return;
    if (!artifacts) {
      // Read again next time.
      this.#dirty.add(worker.id);
      return;
    }
    await this.#record(managed, coordinatorId, worker.id, artifacts);
    this.#inspected.set(worker.id, worker.updatedAt);
  }

  /** Records a sandbox's published outputs and copies the images not copied yet. */
  async #record(managed: ManagedCopilot, coordinatorId: string, workerId: string, artifacts: readonly ArtifactInfo[]): Promise<void> {
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
    for (const artifact of published) {
      if (!imageType(artifact.path, artifact.contentType) || artifact.size > MAX_IMAGE_BYTES || this.#deps.store.output(artifact.id)?.cached) continue;
      try {
        this.#deps.store.cacheOutput(artifact.id, await managed.artifacts(workerId).readBytes(artifact.path, { version: artifact.version }));
      } catch (error) {
        this.#deps.log.debug("Couldn't copy a sandbox image", { workerId, path: artifact.path, error: errorMessage(error) });
      }
    }
  }

  /** Times each card's work: from its tool call until its sandbox settled (events end it on time; states catch up). */
  #track(coordinatorId: string, workers: readonly WorkerInfo[]): void {
    const store = this.#deps.store;
    const cards = this.#deps.cards().filter((card) => card.status === "succeeded");
    for (const card of cards) {
      store.startRun({ cardId: card.id, coordinatorId, workerName: card.worker, workerId: card.workerId ?? this.#workerFor(workers, card)?.id, startedAt: iso(card.endedAt ?? card.at) });
    }
    // A follow-up reaches a sandbox only once it finished its earlier work, so an earlier card's work ended by then.
    const runs = store.runs(coordinatorId);
    const byWorker = new Map<string, typeof runs>();
    for (const run of runs) if (run.workerId) byWorker.set(run.workerId, [...(byWorker.get(run.workerId) ?? []), run]);
    for (const list of byWorker.values()) {
      for (let index = 0; index < list.length - 1; index++) {
        const run = list[index]!;
        if (!run.finishedAt) store.finishRun(run.cardId, list[index + 1]!.startedAt, "idle");
      }
    }
    for (const worker of workers) if (SETTLED.has(worker.state)) store.finishRuns(worker.id, iso(worker.updatedAt), worker.state as Settled);
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
    if (previousSessionId) this.#deps.store.clearSandboxes(previousSessionId);
    this.#workers = [];
    this.#inspected.clear();
    this.#awaited.clear();
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
