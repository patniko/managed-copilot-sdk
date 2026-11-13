import { randomUUID } from "node:crypto";
import { isManagedCopilotError, type SessionInfo } from "@managed-copilot/sdk";
import { findTemplate } from "../../shared/templates.js";
import {
  ACTIVE_WORK_ORDER_STATUSES,
  formatWorkOrderNumber,
  mediaTypeOf,
  TERMINAL_STATION_STATUSES,
  workOrderMode,
  type ActivityItem,
  type ArtifactFileView,
  type ArtifactIndex,
  type ChangeRevision,
  type CreateWorkOrderRequest,
  type ReleaseFiles,
  type WorkOrder,
  type WorkOrderGate,
  type WorkOrderSummary,
} from "../../shared/types.js";
import type { GitHubApi } from "../github.js";
import { parseRepository } from "../github.js";
import { log } from "../log.js";
import type { StoredArtifact } from "../store.js";
import { CancelledError, StationError, toFactoryError } from "./errors.js";
import { CONTEXT_PREFIX, describeInputs, digestOf, INTAKE_STATION, parseRoutedInputs, PROJECT_PREFIX, type LoadedInputs, type RoutedInputs } from "./inputs.js";
import { decideGate, gateActivity, openGate, parseDecision, parseGateDeclarations, parseOpenGate, parseOutcome, reportGate } from "./gates.js";
import type { WorkspaceNotes } from "./prompts.js";
import { Semaphore } from "./semaphore.js";
import { branchName, workOrderTitle } from "./repo.js";
import { CHANGE_BUILD, contentTypeFor, type Mutable, type MWorkOrder, now, type ReadinessKind, readinessKind, type Run, toSummary } from "./factory-shared.js";
import { FactoryStages } from "./factory-stages.js";

export { contentTypeFor, describeNetwork, isTextPath, toSummary } from "./factory-shared.js";
export type { FactoryOptions } from "./factory-shared.js";

/** Runs work orders through the factory: plan → parallel builds with review loops → release. */
export class Factory extends FactoryStages {
  // ─── Queries ────────────────────────────────────────────────────────────────────────────────────────────────

  get(id: string): WorkOrder | undefined {
    return this.runs.get(id)?.wo ?? this.store.getWorkOrder(id);
  }

  list(): WorkOrderSummary[] {
    return this.store.listWorkOrders().map((stored) => toSummary(this.runs.get(stored.id)?.wo ?? stored));
  }

  override isActive(id: string): boolean {
    return this.runs.has(id) || this.cancelling.has(id);
  }

  activity(id: string, stationId?: string): ActivityItem[] {
    return this.store.listActivity(id, stationId);
  }

