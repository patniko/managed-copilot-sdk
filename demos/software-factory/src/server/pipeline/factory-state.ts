import { randomUUID } from "node:crypto";
import type { SessionConfig } from "@github/copilot-sdk";
import type { ArtifactInfo, SessionInfo } from "@managed-copilot/sdk";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS, SANDBOX_SIZES } from "../../shared/environments.js";
import {
  ACTIVE_WORK_ORDER_STATUSES,
  mediaTypeOf,
  type ActivityItem,
  type FactoryError,
  type OutputManifest,
  type PlanTask,
  type Station,
  type StationKind,
  type TestReport,
  type TestSummary,
  type WorkOrder,
} from "../../shared/types.js";
import type { GitHubApi } from "../github.js";
import { log } from "../log.js";
import type { FactoryPlatform, StationSession } from "../platform.js";
import type { FactoryStore } from "../store.js";
import { StationActivityMapper } from "./activity.js";
import { CancelledError, isPlatformInterruption, PlatformUnavailableError, StationError, toFactoryError } from "./errors.js";
import type { LoadedInputs } from "./inputs.js";
import { factoryPermissions } from "./permissions.js";
import type { ValidReview } from "./plan.js";
import { continuePrompt, type WorkspaceNotes } from "./prompts.js";
import { DEFAULT_SKILLS_ROOT, type SeedFile, type TaskOutcome } from "./seed.js";
import { Semaphore } from "./semaphore.js";
import { MAX_MEDIA_BYTES } from "./repo.js";
import {
  ABORT_TIMEOUT_MS,
  type ActiveSession,
  type Capture,
  type CheckOutcome,
  contentTypeFor,
  describeNetwork,
  DETACH_TIMEOUT_MS,
  type FactoryOptions,
  isTextPath,
  MAX_AUTO_RESUMES,
  MAX_READ_FAILURES,
  MAX_TEXT_BYTES,
  type MStation,
  type MWorkOrder,
  networkView,
  now,
  parseJson,
  RESTART_GRACE_MS,
  RESTART_MARGIN_MS,
  ROLE_FOR_KIND,
  type Run,
  spokenDuration,
  STALL_MS,
  summaryOf,
} from "./factory-shared.js";

/** Factory state shared by every stage: run bookkeeping, station sessions and turns, artifacts, pauses, and persistence. */
export abstract class FactoryState {
  protected readonly options: FactoryOptions;
  protected readonly runs = new Map<string, Run>();
  protected readonly cancelling = new Set<string>();
  protected readonly sandboxes: Semaphore;
  protected readonly usageTimers = new Map<string, NodeJS.Timeout>();
  /** Work orders paused by a lost platform connection, and how many times. */
  protected readonly pauses = new Map<string, number>();
  protected readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  protected stopping = false;

  constructor(options: FactoryOptions) {
    this.options = options;
    this.sandboxes = new Semaphore(options.config.maxSandboxes);
  }

  protected get store(): FactoryStore {
    return this.options.store;
  }

  protected get platform(): FactoryPlatform {
    return this.options.platform;
  }

  // Implemented by the stages layered on top.
  protected abstract inputs(run: Run): LoadedInputs | undefined;
  protected abstract notes(run: Run): WorkspaceNotes | undefined;
  protected abstract review(run: Run, review: MStation, build: MStation, round: number, prompt: () => string, label?: number): Promise<ValidReview>;
  protected abstract requireGitHub(): GitHubApi;
  protected abstract loadPullRequest(wo: MWorkOrder): Promise<void>;
  protected abstract dependencyFiles(run: Run, task: PlanTask): Map<string, string>;
  protected abstract acceptRelease(run: Run, station: MStation, outcome: CheckOutcome): void;
  protected abstract reviewRound(run: Run, task: PlanTask, build: MStation, report: TestReport | undefined, builderSummary: string | undefined, reuse?: boolean): Promise<ValidReview>;
  protected abstract latestReport(run: Run, stationId: string): TestReport | undefined;
  protected abstract outcomes(run: Run): TaskOutcome[];
  protected abstract resume(wo: MWorkOrder): void;
  abstract isActive(id: string): boolean;

  // ─── Sessions and turns ─────────────────────────────────────────────────────────────────────────────────────

  protected get skillsRoot(): string {
    return this.options.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  }

