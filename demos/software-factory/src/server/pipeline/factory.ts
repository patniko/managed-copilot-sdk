import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type PermissionHandler, type SessionConfig, type SessionEvent, type Tool } from "@github/copilot-sdk";
import { isManagedCopilotError, type ArtifactInfo, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import { z } from "zod";
import { FACTORY_ENVIRONMENTS, PR_REVIEWER_AGENT, ROLE_AGENTS, SANDBOX_SIZES } from "../../shared/environments.js";
import { findTemplate } from "../../shared/templates.js";
import {
  ACTIVE_WORK_ORDER_STATUSES,
  formatWorkOrderNumber,
  isGitHubWorkOrder,
  mediaTypeOf,
  TERMINAL_STATION_STATUSES,
  workOrderMode,
  type ActivityItem,
  type ArtifactFileView,
  type ArtifactIndex,
  type ChangeCheck,
  type ChangeRevision,
  type CreateWorkOrderRequest,
  type FactoryError,
  type GitHubWork,
  type MediaItem,
  type NetworkView,
  type OutputManifest,
  type Plan,
  type PlanTask,
  type PullRequestView,
  type ReleaseChange,
  type ReleaseFiles,
  type ReleaseSummary,
  type ReviewRecord,
  type Station,
  type StationKind,
  type StationRole,
  type TestReport,
  type TestSummary,
  type WorkOrder,
  type WorkOrderGate,
  type WorkOrderMode,
  type WorkOrderSummary,
} from "../../shared/types.js";
import type { FactoryConfig } from "../config.js";
import type { GitHubApi, TreeEntry } from "../github.js";
import { parseRepository } from "../github.js";
import type { EventHub } from "../hub.js";
import { log } from "../log.js";
import type { FactoryPlatform, StationSession } from "../platform.js";
import type { StoredArtifact, FactoryStore } from "../store.js";
import { StationActivityMapper } from "./activity.js";
import {
  builderName,
  coordinatorPrompt,
  coordinatorReminder,
  NoArgsSchema,
  ReleaseWorkerSchema,
  TaskSchema,
  TaskWorkerSchema,
  taskStart,
  toolDecision,
  WORKER_READY_TASK,
  type ToolStart,
} from "./coordinator.js";
import { CancelledError, isPlatformInterruption, PlatformUnavailableError, StationError, toFactoryError } from "./errors.js";
import {
  CONTEXT_PREFIX,
  describeInputs,
  digestOf,
  INTAKE_STATION,
  parseRoutedInputs,
  PROJECT_PREFIX,
  projectChanges,
  type LoadedInputs,
  type RoutedInputs,
} from "./inputs.js";
import { factoryPermissions } from "./permissions.js";
import { decideGate, gateActivity, openGate, parseDecision, parseGateDeclarations, parseOpenGate, parseOutcome, reportGate } from "./gates.js";
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
  type WorkspaceNotes,
} from "./prompts.js";
import { builderSeed, DEFAULT_SKILLS_ROOT, projectPackageName, releaseSeed, sha256, type SeedFile, type TaskOutcome } from "./seed.js";
import { Semaphore } from "./semaphore.js";
import {
  blobScript,
  branchName,
  changeCheckFailedPrompt,
  changeFixPrompt,
  changeRetryPrompt,
  changeReviewPrompt,
  checkoutScript,
  checkScript,
  commitMessage,
  developPrompt,
  gitBlobSha,
  MAX_MEDIA_BYTES,
  MAX_PUSH_BYTES,
  MAX_PUSH_FILE_BYTES,
  MAX_PUSH_FILES,
  outputTail,
  parseSnapshot,
  patchScript,
  pullRequestBody,
  REPO_DIR,
  requestMarkdown,
  revisionComment,
  revisionPrompt,
  snapshotScript,
  submitChangeRetryPrompt,
  SubmitChangeSchema,
  validateChange,
  workOrderTitle,
  type Snapshot,
  type SubmittedChange,
} from "./repo.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MStation = Mutable<Station>;
type MWorkOrder = Mutable<Omit<WorkOrder, "stations">> & { stations: MStation[] };
type ReadinessKind = WorkOrderMode | "github";

/** The single change lane of a GitHub work order. */
const CHANGE_TASK = "change";
const CHANGE_BUILD = `build:${CHANGE_TASK}`;
const CHANGE_REVIEW = `review:${CHANGE_TASK}`;
/** Repository archives the factory moves into a sandbox (GitHub's own limit for archives is far larger). */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
/** Checkout and diff commands in the sandbox. */
const SANDBOX_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_PATCH_BYTES = 1024 * 1024;

/** Nudges per round when the factory check fails before the station gives up. */
const MAX_NUDGES = 2;
/** Artifacts the factory keeps in its own store for viewing, diffing, and the release (bytes). */
const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "json", "md", "markdown", "txt", "patch", "diff", "csv", "tsv", "yml", "yaml",
  "toml", "ini", "sh", "bash", "py", "rb", "go", "rs", "java", "cs", "html", "htm", "css", "scss", "xml", "svg", "sql", "env", "gitignore", "npmignore", "editorconfig", "lock", "log",
]);

const ROLE_FOR_KIND: Readonly<Record<StationKind, StationRole>> = { plan: "planner", coordinate: "coordinator", build: "builder", review: "reviewer", release: "release" };

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

/** What a work order needs from the platform: GitHub work orders need `factory-repo` and sandbox commands. */
function readinessKind(wo: WorkOrder): ReadinessKind {
  return isGitHubWorkOrder(wo) ? "github" : workOrderMode(wo);
}

/** Key of an uploaded media file in `GitHubWork.uploads`. */
function mediaKey(item: Pick<MediaItem, "stationId" | "path" | "version">): string {
  return `${item.stationId}:${item.path}@${item.version}`;
}

/** "3 files changed · tests pass · 2 media" for the change station. */
function describeChange(revision: ChangeRevision): string {
  const files = revision.files?.length ?? 0;
  if (files === 0) return revision.answer ? "Answered · no changes" : "No changes";
  const parts = [`${files} file${files === 1 ? "" : "s"} changed`];
  if (revision.check) parts.push(revision.check.passed ? "tests pass" : "tests failing");
  const media = revision.media?.length ?? 0;
  if (media > 0) parts.push(`${media} media`);
  return parts.join(" · ");
}

/**
 * A `factory-repo` sandbox whose session-time npm install failed: most often a registry that hands out downloads from
 * other hosts than its own, which the environment's network rules don't list yet.
 */
function explainSetupFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/npm install -g .* failed/i.test(message)) return error;
  return new StationError(
    "setup_failed",
    `${message.replace(/\s*\[\w+\]\s*$/, "").replace(/[.\s]+$/, "")}. If your npm registry serves package downloads from other hosts (an Azure Artifacts upstream uses *.pkgs.visualstudio.com and *.vsblob.vsassets.io), list them in FACTORY_REPO_EXTRA_HOSTS and restart the AppHost.`,
  );
}

interface Capture {
  plan?: Plan;
  review?: ValidReview;
  /** GitHub work orders: the developer called `submit_change` in the current turn. */
  change?: SubmittedChange;
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
  readonly gates: Semaphore;
  readonly decisions: Map<string, { readonly start: ToolStart; readonly firstMessage: boolean }>;
  workerSync?: Promise<WorkerInfo[]>;
  workerRevision: number;
  workerSnapshotRevision: number;
  stopCoordinator?: (error: unknown) => void;
  /** A routed work order's files, loaded on first use. */
  inputs?: LoadedInputs;
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
  readonly readiness: (mode?: ReadinessKind) => { readonly ready: boolean; readonly reason?: string };
  readonly account: () => { readonly login: string; readonly avatarUrl?: string } | undefined;
  readonly config: Pick<FactoryConfig, "maxSandboxes" | "turnTimeoutMs" | "publicationTimeoutMs"> & Partial<Pick<FactoryConfig, "checkTimeoutMs">>;
  /** GitHub work orders: the factory's own GitHub access (repositories, archives, branches, pull requests). */
  readonly github?: GitHubApi;
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
/** Failed reads of an in-flight turn's status in a row (with the platform otherwise up) before the work order pauses. */
const MAX_READ_FAILURES = 5;

/** Runs work orders through the factory: plan → parallel builds with review loops → release. */
export class Factory {
  readonly #options: FactoryOptions;
  readonly #runs = new Map<string, Run>();
  readonly #cancelling = new Set<string>();
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
    return this.#runs.has(id) || this.#cancelling.has(id);
  }

  activity(id: string, stationId?: string): ActivityItem[] {
    return this.#store.listActivity(id, stationId);
  }

