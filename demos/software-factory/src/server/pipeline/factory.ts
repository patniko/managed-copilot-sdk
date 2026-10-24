import { randomUUID } from "node:crypto";
import { defineTool, type SessionConfig } from "@github/copilot-sdk";
import { isManagedCopilotError, type SessionInfo } from "@managed-copilot/sdk";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS, SANDBOX_SIZES } from "../../shared/environments.js";
import { findTemplate } from "../../shared/templates.js";
import {
  ACTIVE_WORK_ORDER_STATUSES,
  formatWorkOrderNumber,
  TERMINAL_STATION_STATUSES,
  type ActivityItem,
  type ArtifactFileView,
  type ArtifactIndex,
  type CreateWorkOrderRequest,
  type FactoryError,
  type NetworkView,
  type OutputManifest,
  type Plan,
  type PlanTask,
  type ReleaseSummary,
  type ReviewRecord,
  type Station,
  type StationKind,
  type StationRole,
  type TestReport,
  type TestSummary,
  type WorkOrder,
  type WorkOrderSummary,
} from "../../shared/types.js";
import type { FactoryConfig } from "../config.js";
import type { EventHub } from "../hub.js";
import { log } from "../log.js";
import type { FactoryPlatform, StationSession } from "../platform.js";
import type { StoredArtifact, FactoryStore } from "../store.js";
import { StationActivityMapper } from "./activity.js";
import { CancelledError, isPlatformInterruption, PlatformUnavailableError, StationError, toFactoryError } from "./errors.js";
import { factoryPermissions } from "./permissions.js";
import { PlanInputSchema, ReviewInputSchema, topologicalOrder, validatePlan, validateReview, type ValidReview } from "./plan.js";
import {
  buildPrompt,
  checkFailedPrompt,
  continuePrompt,
  fixPrompt,
  planPrompt,
  planRetryPrompt,
  releasePrompt,
  retryPrompt,
  reviewPrompt,
  reviewRetryPrompt,
} from "./prompts.js";
import { builderSeed, DEFAULT_SKILLS_ROOT, releaseSeed, type SeedFile, type TaskOutcome } from "./seed.js";
import { Semaphore } from "./semaphore.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MStation = Mutable<Station>;
type MWorkOrder = Mutable<Omit<WorkOrder, "stations">> & { stations: MStation[] };

/** Nudges per round when the factory check fails before the station gives up. */
const MAX_NUDGES = 2;
/** Artifacts the factory keeps in its own store for viewing, diffing, and the release (bytes). */
const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "json", "md", "markdown", "txt", "patch", "diff", "csv", "tsv", "yml", "yaml",
  "toml", "ini", "sh", "bash", "py", "rb", "go", "rs", "java", "cs", "html", "htm", "css", "scss", "xml", "svg", "sql", "env", "gitignore", "npmignore", "editorconfig", "lock", "log",
]);

const ROLE_FOR_KIND: Readonly<Record<StationKind, StationRole>> = { plan: "planner", build: "builder", review: "reviewer", release: "release" };

export function isTextPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) return ["README", "LICENSE", "Makefile", "Dockerfile"].some((known) => name.startsWith(known));
  return TEXT_EXTENSIONS.has(name.split(".").pop()!.toLowerCase());
}

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "json") return "application/json";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "patch" || ext === "diff") return "text/x-diff";
  if (["js", "mjs", "cjs"].includes(ext)) return "text/javascript";
  return isTextPath(path) ? "text/plain" : "application/octet-stream";
}

function now(): string {
  return new Date().toISOString();
}