  protected sessionConfig(run: Run, station: MStation, mapper: StationActivityMapper, extra: Partial<SessionConfig>): SessionConfig {
    return {
      agent: station.agent,
      ...(station.model ? { model: station.model } : {}),
      streaming: true,
      onPermissionRequest: factoryPermissions(station.placement, (kind) => mapper.status(`Denied a "${kind}" request`, "warning")),
      onEvent: (event) => mapper.handle(event),
      ...extra,
    };
  }

  protected newMapper(run: Run, station: MStation): StationActivityMapper {
    return new StationActivityMapper(run.wo.id, station.id, {
      item: (item) => this.onItem(run, station, item),
      delta: (messageId, text) => this.options.hub.publish({ type: "delta", workOrderId: run.wo.id, stationId: station.id, messageId, text }),
      tests: (tests) => this.updateStation(run, station, { tests, detail: tests.failed > 0 ? `${tests.failed} of ${tests.total} tests failing` : `${tests.passed} tests passed` }),
      usage: (usage) => {
        if (run.closed) return;
        station.usage = usage;
        this.scheduleUsageSave(run);
      },
    }, station.usage);
  }

  /** Office stations get a fresh shared session (cheap); earlier sessions are kept for history. */
  protected async openSharedSession(run: Run, station: MStation, extra: Partial<SessionConfig>, capture: Capture): Promise<ActiveSession> {
    this.throwIfCancelled(run);
    if (station.sessionId) station.previousSessionIds = [...(station.previousSessionIds ?? []), station.sessionId];
    this.updateStation(run, station, {
      status: "starting",
      detail: "Opening a session",
      startedAt: station.startedAt ?? now(),
      model: this.platform.models[station.role],
      sessionId: undefined,
      turn: undefined,
    });
    const mapper = this.newMapper(run, station);
    const session = await this.platform.createSession(station.role, this.sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
    const active: ActiveSession = { session, mapper, capture };
    run.sessions.set(station.id, active);
    this.updateStation(run, station, { sessionId: session.sessionId });
    mapper.status(`Session ${session.sessionId} opened on ${station.environment} (shared, no sandbox) with ${station.model}`);
    return active;
  }

  /**
   * Sandbox stations resume their existing session when they have one, so a restart or retry keeps the workspace.
   * `extra` adds session options (a station's own tools) on create and resume; `prepare` runs after the seed files are
   * written, before the station counts as seeded (a GitHub checkout).
   */
  protected async openSandboxSession(
    run: Run,
    station: MStation,
    seed: () => SeedFile[],
    options: { readonly extra?: Partial<SessionConfig>; readonly capture?: Capture; readonly prepare?: (active: ActiveSession) => Promise<void> } = {},
  ): Promise<ActiveSession> {
    this.throwIfCancelled(run);
    const existing = run.sessions.get(station.id);
    if (existing) return existing;
    const extra = options.extra ?? {};
    const capture = options.capture ?? {};
    if (station.sessionId) {
      const mapper = this.newMapper(run, station);
      let session: StationSession | undefined;
      try {
        this.updateStation(run, station, { status: "starting", detail: "Reattaching to the sandbox" });
        session = await this.platform.resumeSession(station.role, station.sessionId, this.sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
      } catch (error) {
        // Events reaching an abandoned resume (one that answers after its deadline) don't belong on the floor.
        mapper.close();
        if (run.abort.signal.aborted) throw new CancelledError();
        // A dropped connection isn't a lost sandbox: keep the workspace and its checkpoint, whether the work order pauses
        // or (out of pauses) fails.
        if (this.isInterruption(error)) throw error;
        // Starting over discards work, so it also needs a platform that answers right now. When it doesn't, the failure
        // is the outage's, and stays classified that way (the platform may be back by the time the station fails).
        if (!(await this.platformAnswers())) throw new PlatformUnavailableError(toFactoryError(error).message);
        if (run.abort.signal.aborted) throw new CancelledError();
        if (this.stopping) throw error;
        mapper.status(`Couldn't reattach to session ${station.sessionId} (${toFactoryError(error).message}); starting a fresh sandbox`, "warning");
        // The new sandbox starts over: its artifact versions restart at 1 and its rounds need fresh reviews.
        this.store.deleteStationArtifacts(run.wo.id, station.id);
        station.previousSessionIds = [...(station.previousSessionIds ?? []), station.sessionId];
        this.updateStation(run, station, {
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
          const review = this.station(run, `review:${station.taskId}`);
          this.updateStation(run, review, { status: "waiting", detail: "Waits for the build", reviews: undefined, round: 0, acceptedWithFindings: undefined });
        }
        this.options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
      }
      if (session) {
        const active: ActiveSession = { session, mapper, capture };
        run.sessions.set(station.id, active);
        await this.refreshSandbox(run, station);
        mapper.status(`Reattached to session ${session.sessionId}`);
        // Seeding was interrupted before the first prompt: finish it (writes are idempotent).
        if (!station.seeded && !station.turn) await this.seed(run, station, active, seed, options.prepare);
        return active;
      }
    }
    this.updateStation(run, station, {
      status: "starting",
      detail: "Provisioning a sandbox",
      startedAt: station.startedAt ?? now(),
      model: this.platform.models[station.role],
    });
    const mapper = this.newMapper(run, station);
    const session = await this.platform.createSession(station.role, this.sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
    const active: ActiveSession = { session, mapper, capture };
    run.sessions.set(station.id, active);
    this.updateStation(run, station, { sessionId: session.sessionId, seeded: false });
    await this.refreshSandbox(run, station);
    const sandbox = station.sandbox;
    mapper.status(
      sandbox
        ? `Sandbox ${sandbox.id} ready: ${sandbox.size} (${SANDBOX_SIZES[sandbox.size].cpus} vCPU · ${SANDBOX_SIZES[sandbox.size].memoryGiB} GiB), ${describeNetwork(sandbox.network)}`
        : `Session ${session.sessionId} ready on ${station.environment}`,
    );
    await this.seed(run, station, active, seed, options.prepare);
    return active;
  }

  /** Writes the station's seed files into its sandbox (and runs `prepare`), then records the checkpoint. */
  protected async seed(run: Run, station: MStation, active: ActiveSession, seed: () => SeedFile[], prepare?: (active: ActiveSession) => Promise<void>): Promise<void> {
    this.updateStation(run, station, { status: "starting", detail: "Seeding the workspace" });
    const files = seed();
    const writer = this.platform.files(active.session.sessionId);
    for (const file of files) await writer.write(file.path, file.content);
    if (prepare) await prepare(active);
    this.updateStation(run, station, { seeded: true });
    active.mapper.status(
      `Seeded ${files.length} files: ${files.map((file) => file.path).filter((path) => !path.startsWith(".factory/conflicts/")).slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`,
    );
  }

  protected async refreshSandbox(run: Run, station: MStation, strict = false): Promise<void> {
    if (!station.sessionId) return;
    try {
      const info = await this.platform.sessionInfo(station.sessionId);
      if (info.id !== station.sessionId) return;
      const patch: Partial<MStation> = { sessionState: info.state, sessionGone: undefined };
      if (station.worker) patch.worker = { ...station.worker, turnId: info.lastTurn?.turnId };
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
      this.updateStation(run, station, patch);
    } catch (error) {
      if (strict) throw error;
      log.debug("Sandbox details unavailable", { station: station.id, error: (error as Error).message });
    }
  }

  protected async closeSession(run: Run, stationId: string): Promise<void> {
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

  protected async turn(run: Run, station: MStation, active: ActiveSession, prompt: string, kind: NonNullable<Station["turn"]>["kind"], round: number): Promise<void> {
    this.throwIfCancelled(run);
    const detail = {
      work: "Working",
      fix: `Fixing review findings (round ${round})`,
      nudge: "Fixing the factory check",
      review: `Reviewing round ${round}`,
      retry: "Retrying",
      continue: "Continuing after an interruption",
    }[kind];
    this.updateStation(run, station, {
      status: "working",
      detail,
      round,
      turn: { kind, round, sentAt: now() },
      startedAt: station.startedAt ?? now(),
    });
    const timeoutMs = this.options.config.turnTimeoutMs[station.role];
    try {
      await active.session.sendAndWait({ prompt }, timeoutMs);
    } catch (error) {
      if (run.abort.signal.aborted) throw new CancelledError();
      // The agent's own time running out. A platform deadline ("… [timeout]" from a registration step) is an interruption.
      if (!isPlatformInterruption(error) && /timeout|timed out/i.test((error as Error).message ?? "")) {
        await active.session.abort().catch(() => undefined);
        throw new StationError("timeout", `The ${station.agent} agent didn't finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
      }
      throw error;
    }
    this.throwIfCancelled(run);
    this.updateStation(run, station, { turn: { ...station.turn!, completedAt: now() } });
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
  protected async awaitTurn(run: Run, station: MStation, active: ActiveSession, release: boolean | "change"): Promise<void> {
    this.updateStation(run, station, { status: "working", detail: "Resuming the in-flight turn" });
    const deadline = Date.now() + this.options.config.turnTimeoutMs[station.role];
    const pollMs = this.options.pollMs ?? 3_000;
    const stallMs = this.options.stallMs ?? STALL_MS;
    const graceMs = this.options.restartGraceMs ?? RESTART_GRACE_MS;
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
    let failedReads = 0;
    const read = async (): Promise<SessionInfo | undefined> => {
      try {
        const info = await this.platform.sessionInfo(active.session.sessionId);
        failedReads = 0;
        return info;
      } catch (error) {
        // A slow or failed read while the platform is up is a blip: read again. With the platform down, or the reads
        // failing MAX_READ_FAILURES times in a row, the error (an interruption) pauses the work order.
        if (!isPlatformInterruption(error) || !this.options.readiness().ready || ++failedReads >= MAX_READ_FAILURES) throw error;
        log.debug("Couldn't read the in-flight turn's status; reading again", { station: station.id, error: (error as Error).message });
        return undefined;
      }
    };
    let outcome: "completed" | "running" | "failed" | "cancelled" | undefined;
    let stuck: "restarted" | "silent" | undefined;
    try {
      for (;;) {
        this.throwIfCancelled(run);
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
      this.addActivity(
        run.wo,
        station.id,
        stuck === "restarted"
          ? "The sandbox restarted while this turn was running, so the turn can't finish; asking the agent to check its workspace and continue"
          : `The in-flight turn showed no activity for ${spokenDuration(stallMs)}; stopping it and asking the agent to check its workspace and continue`,
        "warning",
      );
      log.info("Continuing an in-flight turn that can't finish", { id: run.wo.id, station: station.id, reason: stuck });
      if (stuck === "silent") {
        await Promise.race([active.session.abort().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS).unref())]);
      }
      await this.turn(run, station, active, continuePrompt(release), "continue", Math.max(station.round, 1));
      return;
    }
    if (outcome === "failed" || outcome === "cancelled") {
      this.addActivity(run.wo, station.id, `The interrupted turn ${outcome === "failed" ? "failed" : "was stopped"}; asking the agent to check its workspace and continue`, "warning");
      await this.turn(run, station, active, continuePrompt(release), "continue", Math.max(station.round, 1));
      return;
    }
    this.updateStation(run, station, { turn: { ...station.turn!, completedAt: now() } });
  }

  // ─── Artifacts and checks ───────────────────────────────────────────────────────────────────────────────────

  protected async collect(run: Run, station: MStation, release: boolean, freshAfter?: { readonly version?: number; readonly turnId?: string }): Promise<CheckOutcome> {
    const previousVersion = freshAfter ? freshAfter.version : station.reportVersion;
    this.updateStation(run, station, { status: "collecting", detail: "Collecting artifacts" });
    const published = await this.capturePublication(run, station);
    await this.refreshSandbox(run, station);
    this.throwIfCancelled(run);
    const latest = this.store.latestArtifacts(run.wo.id, station.id);
    const reportArtifact = latest.find((artifact) => artifact.path === "test-report.json");
    const report = parseJson<TestReport>(reportArtifact?.content);
    const manifest = parseJson<OutputManifest>(latest.find((artifact) => artifact.path === "manifest.json")?.content);
    if (reportArtifact) this.updateStation(run, station, { reportVersion: reportArtifact.version });
    if (report) this.updateStation(run, station, { tests: summaryOf(report, reportArtifact?.publishedAt) });
    const check = release ? "npm run check:release" : "npm run check";
    const fail = (code: string, problem: string): CheckOutcome => ({ passed: false, code, problem, ...(report ? { report } : {}), ...(manifest ? { manifest } : {}) });
    if (!report) return fail("no_test_report", `no test report was published (run \`${check}\`)`);
    if (freshAfter?.turnId && published.find((artifact) => artifact.path === "test-report.json" && artifact.state === "published")?.turnId !== freshAfter.turnId) {
      return fail("check_not_run", `\`${check}\` wasn't run in the worker's latest turn`);
    }
    if (previousVersion !== undefined && reportArtifact!.version <= previousVersion) return fail("check_not_run", `\`${check}\` wasn't run after the latest changes`);
    if (report.summary.total === 0) return fail("no_tests", "no tests ran (name test files like test/<name>.test.js)");
    if (report.summary.failed > 0) return fail("tests_failed", `${report.summary.failed} of ${report.summary.total} tests failed`);
    if (report.summary.passed === 0) return fail("no_tests", "no test passed: every test was skipped");
    if (report.exitCode !== 0) return fail("tests_failed", `the test run exited with status ${report.exitCode}`);
    if (!manifest || manifest.files.length === 0) return fail("nothing_published", `no files were published (run \`${check}\`)`);
    return { passed: true, code: "ok", problem: "", report, manifest };
  }

  protected async capturePublication(run: Run, station: MStation): Promise<ArtifactInfo[]> {
    const sessionId = station.sessionId!;
    const artifacts = this.platform.artifacts(sessionId);
    const publication = await artifacts.waitForPublication({ timeoutMs: this.options.config.publicationTimeoutMs });
    this.throwIfCancelled(run);
    if (publication.state === "failed") throw new StationError("publication_failed", publication.error ?? "The platform couldn't publish this turn's artifacts.");
    const list = await artifacts.list({ versions: "latest" });
    let added = 0;
    for (const info of list) {
      if (info.state !== "published" || this.store.hasArtifact(run.wo.id, station.id, info.path, info.version)) continue;
      let content: string | undefined;
      let bytes: Uint8Array | undefined;
      const media = info.path.startsWith("media/") ? mediaTypeOf(info.path) : undefined;
      if (media && info.size <= MAX_MEDIA_BYTES) {
        bytes = await this.readArtifactWith(station, info.path, () => artifacts.readBytes(info.path, { version: info.version }));
      } else if ((isTextPath(info.path) || this.projectOutput(run, info.path)) && info.size <= MAX_TEXT_BYTES) {
        const text = await this.readArtifact(artifacts, station, info.path, info.version);
        content = text.includes("\u0000") ? undefined : text;
      }
      this.throwIfCancelled(run);
      this.store.putArtifact({
        workOrderId: run.wo.id,
        stationId: station.id,
        path: info.path,
        version: info.version,
        round: station.round,
        size: info.size,
        digest: info.digest,
        contentType: media?.contentType ?? info.contentType ?? contentTypeFor(info.path),
        publishedAt: info.publishedAt ?? now(),
        ...(content !== undefined ? { content } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
      });
      added++;
    }
    if (added > 0) {
      this.options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
      this.emitItem(run.wo, { stationId: station.id, kind: "artifact", text: `Published ${added} file${added === 1 ? "" : "s"}`, level: "info" });
    }
    return list;
  }

  /**
   * A builder's or the release's file in a work order that changes an existing project: kept as text whatever its
   * extension (a `.vue` or `.hbs` file, `go.mod`), as long as it has no NUL byte, so a fix to it reaches the review, the
   * release, and the app that routed the work order.
   */
  protected projectOutput(run: Run, path: string): boolean {
    return Boolean(run.wo.inputs?.project) && (path.startsWith("files/") || path.startsWith("bundle/"));
  }

  /**
   * Downloads a text artifact, retrying transient failures. A file that can't be read fails the collection rather
   * than being recorded without content, so a retry downloads it again instead of silently dropping it.
   */
  protected async readArtifact(artifacts: ReturnType<FactoryPlatform["artifacts"]>, station: MStation, path: string, version: number): Promise<string> {
    return this.readArtifactWith(station, path, () => artifacts.read(path, { version }));
  }

  protected async readArtifactWith<T>(station: MStation, path: string, read: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await read();
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

  protected newStation(kind: StationKind, task?: PlanTask): MStation {
    const role = ROLE_FOR_KIND[kind];
    const title = { plan: "Plan", coordinate: "Coordinator", build: `Build · ${task?.title ?? ""}`, review: `Review · ${task?.title ?? ""}`, release: "Release" }[kind];
    const detail = { plan: "Queued", coordinate: "Waits for the accepted plan", build: "Queued", review: "Waits for the build", release: "Waits for every task" }[kind];
    return {
      id: task ? `${kind}:${task.id}` : kind === "coordinate" ? "coordinator" : kind,
      kind,
      title,
      ...(task ? { taskId: task.id } : {}),
      status: "waiting",
      detail,
      role,
      environment: FACTORY_ENVIRONMENTS[role],
      placement: role === "planner" || role === "reviewer" || role === "coordinator" ? "shared" : "sandbox",
      agent: ROLE_AGENTS[role],
      model: this.platform.models[role],
      round: 0,
    };
  }

  protected station(run: Run, id: string): MStation {
    const station = run.wo.stations.find((candidate) => candidate.id === id);
    if (!station) throw new StationError("internal", `Unknown station ${id}`);
    return station;
  }

  protected throwIfCancelled(run: Run): void {
    if (run.abort.signal.aborted || run.closed || this.stopping) throw new CancelledError();
  }

  protected async failStation(run: Run, station: MStation, error: unknown): Promise<void> {
    const interrupted = await this.interruptedBy(run, error);
    // A cancel (or shutdown) that came while the platform was being checked decides instead.
    if (run.abort.signal.aborted || this.stopping) return;
    if (interrupted) {
      // Not a failure: the work order pauses at its checkpoint and resumes when the platform is back (#pauseRun).
      run.interrupted = true;
      return;
    }
    run.failed = true;
    const failure: FactoryError = toFactoryError(error);
    this.updateStation(run, station, { status: "failed", error: failure, detail: failure.message, finishedAt: now() });
    this.emitItem(run.wo, { stationId: station.id, kind: "error", text: failure.message, level: "error" });
  }

  /** Whether an error is the platform connection dropping (or the platform being down) rather than the station's own failure. */
  protected isInterruption(error: unknown): boolean {
    if (this.stopping || error instanceof CancelledError) return false;
    return isPlatformInterruption(error) || !this.options.readiness().ready;
  }

  /** Whether the work order pauses for an interruption: after MAX_AUTO_RESUMES pauses, the next one fails it instead. */
  protected interrupts(run: Run, error: unknown): boolean {
    return this.canPause(run, error) && this.isInterruption(error);
  }

  /** A cancel by the user (or a shutdown) is never a pause, and pauses are budgeted. */
  protected canPause(run: Run, error: unknown): boolean {
    if (this.stopping || run.abort.signal.aborted || error instanceof CancelledError) return false;
    return (this.pauses.get(run.wo.id) ?? 0) < MAX_AUTO_RESUMES;
  }

  /**
   * `interrupts`, plus: a platform error the classifier doesn't know is the outage's too when the platform doesn't
   * answer right now (FactoryOptions.checkPlatform). The factory's own verdicts (StationError) are taken as given.
   */
  protected async interruptedBy(run: Run, error: unknown): Promise<boolean> {
    if (this.interrupts(run, error)) return true;
    if (error instanceof StationError || !this.canPause(run, error)) return false;
    return !(await this.platformAnswers());
  }

  /** Whether the platform answers right now. Assumed when there's no check (tests). */
  protected async platformAnswers(): Promise<boolean> {
    if (!this.options.readiness().ready) return false;
    return this.options.checkPlatform ? await this.options.checkPlatform().catch(() => false) : true;
  }

  /** Leaves an interrupted work order at its checkpoint: running stations wait, and nothing is marked failed. */
  protected pauseRun(run: Run, error: unknown): void {
    const { wo } = run;
    run.paused = true;
    this.pauses.set(wo.id, (this.pauses.get(wo.id) ?? 0) + 1);
    const text = error instanceof Error ? error.message : String(error);
    const reason = (/\[managed-copilot\]\s*([^\n]+)/.exec(text)?.[1] ?? text.split("\n")[0] ?? "").replace(/[.\s]+$/, "") || "the connection dropped";
    const note = `Paused: lost the connection to Managed Copilot (${reason}). Continues from its last checkpoint once the platform is back.`;
    const active = wo.stations.filter((station) => station.status === "starting" || station.status === "working" || station.status === "collecting");
    for (const station of active) {
      Object.assign(station, { status: "waiting", detail: "Paused until Managed Copilot is back" });
      this.addActivity(wo, station.id, note, "warning");
    }
    if (active.length === 0) this.addActivity(wo, wo.stations[0]?.id ?? "plan", note, "warning");
    this.setWorkOrder(run, {});
    log.warn("Work order paused: lost the platform connection", { id: wo.id, pauses: this.pauses.get(wo.id), reason });
  }

  /**
   * Resumes a paused work order by itself once the platform answers. While the platform is down, its return to ready
   * resumes the work order instead (main.ts calls `resumeInterrupted`).
   */
  protected resumeSoon(id: string): void {
    if (this.stopping) return;
    const pauses = this.pauses.get(id) ?? 1;
    const delay = Math.min((this.options.resumeBackoffMs ?? 1_000) * 2 ** (pauses - 1), 30_000);
    const existing = this.resumeTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.resumePaused(id), delay);
    timer.unref();
    this.resumeTimers.set(id, timer);
  }

  protected async resumePaused(id: string): Promise<void> {
    this.resumeTimers.delete(id);
    if (!this.resumable(id) || !this.options.readiness().ready) return;
    if (this.options.checkPlatform && !(await this.options.checkPlatform())) return;
    const wo = this.resumable(id);
    if (wo && this.options.readiness().ready) this.resume(wo);
  }

  /** The stored work order when it's still active and nothing runs it (it may have been cancelled or deleted meanwhile). */
  protected resumable(id: string): MWorkOrder | undefined {
    if (this.stopping || this.isActive(id)) return undefined;
    const stored = this.store.getWorkOrder(id);
    return stored && ACTIVE_WORK_ORDER_STATUSES.includes(stored.status) ? (stored as MWorkOrder) : undefined;
  }

  protected forgetPause(id: string): void {
    this.pauses.delete(id);
    const timer = this.resumeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(id);
  }

  protected updateStation(run: Run, station: MStation, patch: Partial<MStation>): void {
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
    this.persist(run.wo);
  }

  protected setWorkOrder(run: Run, patch: Partial<MWorkOrder>): void {
    if (run.closed) return;
    Object.assign(run.wo, patch);
    this.persist(run.wo);
  }

  protected persist(wo: MWorkOrder): void {
    // While stopping, the stored state is the checkpoint the next start resumes from: leave it untouched.
    if (this.stopping) return;
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
    this.store.saveWorkOrder(wo);
    this.options.hub.publish({ type: "workOrder", workOrder: wo });
  }

  protected scheduleUsageSave(run: Run): void {
    if (run.closed || this.usageTimers.has(run.wo.id)) return;
    const timer = setTimeout(() => {
      this.usageTimers.delete(run.wo.id);
      // A finished (or paused) run's snapshot must never overwrite the work order a later run is updating.
      if (!run.closed) this.persist(run.wo);
    }, 1_500);
    timer.unref();
    this.usageTimers.set(run.wo.id, timer);
  }

  protected onItem(run: Run, station: MStation, item: ActivityItem): void {
    if (this.stopping || run.closed) return;
    this.store.upsertActivity(item);
    this.options.hub.publish({ type: "activity", item });
    if (station.status !== "working") return;
    if (item.kind === "intent" && item.text) this.updateStation(run, station, { detail: item.text });
    else if (item.kind === "tool" && item.tool?.status === "running" && /npm run check|check\.mjs/.test(item.tool.summary)) {
      this.updateStation(run, station, { detail: "Running the factory check" });
    }
  }

  protected emitItem(wo: Pick<WorkOrder, "id">, partial: Omit<ActivityItem, "id" | "workOrderId" | "at"> & { id?: string }): void {
    if (this.stopping) return;
    const item: ActivityItem = { ...partial, id: partial.id ?? `${partial.stationId}:${randomUUID()}`, workOrderId: wo.id, at: now() };
    this.store.upsertActivity(item);
    this.options.hub.publish({ type: "activity", item });
  }

  protected addActivity(wo: Pick<WorkOrder, "id">, stationId: string, text: string, level: ActivityItem["level"]): void {
    this.emitItem(wo, { stationId, kind: "status", text, level });
  }
}