  artifactIndex(id: string): ArtifactIndex {
    const wo = this.get(id);
    // The intake (what a routed work order brought along) comes first, then the stations in pipeline order.
    const order = new Map([[INTAKE_STATION, -1], ...(wo?.stations ?? []).map((station, index) => [station.id, index] as const)]);
    const files = new Map<string, Mutable<ArtifactFileView> & { versions: ArtifactFileView["versions"][number][] }>();
    for (const meta of this.#store.listArtifacts(id)) {
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
    return this.#store.getArtifact(id, stationId, path, version);
  }

  /** A screenshot or recording the factory kept (GitHub work orders). */
  media(id: string, stationId: string, path: string, version?: number): { readonly bytes: Uint8Array; readonly contentType: string } | undefined {
    if (!mediaTypeOf(path)) return undefined;
    return this.#store.getArtifactBytes(id, stationId, path, version);
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
      files: [...this.#currentFiles(id, "release", "bundle/")].map(([path, content]) => ({ path, content })),
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
    this.#requireReady(mode);
    if (mode === "agent" && this.#platform.models.builder === this.#platform.models.reviewer) {
      throw new StationError("invalid_request", "Choose a reviewer model different from the builder model for independent review.");
    }
    const template = findTemplate(request.templateId);
    const inputs = parseRoutedInputs(request);
    const described = describeInputs(inputs);
    const owner = this.#options.account();
    const created = now();
    const gates = parseGateDeclarations(request.gates, inputs.origin !== undefined, created);
    const wo: MWorkOrder = {
      id: `wo_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      number: this.#store.nextWorkOrderNumber(),
      title,
      brief,
      mode,
      source: template ? { kind: "template", templateId: template.id } : { kind: "brief" },
      maxReviewRounds: rounds,
      status: "queued",
      createdAt: created,
      updatedAt: created,
      taskCount: 0,
      stations: [this.#newStation("plan"), ...(mode === "agent" ? [this.#newStation("coordinate")] : []), this.#newStation("release")],
      ...(owner ? { owner } : {}),
      ...(inputs.origin ? { origin: inputs.origin } : {}),
      ...(described ? { inputs: described } : {}),
      ...(gates.length ? { gates } : {}),
    };
    this.#store.saveWorkOrder(wo);
    this.#storeInputs(wo, inputs);
    log.info("Work order created", {
      id: wo.id,
      number: formatWorkOrderNumber(wo.number),
      title,
      ...(inputs.origin ? { origin: inputs.origin.app } : {}),
      ...(described ? { context: described.context.length, projectFiles: described.project?.files ?? 0 } : {}),
      ...(gates.length ? { gates: gates.map((gate) => gate.id).join(",") } : {}),
    });
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  /** Keeps a routed work order's files as the `intake` station's artifacts: the floor lists them, and the pipeline seeds from them. */
  #storeInputs(wo: WorkOrder, inputs: RoutedInputs): void {
    const files = [
      ...inputs.context.map((file) => ({ path: `${CONTEXT_PREFIX}${file.path}`, content: file.content })),
      ...(inputs.project?.files ?? []).map((file) => ({ path: `${PROJECT_PREFIX}${file.path}`, content: file.content })),
    ];
    if (files.length === 0) return;
    for (const file of files) {
      this.#store.putArtifact({
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
    this.#options.hub.publish({ type: "artifacts", workOrderId: wo.id });
  }

  /** A routed work order's context and project files, read once per run. */
  #inputs(run: Run): LoadedInputs | undefined {
    if (!run.wo.inputs) return undefined;
    if (run.inputs) return run.inputs;
    const context = new Map<string, string>();
    const project = new Map<string, string>();
    for (const artifact of this.#store.latestArtifacts(run.wo.id, INTAKE_STATION)) {
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
  #notes(run: Run): WorkspaceNotes | undefined {
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
    const github = this.#requireGitHub();
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
    this.#requireReady("github");
    if (this.#platform.models.developer === this.#platform.models.reviewer) {
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
    this.#requireReady("github");
    const titleText = typeof request.title === "string" && request.title.trim() ? request.title.trim().slice(0, 120) : workOrderTitle(brief, issue);
    const owner = this.#options.account();
    const created = now();
    const number = this.#store.nextWorkOrderNumber();
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
      stations: this.#changeStations(titleText),
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
    this.#store.saveWorkOrder(wo);
    log.info("GitHub work order created", { id: wo.id, number: formatWorkOrderNumber(wo.number), repository: repository.fullName, issue: issue?.number });
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  /** Asks for more changes on a finished GitHub work order: the same sandbox makes them, and they're pushed to the same pull request. */
  async revise(id: string, text: string): Promise<WorkOrder> {
    if (this.#runs.has(id) || this.#cancelling.has(id)) throw new StationError("conflict", "This work order is still running. Wait for it to finish, then ask for more changes.");
    const stored = this.#store.getWorkOrder(id);
    if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
    if (!stored.github) throw new StationError("invalid_request", "Only GitHub work orders take more changes.");
    if (stored.status !== "completed") throw new StationError("conflict", "Ask for more changes once the work order has finished; retry it if it failed.");
    const request = typeof text === "string" ? text.trim() : "";
    if (request.length < 3 || request.length > 8000) throw new StationError("invalid_request", "Say what to change in 3 to 8,000 characters.");
    this.#requireGitHub();
    this.#requireReady("github");
    const wo = stored as MWorkOrder;
    if (wo.github!.pullRequest) {
      await this.#refreshPullRequest(wo).catch((error: unknown) => log.debug("Couldn't refresh the pull request", { id, error: (error as Error).message }));
      const state = wo.github!.pullRequest!.state;
      if (state !== "open") throw new StationError("conflict", `Pull request #${wo.github!.pullRequest!.number} is ${state}. Start a new work order for more changes.`);
    }
    if (this.#runs.has(id)) throw new StationError("conflict", "This work order is already running.");
    const owner = this.#options.account();
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
    this.#persist(wo);
    this.#activity(wo, CHANGE_BUILD, `Revision ${revision.number} requested: ${request.split("\n")[0]!.slice(0, 160)}`, "info");
    log.info("More changes requested", { id, revision: revision.number });
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  /** Re-reads the work order's pull request from GitHub (its state, checks, and merge status). */
  async refreshPullRequest(id: string): Promise<WorkOrder> {
    const wo = this.get(id) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    if (!wo.github?.pullRequest) return structuredClone(wo);
    this.#requireGitHub();
    await this.#refreshPullRequest(wo);
    return structuredClone(wo);
  }

  /** Merges the work order's pull request on GitHub. */
  async merge(id: string, method: "merge" | "squash" | "rebase" = "squash"): Promise<WorkOrder> {
    if (!["merge", "squash", "rebase"].includes(method)) throw new StationError("invalid_request", 'Merge with "merge", "squash", or "rebase".');
    if (this.isActive(id)) throw new StationError("conflict", "This work order is still running. Merge once it has finished.");
    const wo = this.#store.getWorkOrder(id) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    const pull = wo.github?.pullRequest;
    if (!pull) throw new StationError("conflict", "This work order has no pull request to merge.");
    const github = this.#requireGitHub();
    const { owner, name } = wo.github!.repository;
    await github.merge(owner, name, pull.number, method);
    this.#activity(wo, "release", `Merged pull request #${pull.number} (${method})`, "success");
    await this.#refreshPullRequest(wo).catch(() => {
      wo.github = { ...wo.github!, pullRequest: { ...pull, state: "merged", mergedAt: now() } };
      this.#persist(wo);
    });
    log.info("Pull request merged", { id, pullRequest: pull.number, method });
    return structuredClone(wo);
  }

  async #refreshPullRequest(wo: MWorkOrder): Promise<void> {
    const github = this.#requireGitHub();
    const { owner, name } = wo.github!.repository;
    const pull = await github.pullRequest(owner, name, wo.github!.pullRequest!.number);
    wo.github = { ...wo.github!, pullRequest: pull };
    this.#persist(wo);
  }

  #requireGitHub(): GitHubApi {
    if (!this.#options.github) throw new StationError("platform_unavailable", "This factory isn't set up to work with GitHub.");
    return this.#options.github;
  }

  // ─── Gates ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** The routing app's request on a gate (its deploy request): it waits for a person on the floor. */
  openGate(id: string, gateId: string, body: unknown): WorkOrder {
    return this.#changeGate(id, gateId, (wo, gate, at) => {
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
    return this.#changeGate(id, gateId, (_wo, gate, at) => decideGate(gate, decision, this.#options.account()?.login, at));
  }

  /** The routing app's report: how the approved deploy went, or that its request was answered elsewhere. */
  reportGate(id: string, gateId: string, body: unknown): WorkOrder {
    const report = parseOutcome(body);
    return this.#changeGate(id, gateId, (_wo, gate, at) => reportGate(gate, report, at));
  }

  #changeGate(id: string, gateId: string, change: (wo: WorkOrder, gate: WorkOrderGate, at: string) => WorkOrderGate): WorkOrder {
    // A running work order's record is the run's; a finished one's is the store's.
    const wo = (this.#runs.get(id)?.wo ?? this.#store.getWorkOrder(id)) as MWorkOrder | undefined;
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    const gate = wo.gates?.find((candidate) => candidate.id === gateId);
    if (!gate) throw new StationError("not_found", `${formatWorkOrderNumber(wo.number)} has no ${gateId} gate.`);
    const updated = change(wo, gate, now());
    if (updated === gate) return structuredClone(wo);
    wo.gates = wo.gates!.map((candidate) => (candidate.id === gateId ? updated : candidate));
    this.#persist(wo);
    const said = gateActivity(updated, wo.origin?.name ?? "The routing app");
    this.#activity(wo, "release", said.text, said.level);
    log.info("Gate changed", { id: wo.id, gate: gateId, state: updated.state, ...(updated.decision?.by ? { by: updated.decision.by } : {}) });
    return structuredClone(wo);
  }

  async cancel(id: string): Promise<WorkOrder> {
    if (this.#cancelling.has(id)) throw new StationError("conflict", "This work order is already being cancelled.");
    const run = this.#runs.get(id);
    if (!run) {
      const stored = this.#store.getWorkOrder(id);
      if (!stored) throw new StationError("not_found", "That work order doesn't exist.");
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status)) throw new StationError("conflict", "Only an active work order can be cancelled.");
      // Interrupted by a restart (or paused by a lost connection) and never resumed: cancel the record directly.
      const wo = stored as MWorkOrder;
      this.#forgetPause(id);
      this.#cancelling.add(id);
      try {
        if (workOrderMode(wo) === "agent") {
          await this.#stopPersistedCoordinator(wo);
          await this.#deleteWorkerSessions(wo);
        }
        this.#cancelStations(wo);
        Object.assign(wo, { status: "cancelled", completedAt: now() });
        this.#persist(wo);
        return wo;
      } finally {
        this.#cancelling.delete(id);
      }
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
    this.#requireReady(readinessKind(stored));
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
    this.#persist(wo);
    this.#activity(wo, wo.stations[0]?.id ?? "plan", "Retrying from the last checkpoint", "info");
    const snapshot = structuredClone(wo);
    this.#start(wo);
    return snapshot;
  }

  /** Deletes the work order, its records, and (best effort) its platform sessions, sandboxes, and artifacts. */
  async delete(id: string): Promise<void> {
    if (this.isActive(id)) throw new StationError("conflict", "Finish cancelling the work order before deleting it.");
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
      if (!ACTIVE_WORK_ORDER_STATUSES.includes(stored.status) || this.isActive(stored.id)) continue;
      if (!this.#options.readiness(readinessKind(stored)).ready) continue;
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
    this.#activity(wo, wo.stations[0]?.id ?? "plan", note, "warning");
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
      run.closed = true;
      run.stopCoordinator?.(new CancelledError());
      for (const active of run.sessions.values()) active.mapper.close();
      await Promise.allSettled([...run.sessions.values()].map((active) => active.session.disconnect()));
    }
    await Promise.race([Promise.allSettled(runs.map((run) => run.done)), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    for (const timer of this.#usageTimers.values()) clearTimeout(timer);
    for (const timer of this.#resumeTimers.values()) clearTimeout(timer);
  }

  // ─── Run loop ───────────────────────────────────────────────────────────────────────────────────────────────

  #requireReady(mode: ReadinessKind): void {
    const { ready, reason } = this.#options.readiness(mode);
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
      gates: new Semaphore(1),
      decisions: new Map(),
      workerRevision: 0,
      workerSnapshotRevision: -1,
    };
    this.#runs.set(wo.id, run);
    run.done = this.#execute(run).finally(() => this.#finish(run));
  }

  async #execute(run: Run): Promise<void> {
    const { wo } = run;
    try {
      if (wo.github) {
        this.#setWorkOrder(run, { status: "building", startedAt: wo.startedAt ?? now() });
        await this.#develop(run);
        this.#setWorkOrder(run, { status: "releasing" });
        await this.#pullRequest(run);
        this.#setWorkOrder(run, { status: "completed", completedAt: now() });
        log.info("GitHub work order completed", { id: wo.id, pullRequest: wo.github.pullRequest?.number });
        return;
      }
      if (!wo.plan) await this.#plan(run);
      this.#setWorkOrder(run, { status: "building" });
      if (workOrderMode(wo) === "agent") {
        await this.#coordinate(run);
      } else {
        await this.#buildAll(run);
        this.#setWorkOrder(run, { status: "releasing" });
        await this.#release(run);
      }
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
      const inputs = this.#inputs(run);
      // A plan for an existing project keeps the project's own package name.
      const projectName = projectPackageName(inputs);
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
          capture.plan = projectName ? { ...result.value, projectName } : result.value;
          return `Accepted: ${result.value.tasks.length} task(s). Builders are starting now.`;
        },
      });
      const active = await this.#openSharedSession(run, station, { tools: [submitPlan] }, capture);
      await this.#turn(run, station, active, planPrompt(run.wo, inputs ? { inputs } : {}), "work", 1);
      if (!capture.plan) await this.#turn(run, station, active, planRetryPrompt(), "nudge", 1);
      const plan = capture.plan;
      if (!plan) throw new StationError("plan_missing", "The planner didn't submit a plan.");
      const tasks = topologicalOrder(plan.tasks);
      run.wo.plan = plan;
      run.wo.taskCount = plan.tasks.length;
      run.wo.stations = [
        station,
        ...(workOrderMode(run.wo) === "agent" ? [this.#station(run, "coordinator")] : []),
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
      const inputs = this.#inputs(run);
      const active = await this.#openSandboxSession(run, build, () => builderSeed(run.wo, run.wo.plan!, task, dependencyFiles, this.#skillsRoot, inputs));
      await this.#bringTurnCurrent(run, build, active, false, () => buildPrompt(run.wo, task, [...dependencyFiles.keys()], this.#notes(run)));

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

  async #reviewRound(run: Run, task: PlanTask, build: MStation, report: TestReport | undefined, builderSummary: string | undefined, reuse = true): Promise<ValidReview> {
    const review = this.#station(run, `review:${task.id}`);
    const round = build.round;
    const existing = reuse ? review.reviews?.find((record) => record.round === round) : undefined;
    if (existing) return existing;
    const files = [...this.#taskFiles(run, task.id)]
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => Number(/\.(test|spec)\./.test(a.path)) - Number(/\.(test|spec)\./.test(b.path)) || a.path.localeCompare(b.path));
    const previous = review.reviews?.at(-1)?.findings;
    const inputs = this.#inputs(run);
    // A task that changed an existing project's files is reviewed against their originals.
    const project = inputs?.project
      ? {
          name: inputs.project.name,
          originals: files.flatMap((file) => {
            const original = inputs.project!.files.get(file.path);
            return original !== undefined && file.path !== "package.json" ? [{ path: file.path, content: original }] : [];
          }),
        }
      : undefined;
    return this.#review(run, review, build, round, () =>
      reviewPrompt(task, round, run.wo.maxReviewRounds, { files, report, builderSummary, ...(project ? { project } : {}) }, previous),
    );
  }

  /**
   * One review turn: opens (or reuses) the review station's shared session with `submit_review`, sends the prompt, and
   * records the verdict for the build's `round`. Requested changes are announced on the build station.
   */
  async #review(run: Run, review: MStation, build: MStation, round: number, prompt: () => string, label = round): Promise<ValidReview> {
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
    this.#updateStation(run, review, { round, detail: `Reviewing round ${label}` });
    await this.#turn(run, review, active, prompt(), "review", round);
    if (!captured()) await this.#turn(run, review, active, reviewRetryPrompt(), "nudge", round);
    const verdict = captured();
    if (!verdict) throw new StationError("review_missing", "The reviewer didn't submit a verdict.");
    const record: ReviewRecord = { round, verdict: verdict.verdict, summary: verdict.summary, findings: verdict.findings, at: now() };
    this.#updateStation(run, review, { reviews: [...(review.reviews ?? []).filter((item) => item.round !== round), record] });
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
      this.#updateStation(run, review, { status: "changes_requested", detail: `${blocking} finding${blocking === 1 ? "" : "s"} sent back to the ${build.role === "developer" ? "developer" : "builder"}` });
      this.#activity(run.wo, build.id, `Reviewer requested changes: ${blocking} finding${blocking === 1 ? "" : "s"} to fix`, "warning");
    }
    return verdict;
  }

