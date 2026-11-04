// All of Data Desk's analyses: kept in its records, confirmed against Managed Copilot after every connection, and
// resumed there so their move requests and progress continue. Platform events reach the analysis they're about.
import type { DatasetSummary, DeskState, RowsPage, ServerEvent, AnalysisSummary, AnalysisView } from "../shared/types.js";
import { Analysis, type AnalysisHost } from "./analysis.js";
import { attachCommandTemplate, canLaunchTerminal } from "./attach.js";
import type { DeskConfig } from "./config.js";
import type { Datasets } from "./datasets.js";
import { DeskError, errorText, isMissingSession } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { DeskPlatform } from "./platform.js";
import type { Store } from "./store.js";

/** Analyses resumed right after connecting; others resume when opened. */
const ATTACH_ON_CONNECT = 8;
const MAX_PROMPT = 8_000;
const PUBLISH_MS = 100;
const LIST_MS = 300;
const PAGE_MAX = 500;

export class AnalysisManager implements AnalysisHost {
  readonly platform: DeskPlatform;
  readonly config: DeskConfig;
  readonly store: Store;
  readonly datasets: Datasets;
  readonly #hub: EventHub;
  readonly #analyses = new Map<string, Analysis>();
  readonly #publishing = new Map<string, NodeJS.Timeout>();
  #listTimer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(platform: DeskPlatform, config: DeskConfig, store: Store, datasets: Datasets, hub: EventHub) {
    this.platform = platform;
    this.config = config;
    this.store = store;
    this.datasets = datasets;
    this.#hub = hub;
  }

  start(): void {
    // Known analyses show right away, from Data Desk's records; the platform confirms them once connected.
    for (const stored of this.store.list()) this.#analyses.set(stored.id, new Analysis(this, stored.id));
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
      analyses: this.summaries(),
      attachCommand: attachCommandTemplate(this.config.attachUrl),
      canLaunchTerminal: canLaunchTerminal(),
      maxUploadBytes: this.datasets.maxBytes,
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
    const table = this.datasets.require(datasetId).table;
    const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, table.rows.length));
    const count = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 200, PAGE_MAX));
    return { offset: start, total: table.rows.length, rows: table.rows.slice(start, start + count) };
  }

  upload(name: string, bytes: Buffer): DatasetSummary {
    const dataset = this.datasets.add(name, bytes);
    this.#hub.publish({ type: "datasets", datasets: this.datasets.list() });
    return dataset.summary;
  }

  /** Starts an analysis of a dataset: a new session on the shared runtime. */
  async create(datasetId: string): Promise<AnalysisView> {
    this.#requireConnected();
    const dataset = this.datasets.require(datasetId);
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