  artifactIndex(id: string): ArtifactIndex {
    const wo = this.get(id);
    // The intake (what a routed work order brought along) comes first, then the stations in pipeline order.
    const order = new Map([[INTAKE_STATION, -1], ...(wo?.stations ?? []).map((station, index) => [station.id, index] as const)]);
    const files = new Map<string, Mutable<ArtifactFileView> & { versions: ArtifactFileView["versions"][number][] }>();
    for (const meta of this.store.listArtifacts(id)) {
      const key = `${meta.stationId}\u0000${meta.path}`;
      let file = files.get(key);
      if (!file) {
        file = { stationId: meta.stationId, path: meta.path, contentType: meta.contentType, versions: [], viewable: meta.hasContent, ...(meta.hasBytes ? { media: true } : {}) };
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
    return this.store.getArtifact(id, stationId, path, version);
  }

  /** A screenshot or recording the factory kept (GitHub work orders). */
  media(id: string, stationId: string, path: string, version?: number): { readonly bytes: Uint8Array; readonly contentType: string } | undefined {
    if (!mediaTypeOf(path)) return undefined;
    return this.store.getArtifactBytes(id, stationId, path, version);
  }

  /** The release bundle plus release notes, patch, and test report, for the zip download. */
  releaseFiles(id: string): { projectName: string; files: { path: string; content: string }[] } | undefined {
    const wo = this.get(id);
    if (!wo?.plan || !wo.release) return undefined;
    const files = [...this.currentFiles(id, "release", "bundle/")].map(([path, content]) => ({ path: `${wo.plan!.projectName}/${path}`, content }));
    const latest = this.store.latestArtifacts(id, "release");
    for (const name of ["RELEASE.md", "project.patch", "test-report.json"]) {
      const content = latest.find((candidate) => candidate.path === name)?.content;
      if (content !== undefined) files.push({ path: name, content });
    }
    return { projectName: wo.plan.projectName, files };
  }

  /** The released project's files as text, with what changed in a routed project: for the app that routed the work order. */
  release(id: string): ReleaseFiles | undefined {
    const wo = this.get(id);
    if (!wo?.plan || !wo.release) return undefined;
    return {
      workOrderId: wo.id,
      number: wo.number,
      projectName: wo.plan.projectName,
      ...(wo.release.tests ? { tests: wo.release.tests } : {}),
      ...(wo.release.notes ? { notes: wo.release.notes } : {}),
      files: [...this.currentFiles(id, "release", "bundle/")].map(([path, content]) => ({ path, content })),
      ...(wo.release.changes ? { changes: wo.release.changes } : {}),
    };
  }

  // ─── Commands ───────────────────────────────────────────────────────────────────────────────────────────────

  create(request: CreateWorkOrderRequest): WorkOrder {
    if (!request || typeof request !== "object" || typeof request.title !== "string" || typeof request.brief !== "string") {
      throw new StationError("invalid_request", "Give the work order a title and a brief.");
    }
    if (request.github !== undefined) throw new StationError("invalid_request", "Create GitHub work orders with createGitHub.");
    const title = request.title?.trim() ?? "";
    const brief = request.brief?.trim() ?? "";
    if (title.length < 3 || title.length > 120) throw new StationError("invalid_request", "Give the work order a title of 3 to 120 characters.");
    if (brief.length < 20 || brief.length > 8000) throw new StationError("invalid_request", "Describe the work in 20 to 8,000 characters.");
    const rounds = request.maxReviewRounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new StationError("invalid_request", "Review rounds must be 1, 2, or 3.");
    const mode = request.mode ?? "agent";
    if (mode !== "agent" && mode !== "classic") throw new StationError("invalid_request", 'Choose "agent" or "classic" for the work order mode.');
    this.requireReady(mode);
    if (mode === "agent" && this.platform.models.builder === this.platform.models.reviewer) {
      throw new StationError("invalid_request", "Choose a reviewer model different from the builder model for independent review.");
    }
    const template = findTemplate(request.templateId);
    const inputs = parseRoutedInputs(request);
    const described = describeInputs(inputs);
    const owner = this.options.account();
    const created = now();
    const gates = parseGateDeclarations(request.gates, inputs.origin !== undefined, created);
    const wo: MWorkOrder = {
      id: `wo_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      number: this.store.nextWorkOrderNumber(),
      title,
      brief,
      mode,
      source: template ? { kind: "template", templateId: template.id } : { kind: "brief" },
      maxReviewRounds: rounds,
      status: "queued",
      createdAt: created,
      updatedAt: created,
      taskCount: 0,
      stations: [this.newStation("plan"), ...(mode === "agent" ? [this.newStation("coordinate")] : []), this.newStation("release")],
      ...(owner ? { owner } : {}),
      ...(inputs.origin ? { origin: inputs.origin } : {}),
      ...(described ? { inputs: described } : {}),
      ...(gates.length ? { gates } : {}),
    };
    this.store.saveWorkOrder(wo);
    this.storeInputs(wo, inputs);
    log.info("Work order created", {
      id: wo.id,
      number: formatWorkOrderNumber(wo.number),
      title,
      ...(inputs.origin ? { origin: inputs.origin.app } : {}),
      ...(described ? { context: described.context.length, projectFiles: described.project?.files ?? 0 } : {}),
      ...(gates.length ? { gates: gates.map((gate) => gate.id).join(",") } : {}),
    });
    const snapshot = structuredClone(wo);
    this.start(wo);
    return snapshot;
  }

  /** Keeps a routed work order's files as the `intake` station's artifacts: the floor lists them, and the pipeline seeds from them. */
  protected storeInputs(wo: WorkOrder, inputs: RoutedInputs): void {
    const files = [
      ...inputs.context.map((file) => ({ path: `${CONTEXT_PREFIX}${file.path}`, content: file.content })),
      ...(inputs.project?.files ?? []).map((file) => ({ path: `${PROJECT_PREFIX}${file.path}`, content: file.content })),
    ];
    if (files.length === 0) return;
    for (const file of files) {
      this.store.putArtifact({
        workOrderId: wo.id,
        stationId: INTAKE_STATION,
        path: file.path,
        version: 1,
        round: 0,
        size: Buffer.byteLength(file.content, "utf8"),
        digest: digestOf(file.content),
        contentType: contentTypeFor(file.path),
        publishedAt: wo.createdAt,
        content: file.content,
      });
    }
    this.options.hub.publish({ type: "artifacts", workOrderId: wo.id });
  }

  /** A routed work order's context and project files, read once per run. */
  protected override inputs(run: Run): LoadedInputs | undefined {
    if (!run.wo.inputs) return undefined;
    if (run.inputs) return run.inputs;
    const context = new Map<string, string>();
    const project = new Map<string, string>();
    for (const artifact of this.store.latestArtifacts(run.wo.id, INTAKE_STATION)) {
      if (artifact.content === undefined) continue;
      if (artifact.path.startsWith(CONTEXT_PREFIX)) context.set(artifact.path.slice(CONTEXT_PREFIX.length), artifact.content);
      else if (artifact.path.startsWith(PROJECT_PREFIX)) project.set(artifact.path.slice(PROJECT_PREFIX.length), artifact.content);
    }
    // Keep the order the routing app sent them in (the store lists by path).
    const order = (paths: readonly string[], files: Map<string, string>) => new Map(paths.filter((path) => files.has(path)).map((path) => [path, files.get(path)!]));
    const name = run.wo.inputs.project?.name;
    run.inputs = {
      context: order(run.wo.inputs.context.map((file) => file.path), context),
      ...(name ? { project: { name, files: new Map([...project].sort(([a], [b]) => a.localeCompare(b))) } } : {}),
    };
    return run.inputs;
  }

  /** What builders and the release are told about a routed work order's project and reference material. */
  protected override notes(run: Run): WorkspaceNotes | undefined {
    const inputs = run.wo.inputs;
    if (!inputs && !run.wo.origin) return undefined;
    return {
      ...(inputs?.project ? { project: inputs.project.name } : {}),
      ...(inputs && inputs.context.length > 0 ? { context: inputs.context.map((file) => file.path) } : {}),
      ...(run.wo.origin ? { origin: run.wo.origin } : {}),
    };
  }

  /**
   * A GitHub work order: the change goes into one `factory-repo` sandbox holding the repository's default branch, a
   * second model reviews it, and the factory pushes a branch and opens a pull request with the developer's media.
   */
  async createGitHub(request: CreateWorkOrderRequest): Promise<WorkOrder> {
    if (!request || typeof request !== "object" || typeof request.brief !== "string" || !request.github || typeof request.github.repository !== "string") {
      throw new StationError("invalid_request", "Pick a repository and say what the factory should do.");
    }
    const github = this.requireGitHub();
    const brief = request.brief.trim();
    if (brief.length < 3 || brief.length > 8000) throw new StationError("invalid_request", "Say what the factory should do in 3 to 8,000 characters.");
    const rounds = request.maxReviewRounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new StationError("invalid_request", "Review rounds must be 1, 2, or 3.");
    const issueNumber = request.github.issue;
    if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) throw new StationError("invalid_request", "Pick an issue by its number.");
    if ((request.context !== undefined && request.context !== null) || (request.project !== undefined && request.project !== null)) {
      throw new StationError("invalid_request", "GitHub work orders change the repository itself: put what the factory needs to know in the brief.");
    }
    if (Array.isArray(request.gates) && request.gates.length > 0) throw new StationError("invalid_request", "GitHub work orders end in a pull request: they take no gates.");
    const origin = parseRoutedInputs({ ...request, context: undefined, project: undefined }).origin;
    const target = parseRepository(request.github.repository);
    if (!target) throw new StationError("invalid_request", "Pick a repository as owner/name.");
    this.requireReady("github");
    if (this.platform.models.developer === this.platform.models.reviewer) {
      throw new StationError("invalid_request", "Choose a reviewer model different from the developer model for independent review.");
    }
    const repository = await github.repository(target.owner, target.name);
    if (repository.archived) throw new StationError("invalid_request", `${repository.fullName} is archived, so it can't take pull requests.`);
    if (!repository.canPush) {
      throw new StationError("forbidden", `Your GitHub account can't push to ${repository.fullName}, so the factory can't open a pull request there. Pick a repository you can push to.`);
    }
    const [issue, baseSha] = await Promise.all([
      issueNumber !== undefined ? github.issue(repository.owner, repository.name, issueNumber) : Promise.resolve(undefined),
      github.branchHead(repository.owner, repository.name, repository.defaultBranch),
    ]);
    if (!baseSha) throw new StationError("invalid_request", `${repository.fullName} has no commits on ${repository.defaultBranch} yet.`);
    this.requireReady("github");
    const titleText = typeof request.title === "string" && request.title.trim() ? request.title.trim().slice(0, 120) : workOrderTitle(brief, issue);
    const owner = this.options.account();
    const created = now();
    const number = this.store.nextWorkOrderNumber();
    const revision: ChangeRevision = { number: 1, request: brief, requestedAt: created, ...(owner ? { requestedBy: owner.login } : {}) };
    const wo: MWorkOrder = {
      id: `wo_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      number,
      title: titleText,
      brief,
      mode: "classic",
      source: { kind: "github" },
      maxReviewRounds: rounds,
      status: "queued",
      createdAt: created,
      updatedAt: created,
      taskCount: 1,
      stations: this.changeStations(titleText),
      github: {
        repository,
        ...(issue ? { issue } : {}),
        baseSha,
        branch: branchName(number, issue ? `${issue.number}-${issue.title}` : titleText),
        revisions: [revision],
      },
      ...(owner ? { owner } : {}),
      ...(origin ? { origin } : {}),
    };
    this.store.saveWorkOrder(wo);
    log.info("GitHub work order created", { id: wo.id, number: formatWorkOrderNumber(wo.number), repository: repository.fullName, issue: issue?.number });
    const snapshot = structuredClone(wo);
    this.start(wo);
    return snapshot;
  }

  /** Asks for more changes on a finished GitHub work order: the same sandbox makes them, and they're pushed to the same pull request. */
  async revise(id: string, text: string): Promise<WorkOrder> {
    if (this.runs.has(id) || this.cancelling.has(id)) throw new StationError("conflict", "This work order is still running. Wait for it to finish, then ask for more changes.");
    const stored = this.store.getWorkOrder(id);
    if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
    if (!stored.github) throw new StationError("invalid_request", "Only GitHub work orders take more changes.");
    if (stored.status !== "completed") throw new StationError("conflict", "Ask for more changes once the work order has finished; retry it if it failed.");
    const request = typeof text === "string" ? text.trim() : "";
    if (request.length < 3 || request.length > 8000) throw new StationError("invalid_request", "Say what to change in 3 to 8,000 characters.");
    this.requireGitHub();
    this.requireReady("github");
    const wo = stored as MWorkOrder;
    if (wo.github!.pullRequest) {
      await this.loadPullRequest(wo).catch((error: unknown) => log.debug("Couldn't refresh the pull request", { id, error: (error as Error).message }));
      const state = wo.github!.pullRequest!.state;
      if (state !== "open") throw new StationError("conflict", `Pull request #${wo.github!.pullRequest!.number} is ${state}. Start a new work order for more changes.`);
    }
    if (this.runs.has(id)) throw new StationError("conflict", "This work order is already running.");
    const owner = this.options.account();
    const revisions = wo.github!.revisions;
    const revision: ChangeRevision = { number: revisions.length + 1, request, requestedAt: now(), ...(owner ? { requestedBy: owner.login } : {}) };
    wo.github = { ...wo.github!, revisions: [...revisions, revision] };
    for (const station of wo.stations) {
      Object.assign(station, { status: "waiting", detail: station.kind === "build" ? `Queued: revision ${revision.number}` : station.kind === "review" ? "Waits for the change" : "Waits for the review" });
      delete station.finishedAt;
      delete station.error;
      delete station.acceptedWithFindings;
    }
    delete wo.completedAt;
    delete wo.error;
    wo.status = "queued";
    this.persist(wo);
    this.addActivity(wo, CHANGE_BUILD, `Revision ${revision.number} requested: ${request.split("\n")[0]!.slice(0, 160)}`, "info");
    log.info("More changes requested", { id, revision: revision.number });
    const snapshot = structuredClone(wo);
    this.start(wo);
    return snapshot;
  }

  /** Re-reads the work order's pull request from GitHub (its state, checks, and merge status). */
  async refreshPullRequest(id: string): Promise<WorkOrder> {
    const wo = this.get(id) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    if (!wo.github?.pullRequest) return structuredClone(wo);
    this.requireGitHub();
    await this.loadPullRequest(wo);
    return structuredClone(wo);
  }

  /** Merges the work order's pull request on GitHub. */
  async merge(id: string, method: "merge" | "squash" | "rebase" = "squash"): Promise<WorkOrder> {
    if (!["merge", "squash", "rebase"].includes(method)) throw new StationError("invalid_request", 'Merge with "merge", "squash", or "rebase".');
    if (this.isActive(id)) throw new StationError("conflict", "This work order is still running. Merge once it has finished.");
    const wo = this.store.getWorkOrder(id) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    const pull = wo.github?.pullRequest;
    if (!pull) throw new StationError("conflict", "This work order has no pull request to merge.");
    const github = this.requireGitHub();
    const { owner, name } = wo.github!.repository;
    await github.merge(owner, name, pull.number, method);
    this.addActivity(wo, "release", `Merged pull request #${pull.number} (${method})`, "success");
    await this.loadPullRequest(wo).catch(() => {
      wo.github = { ...wo.github!, pullRequest: { ...pull, state: "merged", mergedAt: now() } };
      this.persist(wo);
    });
    log.info("Pull request merged", { id, pullRequest: pull.number, method });
    return structuredClone(wo);
  }

  protected override async loadPullRequest(wo: MWorkOrder): Promise<void> {
    const github = this.requireGitHub();
    const { owner, name } = wo.github!.repository;
    const pull = await github.pullRequest(owner, name, wo.github!.pullRequest!.number);
    wo.github = { ...wo.github!, pullRequest: pull };
    this.persist(wo);
  }

  protected override requireGitHub(): GitHubApi {
    if (!this.options.github) throw new StationError("platform_unavailable", "This factory isn't set up to work with GitHub.");
    return this.options.github;
  }

  // ─── Gates ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** The routing app's request on a gate (its deploy request): it waits for a person on the floor. */
  openGate(id: string, gateId: string, body: unknown): WorkOrder {
    return this.changeGate(id, gateId, (wo, gate, at) => {
      if (wo.status !== "completed") {
        throw new StationError(
          "conflict",
          ACTIVE_WORK_ORDER_STATUSES.includes(wo.status) ? `${formatWorkOrderNumber(wo.number)} hasn't released yet.` : `${formatWorkOrderNumber(wo.number)} was ${wo.status}: there's nothing to deploy.`,
        );
      }
      return openGate(gate, parseOpenGate(body, gate, at), at);
    });
  }

  /** A person's decision on an open gate, as the factory's signed-in account. */
  decideGate(id: string, gateId: string, body: unknown): WorkOrder {
    const decision = parseDecision(body);
    return this.changeGate(id, gateId, (_wo, gate, at) => decideGate(gate, decision, this.options.account()?.login, at));
  }

  /** The routing app's report: how the approved deploy went, or that its request was answered elsewhere. */
  reportGate(id: string, gateId: string, body: unknown): WorkOrder {
    const report = parseOutcome(body);
    return this.changeGate(id, gateId, (_wo, gate, at) => reportGate(gate, report, at));
  }

  protected changeGate(id: string, gateId: string, change: (wo: WorkOrder, gate: WorkOrderGate, at: string) => WorkOrderGate): WorkOrder {
    // A running work order's record is the run's; a finished one's is the store's.
    const wo = (this.runs.get(id)?.wo ?? this.store.getWorkOrder(id)) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    const gate = wo.gates?.find((candidate) => candidate.id === gateId);
    if (!gate) throw new StationError("not_found", `${formatWorkOrderNumber(wo.number)} has no ${gateId} gate.`);
    const updated = change(wo, gate, now());
    if (updated === gate) return structuredClone(wo);
    wo.gates = wo.gates!.map((candidate) => (candidate.id === gateId ? updated : candidate));
    this.persist(wo);
    const said = gateActivity(updated, wo.origin?.name ?? "The routing app");
    this.addActivity(wo, "release", said.text, said.level);
    log.info("Gate changed", { id: wo.id, gate: gateId, state: updated.state, ...(updated.decision?.by ? { by: updated.decision.by } : {}) });
    return structuredClone(wo);
  }

  async cancel(id: string): Promise<WorkOrder> {
    if (this.cancelling.has(id)) throw new StationError("conflict", "This work order is already being cancelled.");
    const run = this.runs.get(id);
    if (!run) {
      const stored = this.store.getWorkOrder(id);
      if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status)) throw new StationError("conflict", "Only an active work order can be cancelled.");
      // Interrupted by a restart (or paused by a lost connection) and never resumed: cancel the record directly.
      const wo = stored as MWorkOrder;
      this.forgetPause(id);
      this.cancelling.add(id);
      try {
        if (workOrderMode(wo) === "agent") {
          await this.stopPersistedCoordinator(wo);
          await this.deleteWorkerSessions(wo);
        }
        this.cancelStations(wo);
        Object.assign(wo, { status: "cancelled", completedAt: now() });
        this.persist(wo);
        return wo;
      } finally {
        this.cancelling.delete(id);
      }
    }
    run.abort.abort();
    await Promise.allSettled([...run.sessions.values()].map((active) => active.session.abort()));
    await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 15_000).unref())]);
    return this.get(id)!;
  }

  retry(id: string): WorkOrder {
    if (this.runs.has(id)) throw new StationError("conflict", "This work order is still running.");
    const stored = this.store.getWorkOrder(id);
    if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
    if (stored.status !== "failed" && stored.status !== "cancelled") throw new StationError("conflict", "Only a failed or cancelled work order can be retried.");
    this.requireReady(readinessKind(stored));
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
        if (workOrderMode(wo) === "agent") station.failedChecks = 0;
      }
    }
    this.persist(wo);
    this.addActivity(wo, wo.stations[0]?.id ?? "plan", "Retrying from the last checkpoint", "info");
    const snapshot = structuredClone(wo);
    this.start(wo);
    return snapshot;
  }

  /** Deletes the work order, its records, and (best effort) its platform sessions, sandboxes, and artifacts. */
  async delete(id: string): Promise<void> {
    if (this.isActive(id)) throw new StationError("conflict", "Finish cancelling the work order before deleting it.");
    const wo = this.store.getWorkOrder(id);
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    this.forgetPause(id);
    this.store.deleteWorkOrder(id);
    this.options.hub.publish({ type: "workOrderDeleted", workOrderId: id });
    const sessionIds = wo.stations.flatMap((station) => [...(station.sessionId ? [station.sessionId] : []), ...(station.previousSessionIds ?? [])]);
    void Promise.allSettled(sessionIds.map((sessionId) => this.platform.deleteSession(sessionId))).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) log.warn("Some sessions could not be deleted", { workOrder: id, failed });
    });
  }

  /**
   * Resumes work orders interrupted by a factory restart or paused by a lost platform connection. Call when the
   * platform becomes ready.
   */
  resumeInterrupted(): void {
    for (const stored of this.store.listWorkOrders()) {
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status) || this.isActive(stored.id)) continue;
      if (!this.options.readiness(readinessKind(stored)).ready) continue;
      this.resume(stored as MWorkOrder);
    }
  }

  protected override resume(wo: MWorkOrder): void {
    const paused = this.pauses.has(wo.id);
    const timer = this.resumeTimers.get(wo.id);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(wo.id);
    log.info(paused ? "Resuming work order: the platform is back" : "Resuming work order after restart", { id: wo.id });
    const note = paused ? "Managed Copilot is back; resuming from the last checkpoint" : "The factory restarted; resuming from the last checkpoint";
    this.addActivity(wo, wo.stations[0]?.id ?? "plan", note, "warning");
    this.start(wo);
  }

  /**
   * Reconciles finished work orders with the platform's own session list (`managed.sessions.list()`): each station
   * shows its session's current state and sandbox, or that the session no longer exists. Pass `workOrderIds` to limit
   * it to some work orders.
   */
  async reconcileSessions(workOrderIds?: readonly string[]): Promise<void> {
    const candidates = (): MWorkOrder[] =>
      (this.store.listWorkOrders() as MWorkOrder[]).filter((wo) => !this.runs.has(wo.id) && (!workOrderIds || workOrderIds.includes(wo.id)));
    const sessions = new Map<string, SessionInfo>();
    try {
      for (const info of await this.platform.listSessions()) sessions.set(info.id, info);
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
            sessions.set(sessionId, await this.platform.sessionInfo(sessionId));
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
      if (changed) this.persist(wo);
    }
  }

  /**
   * Detaches from every running work order without recording failures, so `resumeInterrupted()` picks them up after
   * the next start. Accepted platform turns keep running while the factory is away.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.closed = true;
      run.stopCoordinator?.(new CancelledError());
      for (const active of run.sessions.values()) active.mapper.close();
      await Promise.allSettled([...run.sessions.values()].map((active) => active.session.disconnect()));
    }
    await Promise.race([Promise.allSettled(runs.map((run) => run.done)), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    for (const timer of this.usageTimers.values()) clearTimeout(timer);
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
  }

  // ─── Run loop ───────────────────────────────────────────────────────────────────────────────────────────────

  protected requireReady(mode: ReadinessKind): void {
    const { ready, reason } = this.options.readiness(mode);
    if (!ready) throw new StationError("platform_unavailable", reason ?? "The Managed Copilot platform isn't ready.");
  }

  protected start(wo: MWorkOrder): void {
    const run: Run = {
      wo,
      abort: new AbortController(),
      sessions: new Map(),
      closed: false,
      done: Promise.resolve(),
      interrupted: false,
      failed: false,
      paused: false,
      gates: new Semaphore(1),
      decisions: new Map(),
      workerRevision: 0,
      workerSnapshotRevision: -1,
    };
    this.runs.set(wo.id, run);
    run.done = this.execute(run).finally(() => this.finish(run));
  }

  protected async execute(run: Run): Promise<void> {
    const { wo } = run;
    try {
      if (wo.github) {
        this.setWorkOrder(run, { status: "building", startedAt: wo.startedAt ?? now() });
        await this.develop(run);
        this.setWorkOrder(run, { status: "releasing" });
        await this.pullRequest(run);
        this.setWorkOrder(run, { status: "completed", completedAt: now() });
        log.info("GitHub work order completed", { id: wo.id, pullRequest: wo.github.pullRequest?.number });
        return;
      }
      if (!wo.plan) await this.plan(run);
      this.setWorkOrder(run, { status: "building" });
      if (workOrderMode(wo) === "agent") {
        await this.coordinate(run);
      } else {
        await this.buildAll(run);
        this.setWorkOrder(run, { status: "releasing" });
        await this.runRelease(run);
      }
      this.setWorkOrder(run, { status: "completed", completedAt: now() });
      log.info("Work order completed", { id: wo.id, tests: wo.release?.tests });
    } catch (error) {
      if (this.stopping) return;
      if (run.abort.signal.aborted || error instanceof CancelledError) {
        this.cancelStations(wo);
        this.setWorkOrder(run, { status: "cancelled", completedAt: now() });
        log.info("Work order cancelled", { id: wo.id });
      } else if (!run.failed && (run.interrupted || this.interrupts(run, error))) {
        this.pauseRun(run, error);
      } else {
        const failure = toFactoryError(error);
        for (const station of wo.stations) {
          if (!TERMINAL_STATION_STATUSES.includes(station.status) && station.status !== "changes_requested") {
            Object.assign(station, { status: "skipped", detail: "Skipped", finishedAt: station.startedAt ? now() : undefined });
          }
        }
        this.setWorkOrder(run, { status: "failed", error: failure, completedAt: now() });
        log.warn("Work order failed", { id: wo.id, code: failure.code, message: failure.message });
      }
    }
  }

  protected async finish(run: Run): Promise<void> {
    this.runs.delete(run.wo.id);
    const timer = this.usageTimers.get(run.wo.id);
    if (timer) clearTimeout(timer);
    // The next run of this work order (a resume or retry) schedules its own usage saves.
    this.usageTimers.delete(run.wo.id);
    if (this.stopping) return;
    this.persist(run.wo);
    run.closed = true;
    await Promise.allSettled([...run.sessions.keys()].map((stationId) => this.closeSession(run, stationId)));
    if (run.paused) {
      this.resumeSoon(run.wo.id);
      return;
    }
    this.pauses.delete(run.wo.id);
    // Record where each station's session ended up (sessions replaced or deleted during the run included).
    if (!this.stopping) {
      await this.reconcileSessions([run.wo.id]).catch((error: unknown) => log.debug("Session reconciliation failed", { error: (error as Error).message }));
    }
  }

  protected cancelStations(wo: MWorkOrder): void {
    for (const station of wo.stations) {
      if (!TERMINAL_STATION_STATUSES.includes(station.status)) {
        Object.assign(station, { status: "cancelled", detail: "Cancelled", ...(station.startedAt ? { finishedAt: now() } : {}) });
      }
    }
  }
}