  // ─── Release ────────────────────────────────────────────────────────────────────────────────────────────────

  async #release(run: Run): Promise<void> {
    const station = this.#station(run, "release");
    if (station.status === "done" && run.wo.release) return;
    const plan = run.wo.plan!;
    const outcomes = this.#outcomes(run);
    const seed = releaseSeed(run.wo, plan, outcomes, this.#skillsRoot, this.#inputs(run));
    this.#updateStation(run, station, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.#sandboxes.acquire(run.abort.signal);
    try {
      const active = await this.#openSandboxSession(run, station, () => [...seed.files]);
      await this.#bringTurnCurrent(run, station, active, true, () => releasePrompt(run.wo, plan, seed.conflicts, this.#notes(run)));
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
        this.#acceptRelease(run, station, outcome);
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

  #outcomes(run: Run): TaskOutcome[] {
    return run.wo.plan!.tasks.map((task) => {
      const review = this.#station(run, `review:${task.id}`);
      return { task, reviews: review.reviews ?? [], acceptedWithFindings: Boolean(review.acceptedWithFindings), files: this.#taskFiles(run, task.id) };
    });
  }

  #acceptRelease(run: Run, station: MStation, outcome: CheckOutcome): void {
    const latest = this.#store.latestArtifacts(run.wo.id, station.id);
    const patch = latest.find((artifact) => artifact.path === "project.patch");
    const notes = latest.find((artifact) => artifact.path === "RELEASE.md")?.content;
    const manifest = outcome.manifest!;
    const project = this.#inputs(run)?.project;
    let changes: ReleaseChange[] | undefined;
    if (project) {
      const bundle = new Map(latest.filter((artifact) => artifact.path.startsWith("bundle/")).map((artifact) => [artifact.path.slice("bundle/".length), artifact.content]));
      changes = projectChanges(project.files, new Map(manifest.files.map((file) => [file.path, { content: bundle.get(file.path), sha256: file.sha256 }])));
    }
    const release: ReleaseSummary = {
      files: manifest.files.length,
      bytes: manifest.files.reduce((total, file) => total + file.size, 0),
      tests: summaryOf(outcome.report!),
      ...(patch ? { patchBytes: patch.size } : {}),
      ...(notes ? { notes } : {}),
      ...(changes ? { changes } : {}),
    };
    run.wo.release = release;
    this.#updateStation(run, station, { status: "done", detail: `Release ready · ${release.tests!.passed} tests passed`, finishedAt: now() });
    const changed = changes ? `, ${changes.filter((change) => change.status !== "added").length} of ${project!.name}'s files changed and ${changes.filter((change) => change.status === "added").length} added` : "";
    this.#activity(run.wo, station.id, `Release ready: ${release.files} files${changed}, ${release.tests!.passed} tests passed`, "success");
  }

  // ─── GitHub work orders ─────────────────────────────────────────────────────────────────────────────────────

  /** One lane: the developer's change (a `factory-repo` sandbox), its review, and the pull request the factory opens. */
  #changeStations(title: string): MStation[] {
    return [
      {
        id: CHANGE_BUILD,
        kind: "build",
        title: `Change · ${title}`,
        taskId: CHANGE_TASK,
        status: "waiting",
        detail: "Queued",
        role: "developer",
        environment: FACTORY_ENVIRONMENTS.developer,
        placement: "sandbox",
        agent: ROLE_AGENTS.developer,
        model: this.#platform.models.developer,
        round: 0,
      },
      {
        id: CHANGE_REVIEW,
        kind: "review",
        title: `Review · ${title}`,
        taskId: CHANGE_TASK,
        status: "waiting",
        detail: "Waits for the change",
        role: "reviewer",
        environment: FACTORY_ENVIRONMENTS.reviewer,
        placement: "shared",
        agent: PR_REVIEWER_AGENT,
        model: this.#platform.models.reviewer,
        round: 0,
      },
      {
        id: "release",
        kind: "release",
        title: "Pull request",
        status: "waiting",
        detail: "Waits for the review",
        role: "developer",
        environment: FACTORY_ENVIRONMENTS.developer,
        placement: "sandbox",
        agent: "factory",
        round: 0,
      },
    ];
  }

