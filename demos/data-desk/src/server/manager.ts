// All of Data Desk's analyses: kept in its records, confirmed against Managed Copilot after every connection, and
// resumed there so their move requests and progress continue. Platform events reach the analysis they're about. An
// analysis's insight can be sent to Software Factory; the work orders it made are followed until they finish.
import { FACTORY_NOT_CONNECTED, STATUS_LABEL, workOrderLabel } from "../shared/factory.js";
import { analysisHref } from "../shared/routes.js";
import type { DatasetSummary, DeskState, RowsPage, SendToFactoryResponse, ServerEvent, AnalysisSummary, AnalysisView } from "../shared/types.js";
import { Analysis, type AnalysisHost } from "./analysis.js";
import { attachCommandTemplate, canLaunchTerminal } from "./attach.js";
import type { DeskConfig } from "./config.js";
import type { Datasets } from "./datasets.js";
import { DeskError, errorText, isMissingSession } from "./errors.js";
import { createFactory, FactoryTracker, nextRoutingNumber, ORIGIN_APP, ORIGIN_NAME, routingView, workOrderUrl, type FactoryClient } from "./factory.js";
import { composeHandoff, parseHandoffRequest } from "./handoff.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { DeskPlatform } from "./platform.js";
import type { Store, StoredRouting } from "./store.js";

/** Analyses resumed right after connecting; others resume when opened. */
const ATTACH_ON_CONNECT = 8;
const MAX_PROMPT = 8_000;
const PUBLISH_MS = 100;
const LIST_MS = 300;
const PAGE_MAX = 500;
const LABEL_MAX = 120;