/** "3 minutes", "30 seconds": for activity notes. */
function spokenDuration(ms: number): string {
  const [amount, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.max(1, Math.round(ms / 1000)), "second"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function networkView(policy: { access: NetworkView["access"]; allowedDomains: readonly string[] } | undefined): NetworkView {
  return { access: policy?.access ?? "enabled", allowedDomains: [...(policy?.allowedDomains ?? [])] };
}

export function describeNetwork(network: NetworkView): string {
  if (network.access === "disabled") return "network off";
  if (network.access === "enabled") return "open network";
  return `network limited to ${network.allowedDomains.join(", ")}`;
}

function summaryOf(report: TestReport, at = now()): TestSummary {
  return { ...report.summary, durationMs: report.durationMs, at };
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

interface Capture {
  plan?: Plan;
  review?: ValidReview;
}

interface ActiveSession {
  readonly session: StationSession;
  readonly mapper: StationActivityMapper;
  readonly capture: Capture;
}

interface Run {
  readonly wo: MWorkOrder;
  readonly abort: AbortController;
  readonly sessions: Map<string, ActiveSession>;
  /** Set once the run has finished; late asynchronous results must not touch the work order anymore. */
  closed: boolean;
  done: Promise<void>;
  /** A station lost its platform connection (see `#interrupts`); no failure was recorded for it. */
  interrupted: boolean;
  /** A station recorded a real failure, so the work order fails rather than pausing. */
  failed: boolean;
  /** The run ended paused at its checkpoint; the work order resumes when the platform is ready. */
  paused: boolean;
}

interface CheckOutcome {
  readonly passed: boolean;
  readonly code: string;
  readonly problem: string;
  readonly report?: TestReport;
  readonly manifest?: OutputManifest;
}

export interface FactoryOptions {
  readonly store: FactoryStore;
  readonly hub: EventHub;
  readonly platform: FactoryPlatform;
  /** Whether the platform can run work orders right now, with a user-facing reason when it can't. */
  readonly readiness: () => { readonly ready: boolean; readonly reason?: string };
  readonly account: () => { readonly login: string; readonly avatarUrl?: string } | undefined;
  readonly config: Pick<FactoryConfig, "maxSandboxes" | "turnTimeoutMs" | "publicationTimeoutMs">;
  readonly skillsRoot?: string;
  /** Poll interval while waiting for a resumed turn (tests shorten it). */
  readonly pollMs?: number;
  /**
   * Confirms the platform answers before a paused work order resumes on its own; resolves false (and starts
   * reconnecting) when it doesn't. Without it, readiness alone decides.
   */
  readonly checkPlatform?: () => Promise<boolean>;
  /** First delay before a paused work order resumes on its own; doubles per pause (tests shorten it). */
  readonly resumeBackoffMs?: number;
  /** How long a resumed in-flight turn may show no activity at all before it is stopped and continued (tests shorten it). */
  readonly stallMs?: number;
  /** How long a resumed turn whose sandbox restarted under it may stay silent before the agent is asked to continue. */
  readonly restartGraceMs?: number;
}

/** Pauses a work order may take for lost platform connections before the next one fails it instead. */
const MAX_AUTO_RESUMES = 5;
/** Detaching a session whose transport dropped can go unanswered; the run moves on after this long. */
const DETACH_TIMEOUT_MS = 5_000;
/** A resumed in-flight turn with no session events for this long is stuck (for example on a connection that died with a gateway). */
const STALL_MS = 3 * 60_000;
/** Silence allowed after reattaching before a turn whose sandbox restarted under it is taken as gone. */
const RESTART_GRACE_MS = 30_000;
/** Clock skew allowed between the factory (turn sent) and the gateway (sandbox started). */
const RESTART_MARGIN_MS = 5_000;
/** Stopping a stuck turn can go unanswered too. */
const ABORT_TIMEOUT_MS = 10_000;

/** Runs work orders through the factory: plan → parallel builds with review loops → release. */
export class Factory {
  readonly #options: FactoryOptions;
  readonly #runs = new Map<string, Run>();
  readonly #sandboxes: Semaphore;
  readonly #usageTimers = new Map<string, NodeJS.Timeout>();
  /** Work orders paused by a lost platform connection, and how many times. */
  readonly #pauses = new Map<string, number>();
  readonly #resumeTimers = new Map<string, NodeJS.Timeout>();
  #stopping = false;

  constructor(options: FactoryOptions) {
    this.#options = options;
    this.#sandboxes = new Semaphore(options.config.maxSandboxes);
  }

  get #store(): FactoryStore {
    return this.#options.store;
  }

  get #platform(): FactoryPlatform {
    return this.#options.platform;
  }

  // ─── Queries ────────────────────────────────────────────────────────────────────────────────────────────────

  get(id: string): WorkOrder | undefined {
    return this.#runs.get(id)?.wo ?? this.#store.getWorkOrder(id);
  }

  list(): WorkOrderSummary[] {
    return this.#store.listWorkOrders().map((stored) => toSummary(this.#runs.get(stored.id)?.wo ?? stored));
  }

  isActive(id: string): boolean {
    return this.#runs.has(id);
  }

  activity(id: string, stationId?: string): ActivityItem[] {
    return this.#store.listActivity(id, stationId);
  }

  artifactIndex(id: string): ArtifactIndex {
    const wo = this.get(id);
    const order = new Map((wo?.stations ?? []).map((station, index) => [station.id, index]));
    const files = new Map<string, Mutable<ArtifactFileView> & { versions: ArtifactFileView["versions"][number][] }>();
    for (const meta of this.#store.listArtifacts(id)) {
      const key = `${meta.stationId}\u0000${meta.path}`;
      let file = files.get(key);
      if (!file) {
        file = { stationId: meta.stationId, path: meta.path, contentType: meta.contentType, versions: [], viewable: meta.hasContent };
        files.set(key, file);
      }
      file.versions.push({
        version: meta.version,
        size: meta.size,
        digest: meta.digest,
        publishedAt: meta.publishedAt,
        round: meta.round,
        viewable: meta.hasContent,
      });
    }
    const sorted = [...files.values()].sort(
      (a, b) => (order.get(a.stationId) ?? 99) - (order.get(b.stationId) ?? 99) || a.path.localeCompare(b.path),
    );
    return { workOrderId: id, files: sorted };
  }

  artifact(id: string, stationId: string, path: string, version?: number): StoredArtifact | undefined {
    return this.#store.getArtifact(id, stationId, path, version);
  }

  /** The release bundle plus release notes, patch, and test report, for the zip download. */
  releaseFiles(id: string): { projectName: string; files: { path: string; content: string }[] } | undefined {
    const wo = this.get(id);
    if (!wo?.plan || !wo.release) return undefined;
    const files = [...this.#currentFiles(id, "release", "bundle/")].map(([path, content]) => ({ path: `${wo.plan!.projectName}/${path}`, content }));
    const latest = this.#store.latestArtifacts(id, "release");
    for (const name of ["RELEASE.md", "project.patch", "test-report.json"]) {
      const content = latest.find((candidate) => candidate.path === name)?.content;
      if (content !== undefined) files.push({ path: name, content });
    }
    return { projectName: wo.plan.projectName, files };
  }

  // ─── Commands ───────────────────────────────────────────────────────────────────────────────────────────────

  create(request: CreateWorkOrderRequest): WorkOrder {
    const title = request.title?.trim() ?? "";
    const brief = request.brief?.trim() ?? "";
    if (title.length < 3 || title.length > 120) throw new StationError("invalid_request", "Give the work order a title of 3 to 120 characters.");
    if (brief.length < 20 || brief.length > 8000) throw new StationError("invalid_request", "Describe the work in 20 to 8,000 characters.");
    const rounds = request.maxReviewRounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new StationError("invalid_request", "Review rounds must be 1, 2, or 3.");
    this.#requireReady();
    const template = findTemplate(request.templateId);
    const owner = this.#options.account();
    const created = now();
    const wo: MWorkOrder = {
      id: `wo_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      number: this.#store.nextWorkOrderNumber(),
      title,
      brief,
      source: template ? { kind: "template", templateId: template.id } : { kind: "brief" },
      maxReviewRounds: rounds,
      status: "queued",
      createdAt: created,
      updatedAt: created,
      taskCount: 0,
      stations: [this.#newStation("plan"), this.#newStation("release")],
      ...(owner ? { owner } : {}),
    };
    this.#store.saveWorkOrder(wo);
    log.info("Work order created", { id: wo.id, number: formatWorkOrderNumber(wo.number), title });
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  async cancel(id: string): Promise<WorkOrder> {
    const run = this.#runs.get(id);
    if (!run) {
      const stored = this.#store.getWorkOrder(id);
      if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status)) throw new StationError("conflict", "Only an active work order can be cancelled.");
      // Interrupted by a restart (or paused by a lost connection) and never resumed: cancel the record directly.
      const wo = stored as MWorkOrder;
      this.#forgetPause(id);
      this.#cancelStations(wo);
      Object.assign(wo, { status: "cancelled", completedAt: now() });
      this.#persist(wo);
      return wo;
    }
    run.abort.abort();
    await Promise.allSettled([...run.sessions.values()].map((active) => active.session.abort()));
    await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 15_000).unref())]);
    return this.get(id)!;
  }

  retry(id: string): WorkOrder {
    if (this.#runs.has(id)) throw new StationError("conflict", "This work order is still running.");
    const stored = this.#store.getWorkOrder(id);
    if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
    if (stored.status !== "failed" && stored.status !== "cancelled") throw new StationError("conflict", "Only a failed or cancelled work order can be retried.");
    this.#requireReady();
    const wo = stored as MWorkOrder;
    delete wo.error;
    delete wo.completedAt;
    wo.status = "queued";
    for (const station of wo.stations) {
      if (station.status === "failed" || station.status === "cancelled" || station.status === "skipped") {
        // A sandbox station that already has a session continues in it, starting with why it stopped.
        if (station.sessionId && station.turn && (station.kind === "build" || station.kind === "release")) {
          station.retryNote =
            station.status === "failed"
              ? (station.error?.message ?? "The previous attempt failed.")
              : "The work order was stopped before this station finished.";
        }
        station.status = "waiting";
        station.detail = "Queued for retry";
        delete station.error;
        delete station.finishedAt;
      }
    }
    this.#persist(wo);
    this.#activity(wo, "plan", "Retrying from the last checkpoint", "info");
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  /** Deletes the work order, its records, and (best effort) its platform sessions, sandboxes, and artifacts. */
  async delete(id: string): Promise<void> {
    if (this.#runs.has(id)) throw new StationError("conflict", "Cancel the work order before deleting it.");
    const wo = this.#store.getWorkOrder(id);
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    this.#forgetPause(id);
    this.#store.deleteWorkOrder(id);
    this.#options.hub.publish({ type: "workOrderDeleted", workOrderId: id });
    const sessionIds = wo.stations.flatMap((station) => [...(station.sessionId ? [station.sessionId] : []), ...(station.previousSessionIds ?? [])]);
    void Promise.allSettled(sessionIds.map((sessionId) => this.#platform.deleteSession(sessionId))).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) log.warn("Some sessions could not be deleted", { workOrder: id, failed });
    });
  }

  /**
   * Resumes work orders interrupted by a factory restart or paused by a lost platform connection. Call when the
   * platform becomes ready.
   */
  resumeInterrupted(): void {
    for (const stored of this.#store.listWorkOrders()) {
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status) || this.#runs.has(stored.id)) continue;
      this.#resume(stored as MWorkOrder);
    }
  }

  #resume(wo: MWorkOrder): void {
    const paused = this.#pauses.has(wo.id);
    const timer = this.#resumeTimers.get(wo.id);
    if (timer) clearTimeout(timer);
    this.#resumeTimers.delete(wo.id);
    log.info(paused ? "Resuming work order: the platform is back" : "Resuming work order after restart", { id: wo.id });
    const note = paused ? "Managed Copilot is back; resuming from the last checkpoint" : "The factory restarted; resuming from the last checkpoint";
    this.#activity(wo, "plan", note, "warning");
    this.#start(wo);
  }

  /**
   * Reconciles finished work orders with the platform's own session list (`managed.sessions.list()`): each station
   * shows its session's current state and sandbox, or that the session no longer exists. Pass `workOrderIds` to limit
   * it to some work orders.
   */
  async reconcileSessions(workOrderIds?: readonly string[]): Promise<void> {
    const candidates = (): MWorkOrder[] =>
      (this.#store.listWorkOrders() as MWorkOrder[]).filter((wo) => !this.#runs.has(wo.id) && (!workOrderIds || workOrderIds.includes(wo.id)));
    const sessions = new Map<string, SessionInfo>();
    try {
      for (const info of await this.#platform.listSessions()) sessions.set(info.id, info);
    } catch (error) {
      log.warn("Couldn't list platform sessions", { error: toFactoryError(error).message });
      return;
    }
    // The list is capped, so a missing session isn't necessarily gone: look each one up, and only a definitive
    // not_found marks it deleted. Confirmed deletions aren't looked up again; older `deleted` markers are rechecked.
    const missing = new Set<string>();
    for (const wo of candidates()) {
      for (const station of wo.stations) {
        if (station.sessionId && !sessions.has(station.sessionId) && !station.sessionGone) missing.add(station.sessionId);
      }
    }
    const goneIds = new Set<string>();
    const pending = [...missing];
    for (let index = 0; index < pending.length; index += 8) {
      await Promise.all(
        pending.slice(index, index + 8).map(async (sessionId) => {
          try {
            sessions.set(sessionId, await this.#platform.sessionInfo(sessionId));
          } catch (error) {
            if (isManagedCopilotError(error, "not_found")) goneIds.add(sessionId);
            else log.debug("Couldn't look up a session", { sessionId, error: (error as Error).message });
          }
        }),
      );
    }
    // No awaits from here on, so a work order can't start running while it's being updated.
    for (const wo of candidates()) {
      let changed = false;
      for (const station of wo.stations) {
        if (!station.sessionId) continue;
        const info = sessions.get(station.sessionId);
        const gone = goneIds.has(station.sessionId);
        const state = info?.state ?? (gone ? "deleted" : station.sessionState);
        if (station.sessionState !== state) {
          if (state === undefined) delete station.sessionState;
          else station.sessionState = state;
          changed = true;
        }
        if (gone && !station.sessionGone) {
          station.sessionGone = true;
          changed = true;
        } else if (info && station.sessionGone) {
          delete station.sessionGone;
          changed = true;
        }
        if (info?.sandbox && station.sandbox && station.sandbox.state !== info.sandbox.state) {
          station.sandbox = { ...station.sandbox, state: info.sandbox.state };
          changed = true;
        }
      }
      if (changed) this.#persist(wo);
    }
  }

  /**
   * Detaches from every running work order without recording failures, so `resumeInterrupted()` picks them up after
   * the next start. Accepted platform turns keep running while the factory is away.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    const runs = [...this.#runs.values()];
    for (const run of runs) {
      for (const active of run.sessions.values()) active.mapper.close();
      await Promise.allSettled([...run.sessions.values()].map((active) => active.session.disconnect()));
    }
    await Promise.race([Promise.allSettled(runs.map((run) => run.done)), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    for (const timer of this.#usageTimers.values()) clearTimeout(timer);
    for (const timer of this.#resumeTimers.values()) clearTimeout(timer);
  }

  // ─── Run loop ───────────────────────────────────────────────────────────────────────────────────────────────

  #requireReady(): void {
    const { ready, reason } = this.#options.readiness();
    if (!ready) throw new StationError("platform_unavailable", reason ?? "The Managed Copilot platform isn't ready.");
  }

  #start(wo: MWorkOrder): void {
    const run: Run = {
      wo,
      abort: new AbortController(),
      sessions: new Map(),
      closed: false,
      done: Promise.resolve(),
      interrupted: false,
      failed: false,
      paused: false,
    };
    this.#runs.set(wo.id, run);
    run.done = this.#execute(run).finally(() => this.#finish(run));
  }

  async #execute(run: Run): Promise<void> {
    const { wo } = run;
    try {
      if (!wo.plan) await this.#plan(run);
      this.#setWorkOrder(run, { status: "building" });
      await this.#buildAll(run);
      this.#setWorkOrder(run, { status: "releasing" });
      await this.#release(run);
      this.#setWorkOrder(run, { status: "completed", completedAt: now() });
      log.info("Work order completed", { id: wo.id, tests: wo.release?.tests });
    } catch (error) {
      if (this.#stopping) return;
      if (run.abort.signal.aborted || error instanceof CancelledError) {
        this.#cancelStations(wo);
        this.#setWorkOrder(run, { status: "cancelled", completedAt: now() });
        log.info("Work order cancelled", { id: wo.id });
      } else if (!run.failed && (run.interrupted || this.#interrupts(run, error))) {
        this.#pauseRun(run, error);
      } else {
        const failure = toFactoryError(error);
        for (const station of wo.stations) {
          if (!TERMINAL_STATION_STATUSES.includes(station.status) && station.status !== "changes_requested") {
            Object.assign(station, { status: "skipped", detail: "Skipped", finishedAt: station.startedAt ? now() : undefined });
          }
        }
        this.#setWorkOrder(run, { status: "failed", error: failure, completedAt: now() });
        log.warn("Work order failed", { id: wo.id, code: failure.code, message: failure.message });
      }
    }
  }

  async #finish(run: Run): Promise<void> {
    this.#runs.delete(run.wo.id);
    const timer = this.#usageTimers.get(run.wo.id);
    if (timer) clearTimeout(timer);
    // The next run of this work order (a resume or retry) schedules its own usage saves.
    this.#usageTimers.delete(run.wo.id);
    if (this.#stopping) return;
    this.#persist(run.wo);
    run.closed = true;
    await Promise.allSettled([...run.sessions.keys()].map((stationId) => this.#closeSession(run, stationId)));
    if (run.paused) {
      this.#resumeSoon(run.wo.id);
      return;
    }
    this.#pauses.delete(run.wo.id);
    // Record where each station's session ended up (sessions replaced or deleted during the run included).
    if (!this.#stopping) {
      await this.reconcileSessions([run.wo.id]).catch((error: unknown) => log.debug("Session reconciliation failed", { error: (error as Error).message }));
    }
  }

  #cancelStations(wo: MWorkOrder): void {
    for (const station of wo.stations) {
      if (!TERMINAL_STATION_STATUSES.includes(station.status)) {
        Object.assign(station, { status: "cancelled", detail: "Cancelled", ...(station.startedAt ? { finishedAt: now() } : {}) });
      }
    }
  }

  // ─── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────

  async #plan(run: Run): Promise<void> {
    const station = this.#station(run, "plan");
    this.#setWorkOrder(run, { status: "planning", startedAt: run.wo.startedAt ?? now() });
    try {
      const capture: Capture = {};
      const submitPlan = defineTool("submit_plan", {
        description: "Submit the work order's build plan to the factory. Returns 'Accepted' or the problems to fix before resubmitting.",
        parameters: PlanInputSchema,
        skipPermission: true,
        handler: async (args: unknown) => {
          const result = validatePlan(args);
          if (!result.ok) {
            this.#activity(run.wo, station.id, `Plan rejected: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} to fix`, "warning");
            return `Rejected. Fix these problems and call submit_plan again:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
          }
          capture.plan = result.value;
          return `Accepted: ${result.value.tasks.length} task(s). Builders are starting now.`;
        },
      });
      const active = await this.#openSharedSession(run, station, { tools: [submitPlan] }, capture);
      await this.#turn(run, station, active, planPrompt(run.wo), "work", 1);
      if (!capture.plan) await this.#turn(run, station, active, planRetryPrompt(), "nudge", 1);
      const plan = capture.plan;
      if (!plan) throw new StationError("plan_missing", "The planner didn't submit a plan.");
      const tasks = topologicalOrder(plan.tasks);
      run.wo.plan = plan;
      run.wo.taskCount = plan.tasks.length;
      run.wo.stations = [
        station,
        ...tasks.flatMap((task) => [this.#newStation("build", task), this.#newStation("review", task)]),
        this.#station(run, "release"),
      ];
      this.#updateStation(run, station, { status: "done", detail: `${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} planned`, finishedAt: now() });
      this.#activity(run.wo, station.id, `Plan accepted: ${plan.tasks.map((task) => task.title).join(" · ")}`, "success");
      await this.#closeSession(run, station.id);
    } catch (error) {
      await this.#failStation(run, station, error);
      throw error;
    }
  }

  // ─── Build and review ───────────────────────────────────────────────────────────────────────────────────────

  async #buildAll(run: Run): Promise<void> {
    const plan = run.wo.plan!;
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const running = new Map<string, Promise<void>>();
    const runTask = (task: PlanTask): Promise<void> => {
      const existing = running.get(task.id);
      if (existing) return existing;
      const promise = (async () => {
        if (task.dependsOn.length > 0) {
          const build = this.#station(run, `build:${task.id}`);
          if (build.status === "waiting") {
            const names = task.dependsOn.map((dep) => byId.get(dep)?.title ?? dep).join(", ");
            this.#updateStation(run, build, { detail: `Waiting for ${names}` });
          }
        }
        const settled = await Promise.allSettled(task.dependsOn.map((dep) => runTask(byId.get(dep)!)));
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) {
          // A dependency that lost its platform connection didn't fail: this task waits for the work order to resume.
          if (run.interrupted && !run.failed) throw rejected.reason;
          for (const id of [`build:${task.id}`, `review:${task.id}`]) {
            const station = this.#station(run, id);
            if (!TERMINAL_STATION_STATUSES.includes(station.status)) this.#updateStation(run, station, { status: "skipped", detail: "Skipped: a dependency failed" });
          }
          throw new StationError("dependency_failed", `Task "${task.id}" was skipped because a task it depends on failed.`);
        }
        await this.#buildTask(run, task);
      })();
      running.set(task.id, promise);
      return promise;
    };
    const results = await Promise.allSettled(plan.tasks.map(runTask));
    if (run.abort.signal.aborted) throw new CancelledError();
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    if (failures.length > 0) {
      const primary = failures.find((reason) => !(reason instanceof StationError && reason.code === "dependency_failed")) ?? failures[0];
      throw primary;
    }
  }

  #dependencyFiles(run: Run, task: PlanTask): Map<string, string> {
    // The whole dependency closure, ancestors first: a dependency publishes only its own changes, so a chain
    // (C needs B needs A) must also bring A's files.
    const byId = new Map(run.wo.plan!.tasks.map((item) => [item.id, item]));
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
      order.push(id);
    };
    for (const dep of task.dependsOn) visit(dep);
    const files = new Map<string, string>();
    for (const id of order) for (const [path, content] of this.#taskFiles(run, id)) files.set(path, content);
    return files;
  }

  /** The files a task currently publishes: its latest manifest's inventory, read from `outputs/files/**`. */
  #taskFiles(run: Run, taskId: string): Map<string, string> {
    return this.#currentFiles(run.wo.id, `build:${taskId}`, "files/");
  }

  /**
   * A station's current files under `prefix`, keyed by project path. The harness's latest manifest is the inventory,
   * so files deleted in a later round don't come back from the artifact history.
   */
  #currentFiles(workOrderId: string, stationId: string, prefix: string): Map<string, string> {
    const latest = new Map(this.#store.latestArtifacts(workOrderId, stationId).map((artifact) => [artifact.path, artifact]));
    const manifest = parseJson<OutputManifest>(latest.get("manifest.json")?.content);
    const paths = manifest
      ? manifest.files.map((file) => file.path)
      : [...latest.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    const files = new Map<string, string>();
    for (const path of paths) {
      const content = latest.get(`${prefix}${path}`)?.content;
      if (content !== undefined) files.set(path, content);
    }
    return files;
  }

  async #buildTask(run: Run, task: PlanTask): Promise<void> {
    const build = this.#station(run, `build:${task.id}`);
    const review = this.#station(run, `review:${task.id}`);
    if (review.status === "done") return;
    let current = build;
    if (build.status === "waiting") this.#updateStation(run, build, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.#sandboxes.acquire(run.abort.signal);
    try {
      const dependencyFiles = this.#dependencyFiles(run, task);
      const active = await this.#openSandboxSession(run, build, () => builderSeed(run.wo, run.wo.plan!, task, dependencyFiles, this.#skillsRoot));
      await this.#bringTurnCurrent(run, build, active, false, () => buildPrompt(run.wo, task, [...dependencyFiles.keys()]));

      let nudges = 0;
      for (;;) {
        current = build;
        let report: TestReport | undefined;
        if (build.passedRound !== build.round) {
          const outcome = await this.#collect(run, build, false);
          if (!outcome.passed) {
            if (nudges >= MAX_NUDGES) throw new StationError(outcome.code, `The builder couldn't get the factory check to pass: ${outcome.problem}`);
            nudges++;
            this.#activity(run.wo, build.id, `Check failed: ${outcome.problem}. Asking the builder to fix it.`, "warning");
            await this.#turn(run, build, active, checkFailedPrompt(outcome.problem, outcome.report, false), "nudge", build.round);
            continue;
          }
          report = outcome.report;
          this.#updateStation(run, build, {
            status: "done",
            passedRound: build.round,
            detail: `${report!.summary.passed} tests passed · in review`,
            finishedAt: now(),
          });
        } else {
          // This round already passed its check (a restart or retry stopped during review): review it as published.
          report = this.#latestReport(run, build.id);
          if (build.status !== "done") this.#updateStation(run, build, { status: "done", detail: "Tests passed · in review", finishedAt: build.finishedAt ?? now() });
        }

        current = review;
        const verdict = await this.#reviewRound(run, task, build, report, active.mapper.lastMessage);
        const passedTests = `${report?.summary.passed ?? build.tests?.passed ?? 0} tests passed`;
        if (verdict.verdict === "approve") {
          this.#updateStation(run, review, { status: "done", detail: `Approved in round ${build.round}`, finishedAt: now() });
          this.#updateStation(run, build, { detail: passedTests });
          return;
        }
        if (build.round >= run.wo.maxReviewRounds) {
          this.#updateStation(run, review, {
            status: "done",
            acceptedWithFindings: true,
            detail: `Accepted after ${build.round} rounds with findings open`,
            finishedAt: now(),
          });
          this.#updateStation(run, build, { detail: passedTests });
          this.#activity(run.wo, review.id, "Maximum review rounds reached: accepting the task and passing open findings to the release notes", "warning");
          return;
        }
        nudges = 0;
        current = build;
        this.#updateStation(run, build, { finishedAt: undefined });
        await this.#turn(run, build, active, fixPrompt(build.round + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary), "fix", build.round + 1);
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.#stopping) await this.#failStation(run, current, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.#stopping) {
        // Detach from finished stations; their sessions (and sandboxes) stay on the platform for history and attach.
        await this.#closeSession(run, build.id);
        await this.#closeSession(run, review.id);
      }
    }
  }

  /** Makes sure the station's latest turn has run: the first prompt, a retry note, or an in-flight turn after a restart. */
  async #bringTurnCurrent(run: Run, station: MStation, active: ActiveSession, release: boolean, firstPrompt: () => string): Promise<void> {
    if (!station.turn) {
      await this.#turn(run, station, active, firstPrompt(), "work", 1);
    } else if (station.retryNote) {
      const note = station.retryNote;
      this.#updateStation(run, station, { retryNote: undefined, passedRound: undefined });
      await this.#turn(run, station, active, retryPrompt(note, release), "retry", Math.max(station.round, 1));
    } else if (!station.turn.completedAt) {
      await this.#awaitTurn(run, station, active, release);
    }
  }

  #latestReport(run: Run, stationId: string): TestReport | undefined {
    return parseJson<TestReport>(this.#store.latestArtifacts(run.wo.id, stationId).find((artifact) => artifact.path === "test-report.json")?.content);
  }

  async #reviewRound(run: Run, task: PlanTask, build: MStation, report: TestReport | undefined, builderSummary: string | undefined): Promise<ValidReview> {
    const review = this.#station(run, `review:${task.id}`);
    const round = build.round;
    const existing = review.reviews?.find((record) => record.round === round);
    if (existing) return existing;
    let active = run.sessions.get(review.id);
    const capture: Capture = active?.capture ?? {};
    if (!active) {
      const submitReview = defineTool("submit_review", {
        description: "Submit your review verdict for the task. Returns 'Recorded' or the problems to fix before resubmitting.",
        parameters: ReviewInputSchema,
        skipPermission: true,
        handler: async (args: unknown) => {
          const result = validateReview(args);
          if (!result.ok) return `Rejected. Fix these problems and call submit_review again:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
          capture.review = result.value;
          return `Recorded: ${result.value.verdict === "approve" ? "approved" : "changes requested"}.`;
        },
      });
      active = await this.#openSharedSession(run, review, { tools: [submitReview] }, capture);
    }
    delete capture.review;
    const captured = (): ValidReview | undefined => capture.review;
    const files = [...this.#taskFiles(run, task.id)]
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => Number(/\.(test|spec)\./.test(a.path)) - Number(/\.(test|spec)\./.test(b.path)) || a.path.localeCompare(b.path));
    const previous = review.reviews?.at(-1)?.findings;
    this.#updateStation(run, review, { round, detail: `Reviewing round ${round}` });
    await this.#turn(run, review, active, reviewPrompt(task, round, run.wo.maxReviewRounds, { files, report, builderSummary }, previous), "review", round);
    if (!captured()) await this.#turn(run, review, active, reviewRetryPrompt(), "nudge", round);
    const verdict = captured();
    if (!verdict) throw new StationError("review_missing", "The reviewer didn't submit a verdict.");
    const record: ReviewRecord = { round, verdict: verdict.verdict, summary: verdict.summary, findings: verdict.findings, at: now() };
    this.#updateStation(run, review, { reviews: [...(review.reviews ?? []), record] });
    const blocking = verdict.findings.filter((finding) => finding.severity !== "minor").length;
    this.#emitItem(run.wo, {
      id: `${review.id}:review:${round}`,
      stationId: review.id,
      kind: "review",
      review: { round, verdict: verdict.verdict, findings: verdict.findings.length },
      text: verdict.summary,
      level: verdict.verdict === "approve" ? "success" : "warning",
    });
    if (verdict.verdict === "request_changes") {
      this.#updateStation(run, review, { status: "changes_requested", detail: `${blocking} finding${blocking === 1 ? "" : "s"} sent back to the builder` });
      this.#activity(run.wo, build.id, `Reviewer requested changes: ${blocking} finding${blocking === 1 ? "" : "s"} to fix`, "warning");
    }
    return verdict;
  }

  // ─── Release ────────────────────────────────────────────────────────────────────────────────────────────────

  async #release(run: Run): Promise<void> {
    const station = this.#station(run, "release");
    if (station.status === "done" && run.wo.release) return;
    const plan = run.wo.plan!;
    const outcomes: TaskOutcome[] = plan.tasks.map((task) => {
      const review = this.#station(run, `review:${task.id}`);
      return { task, reviews: review.reviews ?? [], acceptedWithFindings: Boolean(review.acceptedWithFindings), files: this.#taskFiles(run, task.id) };
    });
    const seed = releaseSeed(run.wo, plan, outcomes, this.#skillsRoot);
    this.#updateStation(run, station, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.#sandboxes.acquire(run.abort.signal);
    try {
      const active = await this.#openSandboxSession(run, station, () => [...seed.files]);
      await this.#bringTurnCurrent(run, station, active, true, () => releasePrompt(run.wo, plan, seed.conflicts));
      let nudges = 0;
      for (;;) {
        const outcome = await this.#collect(run, station, true);
        const latest = this.#store.latestArtifacts(run.wo.id, station.id);
        const notes = latest.find((artifact) => artifact.path === "RELEASE.md")?.content;
        const problem = !outcome.passed ? outcome.problem : notes ? undefined : "outputs/RELEASE.md is missing";
        if (problem) {
          if (nudges >= MAX_NUDGES) throw new StationError(outcome.passed ? "release_incomplete" : outcome.code, `The release couldn't be completed: ${problem}`);
          nudges++;
          this.#activity(run.wo, station.id, `Release check failed: ${problem}. Asking the release agent to fix it.`, "warning");
          await this.#turn(run, station, active, checkFailedPrompt(problem, outcome.report, true), "nudge", station.round);
          continue;
        }
        const manifest = outcome.manifest!;
        const patch = latest.find((artifact) => artifact.path === "project.patch");
        const release: ReleaseSummary = {
          files: manifest.files.length,
          bytes: manifest.files.reduce((total, file) => total + file.size, 0),
          tests: summaryOf(outcome.report!),
          ...(patch ? { patchBytes: patch.size } : {}),
          ...(notes ? { notes } : {}),
        };
        run.wo.release = release;
        this.#updateStation(run, station, { status: "done", detail: `Release ready · ${release.tests!.passed} tests passed`, finishedAt: now() });
        this.#activity(run.wo, station.id, `Release ready: ${release.files} files, ${release.tests!.passed} tests passed`, "success");
        return;
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.#stopping) await this.#failStation(run, station, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.#stopping) await this.#closeSession(run, station.id);
    }
  }

  // ─── Sessions and turns ─────────────────────────────────────────────────────────────────────────────────────

  get #skillsRoot(): string {
    return this.#options.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  }

  #sessionConfig(run: Run, station: MStation, mapper: StationActivityMapper, extra: Partial<SessionConfig>): SessionConfig {
    return {
      agent: station.agent,
      ...(station.model ? { model: station.model } : {}),
      streaming: true,
      onPermissionRequest: factoryPermissions(station.placement, (kind) => mapper.status(`Denied a "${kind}" request`, "warning")),
      onEvent: (event) => mapper.handle(event),
      ...extra,
    };
  }

  #newMapper(run: Run, station: MStation): StationActivityMapper {
    return new StationActivityMapper(run.wo.id, station.id, {
      item: (item) => this.#onItem(run, station, item),
      delta: (messageId, text) => this.#options.hub.publish({ type: "delta", workOrderId: run.wo.id, stationId: station.id, messageId, text }),
      tests: (tests) => this.#updateStation(run, station, { tests, detail: tests.failed > 0 ? `${tests.failed} of ${tests.total} tests failing` : `${tests.passed} tests passed` }),
      usage: (usage) => {
        if (run.closed) return;
        station.usage = usage;
        this.#scheduleUsageSave(run);
      },
    }, station.usage);
  }

  /** Office stations get a fresh shared session (cheap); earlier sessions are kept for history. */
  async #openSharedSession(run: Run, station: MStation, extra: Partial<SessionConfig>, capture: Capture): Promise<ActiveSession> {
    this.#throwIfCancelled(run);
    if (station.sessionId) station.previousSessionIds = [...(station.previousSessionIds ?? []), station.sessionId];
    this.#updateStation(run, station, {
      status: "starting",
      detail: "Opening a session",
      startedAt: station.startedAt ?? now(),
      model: this.#platform.models[station.role],
      sessionId: undefined,
      turn: undefined,
    });
    const mapper = this.#newMapper(run, station);
    const session = await this.#platform.createSession(station.role, this.#sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
    const active: ActiveSession = { session, mapper, capture };
    run.sessions.set(station.id, active);
    this.#updateStation(run, station, { sessionId: session.sessionId });
    mapper.status(`Session ${session.sessionId} opened on ${station.environment} (shared, no sandbox) with ${station.model}`);
    return active;
  }

  /** Sandbox stations resume their existing session when they have one, so a restart or retry keeps the workspace. */
  async #openSandboxSession(run: Run, station: MStation, seed: () => SeedFile[]): Promise<ActiveSession> {
    this.#throwIfCancelled(run);
    const existing = run.sessions.get(station.id);
    if (existing) return existing;
    if (station.sessionId) {
      const mapper = this.#newMapper(run, station);
      let session: StationSession | undefined;
      try {
        this.#updateStation(run, station, { status: "starting", detail: "Reattaching to the sandbox" });
        session = await this.#platform.resumeSession(station.role, station.sessionId, this.#sessionConfig(run, station, mapper, {}), (text) => mapper.status(text, "warning"));
      } catch (error) {
        // Events reaching an abandoned resume (one that answers after its deadline) don't belong on the floor.
        mapper.close();
        if (run.abort.signal.aborted) throw new CancelledError();
        // A dropped connection isn't a lost sandbox: keep the workspace and its checkpoint, whether the work order pauses
        // or (out of pauses) fails.
        if (this.#isInterruption(error)) throw error;
        // Starting over discards work, so it also needs a platform that answers right now. When it doesn't, the failure
        // is the outage's, and stays classified that way (the platform may be back by the time the station fails).
        if (!(await this.#platformAnswers())) throw new PlatformUnavailableError(toFactoryError(error).message);
        if (run.abort.signal.aborted) throw new CancelledError();
        if (this.#stopping) throw error;
        mapper.status(`Couldn't reattach to session ${station.sessionId} (${toFactoryError(error).message}); starting a fresh sandbox`, "warning");
        // The new sandbox starts over: its artifact versions restart at 1 and its rounds need fresh reviews.
        this.#store.deleteStationArtifacts(run.wo.id, station.id);
        station.previousSessionIds = [...(station.previousSessionIds ?? []), station.sessionId];
        this.#updateStation(run, station, {
          sessionId: undefined,
          turn: undefined,
          round: 0,
          sandbox: undefined,
          reportVersion: undefined,
          passedRound: undefined,
          retryNote: undefined,
          seeded: undefined,
          tests: undefined,
        });
        if (station.kind === "build" && station.taskId) {
          const review = this.#station(run, `review:${station.taskId}`);
          this.#updateStation(run, review, { status: "waiting", detail: "Waits for the build", reviews: undefined, round: 0, acceptedWithFindings: undefined });
        }
        this.#options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
      }
      if (session) {
        const active: ActiveSession = { session, mapper, capture: {} };
        run.sessions.set(station.id, active);
        await this.#refreshSandbox(run, station);
        mapper.status(`Reattached to session ${session.sessionId}`);
        // Seeding was interrupted before the first prompt: finish it (writes are idempotent).
        if (!station.seeded && !station.turn) await this.#seed(run, station, active, seed);
        return active;
      }
    }
    this.#updateStation(run, station, {
      status: "starting",
      detail: "Provisioning a sandbox",
      startedAt: station.startedAt ?? now(),
      model: this.#platform.models[station.role],
    });
    const mapper = this.#newMapper(run, station);
    const session = await this.#platform.createSession(station.role, this.#sessionConfig(run, station, mapper, {}), (text) => mapper.status(text, "warning"));
    const active: ActiveSession = { session, mapper, capture: {} };
    run.sessions.set(station.id, active);
    this.#updateStation(run, station, { sessionId: session.sessionId, seeded: false });
    await this.#refreshSandbox(run, station);
    const sandbox = station.sandbox;
    mapper.status(
      sandbox
        ? `Sandbox ${sandbox.id} ready: ${sandbox.size} (${SANDBOX_SIZES[sandbox.size].cpus} vCPU · ${SANDBOX_SIZES[sandbox.size].memoryGiB} GiB), ${describeNetwork(sandbox.network)}`
        : `Session ${session.sessionId} ready on ${station.environment}`,
    );
    await this.#seed(run, station, active, seed);
    return active;
  }

  /** Writes the station's seed files into its sandbox, then records the checkpoint. */
  async #seed(run: Run, station: MStation, active: ActiveSession, seed: () => SeedFile[]): Promise<void> {
    this.#updateStation(run, station, { status: "starting", detail: "Seeding the workspace" });
    const files = seed();
    const writer = this.#platform.files(active.session.sessionId);
    for (const file of files) await writer.write(file.path, file.content);
    this.#updateStation(run, station, { seeded: true });
    active.mapper.status(
      `Seeded ${files.length} files: ${files.map((file) => file.path).filter((path) => !path.startsWith(".factory/conflicts/")).slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`,
    );
  }

  async #refreshSandbox(run: Run, station: MStation): Promise<void> {
    if (!station.sessionId) return;
    try {
      const info = await this.#platform.sessionInfo(station.sessionId);
      if (info.id !== station.sessionId) return;
      const patch: Partial<MStation> = { sessionState: info.state, sessionGone: undefined };
      if (info.sandbox) {
        patch.sandbox = {
          id: info.sandbox.id,
          size: info.sandbox.size,
          state: info.sandbox.state,
          ...(info.sandbox.image ? { image: info.sandbox.image } : {}),
          network: networkView(info.sandbox.network),
          ...(info.sandbox.startedAt ? { startedAt: info.sandbox.startedAt } : {}),
        };
      }
      this.#updateStation(run, station, patch);
    } catch (error) {
      log.debug("Sandbox details unavailable", { station: station.id, error: (error as Error).message });
    }
  }

  async #closeSession(run: Run, stationId: string): Promise<void> {
    const active = run.sessions.get(stationId);
    if (!active) return;
    run.sessions.delete(stationId);
    active.mapper.close();
    // A dropped transport can leave the detach unanswered; the session stays on the platform either way.
    await Promise.race([
      active.session.disconnect().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, DETACH_TIMEOUT_MS).unref()),
    ]);
  }

  async #turn(run: Run, station: MStation, active: ActiveSession, prompt: string, kind: NonNullable<Station["turn"]>["kind"], round: number): Promise<void> {
    this.#throwIfCancelled(run);
    const detail = {
      work: "Working",
      fix: `Fixing review findings (round ${round})`,
      nudge: "Fixing the factory check",
      review: `Reviewing round ${round}`,
      retry: "Retrying",
      continue: "Continuing after an interruption",
    }[kind];
    this.#updateStation(run, station, {
      status: "working",
      detail,
      round,
      turn: { kind, round, sentAt: now() },
      startedAt: station.startedAt ?? now(),
    });
    const timeoutMs = this.#options.config.turnTimeoutMs[station.role];
    try {
      await active.session.sendAndWait({ prompt }, timeoutMs);
    } catch (error) {
      if (run.abort.signal.aborted) throw new CancelledError();
      if (/timeout|timed out/i.test((error as Error).message ?? "")) {
        await active.session.abort().catch(() => undefined);
        throw new StationError("timeout", `The ${station.agent} agent didn't finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
      }
      throw error;
    }
    this.#throwIfCancelled(run);
    this.#updateStation(run, station, { turn: { ...station.turn!, completedAt: now() } });
  }

  /**
   * Waits for a turn that was already running when the factory lost its connection or restarted. The platform's turn
   * status decides, except where it can't move on by itself:
   * - The session's sandbox started after the turn was sent (a gateway handover can recreate it), so the runtime that
   *   ran the turn is gone. Once nothing has happened for RESTART_GRACE_MS, the agent is asked to continue. Nothing is
   *   stopped: a turn that did survive finishes first, and the continue prompt queues behind it.
   * - No session event at all for STALL_MS, as with a turn stuck on a connection that died with the old gateway: the
   *   turn is stopped and the agent is asked to continue.
   * A turn the platform reports as failed or cancelled is continued too, rather than treated as complete.
   */
  async #awaitTurn(run: Run, station: MStation, active: ActiveSession, release: boolean): Promise<void> {
    this.#updateStation(run, station, { status: "working", detail: "Resuming the in-flight turn" });
    const deadline = Date.now() + this.#options.config.turnTimeoutMs[station.role];
    const pollMs = this.#options.pollMs ?? 3_000;
    const stallMs = this.#options.stallMs ?? STALL_MS;
    const graceMs = this.#options.restartGraceMs ?? RESTART_GRACE_MS;
    const sentAt = Date.parse(station.turn!.sentAt);
    let idle = false;
    let lastActivity = Date.now();
    let wake: (() => void) | undefined;
    const stopListening = active.session.on((event) => {
      lastActivity = Date.now();
      if (event.type === "session.idle" && !(event as { agentId?: string }).agentId) {
        idle = true;
        wake?.();
      }
    });
    const read = async (): Promise<SessionInfo | undefined> => {
      try {
        return await this.#platform.sessionInfo(active.session.sessionId);
      } catch (error) {
        // A slow or failed read while the platform is up is a blip: read again. With the platform down, the work order pauses.
        if (!isPlatformInterruption(error) || !this.#options.readiness().ready) throw error;
        log.debug("Couldn't read the in-flight turn's status; reading again", { station: station.id, error: (error as Error).message });
        return undefined;
      }
    };
    let outcome: "completed" | "running" | "failed" | "cancelled" | undefined;
    let stuck: "restarted" | "silent" | undefined;
    try {
      for (;;) {
        this.#throwIfCancelled(run);
        // Read after the idle event, so the platform's verdict on the turn includes it.
        const sawIdle = idle;
        const info = await read();
        if (info) {
          outcome = info.lastTurn?.status;
          if (outcome !== "running" || sawIdle) break;
          const quietMs = Date.now() - lastActivity;
          const sandboxStartedAt = Date.parse(info.sandbox?.startedAt ?? "");
          if (sandboxStartedAt > sentAt + RESTART_MARGIN_MS && quietMs >= graceMs) {
            stuck = "restarted";
            break;
          }
          if (quietMs >= stallMs) {
            stuck = "silent";
            break;
          }
        }
        if (Date.now() > deadline) throw new StationError("timeout", `The ${station.agent} agent didn't finish its turn in time.`);
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, pollMs);
        });
        wake = undefined;
      }
    } finally {
      stopListening();
    }
    if (stuck) {
      this.#activity(
        run.wo,
        station.id,
        stuck === "restarted"
          ? "The sandbox restarted while this turn was running, so the turn can't finish; asking the agent to continue from its workspace"
          : `The in-flight turn showed no activity for ${spokenDuration(stallMs)}; stopping it and asking the agent to continue`,
        "warning",
      );
      log.info("Continuing an in-flight turn that can't finish", { id: run.wo.id, station: station.id, reason: stuck });
      if (stuck === "silent") {
        await Promise.race([active.session.abort().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS).unref())]);
      }
      await this.#turn(run, station, active, continuePrompt(release), "continue", Math.max(station.round, 1));
      return;
    }
    if (outcome === "failed" || outcome === "cancelled") {
      this.#activity(run.wo, station.id, `The interrupted turn ${outcome === "failed" ? "failed" : "was stopped"}; asking the agent to continue`, "warning");
      await this.#turn(run, station, active, continuePrompt(release), "continue", Math.max(station.round, 1));
      return;
    }
    this.#updateStation(run, station, { turn: { ...station.turn!, completedAt: now() } });
  }

  // ─── Artifacts and checks ───────────────────────────────────────────────────────────────────────────────────

  async #collect(run: Run, station: MStation, release: boolean): Promise<CheckOutcome> {
    this.#updateStation(run, station, { status: "collecting", detail: "Collecting artifacts" });
    await this.#capturePublication(run, station);
    await this.#refreshSandbox(run, station);
    const latest = this.#store.latestArtifacts(run.wo.id, station.id);
    const reportArtifact = latest.find((artifact) => artifact.path === "test-report.json");
    const report = parseJson<TestReport>(reportArtifact?.content);
    const manifest = parseJson<OutputManifest>(latest.find((artifact) => artifact.path === "manifest.json")?.content);
    const previousVersion = station.reportVersion;
    if (reportArtifact) this.#updateStation(run, station, { reportVersion: reportArtifact.version });
    if (report) this.#updateStation(run, station, { tests: summaryOf(report, reportArtifact?.publishedAt) });
    const check = release ? "npm run check:release" : "npm run check";
    const fail = (code: string, problem: string): CheckOutcome => ({ passed: false, code, problem, ...(report ? { report } : {}), ...(manifest ? { manifest } : {}) });
    if (!report) return fail("no_test_report", `no test report was published (run \`${check}\`)`);
    if (previousVersion !== undefined && reportArtifact!.version === previousVersion) return fail("check_not_run", `\`${check}\` wasn't run after the latest changes`);
    if (report.summary.total === 0) return fail("no_tests", "no tests ran (name test files like test/<name>.test.js)");
    if (report.summary.failed > 0) return fail("tests_failed", `${report.summary.failed} of ${report.summary.total} tests failed`);
    if (report.summary.passed === 0) return fail("no_tests", "no test passed: every test was skipped");
    if (report.exitCode !== 0) return fail("tests_failed", `the test run exited with status ${report.exitCode}`);
    if (!manifest || manifest.files.length === 0) return fail("nothing_published", `no files were published (run \`${check}\`)`);
    return { passed: true, code: "ok", problem: "", report, manifest };
  }

  async #capturePublication(run: Run, station: MStation): Promise<void> {
    const sessionId = station.sessionId!;
    const artifacts = this.#platform.artifacts(sessionId);
    const publication = await artifacts.waitForPublication({ timeoutMs: this.#options.config.publicationTimeoutMs });
    if (publication.state === "failed") throw new StationError("publication_failed", publication.error ?? "The platform couldn't publish this turn's artifacts.");
    const list = await artifacts.list({ versions: "latest" });
    let added = 0;
    for (const info of list) {
      if (info.state !== "published" || this.#store.hasArtifact(run.wo.id, station.id, info.path, info.version)) continue;
      let content: string | undefined;
      if (isTextPath(info.path) && info.size <= MAX_TEXT_BYTES) {
        const text = await this.#readArtifact(artifacts, station, info.path, info.version);
        content = text.includes("\u0000") ? undefined : text;
      }
      this.#store.putArtifact({
        workOrderId: run.wo.id,
        stationId: station.id,
        path: info.path,
        version: info.version,
        round: station.round,
        size: info.size,
        digest: info.digest,
        contentType: info.contentType ?? contentTypeFor(info.path),
        publishedAt: info.publishedAt ?? now(),
        ...(content !== undefined ? { content } : {}),
      });
      added++;
    }
    if (added > 0) {
      this.#options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
      this.#emitItem(run.wo, { stationId: station.id, kind: "artifact", text: `Published ${added} file${added === 1 ? "" : "s"}`, level: "info" });
    }
  }

  /**
   * Downloads a text artifact, retrying transient failures. A file that can't be read fails the collection rather
   * than being recorded without content, so a retry downloads it again instead of silently dropping it.
   */
  async #readArtifact(artifacts: ReturnType<FactoryPlatform["artifacts"]>, station: MStation, path: string, version: number): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await artifacts.read(path, { version });
      } catch (error) {
        lastError = error;
        log.warn("Couldn't read artifact", { station: station.id, path, attempt, error: (error as Error).message });
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    // A lost connection pauses the work order instead of failing the collection.
    if (isPlatformInterruption(lastError)) throw lastError;
    throw new StationError("artifact_unavailable", `Couldn't download ${path} from the platform: ${toFactoryError(lastError).message}`);
  }

  // ─── State helpers ──────────────────────────────────────────────────────────────────────────────────────────

  #newStation(kind: StationKind, task?: PlanTask): MStation {
    const role = ROLE_FOR_KIND[kind];
    const title = { plan: "Plan", build: `Build · ${task?.title ?? ""}`, review: `Review · ${task?.title ?? ""}`, release: "Release" }[kind];
    const detail = { plan: "Queued", build: "Queued", review: "Waits for the build", release: "Waits for every task" }[kind];
    return {
      id: task ? `${kind}:${task.id}` : kind,
      kind,
      title,
      ...(task ? { taskId: task.id } : {}),
      status: "waiting",
      detail,
      role,
      environment: FACTORY_ENVIRONMENTS[role],
      placement: role === "planner" || role === "reviewer" ? "shared" : "sandbox",
      agent: ROLE_AGENTS[role],
      model: this.#platform.models[role],
      round: 0,
    };
  }

  #station(run: Run, id: string): MStation {
    const station = run.wo.stations.find((candidate) => candidate.id === id);
    if (!station) throw new StationError("internal", `Unknown station ${id}`);
    return station;
  }

  #throwIfCancelled(run: Run): void {
    if (run.abort.signal.aborted) throw new CancelledError();
  }

  async #failStation(run: Run, station: MStation, error: unknown): Promise<void> {
    const interrupted = await this.#interruptedBy(run, error);
    // A cancel (or shutdown) that came while the platform was being checked decides instead.
    if (run.abort.signal.aborted || this.#stopping) return;
    if (interrupted) {
      // Not a failure: the work order pauses at its checkpoint and resumes when the platform is back (#pauseRun).
      run.interrupted = true;
      return;
    }
    run.failed = true;
    const failure: FactoryError = toFactoryError(error);
    this.#updateStation(run, station, { status: "failed", error: failure, detail: failure.message, finishedAt: now() });
    this.#emitItem(run.wo, { stationId: station.id, kind: "error", text: failure.message, level: "error" });
  }

  /** Whether an error is the platform connection dropping (or the platform being down) rather than the station's own failure. */
  #isInterruption(error: unknown): boolean {
    if (this.#stopping || error instanceof CancelledError) return false;
    return isPlatformInterruption(error) || !this.#options.readiness().ready;
  }

  /** Whether the work order pauses for an interruption: after MAX_AUTO_RESUMES pauses, the next one fails it instead. */
  #interrupts(run: Run, error: unknown): boolean {
    return this.#canPause(run, error) && this.#isInterruption(error);
  }

  /** A cancel by the user (or a shutdown) is never a pause, and pauses are budgeted. */
  #canPause(run: Run, error: unknown): boolean {
    if (this.#stopping || run.abort.signal.aborted || error instanceof CancelledError) return false;
    return (this.#pauses.get(run.wo.id) ?? 0) < MAX_AUTO_RESUMES;
  }

  /**
   * `#interrupts`, plus: a platform error the classifier doesn't know is the outage's too when the platform doesn't
   * answer right now (FactoryOptions.checkPlatform). The factory's own verdicts (StationError) are taken as given.
   */
  async #interruptedBy(run: Run, error: unknown): Promise<boolean> {
    if (this.#interrupts(run, error)) return true;
    if (error instanceof StationError || !this.#canPause(run, error)) return false;
    return !(await this.#platformAnswers());
  }

  /** Whether the platform answers right now. Assumed when there's no check (tests). */
  async #platformAnswers(): Promise<boolean> {
    if (!this.#options.readiness().ready) return false;
    return this.#options.checkPlatform ? await this.#options.checkPlatform().catch(() => false) : true;
  }

  /** Leaves an interrupted work order at its checkpoint: running stations wait, and nothing is marked failed. */
  #pauseRun(run: Run, error: unknown): void {
    const { wo } = run;
    run.paused = true;
    this.#pauses.set(wo.id, (this.#pauses.get(wo.id) ?? 0) + 1);
    const text = error instanceof Error ? error.message : String(error);
    const reason = (/\[managed-copilot\]\s*([^\n]+)/.exec(text)?.[1] ?? text.split("\n")[0] ?? "").replace(/[.\s]+$/, "") || "the connection dropped";
    const note = `Paused: lost the connection to Managed Copilot (${reason}). Continues from its last checkpoint once the platform is back.`;
    const active = wo.stations.filter((station) => station.status === "starting" || station.status === "working" || station.status === "collecting");
    for (const station of active) {
      Object.assign(station, { status: "waiting", detail: "Paused until Managed Copilot is back" });
      this.#activity(wo, station.id, note, "warning");
    }
    if (active.length === 0) this.#activity(wo, "plan", note, "warning");
    this.#setWorkOrder(run, {});
    log.warn("Work order paused: lost the platform connection", { id: wo.id, pauses: this.#pauses.get(wo.id), reason });
  }

  /**
   * Resumes a paused work order by itself once the platform answers. While the platform is down, its return to ready
   * resumes the work order instead (main.ts calls `resumeInterrupted`).
   */
  #resumeSoon(id: string): void {
    if (this.#stopping) return;
    const pauses = this.#pauses.get(id) ?? 1;
    const delay = Math.min((this.#options.resumeBackoffMs ?? 1_000) * 2 ** (pauses - 1), 30_000);
    const existing = this.#resumeTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.#resumePaused(id), delay);
    timer.unref();
    this.#resumeTimers.set(id, timer);
  }

  async #resumePaused(id: string): Promise<void> {
    this.#resumeTimers.delete(id);
    if (!this.#resumable(id) || !this.#options.readiness().ready) return;
    if (this.#options.checkPlatform && !(await this.#options.checkPlatform())) return;
    const wo = this.#resumable(id);
    if (wo && this.#options.readiness().ready) this.#resume(wo);
  }

  /** The stored work order when it's still active and nothing runs it (it may have been cancelled or deleted meanwhile). */
  #resumable(id: string): MWorkOrder | undefined {
    if (this.#stopping || this.#runs.has(id)) return undefined;
    const stored = this.#store.getWorkOrder(id);
    return stored && ACTIVE_WORK_ORDER_STATUSES.includes(stored.status) ? (stored as MWorkOrder) : undefined;
  }

  #forgetPause(id: string): void {
    this.#pauses.delete(id);
    const timer = this.#resumeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#resumeTimers.delete(id);
  }

  #updateStation(run: Run, station: MStation, patch: Partial<MStation>): void {
    if (run.closed) return;
    // Session-derived state describes the old session once the station moves to another one.
    if ("sessionId" in patch && patch.sessionId !== station.sessionId) {
      if (!("sessionState" in patch)) delete station.sessionState;
      if (!("sessionGone" in patch)) delete station.sessionGone;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (station as Record<string, unknown>)[key];
      else (station as Record<string, unknown>)[key] = value;
    }
    this.#persist(run.wo);
  }

  #setWorkOrder(run: Run, patch: Partial<MWorkOrder>): void {
    if (run.closed) return;
    Object.assign(run.wo, patch);
    this.#persist(run.wo);
  }

  #persist(wo: MWorkOrder): void {
    // While stopping, the stored state is the checkpoint the next start resumes from: leave it untouched.
    if (this.#stopping) return;
    wo.updatedAt = now();
    const releaseTests = wo.release?.tests ?? wo.stations.find((station) => station.kind === "release")?.tests;
    const buildTests = wo.stations.filter((station) => station.kind === "build" && station.tests).map((station) => station.tests!);
    const tests: TestSummary | undefined =
      releaseTests ??
      (buildTests.length > 0
        ? buildTests.reduce((sum, item) => ({
            total: sum.total + item.total,
            passed: sum.passed + item.passed,
            failed: sum.failed + item.failed,
            skipped: sum.skipped + item.skipped,
            at: item.at > sum.at ? item.at : sum.at,
          }))
        : undefined);
    if (tests) wo.tests = tests;
    this.#store.saveWorkOrder(wo);
    this.#options.hub.publish({ type: "workOrder", workOrder: wo });
  }

  #scheduleUsageSave(run: Run): void {
    if (run.closed || this.#usageTimers.has(run.wo.id)) return;
    const timer = setTimeout(() => {
      this.#usageTimers.delete(run.wo.id);
      // A finished (or paused) run's snapshot must never overwrite the work order a later run is updating.
      if (!run.closed) this.#persist(run.wo);
    }, 1_500);
    timer.unref();
    this.#usageTimers.set(run.wo.id, timer);
  }

  #onItem(run: Run, station: MStation, item: ActivityItem): void {
    if (this.#stopping) return;
    this.#store.upsertActivity(item);
    this.#options.hub.publish({ type: "activity", item });
    if (station.status !== "working") return;
    if (item.kind === "intent" && item.text) this.#updateStation(run, station, { detail: item.text });
    else if (item.kind === "tool" && item.tool?.status === "running" && /npm run check|check\.mjs/.test(item.tool.summary)) {
      this.#updateStation(run, station, { detail: "Running the factory check" });
    }
  }

  #emitItem(wo: Pick<WorkOrder, "id">, partial: Omit<ActivityItem, "id" | "workOrderId" | "at"> & { id?: string }): void {
    if (this.#stopping) return;
    const item: ActivityItem = { ...partial, id: partial.id ?? `${partial.stationId}:${randomUUID()}`, workOrderId: wo.id, at: now() };
    this.#store.upsertActivity(item);
    this.#options.hub.publish({ type: "activity", item });
  }

  #activity(wo: Pick<WorkOrder, "id">, stationId: string, text: string, level: ActivityItem["level"]): void {
    this.#emitItem(wo, { stationId, kind: "status", text, level });
  }
}

export function toSummary(wo: WorkOrder): WorkOrderSummary {
  return {
    id: wo.id,
    number: wo.number,
    title: wo.title,
    status: wo.status,
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    ...(wo.startedAt ? { startedAt: wo.startedAt } : {}),
    ...(wo.completedAt ? { completedAt: wo.completedAt } : {}),
    taskCount: wo.taskCount,
    ...(wo.tests ? { tests: wo.tests } : {}),
    ...(wo.error ? { error: wo.error } : {}),
  };
}