  #revision(run: Run): ChangeRevision {
    return run.wo.github!.revisions.at(-1)!;
  }

  /** Updates the current revision (the last one); `undefined` values remove a field. */
  #updateRevision(run: Run, patch: Partial<Mutable<ChangeRevision>>): ChangeRevision {
    if (run.closed) return this.#revision(run);
    const github = run.wo.github!;
    const revisions = [...github.revisions];
    const current: Record<string, unknown> = { ...revisions.at(-1)! };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete current[key];
      else current[key] = value;
    }
    revisions[revisions.length - 1] = current as unknown as ChangeRevision;
    run.wo.github = { ...github, revisions };
    this.#persist(run.wo);
    return revisions.at(-1)!;
  }

  #updateGitHub(run: Run, patch: Partial<Mutable<GitHubWork>>): void {
    if (run.closed) return;
    run.wo.github = { ...run.wo.github!, ...patch };
    this.#persist(run.wo);
  }

  #submitChangeTool(run: Run, capture: Capture): Tool<unknown> {
    return defineTool("submit_change", {
      description:
        "Submit your change to the software factory: the pull request title and description, the test command the factory re-runs, and your screenshots and recordings. If you were asked a question, put your answer in `answer`. Returns 'Recorded' or the problems to fix before calling it again.",
      parameters: SubmitChangeSchema,
      skipPermission: true,
      handler: async (args: unknown) => {
        const result = validateChange(args);
        if (!result.ok) return `Rejected. Fix these problems and call submit_change again:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
        const value = result.value;
        capture.change = value;
        this.#updateRevision(run, {
          title: value.title,
          summary: value.summary,
          testCommand: value.testCommand,
          answer: value.answer,
          requestedMedia: value.media,
        });
        const media = value.media.length;
        return `Recorded. The factory re-runs ${value.testCommand ? `\`${value.testCommand}\`` : "no tests (no test command)"}, collects ${media} media file${media === 1 ? "" : "s"} from /workspace/outputs/media, and sends the change to review.`;
      },
    }) as Tool<unknown>;
  }

  async #develop(run: Run): Promise<void> {
    const build = this.#station(run, CHANGE_BUILD);
    const review = this.#station(run, CHANGE_REVIEW);
    if (this.#revision(run).acceptedRound !== undefined) return;
    let current = build;
    if (build.status === "waiting") this.#updateStation(run, build, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.#sandboxes.acquire(run.abort.signal);
    try {
      const capture: Capture = {};
      const active = await this.#openSandboxSession(run, build, () => [{ path: ".factory/REQUEST.md", content: requestMarkdown(run.wo) }], {
        extra: { tools: [this.#submitChangeTool(run, capture)] },
        capture,
        prepare: (opened) => this.#checkout(run, build, opened),
      });
      await this.#startRevision(run, build, active);

      let nudges = 0;
      for (;;) {
        current = build;
        if (build.passedRound !== build.round) {
          const submitted = this.#revision(run);
          if (submitted.summary === undefined && submitted.answer === undefined) {
            if (nudges >= MAX_NUDGES) throw new StationError("change_missing", "The developer didn't submit its change with submit_change.");
            nudges++;
            this.#activity(run.wo, build.id, "The developer finished without calling submit_change; asking it to", "warning");
            await this.#turn(run, build, active, submitChangeRetryPrompt(), "nudge", build.round);
            continue;
          }
          const check = await this.#verifyChange(run, build);
          if (check && !check.passed && nudges < MAX_NUDGES) {
            nudges++;
            this.#activity(run.wo, build.id, `\`${check.command}\` failed when the factory re-ran it; asking the developer to fix it`, "warning");
            await this.#turn(run, build, active, changeCheckFailedPrompt(check), "nudge", build.round);
            continue;
          }
          this.#updateStation(run, build, { status: "done", passedRound: build.round, detail: describeChange(this.#revision(run)), finishedAt: now() });
        }
        const revision = this.#revision(run);
        if ((revision.files ?? []).length === 0) {
          this.#updateStation(run, review, { status: "skipped", detail: "No file changes to review", round: build.round });
          this.#updateRevision(run, { acceptedRound: build.round });
          return;
        }

        current = review;
        const startRound = revision.startRound ?? 1;
        const used = build.round - startRound + 1;
        const existing = review.reviews?.find((record) => record.round === build.round);
        const previous = review.reviews?.filter((record) => record.round >= startRound && record.round < build.round).at(-1)?.findings;
        const verdict =
          existing ??
          (await this.#review(run, review, build, build.round, () => this.#changeReviewPrompt(run, build, used, previous), used));
        if (verdict.verdict === "approve") {
          this.#updateStation(run, review, { status: "done", detail: `Approved in round ${used}`, finishedAt: now() });
          this.#updateRevision(run, { acceptedRound: build.round });
          return;
        }
        if (used >= run.wo.maxReviewRounds) {
          this.#updateStation(run, review, {
            status: "done",
            acceptedWithFindings: true,
            detail: `Accepted after ${used} rounds with findings open`,
            finishedAt: now(),
          });
          this.#activity(run.wo, review.id, "Maximum review rounds reached: the pull request lists the open findings", "warning");
          this.#updateRevision(run, { acceptedRound: build.round });
          return;
        }
        nudges = 0;
        current = build;
        this.#updateStation(run, build, { finishedAt: undefined });
        await this.#turn(run, build, active, changeFixPrompt(used + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary), "fix", build.round + 1);
      }
    } catch (caught) {
      const error = explainSetupFailure(caught);
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.#stopping) await this.#failStation(run, current, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.#stopping) {
        // Detach; the session (and its sandbox, with the working tree) stays for the pull request and later revisions.
        await this.#closeSession(run, build.id);
        await this.#closeSession(run, review.id);
      }
    }
  }

  /**
   * Makes sure the current revision's request reached the developer: its first turn (the request), a retry note, or a
   * turn still in flight after a restart.
   */
  async #startRevision(run: Run, build: MStation, active: ActiveSession): Promise<void> {
    const revision = this.#revision(run);
    const sent = revision.startRound !== undefined && (build.turn?.round ?? 0) >= revision.startRound;
    if (!sent) {
      this.#updateStation(run, build, { retryNote: undefined });
      const round = build.round + 1;
      this.#updateRevision(run, { startRound: round });
      // REQUEST.md lists every follow-up so far.
      await this.#platform.files(active.session.sessionId).write(".factory/REQUEST.md", requestMarkdown(run.wo));
      const prompt = revision.number === 1 ? developPrompt(run.wo) : revisionPrompt(revision, run.wo.github!.pullRequest);
      await this.#turn(run, build, active, prompt, "work", round);
    } else if (build.retryNote) {
      const note = build.retryNote;
      this.#updateStation(run, build, { retryNote: undefined, passedRound: undefined });
      await this.#turn(run, build, active, changeRetryPrompt(note), "retry", Math.max(build.round, 1));
    } else if (build.turn && !build.turn.completedAt) {
      await this.#awaitTurn(run, build, active, "change");
    }
  }

  /**
   * Puts the repository into the sandbox without a credential: the factory downloads the base commit's archive with its
   * own GitHub token and uploads it, and the sandbox unpacks it into a git repository. A replacement sandbox also gets
   * the work already pushed to the branch.
   */
  async #checkout(run: Run, station: MStation, active: ActiveSession): Promise<void> {
    const github = this.#requireGitHub();
    const work = run.wo.github!;
    const { owner, name, fullName } = work.repository;
    const pushed = [...work.revisions].reverse().find((revision) => revision.pushed && revision.commitSha)?.commitSha;
    this.#updateStation(run, station, { detail: `Checking out ${fullName}` });
    active.mapper.status(`Checking out ${fullName} at ${work.baseSha.slice(0, 7)} (${work.repository.defaultBranch})${pushed ? `, with the work already pushed (${pushed.slice(0, 7)})` : ""}`);
    const dir = mkdtempSync(join(tmpdir(), "factory-checkout-"));
    try {
      const files = this.#platform.files(active.session.sessionId);
      const archives: [string, string][] = [[work.baseSha, "base.tar.gz"], ...(pushed ? ([[pushed, "head.tar.gz"]] as [string, string][]) : [])];
      for (const [ref, file] of archives) {
        const local = join(dir, file);
        const size = await github.downloadTarball(owner, name, ref, local);
        if (size > MAX_ARCHIVE_BYTES) throw new StationError("repository_too_large", `${fullName} is ${Math.round(size / 1024 / 1024)} MB packed; the factory checks out repositories up to ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
        this.#throwIfCancelled(run);
        await files.upload(local, `.factory/${file}`);
      }
      const result = await this.#platform.exec(
        active.session.sessionId,
        checkoutScript({ branch: work.branch, baseArchive: ".factory/base.tar.gz", ...(pushed ? { headArchive: ".factory/head.tar.gz" } : {}), label: `${fullName}@${work.baseSha.slice(0, 12)}` }),
        { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal },
      );
      this.#throwIfCancelled(run);
      if (result.state !== "completed" || result.exitCode !== 0) {
        throw new StationError("checkout_failed", `Couldn't check out ${fullName} in the sandbox: ${outputTail(result.output, 400) || result.state}`);
      }
      const count = /CHECKED_OUT \S+ (\d+) files/.exec(result.output)?.[1];
      active.mapper.status(`Checked out ${fullName}${count ? ` (${Number(count).toLocaleString("en-US")} files)` : ""} into /workspace/${REPO_DIR}, tagged factory-base`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The developer's working tree against `factory-base`, through a temporary index (nothing in the sandbox changes). */
  async #snapshot(run: Run, station: MStation): Promise<Snapshot> {
    const result = await this.#platform.exec(station.sessionId!, snapshotScript(), { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal });
    this.#throwIfCancelled(run);
    if (result.state !== "completed" || result.exitCode !== 0) {
      throw new StationError("diff_failed", `Couldn't read the change from the sandbox: ${outputTail(result.output, 400) || result.state}`);
    }
    try {
      return parseSnapshot(result.output);
    } catch (error) {
      throw new StationError("diff_failed", (error as Error).message);
    }
  }

  /** Re-runs the developer's test command, collects its media, and records the change for review. */
  async #verifyChange(run: Run, build: MStation): Promise<ChangeCheck | undefined> {
    this.#updateStation(run, build, { status: "collecting", detail: "Collecting the change" });
    await this.#capturePublication(run, build);
    const revision = this.#revision(run);
    const media = this.#matchMedia(run, build, revision.requestedMedia ?? []);
    const snapshot = await this.#snapshot(run, build);
    await this.#savePatch(run, build, snapshot);
    let check: ChangeCheck | undefined;
    if (snapshot.files.length > 0 && revision.testCommand) {
      this.#updateStation(run, build, { detail: `Running ${revision.testCommand}` });
      const started = Date.now();
      const result = await this.#platform.exec(build.sessionId!, checkScript(revision.testCommand), {
        timeoutMs: this.#options.config.checkTimeoutMs ?? 10 * 60_000,
        signal: run.abort.signal,
      });
      this.#throwIfCancelled(run);
      const passed = result.state === "completed" && result.exitCode === 0;
      check = {
        command: revision.testCommand,
        passed,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        durationMs: Date.now() - started,
        output: outputTail(result.output),
        at: now(),
      };
      this.#activity(
        run.wo,
        build.id,
        passed
          ? `The factory re-ran \`${check.command}\`: passed (${spokenDuration(check.durationMs)})`
          : `The factory re-ran \`${check.command}\`: ${result.state === "timed_out" ? "it timed out" : `exit ${result.exitCode ?? result.state}`}`,
        passed ? "success" : "warning",
      );
    }
    this.#updateRevision(run, { files: snapshot.files, media, check });
    if (snapshot.files.length === 0) this.#activity(run.wo, build.id, revision.answer ? "Answered the request without changing files" : "The developer didn't change any files", "info");
    return check;
  }

  /** The media the developer listed, matched to what its turn actually published (and the factory kept). */
  #matchMedia(run: Run, build: MStation, requested: readonly { readonly path: string; readonly caption: string }[]): MediaItem[] {
    const metas = this.#store.listArtifacts(run.wo.id).filter((meta) => meta.stationId === build.id);
    const media: MediaItem[] = [];
    for (const item of requested) {
      const meta = metas.find((candidate) => candidate.path === item.path && candidate.hasBytes);
      const type = mediaTypeOf(item.path);
      if (!meta || !type) {
        const published = metas.find((candidate) => candidate.path === item.path);
        this.#activity(
          run.wo,
          build.id,
          published ? `${item.path} is over ${MAX_MEDIA_BYTES / 1024 / 1024} MB, so it's left out of the pull request` : `${item.path} wasn't in /workspace/outputs, so it's left out of the pull request`,
          "warning",
        );
        continue;
      }
      media.push({ stationId: build.id, path: item.path, version: meta.version, caption: item.caption, kind: type.kind, contentType: type.contentType, size: meta.size });
    }
    return media;
  }

  /** Keeps the change's diff as the station's `change.patch` artifact, for the floor's diff viewer and the reviewer. */
  async #savePatch(run: Run, build: MStation, snapshot: Snapshot): Promise<void> {
    let content = "";
    if (snapshot.files.length > 0) {
      const result = await this.#platform.exec(build.sessionId!, patchScript(snapshot.tree), { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal });
      this.#throwIfCancelled(run);
      if (result.state !== "completed" || result.exitCode !== 0) throw new StationError("diff_failed", `Couldn't read the change's diff: ${outputTail(result.output, 400) || result.state}`);
      content = result.output;
    }
    const digest = `sha256:${sha256(content)}`;
    const latest = this.#store.listArtifacts(run.wo.id).find((meta) => meta.stationId === build.id && meta.path === "change.patch");
    if (latest?.digest === digest) return;
    const bytes = Buffer.byteLength(content, "utf8");
    this.#store.putArtifact({
      workOrderId: run.wo.id,
      stationId: build.id,
      path: "change.patch",
      version: this.#store.nextArtifactVersion(run.wo.id, build.id, "change.patch"),
      round: build.round,
      size: bytes,
      digest,
      contentType: "text/x-diff",
      publishedAt: now(),
      ...(bytes <= MAX_PATCH_BYTES ? { content } : {}),
    });
    this.#options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
  }

  #changeReviewPrompt(run: Run, build: MStation, used: number, previous: ReviewRecord["findings"] | undefined): string {
    const revision = this.#revision(run);
    const patch = this.#store.latestArtifacts(run.wo.id, build.id).find((artifact) => artifact.path === "change.patch")?.content ?? "(The diff is too large to show.)";
    const developerSummary = run.sessions.get(build.id)?.mapper.lastMessage;
    return changeReviewPrompt(run.wo, used, run.wo.maxReviewRounds, { patch, files: revision.files ?? [], revision, ...(developerSummary ? { developerSummary } : {}) }, previous);
  }

  async #pullRequest(run: Run): Promise<void> {
    const station = this.#station(run, "release");
    const build = this.#station(run, CHANGE_BUILD);
    const review = this.#station(run, CHANGE_REVIEW);
    let revision = this.#revision(run);
    if (revision.completedAt) return;
    const work = run.wo.github!;
    if ((revision.files ?? []).length === 0) {
      this.#updateStation(run, station, { status: "skipped", detail: work.pullRequest ? "No new changes to push" : "No changes, so no pull request", finishedAt: now() });
      this.#updateRevision(run, { outcome: "no_changes", completedAt: now() });
      return;
    }
    const github = this.#requireGitHub();
    const { owner, name } = work.repository;
    try {
      this.#updateStation(run, station, { status: "working", detail: "Pushing the change", startedAt: station.startedAt ?? now(), round: build.round });
      if (!revision.pushed) await this.#pushRevision(run, station, build);
      revision = this.#revision(run);
      const urls = await this.#uploadMedia(run, station, revision.media ?? []);
      const text = {
        wo: run.wo,
        revision,
        reviews: (review.reviews ?? []).filter((record) => record.round >= (revision.startRound ?? 1)),
        acceptedWithFindings: Boolean(review.acceptedWithFindings),
        mediaUrls: urls,
        mediaKey,
        models: { developer: build.model ?? this.#platform.models.developer, reviewer: review.model ?? this.#platform.models.reviewer },
      };
      const existing = run.wo.github!.pullRequest;
      if (!existing) {
        this.#updateStation(run, station, { detail: "Opening the pull request" });
        const pull =
          (await github.findPullRequest(owner, name, work.branch)) ??
          (await github.createPullRequest(owner, name, { title: revision.title ?? run.wo.title, body: pullRequestBody(text), head: work.branch, base: work.repository.defaultBranch }));
        this.#updateGitHub(run, { pullRequest: pull });
        this.#updateRevision(run, { outcome: "pull_request", completedAt: now() });
        this.#activity(run.wo, station.id, `Opened pull request #${pull.number}: ${pull.title}`, "success");
        this.#updateStation(run, station, { status: "done", detail: `Opened #${pull.number}`, finishedAt: now() });
      } else {
        this.#updateStation(run, station, { detail: `Commenting on #${existing.number}` });
        const url = revision.commentUrl ?? (await github.comment(owner, name, existing.number, revisionComment(text)));
        this.#updateRevision(run, { commentUrl: url, outcome: "pushed", completedAt: now() });
        await this.#refreshPullRequest(run.wo).catch((error: unknown) => log.debug("Couldn't refresh the pull request", { error: (error as Error).message }));
        this.#activity(run.wo, station.id, `Pushed revision ${revision.number} to pull request #${existing.number}`, "success");
        this.#updateStation(run, station, { status: "done", detail: `Revision ${revision.number} pushed to #${existing.number}`, finishedAt: now() });
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.#stopping) await this.#failStation(run, station, error);
      throw error;
    }
  }

  /**
   * Turns the sandbox's working tree into a commit on the work order's branch with GitHub's Git Data API: a blob per
   * changed file, a tree on top of the base commit's, and a commit whose parent is the last one the factory pushed. The
   * branch only moves forward: commits the factory didn't make stop the push instead of being overwritten.
   */
  async #pushRevision(run: Run, station: MStation, build: MStation): Promise<void> {
    const github = this.#requireGitHub();
    const work = run.wo.github!;
    const { owner, name } = work.repository;
    let revision = this.#revision(run);
    const parent = [...work.revisions].reverse().find((item) => item.number < revision.number && item.pushed && item.commitSha)?.commitSha ?? work.baseSha;
    const remote = await github.branchHead(owner, name, work.branch);
    const foreign = (sha: string | undefined) => sha !== undefined && sha !== parent && sha !== revision.commitSha;
    if (foreign(remote)) {
      throw new StationError(
        "conflict",
        `${work.branch} on GitHub has commits the factory didn't make (now at ${remote!.slice(0, 7)}). The factory won't overwrite them: start a new work order, or reset the branch to ${parent.slice(0, 7)}.`,
      );
    }
    if (!revision.commitSha) {
      const snapshot = await this.#snapshot(run, build);
      if (snapshot.files.length === 0) throw new StationError("nothing_to_push", "The working tree no longer has any changes to push.");
      this.#updateStation(run, station, { detail: `Uploading ${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"}` });
      const entries = await this.#treeEntries(run, build, snapshot);
      const baseTree = await github.commitTree(owner, name, work.baseSha);
      const tree = await github.createTree(owner, name, baseTree, entries);
      const commit = await github.createCommit(owner, name, { message: commitMessage(run.wo, revision, work.issue), tree, parents: [parent] });
      revision = this.#updateRevision(run, { commitSha: commit, files: snapshot.files });
    }
    const commit = revision.commitSha!;
    if (remote !== commit) {
      if (remote) await github.updateBranch(owner, name, work.branch, commit);
      else await github.createBranch(owner, name, work.branch, commit);
    }
    this.#updateRevision(run, { pushed: true });
    const files = revision.files?.length ?? 0;
    this.#activity(run.wo, station.id, `Pushed ${files} changed file${files === 1 ? "" : "s"} to ${work.branch} (${commit.slice(0, 7)})`, "success");
  }

  async #treeEntries(run: Run, build: MStation, snapshot: Snapshot): Promise<TreeEntry[]> {
    const github = this.#requireGitHub();
    const { owner, name } = run.wo.github!.repository;
    const sessionId = build.sessionId!;
    const files = this.#platform.files(sessionId);
    const changed = snapshot.entries.filter((entry) => entry.mode !== "160000");
    if (changed.length > MAX_PUSH_FILES) throw new StationError("change_too_large", `The change touches ${changed.length} files; the factory pushes at most ${MAX_PUSH_FILES}.`);
    const entries: TreeEntry[] = [];
    let total = 0;
    const queue = [...changed];
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        this.#throwIfCancelled(run);
        if (entry.status === "deleted" || !entry.sha) {
          entries.push({ path: entry.path, mode: "100644", sha: null });
          continue;
        }
        let bytes: Uint8Array;
        if (entry.mode === "120000") {
          const result = await this.#platform.exec(sessionId, blobScript(entry.sha), { timeoutMs: 60_000, signal: run.abort.signal });
          if (result.state !== "completed" || result.exitCode !== 0) throw new StationError("diff_failed", `Couldn't read the symbolic link ${entry.path}.`);
          bytes = Buffer.from(result.output, "utf8");
        } else {
          bytes = await files.readBytes(`${REPO_DIR}/${entry.path}`);
        }
        if (bytes.length > MAX_PUSH_FILE_BYTES) throw new StationError("change_too_large", `${entry.path} is ${Math.round(bytes.length / 1024 / 1024)} MB; the factory pushes files up to ${MAX_PUSH_FILE_BYTES / 1024 / 1024} MB.`);
        total += bytes.length;
        if (total > MAX_PUSH_BYTES) throw new StationError("change_too_large", `The change is over ${MAX_PUSH_BYTES / 1024 / 1024} MB; the factory doesn't push changes that large.`);
        if (gitBlobSha(bytes) !== entry.sha) throw new StationError("workspace_changed", `${entry.path} changed while the factory was pushing it. Retry the work order.`);
        const sha = await github.createBlob(owner, name, bytes);
        entries.push({ path: entry.path, mode: entry.mode === "100755" || entry.mode === "120000" ? entry.mode : "100644", sha });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, changed.length)) }, worker));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Uploads the revision's media as GitHub attachments (once each); a failed upload is reported and left out. */
  async #uploadMedia(run: Run, station: MStation, media: readonly MediaItem[]): Promise<Record<string, string>> {
    const github = this.#requireGitHub();
    const work = run.wo.github!;
    const urls: Record<string, string> = { ...(work.uploads ?? {}) };
    const pending = media.filter((item) => !urls[mediaKey(item)]);
    if (pending.length > 0) this.#updateStation(run, station, { detail: `Attaching ${pending.length} screenshot${pending.length === 1 ? "" : "s"} and recording${pending.length === 1 ? "" : "s"}` });
    for (const item of pending) {
      this.#throwIfCancelled(run);
      const stored = this.#store.getArtifactBytes(run.wo.id, item.stationId, item.path, item.version);
      if (!stored) {
        this.#activity(run.wo, station.id, `${item.path} is no longer stored, so it's left out of the pull request`, "warning");
        continue;
      }
      try {
        urls[mediaKey(item)] = await github.uploadAttachment(work.repository.id, item.path.split("/").pop() ?? item.path, item.contentType, stored.bytes);
        this.#updateGitHub(run, { uploads: { ...(run.wo.github!.uploads ?? {}), [mediaKey(item)]: urls[mediaKey(item)]! } });
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        this.#activity(run.wo, station.id, `Couldn't attach ${item.path} to the pull request: ${toFactoryError(error).message}`, "warning");
      }
    }
    return urls;
  }

  // ─── Agent-led coordination ────────────────────────────────────────────────────────────────────────────────

  #ensureCoordinatorRun(run: Run): void {
    if (this.#stopping || run.closed || this.#runs.get(run.wo.id) !== run) throw new CancelledError();
    this.#throwIfCancelled(run);
  }

  async #coordinate(run: Run): Promise<void> {
    const station = this.#station(run, "coordinator");
    if (run.wo.release && this.#station(run, "release").status === "done") {
      this.#updateStation(run, station, { status: "done", detail: "Release accepted", finishedAt: now() });
      return;
    }
    let active: ActiveSession | undefined;
    let unwatch = () => {};
    let failure: unknown;
    const failed = new Promise<never>((_, reject) => {
      run.stopCoordinator = (error) => { failure ??= error; reject(error); };
    });
    // A gate can fail during the resume RPC, before a completion wait has been installed.
    void failed.catch(() => undefined);
    const cancelled = () => run.stopCoordinator?.(new CancelledError());
    run.abort.signal.addEventListener("abort", cancelled, { once: true });
    try {
      const resuming = Boolean(station.sessionId);
      const mapper = this.#newMapper(run, station);
      const config = this.#sessionConfig(run, station, mapper, {
        tools: this.#coordinatorTools(run),
        onPermissionRequest: this.#coordinatorPermissions(run, mapper),
        onEvent: (event) => {
          mapper.handle(event);
          this.#coordinatorEvent(run, event);
        },
      });
      this.#updateStation(run, station, {
        status: "starting", detail: resuming ? "Reattaching to the coordinator" : "Opening the coordinator",
        model: station.model ?? this.#platform.models.coordinator, startedAt: station.startedAt ?? now(),
      });
      const session = station.sessionId
        ? await this.#platform.resumeSession("coordinator", station.sessionId, config)
        : await this.#platform.createSession("coordinator", { ...config, model: station.model });
      active = { session, mapper, capture: {} };
      run.sessions.set(station.id, active);
      this.#ensureCoordinatorRun(run);
      this.#updateStation(run, station, { sessionId: session.sessionId });
      if (resuming) {
        // App tools interrupted by a restart may need reconciliation. Their effects are checkpointed and idempotent:
        // end only the coordinator's old turn, then let a fresh turn read those checkpoints. Workers keep running.
        await this.#endCoordinatorTurn(run, active);
        this.#activity(run.wo, station.id, "Resumed the same coordinator session; reconciling its workers before continuing", "info");
      }
      await this.#syncWorkers(run, true);
      unwatch = this.#watchWorkers(run);
      for (let attempt = 0; attempt <= MAX_NUDGES; attempt++) {
        const prompt = attempt === 0 ? coordinatorPrompt(run.wo, this.#platform.models, resuming) : coordinatorReminder();
        await Promise.race([this.#turn(run, station, active, prompt, resuming ? "continue" : "work", 1), failed]);
        if (failure) throw failure;
        await this.#syncWorkers(run, true);
        if (run.wo.release && this.#station(run, "release").status === "done") {
          this.#updateStation(run, station, { status: "done", detail: "Release accepted by the factory", finishedAt: now() });
          return;
        }
        this.#activity(run.wo, station.id, "The coordinator stopped before the release passed; asking it to continue from the factory checkpoints", "warning");
      }
      throw new StationError("release_incomplete", "The coordinator stopped without getting the release accepted by the factory.");
    } catch (error) {
      if (!this.#stopping) {
        if (active) await this.#abortCoordinator(active.session);
        if (!(error instanceof CancelledError) && !run.abort.signal.aborted) await this.#failStation(run, station, failure ?? error);
        if (run.abort.signal.aborted || run.failed) await this.#deleteWorkerSessions(run.wo);
      }
      throw failure ?? error;
    } finally {
      unwatch();
      run.abort.signal.removeEventListener("abort", cancelled);
      delete run.stopCoordinator;
    }
  }

  async #abortCoordinator(session: StationSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StationError("timeout", "The coordinator didn't acknowledge the stop.")), ABORT_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      log.warn("Couldn't stop the coordinator turn", { sessionId: session.sessionId, error: toFactoryError(error).message });
    } finally {
      clearTimeout(timer);
    }
  }

  async #endCoordinatorTurn(run: Run, active: ActiveSession): Promise<void> {
    await this.#stopCoordinatorTurn(active.session, () => this.#ensureCoordinatorRun(run));
  }

  async #stopCoordinatorTurn(session: StationSession, ensureActive: () => void): Promise<void> {
    let info = await this.#platform.sessionInfo(session.sessionId);
    if (!info.lastTurn || info.lastTurn.completedAt) return;
    await this.#abortCoordinator(session);
    const deadline = Date.now() + ABORT_TIMEOUT_MS;
    while (info.lastTurn && !info.lastTurn.completedAt) {
      ensureActive();
      if (Date.now() >= deadline) throw new StationError("timeout", "The coordinator's interrupted turn has not stopped yet. Retry once the platform has ended it.");
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs ?? 250));
      info = await this.#platform.sessionInfo(session.sessionId);
    }
  }

  async #stopPersistedCoordinator(wo: MWorkOrder): Promise<void> {
    const station = wo.stations.find((item) => item.kind === "coordinate");
    if (!station?.sessionId) return;
    let info: SessionInfo;
    try {
      info = await this.#platform.sessionInfo(station.sessionId);
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return;
      throw error;
    }
    if (!info.lastTurn || info.lastTurn.completedAt) return;
    const session = await this.#platform.resumeSession("coordinator", station.sessionId, {
      agent: station.agent,
      tools: [],
      onPermissionRequest: () => ({ kind: "reject", feedback: "This work order is being cancelled." }),
    });
    try {
      await this.#stopCoordinatorTurn(session, () => {});
      this.#activity(wo, station.id, "Stopped the persisted coordinator turn before cancelling its workers", "info");
    } finally {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Coordinator detach timed out")), DETACH_TIMEOUT_MS); }),
        ]);
      } catch (error) {
        log.warn("Couldn't detach the cancelled coordinator", { sessionId: station.sessionId, error: toFactoryError(error).message });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  #watchWorkers(run: Run): () => void {
    let stopped = false;
    let failures = 0;
    const refresh = () => {
      if (stopped || this.#stopping || run.closed) return;
      void this.#syncWorkers(run).then(() => { failures = 0; }, (error: unknown) => {
        if (stopped || this.#stopping || run.closed) return;
        log.warn("Couldn't reconcile the coordinator's workers", { id: run.wo.id, error: toFactoryError(error).message });
        if (++failures >= MAX_READ_FAILURES || !this.#options.readiness().ready) run.stopCoordinator?.(error);
      });
    };
    const unlisten = this.#platform.onWorkerEvent?.((id) => {
      if (id === this.#station(run, "coordinator").sessionId) {
        run.workerRevision++;
        refresh();
      }
    });
    const timer = setInterval(refresh, this.#options.pollMs ?? 3_000);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); unlisten?.(); };
  }

  async #syncWorkers(run: Run, fresh = false): Promise<WorkerInfo[]> {
    // A gate needs a pass that began after its preceding I/O, not a watcher pass already partway through its reads.
    if (fresh && run.workerSync) await run.workerSync;
    if (run.workerSync) return run.workerSync;
    const read = async (): Promise<WorkerInfo[]> => {
      this.#ensureCoordinatorRun(run);
      const coordinator = this.#station(run, "coordinator");
      if (!coordinator.sessionId) return [];
      const workers = await this.#platform.workers(coordinator.sessionId).list();
      this.#ensureCoordinatorRun(run);
      for (const station of run.wo.stations.filter((item) => item.kind === "build" || item.kind === "release")) {
        const name = station.taskId ? builderName(station.taskId) : "release";
        const worker = [...workers].reverse().find((item) => item.name === name);
        if (!worker) continue;
        const prior = station.worker;
        const replaced = prior !== undefined && prior.id !== worker.id;
        if (replaced) {
          this.#store.deleteStationArtifacts(run.wo.id, station.id);
          if (station.taskId) {
            const review = this.#station(run, `review:${station.taskId}`);
            this.#updateStation(run, review, { status: "waiting", round: 0, reviews: undefined, acceptedWithFindings: undefined, finishedAt: undefined });
          }
          this.#updateStation(run, station, {
            previousSessionIds: [...(station.previousSessionIds ?? []), prior.id],
            round: 0, turn: undefined, seeded: undefined, workerCheck: undefined, passedRound: undefined,
            reviewedMessages: undefined, reviewedTurnId: undefined, reportVersion: undefined, staleReportVersion: undefined, awaitingFix: undefined,
            failedChecks: undefined, inputRevision: undefined, sandbox: undefined, tests: undefined, finishedAt: undefined,
          });
          this.#options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
        }
        const newMessage = !replaced && prior !== undefined && worker.messages > prior.messages && station.seeded;
        if (newMessage) {
          const reviewed = station.taskId && this.#station(run, `review:${station.taskId}`).reviews?.some((review) => review.round === station.round);
          const nextRound = Boolean(reviewed) || station.awaitingFix;
          const round = nextRound ? station.round + 1 : Math.max(1, station.round);
          this.#updateStation(run, station, {
            round, passedRound: undefined, workerCheck: undefined, reviewedMessages: undefined, reviewedTurnId: undefined,
            staleReportVersion: station.reportVersion, awaitingFix: undefined, finishedAt: undefined,
            ...(nextRound ? { failedChecks: 0 } : {}),
            turn: { kind: nextRound ? "fix" : station.round === 0 ? "work" : "nudge", round, sentAt: worker.updatedAt },
          });
          if (station.taskId) this.#updateStation(run, this.#station(run, `review:${station.taskId}`), { status: "waiting", detail: "Waits for the updated build", finishedAt: undefined });
        }
        this.#updateStation(run, station, {
          sessionId: worker.id, model: worker.model ?? station.model, startedAt: station.startedAt ?? worker.createdAt,
          worker: {
            id: worker.id, name: worker.name, state: worker.state, messages: worker.messages,
            ...(!replaced && prior?.turnId ? { turnId: prior.turnId } : {}),
            createdRound: replaced ? 1 : prior?.createdRound ?? 1, ...(worker.error ? { error: worker.error } : {}),
          },
        });
        if (worker.state !== "starting" && worker.state !== "stopped") await this.#refreshSandbox(run, station, worker.state === "idle" || worker.state === "working");
        this.#ensureCoordinatorRun(run);
        if (worker.state === "starting" || worker.state === "working") {
          this.#updateStation(run, station, {
            status: worker.state === "starting" ? "starting" : "working",
            detail: !station.seeded ? "Waiting for workspace preparation" : station.round > 1 ? `Fixing review findings (round ${station.round})` : "Working in its own sandbox",
          });
        } else if (station.turn && !station.turn.completedAt) {
          this.#updateStation(run, station, {
            turn: { ...station.turn, completedAt: worker.updatedAt }, status: "waiting",
            detail: worker.state === "idle" ? "Work finished; awaits the factory check" : worker.error ?? `Worker ${worker.state}`,
          });
        }
        if (worker.state === "idle" && (prior?.state !== "idle" || prior.messages !== worker.messages) && worker.result) {
          this.#emitItem(run.wo, { id: `worker:${worker.id}:${worker.messages}`, stationId: station.id, kind: "message", text: worker.result });
        }
      }
      if (run.wo.workersStarted !== workers.length) this.#setWorkOrder(run, { workersStarted: workers.length });
      return workers;
    };
    const sync = async (): Promise<WorkerInfo[]> => {
      for (;;) {
        const revision = run.workerRevision;
        const workers = await read();
        // Worker events and coordinator mutation tools invalidate even a partially read snapshot.
        if (revision === run.workerRevision) {
          run.workerSnapshotRevision = revision;
          return workers;
        }
      }
    };
    run.workerSync = sync().finally(() => { delete run.workerSync; });
    return run.workerSync;
  }

  #requireWorkerSnapshot(run: Run): void {
    const changing = [...run.decisions.values()].some(({ start }) => start.data.toolName === "message_worker" || start.data.toolName === "stop_worker");
    if (run.workerSync || run.workerSnapshotRevision !== run.workerRevision || changing) {
      throw new StationError("conflict", "Worker instructions changed while the factory was checking them. Wait for pending worker tools to finish, then call the factory gate again.");
    }
  }

  #coordinatorPermissions(run: Run, mapper: StationActivityMapper): PermissionHandler {
    const ordinary = factoryPermissions("shared", (kind) => mapper.status(`Denied a "${kind}" request`, "warning"));
    return async (request, invocation) => {
      if (request.managedApprovalRequired) return { kind: "no-result" };
      if (request.kind !== "custom-tool" || request.toolName !== "start_worker") return ordinary(request, invocation);
      try {
        this.#ensureCoordinatorRun(run);
        const args = z.object({ name: z.string(), task: z.string(), environment: z.string(), agent: z.string(), model: z.string().optional() }).parse(request.args);
        const task = run.wo.plan!.tasks.find((candidate) => builderName(candidate.id) === args.name);
        const role = task ? "builder" : args.name === "release" ? "release" : undefined;
        if (!role) throw new StationError("invalid_request", "Start only a named builder from the accepted plan, or the release worker.");
        if (args.environment !== FACTORY_ENVIRONMENTS[role] || args.agent !== role) {
          throw new StationError("invalid_request", `Use environment ${FACTORY_ENVIRONMENTS[role]} and agent ${role}.`);
        }
        const inherited = this.#station(run, "coordinator").model;
        if ((args.model ?? inherited) !== this.#platform.models[role]) throw new StationError("invalid_request", `Use model ${this.#platform.models[role]} for the ${role}.`);
        if (args.task !== WORKER_READY_TASK) throw new StationError("invalid_request", `Use the factory's readiness task exactly: ${JSON.stringify(WORKER_READY_TASK)}`);
        const workers = await this.#syncWorkers(run, true);
        if (workers.some((worker) => worker.name === args.name && worker.state !== "stopped")) {
          throw new StationError("conflict", `Worker ${args.name} already exists. Reuse it with message_worker, or wait_for_workers while it is busy.`);
        }
        if (task) this.#requireDependencies(run, task);
        else this.#requireAcceptedTasks(run);
        this.#ensureCoordinatorRun(run);
        return { kind: "approve-once" };
      } catch (error) {
        const message = error instanceof z.ZodError ? "Pass a worker name, readiness task, environment, agent, and model from the factory instructions." : toFactoryError(error).message;
        this.#emitItem(run.wo, { stationId: "coordinator", kind: "decision", decision: { action: "declined", status: "failed" }, text: `Worker start declined: ${message}`, level: "warning" });
        if (!(error instanceof StationError) && !(error instanceof z.ZodError) && !(error instanceof CancelledError)) run.stopCoordinator?.(error);
        return { kind: "reject", feedback: message };
      }
    };
  }

  #coordinatorTools(run: Run): NonNullable<SessionConfig["tools"]> {
    const tool = <T>(name: string, description: string, parameters: z.ZodType<T>, handler: (args: T) => Promise<Record<string, unknown>>): Tool<T> =>
      defineTool(name, {
        description, parameters, skipPermission: true,
        handler: async (args) => {
          const parsed = parameters.safeParse(args);
          if (!parsed.success) return { resultType: "failure", textResultForLlm: JSON.stringify({ ok: false, summary: "Invalid tool arguments. Use the parameters in this tool's schema." }) };
          const release = await run.gates.acquire(run.abort.signal);
          try {
            this.#ensureCoordinatorRun(run);
            const result = await handler(parsed.data);
            this.#ensureCoordinatorRun(run);
            return { resultType: result.ok === false ? "failure" : "success", textResultForLlm: JSON.stringify(result) };
          } catch (error) {
            const refusal = error instanceof StationError && ["invalid_request", "conflict", "session_busy"].includes(error.code);
            if (!refusal && !this.#stopping && !run.closed) run.stopCoordinator?.(error);
            return { resultType: "failure", textResultForLlm: JSON.stringify({ ok: false, fatal: !refusal, summary: toFactoryError(error).message, error: toFactoryError(error) }) };
          } finally {
            release();
          }
        },
      });
    return [
      tool("prepare_workspace", "Prepare a builder's inputs after its readiness turn, then return the task to send with message_worker. Idempotent; never creates a worker.", TaskWorkerSchema,
        ({ taskId, worker }) => this.#prepareBuilder(run, taskId, worker)),
      tool("check_build", "Check the builder's latest published files and fresh test report. Returns a fix message when they fail. Never starts or messages a worker.", TaskSchema,
        ({ taskId }) => this.#checkWorker(run, this.#taskStation(run, taskId), false)),
      tool("request_review", "Review a checked build in factory-reviewer on a second model. Returns acceptance or findings to send to the SAME builder. Review rounds are bounded.", TaskSchema,
        ({ taskId }) => this.#reviewWorker(run, taskId)),
      tool("prepare_release", "After all tasks are accepted, list the copy_worker_files operations needed for the release. Call again after copying: verifies copied bytes, seeds the release, and returns its task.", ReleaseWorkerSchema,
        ({ worker }) => this.#prepareAgentRelease(run, worker)),
      tool("check_release", "Check the release worker's fresh full test suite, bundle, patch, and release notes; only this tool can accept the deliverable.", NoArgsSchema,
        () => this.#checkWorker(run, this.#station(run, "release"), true)),
      tool("factory_status", "Read the factory's persisted checkpoints and the coordinator's current workers, including which factory gate each task needs next.", NoArgsSchema,
        () => this.#coordinatorStatus(run)),
    ];
  }

  #taskStation(run: Run, taskId: string): MStation {
    if (!run.wo.plan!.tasks.some((task) => task.id === taskId)) throw new StationError("invalid_request", `There is no task "${taskId}" in the accepted plan.`);
    return this.#station(run, `build:${taskId}`);
  }

  #taskAccepted(run: Run, taskId: string): boolean {
    const build = this.#station(run, `build:${taskId}`);
    return this.#station(run, `review:${taskId}`).status === "done"
      && build.workerCheck?.passed === true && build.workerCheck.messages === build.worker?.messages
      && build.workerCheck.turnId === build.worker?.turnId
      && build.reviewedMessages === build.worker?.messages && build.reviewedTurnId === build.worker?.turnId
      && build.worker?.state === "idle" && !build.sessionGone;
  }

  #requireDependencies(run: Run, task: PlanTask): void {
    const waiting = task.dependsOn.filter((id) => !this.#taskAccepted(run, id));
    if (waiting.length) throw new StationError("conflict", `Wait for these dependencies to pass the factory's review: ${waiting.join(", ")}.`);
  }

  #requireAcceptedTasks(run: Run): void {
    this.#requireWorkerSnapshot(run);
    const waiting = run.wo.plan!.tasks.filter((task) => !this.#taskAccepted(run, task.id));
    if (waiting.length) throw new StationError("conflict", `The release must wait for these tasks to pass checks and review: ${waiting.map((task) => task.id).join(", ")}.`);
  }

  async #workerFor(run: Run, station: MStation, ref?: string, bootstrap = false): Promise<WorkerInfo> {
    const deadline = Date.now() + Math.min(this.#options.config.turnTimeoutMs.builder, 180_000);
    for (;;) {
      const workers = await this.#syncWorkers(run, true);
      const worker = workers.find((item) => item.id === station.worker?.id);
      if (!worker || (ref && worker.name !== ref && worker.id !== ref)) throw new StationError("invalid_request", `Start the ${station.taskId ? builderName(station.taskId) : "release"} worker first.`);
      if (worker.coordinatorId !== this.#station(run, "coordinator").sessionId || worker.environment !== station.environment || worker.agent !== station.agent) {
        throw new StationError("invalid_request", "This worker doesn't belong to the factory station's coordinator, environment, and agent.");
      }
      if (worker.state === "stopped") throw new StationError("conflict", `Worker ${worker.name} was stopped. Start its replacement with the same name.`);
      if (worker.state !== "working" && worker.state !== "starting") {
        const info = await this.#platform.sessionInfo(worker.id);
        this.#ensureCoordinatorRun(run);
        if (info.parentSessionId !== worker.coordinatorId || info.placement !== "sandbox" || !info.sandbox) {
          throw new StationError("conflict", `Worker ${worker.name} doesn't have the expected sandbox.`);
        }
        if (info.lastTurn && !info.lastTurn.completedAt) throw new StationError("session_busy", `Worker ${worker.name} still has an unfinished turn. Use wait_for_workers.`);
        if (station.worker) this.#updateStation(run, station, { worker: { ...station.worker, turnId: info.lastTurn?.turnId } });
        return worker;
      }
      if (!bootstrap || worker.messages > 1) throw new StationError("session_busy", `Worker ${worker.name} is still working. Use wait_for_workers, then call this tool again.`);
      if (Date.now() >= deadline) throw new StationError("timeout", `Worker ${worker.name} didn't finish preparing its sandbox in time.`);
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs ?? 1_000));
    }
  }

  async #seedWorker(run: Run, station: MStation, files: readonly SeedFile[], inputRevision?: string): Promise<void> {
    const writer = this.#platform.files(station.sessionId!);
    for (const file of files) {
      this.#ensureCoordinatorRun(run);
      await writer.write(file.path, file.content);
    }
    this.#ensureCoordinatorRun(run);
    this.#updateStation(run, station, {
      seeded: true, status: "waiting", detail: "Workspace ready; waiting for the coordinator's instructions",
      ...(inputRevision ? { inputRevision } : {}),
    });
    this.#activity(run.wo, station.id, `Factory prepared ${files.length} input files in ${station.worker!.name}`, "info");
  }

  async #prepareBuilder(run: Run, taskId: string, ref: string): Promise<Record<string, unknown>> {
    const station = this.#taskStation(run, taskId);
    const task = run.wo.plan!.tasks.find((candidate) => candidate.id === taskId)!;
    this.#requireDependencies(run, task);
    const worker = await this.#workerFor(run, station, ref, true);
    this.#requireWorkerSnapshot(run);
    this.#requireDependencies(run, task);
    const dependencyFiles = this.#dependencyFiles(run, task);
    if (!station.seeded) {
      if (worker.messages > 1) throw new StationError("conflict", "This builder started work before its inputs were prepared. Stop it and start a fresh builder with the readiness task.");
      await this.#seedWorker(run, station, builderSeed(run.wo, run.wo.plan!, task, dependencyFiles, this.#skillsRoot, this.#inputs(run)));
    }
    return {
      ok: true, ready: true, summary: `Prepared **${worker.name}** for ${task.title}`,
      worker: worker.name, alreadyWorking: worker.messages > 1,
      message: buildPrompt(run.wo, task, [...dependencyFiles.keys()], this.#notes(run)),
    };
  }

  async #checkWorker(run: Run, station: MStation, release: boolean): Promise<Record<string, unknown>> {
    const worker = await this.#workerFor(run, station);
    this.#requireWorkerSnapshot(run);
    if (!station.seeded || worker.messages < 2) throw new StationError("conflict", "Prepare the workspace and send its real task with message_worker before checking it.");
    if (release) {
      this.#requireAcceptedTasks(run);
      if (station.inputRevision !== this.#inputRevision(run)) throw new StationError("conflict", "A builder changed after the release inputs were prepared. Review that build, then prepare a new release worker.");
    }
    const turnId = station.worker?.turnId;
    if (!turnId) throw new StationError("conflict", "The worker has not completed a runtime turn to check.");
    const previous = station.workerCheck;
    if (previous?.messages === worker.messages && previous.turnId === turnId) return this.#checkReply(station, release);
    if (worker.state !== "idle") {
      return { ok: false, summary: `Worker **${worker.name}** failed: ${worker.error ?? "its turn did not finish"}`, message: continuePrompt(release), worker: worker.name };
    }
    const outcome = await this.#collect(run, station, release, { version: station.staleReportVersion, turnId });
    await this.#syncWorkers(run, true);
    this.#ensureCoordinatorRun(run);
    this.#requireWorkerSnapshot(run);
    if (station.worker?.id !== worker.id || station.worker.messages !== worker.messages || station.worker.state !== "idle" || station.worker.turnId !== turnId) {
      throw new StationError("conflict", "The worker changed while the factory was checking it. Wait for the new work to finish, then check again.");
    }
    if (release) {
      this.#requireAcceptedTasks(run);
      if (station.inputRevision !== this.#inputRevision(run)) throw new StationError("conflict", "A builder changed while the release was being checked. Review its new output and prepare a new release worker.");
    }
    let problem = outcome.problem;
    let code = outcome.code;
    if (outcome.passed && release) {
      const latest = this.#store.latestArtifacts(run.wo.id, station.id);
      if (!latest.some((item) => item.path === "RELEASE.md" && item.content?.trim()) || !latest.some((item) => item.path === "project.patch" && item.content?.trim())) {
        problem = "The release must publish outputs/RELEASE.md and outputs/project.patch.";
        code = "release_incomplete";
      }
    }
    const passed = outcome.passed && !problem;
    this.#updateStation(run, station, {
      workerCheck: { messages: worker.messages, turnId, passed, code, problem },
      status: passed ? "done" : "waiting", detail: passed ? `${outcome.report!.summary.passed} tests passed${release ? "" : " · ready for review"}` : `Check failed: ${problem}`,
      ...(passed ? { passedRound: station.round, finishedAt: now() } : { failedChecks: (station.failedChecks ?? 0) + 1 }),
    });
    if (!passed && station.failedChecks! > MAX_NUDGES) {
      const error = new StationError(code, `The ${release ? "release" : "builder"} couldn't get the factory check to pass: ${problem}`);
      await this.#failStation(run, station, error);
      throw error;
    }
    if (passed && release) this.#acceptRelease(run, station, outcome);
    return this.#checkReply(station, release);
  }

  #checkReply(station: MStation, release: boolean): Record<string, unknown> {
    const check = station.workerCheck!;
    return {
      ok: check.passed, accepted: release && check.passed, worker: station.worker!.name,
      summary: check.passed
        ? `${release ? "Release accepted" : `Factory check for **${station.worker!.name}**`}: **${station.tests?.passed ?? 0} tests pass**`
        : `Factory check for **${station.worker!.name}** failed: ${check.problem}`,
      tests: station.tests,
      ...(check.passed ? { next: release ? "The deliverable is ready. Stop workers you no longer need and report the result." : "Call request_review." }
        : { message: checkFailedPrompt(check.problem, undefined, release), error: { code: check.code, message: check.problem } }),
    };
  }

  async #reviewWorker(run: Run, taskId: string): Promise<Record<string, unknown>> {
    const build = this.#taskStation(run, taskId);
    const worker = await this.#workerFor(run, build);
    this.#requireWorkerSnapshot(run);
    const turnId = build.worker?.turnId;
    if (!build.workerCheck?.passed || build.workerCheck.messages !== worker.messages || build.workerCheck.turnId !== turnId) throw new StationError("conflict", "Call check_build on the latest worker output and get a passing report before requesting review.");
    const review = this.#station(run, `review:${taskId}`);
    const task = run.wo.plan!.tasks.find((candidate) => candidate.id === taskId)!;
    const verdict = await this.#reviewRound(run, task, build, this.#latestReport(run, build.id), worker.result, build.reviewedMessages === worker.messages && build.reviewedTurnId === turnId);
    await this.#syncWorkers(run, true);
    this.#ensureCoordinatorRun(run);
    this.#requireWorkerSnapshot(run);
    if (build.worker?.id !== worker.id || build.worker.messages !== worker.messages || build.worker.state !== "idle" || build.worker.turnId !== turnId) {
      this.#updateStation(run, review, { status: "waiting", detail: "The builder changed during review; check and review its new output" });
      throw new StationError("conflict", "The builder changed during review. Check its new output and request review again.");
    }
    const accepted = verdict.verdict === "approve" || build.round >= run.wo.maxReviewRounds;
    this.#updateStation(run, build, { reviewedMessages: worker.messages, reviewedTurnId: turnId, awaitingFix: !accepted });
    if (accepted) {
      this.#updateStation(run, build, { detail: `${build.tests?.passed ?? 0} tests passed` });
      this.#updateStation(run, review, {
        status: "done", finishedAt: now(), acceptedWithFindings: verdict.verdict !== "approve",
        detail: verdict.verdict === "approve" ? `Approved in round ${build.round}` : `Accepted after ${build.round} rounds with findings open`,
      });
      await this.#closeSession(run, review.id);
    }
    return {
      ok: true, accepted, worker: worker.name, round: build.round, verdict: verdict.verdict, findings: verdict.findings,
      summary: accepted
        ? `Factory review: **${worker.name}** ${verdict.verdict === "approve" ? "approved" : "accepted with open findings"} in round ${build.round}`
        : `Factory review: **${verdict.findings.length} ${verdict.findings.length === 1 ? "finding" : "findings"}** for **${worker.name}**; reuse this builder for round ${build.round + 1}`,
      ...(accepted ? {} : { message: fixPrompt(build.round + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary) }),
    };
  }

  #inputRevision(run: Run): string {
    return sha256(JSON.stringify(run.wo.plan!.tasks.map((task) => {
      const build = this.#station(run, `build:${task.id}`);
      return [task.id, build.worker?.id, build.workerCheck?.messages, build.workerCheck?.turnId, build.reportVersion];
    })));
  }

  async #prepareAgentRelease(run: Run, ref: string): Promise<Record<string, unknown>> {
    await this.#syncWorkers(run, true);
    this.#requireAcceptedTasks(run);
    const station = this.#station(run, "release");
    const worker = await this.#workerFor(run, station, ref, true);
    const revision = this.#inputRevision(run);
    const outcomes = this.#outcomes(run);
    const inputs = this.#inputs(run);
    const seed = releaseSeed(run.wo, run.wo.plan!, outcomes, this.#skillsRoot, inputs);
    if (station.seeded && station.inputRevision !== revision) throw new StationError("conflict", "The accepted builder outputs changed. Stop the release worker and start a fresh one.");
    if (!station.seeded) {
      if (worker.messages > 1) throw new StationError("conflict", "The release started before its inputs were prepared. Stop it and start a fresh release worker.");
      const copies = outcomes.map(({ task }) => ({
        from: this.#station(run, `build:${task.id}`).worker!.name,
        to: worker.name, paths: ["outputs/files"], destination: `.factory/incoming/${task.id}`,
      }));
      const copied: TaskOutcome[] = [];
      const missing: string[] = [];
      const reader = this.#platform.files(worker.id);
      for (const outcome of outcomes) {
        const files = new Map<string, string>();
        for (const [path, expected] of outcome.files) {
          this.#ensureCoordinatorRun(run);
          const source = `.factory/incoming/${outcome.task.id}/outputs/files/${path}`;
          try {
            const content = await reader.read(source);
            if (sha256(content) !== sha256(expected)) missing.push(source);
            else files.set(path, content);
          } catch (error) {
            if (isManagedCopilotError(error, "not_found")) missing.push(source);
            else throw error;
          }
        }
        copied.push({ ...outcome, files });
      }
      if (missing.length) {
        return { ok: true, ready: false, summary: "Release needs the accepted builders' files copied in", copies, next: "Run these copy_worker_files operations, then call prepare_release again. Do not send the release its task yet." };
      }
      await this.#syncWorkers(run, true);
      this.#requireAcceptedTasks(run);
      if (this.#inputRevision(run) !== revision) throw new StationError("conflict", "A builder changed while the factory prepared the release. Check and review it again.");
      await this.#seedWorker(run, station, releaseSeed(run.wo, run.wo.plan!, copied, this.#skillsRoot, inputs).files, revision);
      this.#setWorkOrder(run, { status: "releasing" });
    }
    return {
      ok: true, ready: true, worker: worker.name, summary: "Verified copied outputs and prepared the **release** sandbox",
      message: releasePrompt(run.wo, run.wo.plan!, seed.conflicts, this.#notes(run)),
    };
  }

  async #coordinatorStatus(run: Run): Promise<Record<string, unknown>> {
    const workers = await this.#syncWorkers(run, true);
    return {
      ok: true, summary: run.wo.release ? "The release is accepted." : "Factory checkpoints",
      releaseAccepted: Boolean(run.wo.release),
      tasks: run.wo.plan!.tasks.map((task) => {
        const build = this.#station(run, `build:${task.id}`);
        const review = this.#station(run, `review:${task.id}`);
        return {
          taskId: task.id, dependsOn: task.dependsOn, worker: build.worker, seeded: Boolean(build.seeded), round: build.round,
          check: build.workerCheck, accepted: this.#taskAccepted(run, task.id), latestReview: review.reviews?.at(-1),
          start: taskStart(task, this.#platform.models.builder),
        };
      }),
      release: this.#station(run, "release"),
      workers: workers.map(({ id, name, environment, state, messages, error }) => ({ id, name, environment, state, messages, error })),
    };
  }

  #coordinatorEvent(run: Run, event: SessionEvent): void {
    if (this.#stopping || run.closed || event.agentId) return;
    if (event.type === "tool.execution_start") {
      if (["start_worker", "message_worker", "copy_worker_files", "stop_worker"].includes(event.data.toolName)) run.workerRevision++;
      const args = event.data.arguments;
      const ref = args && typeof args === "object" && "worker" in args ? args.worker : undefined;
      const firstMessage = event.data.toolName === "message_worker"
        && run.wo.stations.some((station) => station.worker?.messages === 1 && (station.worker.name === ref || station.worker.id === ref));
      run.decisions.set(event.data.toolCallId, { start: event, firstMessage });
      const decision = toolDecision(event.data.toolName, args, "running", firstMessage);
      if (decision) {
        this.#emitItem(run.wo, { id: `decision:${event.data.toolCallId}`, stationId: "coordinator", kind: "decision", ...decision });
        this.#updateStation(run, this.#station(run, "coordinator"), { detail: decision.text.replace(/\*\*/g, "") });
      }
    } else if (event.type === "tool.execution_complete") {
      const running = run.decisions.get(event.data.toolCallId);
      if (!running) return;
      run.decisions.delete(event.data.toolCallId);
      const { start, firstMessage } = running;
      if (["start_worker", "message_worker", "copy_worker_files", "stop_worker"].includes(start.data.toolName)) run.workerRevision++;
      const decision = toolDecision(start.data.toolName, start.data.arguments, event.data.success ? "done" : "failed", firstMessage);
      if (!decision) return;
      const result = parseJson<{ summary?: unknown }>(event.data.result?.content);
      this.#emitItem(run.wo, {
        id: `decision:${event.data.toolCallId}`, stationId: "coordinator", kind: "decision", ...decision,
        text: typeof result?.summary === "string" ? result.summary : decision.text,
        level: event.data.success ? "info" : "warning",
      });
    }
  }

  /** Cancelling a work order must stop its workers without attaching a client that would take over their prompts. */
  async #deleteWorkerSessions(wo: MWorkOrder): Promise<void> {
    const id = wo.stations.find((station) => station.kind === "coordinate")?.sessionId;
    if (!id) return;
    try {
      const workers = await this.#platform.workers(id).list();
      await Promise.all(workers.filter((worker) => worker.state !== "stopped").map(async (worker) => {
        try {
          await this.#platform.deleteSession(worker.id);
        } catch (error) {
          if (!isManagedCopilotError(error, "not_found")) throw error;
        }
      }));
    } catch (error) {
      if (isManagedCopilotError(error, "not_found")) return;
      const message = `Couldn't stop every worker: ${toFactoryError(error).message}. Delete the work order to retry cleanup.`;
      wo.error = { code: "cleanup_failed", message };
      this.#activity(wo, "coordinator", message, "error");
      log.warn("Worker cleanup failed", { id: wo.id, error: message });
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

  /**
   * Sandbox stations resume their existing session when they have one, so a restart or retry keeps the workspace.
   * `extra` adds session options (a station's own tools) on create and resume; `prepare` runs after the seed files are
   * written, before the station counts as seeded (a GitHub checkout).
   */
  async #openSandboxSession(
    run: Run,
    station: MStation,
    seed: () => SeedFile[],
    options: { readonly extra?: Partial<SessionConfig>; readonly capture?: Capture; readonly prepare?: (active: ActiveSession) => Promise<void> } = {},
  ): Promise<ActiveSession> {
    this.#throwIfCancelled(run);
    const existing = run.sessions.get(station.id);
    if (existing) return existing;
    const extra = options.extra ?? {};
    const capture = options.capture ?? {};
    if (station.sessionId) {
      const mapper = this.#newMapper(run, station);
      let session: StationSession | undefined;
      try {
        this.#updateStation(run, station, { status: "starting", detail: "Reattaching to the sandbox" });
        session = await this.#platform.resumeSession(station.role, station.sessionId, this.#sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
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
        const active: ActiveSession = { session, mapper, capture };
        run.sessions.set(station.id, active);
        await this.#refreshSandbox(run, station);
        mapper.status(`Reattached to session ${session.sessionId}`);
        // Seeding was interrupted before the first prompt: finish it (writes are idempotent).
        if (!station.seeded && !station.turn) await this.#seed(run, station, active, seed, options.prepare);
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
    const session = await this.#platform.createSession(station.role, this.#sessionConfig(run, station, mapper, extra), (text) => mapper.status(text, "warning"));
    const active: ActiveSession = { session, mapper, capture };
    run.sessions.set(station.id, active);
    this.#updateStation(run, station, { sessionId: session.sessionId, seeded: false });
    await this.#refreshSandbox(run, station);
    const sandbox = station.sandbox;
    mapper.status(
      sandbox
        ? `Sandbox ${sandbox.id} ready: ${sandbox.size} (${SANDBOX_SIZES[sandbox.size].cpus} vCPU · ${SANDBOX_SIZES[sandbox.size].memoryGiB} GiB), ${describeNetwork(sandbox.network)}`
        : `Session ${session.sessionId} ready on ${station.environment}`,
    );
    await this.#seed(run, station, active, seed, options.prepare);
    return active;
  }

  /** Writes the station's seed files into its sandbox (and runs `prepare`), then records the checkpoint. */
  async #seed(run: Run, station: MStation, active: ActiveSession, seed: () => SeedFile[], prepare?: (active: ActiveSession) => Promise<void>): Promise<void> {
    this.#updateStation(run, station, { status: "starting", detail: "Seeding the workspace" });
    const files = seed();
    const writer = this.#platform.files(active.session.sessionId);
    for (const file of files) await writer.write(file.path, file.content);
    if (prepare) await prepare(active);
    this.#updateStation(run, station, { seeded: true });
    active.mapper.status(
      `Seeded ${files.length} files: ${files.map((file) => file.path).filter((path) => !path.startsWith(".factory/conflicts/")).slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`,
    );
  }

  async #refreshSandbox(run: Run, station: MStation, strict = false): Promise<void> {
    if (!station.sessionId) return;
    try {
      const info = await this.#platform.sessionInfo(station.sessionId);
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
      this.#updateStation(run, station, patch);
    } catch (error) {
      if (strict) throw error;
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
      // The agent's own time running out. A platform deadline ("… [timeout]" from a registration step) is an interruption.
      if (!isPlatformInterruption(error) && /timeout|timed out/i.test((error as Error).message ?? "")) {
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
  async #awaitTurn(run: Run, station: MStation, active: ActiveSession, release: boolean | "change"): Promise<void> {
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
    let failedReads = 0;
    const read = async (): Promise<SessionInfo | undefined> => {
      try {
        const info = await this.#platform.sessionInfo(active.session.sessionId);
        failedReads = 0;
        return info;
      } catch (error) {
        // A slow or failed read while the platform is up is a blip: read again. With the platform down, or the reads
        // failing MAX_READ_FAILURES times in a row, the error (an interruption) pauses the work order.
        if (!isPlatformInterruption(error) || !this.#options.readiness().ready || ++failedReads >= MAX_READ_FAILURES) throw error;
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
          ? "The sandbox restarted while this turn was running, so the turn can't finish; asking the agent to check its workspace and continue"
          : `The in-flight turn showed no activity for ${spokenDuration(stallMs)}; stopping it and asking the agent to check its workspace and continue`,
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
      this.#activity(run.wo, station.id, `The interrupted turn ${outcome === "failed" ? "failed" : "was stopped"}; asking the agent to check its workspace and continue`, "warning");
      await this.#turn(run, station, active, continuePrompt(release), "continue", Math.max(station.round, 1));
      return;
    }
    this.#updateStation(run, station, { turn: { ...station.turn!, completedAt: now() } });
  }

  // ─── Artifacts and checks ───────────────────────────────────────────────────────────────────────────────────

  async #collect(run: Run, station: MStation, release: boolean, freshAfter?: { readonly version?: number; readonly turnId?: string }): Promise<CheckOutcome> {
    const previousVersion = freshAfter ? freshAfter.version : station.reportVersion;
    this.#updateStation(run, station, { status: "collecting", detail: "Collecting artifacts" });
    const published = await this.#capturePublication(run, station);
    await this.#refreshSandbox(run, station);
    this.#throwIfCancelled(run);
    const latest = this.#store.latestArtifacts(run.wo.id, station.id);
    const reportArtifact = latest.find((artifact) => artifact.path === "test-report.json");
    const report = parseJson<TestReport>(reportArtifact?.content);
    const manifest = parseJson<OutputManifest>(latest.find((artifact) => artifact.path === "manifest.json")?.content);
    if (reportArtifact) this.#updateStation(run, station, { reportVersion: reportArtifact.version });
    if (report) this.#updateStation(run, station, { tests: summaryOf(report, reportArtifact?.publishedAt) });
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

  async #capturePublication(run: Run, station: MStation): Promise<ArtifactInfo[]> {
    const sessionId = station.sessionId!;
    const artifacts = this.#platform.artifacts(sessionId);
    const publication = await artifacts.waitForPublication({ timeoutMs: this.#options.config.publicationTimeoutMs });
    this.#throwIfCancelled(run);
    if (publication.state === "failed") throw new StationError("publication_failed", publication.error ?? "The platform couldn't publish this turn's artifacts.");
    const list = await artifacts.list({ versions: "latest" });
    let added = 0;
    for (const info of list) {
      if (info.state !== "published" || this.#store.hasArtifact(run.wo.id, station.id, info.path, info.version)) continue;
      let content: string | undefined;
      let bytes: Uint8Array | undefined;
      const media = info.path.startsWith("media/") ? mediaTypeOf(info.path) : undefined;
      if (media && info.size <= MAX_MEDIA_BYTES) {
        bytes = await this.#readArtifactWith(station, info.path, () => artifacts.readBytes(info.path, { version: info.version }));
      } else if ((isTextPath(info.path) || this.#projectOutput(run, info.path)) && info.size <= MAX_TEXT_BYTES) {
        const text = await this.#readArtifact(artifacts, station, info.path, info.version);
        content = text.includes("\u0000") ? undefined : text;
      }
      this.#throwIfCancelled(run);
      this.#store.putArtifact({
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
      this.#options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
      this.#emitItem(run.wo, { stationId: station.id, kind: "artifact", text: `Published ${added} file${added === 1 ? "" : "s"}`, level: "info" });
    }
    return list;
  }

  /**
   * A builder's or the release's file in a work order that changes an existing project: kept as text whatever its
   * extension (a `.vue` or `.hbs` file, `go.mod`), as long as it has no NUL byte, so a fix to it reaches the review, the
   * release, and the app that routed the work order.
   */
  #projectOutput(run: Run, path: string): boolean {
    return Boolean(run.wo.inputs?.project) && (path.startsWith("files/") || path.startsWith("bundle/"));
  }

  /**
   * Downloads a text artifact, retrying transient failures. A file that can't be read fails the collection rather
   * than being recorded without content, so a retry downloads it again instead of silently dropping it.
   */
  async #readArtifact(artifacts: ReturnType<FactoryPlatform["artifacts"]>, station: MStation, path: string, version: number): Promise<string> {
    return this.#readArtifactWith(station, path, () => artifacts.read(path, { version }));
  }

  async #readArtifactWith<T>(station: MStation, path: string, read: () => Promise<T>): Promise<T> {
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

  #newStation(kind: StationKind, task?: PlanTask): MStation {
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
    if (run.abort.signal.aborted || run.closed || this.#stopping) throw new CancelledError();
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
    if (active.length === 0) this.#activity(wo, wo.stations[0]?.id ?? "plan", note, "warning");
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
    if (this.#stopping || this.isActive(id)) return undefined;
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
    if (this.#stopping || run.closed) return;
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
    mode: workOrderMode(wo),
    status: wo.status,
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    ...(wo.startedAt ? { startedAt: wo.startedAt } : {}),
    ...(wo.completedAt ? { completedAt: wo.completedAt } : {}),
    taskCount: wo.taskCount,
    ...(wo.tests ? { tests: wo.tests } : {}),
    ...(wo.error ? { error: wo.error } : {}),
    ...(wo.origin ? { origin: wo.origin } : {}),
    ...(wo.gates?.length ? { gates: wo.gates.map(({ id, kind, target, label, state }) => ({ id, kind, target, label, state })) } : {}),
    ...(wo.github
      ? {
          github: {
            repository: wo.github.repository.fullName,
            ...(wo.github.issue ? { issue: wo.github.issue.number } : {}),
            ...(wo.github.pullRequest ? { pullRequest: wo.github.pullRequest.number, pullRequestState: wo.github.pullRequest.state } : {}),
          },
        }
      : {}),
  };
}