/** What a work order says it came from: "<analysis title> · <dataset name>", once when they're the same. */
export function originLabel(title: string, datasetName: string): string {
  const label = title === datasetName ? title : `${title} · ${datasetName}`;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1).trimEnd()}…` : label;
}

export class AnalysisManager implements AnalysisHost {
  readonly platform: DeskPlatform;
  readonly config: DeskConfig;
  readonly store: Store;
  readonly datasets: Datasets;
  readonly factory: FactoryClient;
  readonly #hub: EventHub;
  readonly #analyses = new Map<string, Analysis>();
  readonly #publishing = new Map<string, NodeJS.Timeout>();
  readonly #tracker: FactoryTracker;
  /** Analyses with a hand-off to Software Factory under way. */
  readonly #sending = new Set<string>();
  #listTimer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(platform: DeskPlatform, config: DeskConfig, store: Store, datasets: Datasets, hub: EventHub, factory: FactoryClient = createFactory(config), factoryPollMs?: number) {
    this.platform = platform;
    this.config = config;
    this.store = store;
    this.datasets = datasets;
    this.factory = factory;
    this.#hub = hub;
    this.#tracker = new FactoryTracker(
      factory,
      store,
      (id) => {
        const analysis = this.#analyses.get(id);
        if (analysis) this.changed(analysis);
      },
      factoryPollMs,
    );
  }

  start(): void {
    // Known analyses show right away, from Data Desk's records; the platform confirms them once connected.
    for (const stored of this.store.list()) this.#analyses.set(stored.id, new Analysis(this, stored.id));
    this.#tracker.start();
    this.#unsubscribe.push(
      this.platform.onConnected(() => void this.sync()),
      this.platform.onStatus(() => {
        this.#hub.publish(this.#platformEvent());
        this.#publishList();
      }),
      this.platform.onEvent((event) => {
        const analysis = event.sessionId ? this.#analyses.get(event.sessionId) : undefined;
        analysis?.platformEvent(event);
      }),
    );
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#tracker.close();
    for (const timer of this.#publishing.values()) clearTimeout(timer);
    this.#publishing.clear();
    if (this.#listTimer) clearTimeout(this.#listTimer);
    await Promise.all([...this.#analyses.values()].map((analysis) => analysis.close()));
    this.store.flush();
  }

  /** After every (re)connection: sessions on the previous client are gone, and some may have been deleted elsewhere. */
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
    for (const analysis of this.#analyses.values()) analysis.detach();
    const before = new Set(this.#analyses.values());
    try {
      const existing = new Set((await this.platform.listSessions()).filter((session) => session.state !== "deleting" && session.state !== "deleted").map((session) => session.id));
      // The list is capped, so absence isn't deletion: look each missing analysis up, and drop only confirmed ones.
      for (const [id, analysis] of [...this.#analyses]) {
        if (existing.has(id) || !before.has(analysis) || !(await this.#confirmGone(id)) || this.#analyses.get(id) !== analysis) continue;
        log.info("An analysis no longer exists on Managed Copilot", { sessionId: id });
        analysis.dispose();
        this.gone(analysis);
      }
    } catch (error) {
      log.warn("Couldn't list analyses on Managed Copilot", { error: errorText(error) });
    }
    this.#publishList();
    for (const analysis of this.#sorted().slice(0, ATTACH_ON_CONNECT)) await analysis.attach();
    this.#publishList();
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

  #sorted(): Analysis[] {
    return [...this.#analyses.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  summaries(): AnalysisSummary[] {
    return this.#sorted().map((analysis) => analysis.summary());
  }

  state(): DeskState {
    return {
      platform: this.platform.status,
      environments: this.platform.environments,
      datasets: this.datasets.list(),
      remoteSamples: this.datasets.remoteSamples(),
      analyses: this.summaries(),
      attachCommand: attachCommandTemplate(this.config.attachUrl),
      canLaunchTerminal: canLaunchTerminal(),
      maxUploadBytes: this.datasets.maxBytes,
      factory: { configured: this.factory.configured, ...(this.factory.publicUrl ? { url: this.factory.publicUrl } : {}) },
    };
  }

  /** What a browser gets when it connects to the event stream. */
  initialEvents(): ServerEvent[] {
    return [this.#platformEvent(), { type: "analyses", analyses: this.summaries() }];
  }

  #platformEvent(): ServerEvent {
    return { type: "platform", platform: this.platform.status, environments: this.platform.environments };
  }

  #require(id: string): Analysis {
    const analysis = this.#analyses.get(id);
    if (!analysis) throw new DeskError("not_found", "There's no such analysis. It may have been deleted.", 404);
    return analysis;
  }

  #requireConnected(): void {
    if (this.platform.status.state !== "connected") throw new DeskError("platform_unavailable", this.platform.status.message ?? "Managed Copilot isn't connected yet.", 503);
  }

  rows(datasetId: string, offset: number, limit: number): RowsPage {
    const table = this.datasets.require(datasetId).table();
    const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, table.rows.length));
    const count = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 200, PAGE_MAX));
    return { offset: start, total: table.rows.length, rows: table.rows.slice(start, start + count) };
  }

  upload(name: string, bytes: Buffer): DatasetSummary {
    const dataset = this.datasets.add(name, bytes);
    this.#hub.publish({ type: "datasets", datasets: this.datasets.list() });
    return dataset.summary;
  }

  /** Starts an analysis of a dataset, or of a remote sample's fresh copy: a new session on the shared runtime. */
  async create(datasetId: string): Promise<AnalysisView> {
    this.#requireConnected();
    const dataset = await this.datasets.open(datasetId);
    // A remote sample's copy is kept the way an upload is, which may have dropped the oldest uploads.
    if (dataset.summary.id !== datasetId) this.#hub.publish({ type: "datasets", datasets: this.datasets.list() });
    const analysis = new Analysis(this);
    try {
      await analysis.start(dataset, (started) => this.#analyses.set(started.id, started));
    } catch (error) {
      throw error instanceof DeskError ? error : new DeskError("create_failed", `Couldn't start the analysis: ${errorText(error)}`, 502);
    }
    this.#publishList();
    return analysis.view();
  }

  /** An analysis with its transcript: resumed first if it isn't yet. */
  async view(id: string): Promise<AnalysisView> {
    const analysis = this.#require(id);
    if (this.platform.status.state === "connected") await analysis.attach();
    return analysis.view();
  }

  async send(id: string, prompt: unknown): Promise<void> {
    this.#requireConnected();
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) throw new DeskError("invalid_request", "Write a message first.");
    if (text.length > MAX_PROMPT) throw new DeskError("invalid_request", `Keep messages under ${MAX_PROMPT.toLocaleString("en-US")} characters.`);
    await this.#require(id).send(text);
  }

  answerMove(id: string, approve: boolean): AnalysisView {
    const analysis = this.#require(id);
    analysis.answerMove(approve);
    return analysis.view();
  }

  async stop(id: string): Promise<void> {
    this.#requireConnected();
    await this.#require(id).stop();
  }

  async delete(id: string): Promise<void> {
    this.#requireConnected();
    const analysis = this.#require(id);
    await analysis.delete();
    this.gone(analysis);
  }

  readOutput(id: string, path: string) {
    this.#requireConnected();
    return this.#require(id).readOutput(path);
  }

  /** Whether a session may be attached from Data Desk: one of its analyses. */
  owns(sessionId: string): boolean {
    return this.#analyses.has(sessionId);
  }

  /** Sending to Software Factory needs `SOFTWARE_FACTORY_URL`. */
  requireFactory(): void {
    if (!this.factory.configured) throw new DeskError("factory_unavailable", FACTORY_NOT_CONNECTED, 503);
  }

  /**
   * Sends what the person picked from an analysis to Software Factory as a new work order, with what to build, and
   * records it on the analysis. `appOrigin` is Data Desk's address as the person's browser sees it, for the link back.
   */
  async sendToFactory(id: string, body: unknown, appOrigin: string): Promise<SendToFactoryResponse> {
    this.requireFactory();
    const analysis = this.#require(id);
    const request = parseHandoffRequest(body);
    if (this.#sending.has(id)) throw new DeskError("busy", "This analysis is already sending something to Software Factory. Wait a moment.", 409);
    this.#sending.add(id);
    try {
      // The tables and the answer come from the session's history: load it first if the analysis isn't open yet.
      if (this.platform.status.state === "connected") await analysis.attach();
      const dataset = analysis.dataset;
      if (!dataset) throw new DeskError("not_found", "This analysis's dataset isn't available anymore, so there's nothing to send.", 404);
      const material = analysis.handoff();
      const link = `${appOrigin}/${analysisHref(id)}`;
      const handoff = await composeHandoff({ ...material, dataset, readOutput: (path) => analysis.readOutput(path), link }, request);
      const key = `${id}:${nextRoutingNumber(this.store.get(id)?.factory ?? [])}`;
      const order = await this.factory.create({
        title: request.title,
        brief: handoff.brief,
        maxReviewRounds: 2,
        origin: { app: ORIGIN_APP, name: ORIGIN_NAME, label: originLabel(analysis.summary().title, dataset.summary.name), url: link, key },
        context: handoff.files,
      });
      const sentAt = new Date().toISOString();
      const routing: StoredRouting = {
        workOrderId: order.id,
        number: order.number,
        title: order.title || request.title,
        url: workOrderUrl(this.factory.publicUrl ?? "", order.id),
        status: order.status,
        sentAt,
        items: [...handoff.items],
        key,
        ...(material.lastItemId ? { after: material.lastItemId } : {}),
      };
      this.store.update(id, (stored) => {
        // The tracker may have found it already (by its key) while the factory answered.
        stored.factory = [...(stored.factory ?? []).filter((existing) => existing.workOrderId !== order.id), routing];
        stored.updatedAt = sentAt;
      });
      // Recorded right away: the work order exists now, whatever happens to Data Desk next.
      this.store.flush();
      this.#tracker.follow();
      log.info("Sent an analysis to Software Factory", { sessionId: id, workOrder: workOrderLabel(order.number), status: STATUS_LABEL[order.status], files: handoff.files.length });
      this.changed(analysis);
      return { routing: routingView(routing), analysis: analysis.view() };
    } finally {
      this.#sending.delete(id);
    }
  }

  // AnalysisHost

  changed(analysis: Analysis): void {
    const id = analysis.id;
    if (!this.#publishing.has(id)) {
      const timer = setTimeout(() => {
        this.#publishing.delete(id);
        if (this.#analyses.get(id) !== analysis) return;
        this.#hub.publish({ type: "analysis", analysis: analysis.view() });
      }, PUBLISH_MS);
      timer.unref?.();
      this.#publishing.set(id, timer);
    }
    this.#publishList();
  }

  gone(analysis: Analysis): void {
    const id = analysis.id;
    if (this.#analyses.get(id) !== analysis) return;
    this.#analyses.delete(id);
    const timer = this.#publishing.get(id);
    if (timer) clearTimeout(timer);
    this.#publishing.delete(id);
    this.store.remove(id);
    this.#hub.publish({ type: "removed", id });
    this.#publishList();
  }

  #publishList(): void {
    if (this.#listTimer) return;
    this.#listTimer = setTimeout(() => {
      this.#listTimer = undefined;
      this.#hub.publish({ type: "analyses", analyses: this.summaries() });
    }, LIST_MS);
    this.#listTimer.unref?.();
  }
}
