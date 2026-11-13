// One incident: its coordinator session (a mixed orchestrator) and everything the app learns about it. The app holds a
// live session only while the agent works. When the agent asks to deploy, the app records the request, leaves it to the
// platform, and lets go: the request waits there (durably, for up to 24 hours) with no browser tab, no live connection,
// and no app memory involved. A person's decision re-attaches; the platform delivers the request again, and the decision
// answers it. Without the app attached, the platform's webhook keeps it informed and answers what needs no person.
// An incident whose fix goes through Software Factory has a work order there: the app follows it (from the store, so
// across restarts) and, once it ends, re-attaches to tell the agent, exactly once. When the factory built the fix and
// its work order declared a deploy gate, the deploy request is decided there: the app puts the request on the gate,
// follows the work order for the decision, answers the platform-held request with it, and reports how the deploy went.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { VerifiedWebhookEvent } from "@managed-copilot/sdk";
import type { ApprovalGateView, CoordinatorState, FactoryWorkView, FileChange, FixRoute, IncidentSummary, IncidentView, SandboxView } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { deployDemo, deployWebhook, nextVersion, type DeployOutcome, type DeployRequest } from "./deploy.js";
import { diffFile } from "./diff.js";
import { AppError, errorText, isMissingSession } from "./errors.js";
import {
  ACTIVE_FACTORY_STATUSES,
  DEPLOY_GATE,
  describeTests,
  FactoryError,
  fixWorkOrder,
  projectFiles,
  projectTooLarge,
  releasedFix,
  workOrderLabel,
  type FactoryClient,
  type FixFile,
  type GateRequest,
  type ReleaseFiles,
  type WorkOrderInfo,
} from "./factory.js";
import { log } from "./log.js";
import { reconnectDelay, type CoordinatorSession, type IncidentPlatform } from "./platform.js";
import { alertPrompt, fixWorkerFallback, runbook, TOOLS } from "./runbook.js";
import { ServiceLoadError, type ServiceCatalog } from "./services.js";
import type { StoredApproval, StoredFactoryWork, StoredIncident, Store } from "./store.js";
import {
  failure,
  incidentTools,
  parseDeploy,
  ToolInputError,
  type DeployInput,
  type PostmortemInput,
  type RouteFixInput,
  type ToolHost,
  type ToolOutcome,
  type UpdateInput,
} from "./tools.js";

export interface RunHost {
  readonly config: AppConfig;
  readonly platform: IncidentPlatform;
  readonly store: Store;
  readonly catalog: ServiceCatalog;
  /** Software Factory, when it's connected: fixes routed there go through it. */
  readonly factory: FactoryClient | undefined;
  /** The environment the repro and fix workers run in. */
  workerEnvironment(): string;
  /** Something the incident page shows changed. */
  changed(id: string): void;
}

/** Text on one line, at most `max` characters. */
const one = (value: unknown, max = 90): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Ends with a period (or other closing punctuation). */
const sentence = (text: string): string => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const base = (path: unknown): string => one(path).split("/").filter(Boolean).at(-1) ?? "";

/** A few of the paths, then how many more. */
function pathList(files: readonly { readonly path: string }[], shown = 3): string {
  const paths = files.slice(0, shown).map((file) => file.path);
  return files.length > shown ? `${paths.join(", ")} and ${files.length - shown} more` : paths.join(", ");
}

/** What a tool call is doing, in a few words. */
export function describeTool(name: string, args: Record<string, unknown> | undefined): string {
  const input = args ?? {};
  switch (name) {
    case "bash":
      return `$ ${one(String(input["command"] ?? "").split("\n")[0])}`;
    case "view":
      return `Reading ${base(input["path"])}`;
    case "grep":
      return `Searching for ${one(input["pattern"], 60)}`;
    case "glob":
      return `Listing ${one(input["pattern"], 60)}`;
    case "create":
      return `Writing ${base(input["path"])}`;
    case "edit":
      return `Editing ${base(input["path"])}`;
    case "read_bash":
    case "write_bash":
    case "stop_bash":
    case "list_bash":
      return "Watching a command";
    case "start_worker":
      return `Starting ${one(input["name"], 40) || "a worker"}`;
    case "copy_worker_files":
      return `Copying files to ${one(input["to"], 40) || "a sandbox"}`;
    case "wait_for_workers":
      return "Waiting for workers";
    case "message_worker":
      return `Messaging ${one(input["name"] ?? input["worker"], 40) || "a worker"}`;
    case "stop_worker":
      return `Stopping ${one(input["name"] ?? input["worker"], 40) || "a worker"}`;
    case "read_worker_file":
      return `Reading a worker's ${base(input["path"]) || "files"}`;
    case "list_workers":
      return "Checking on workers";
    case TOOLS.openWorkspace:
      return "Opening the service's files";
    case TOOLS.update:
      return "Recording a note";
    case TOOLS.routeFix:
      return "Routing the fix to Software Factory";
    case TOOLS.applyFix:
      return "Applying Software Factory's fix";
    case TOOLS.deploy:
      return "Asking to deploy";
    case TOOLS.postmortem:
      return "Writing the postmortem";
    default:
      return name.replace(/_/g, " ");
  }
}

/** A path the model gave, relative to the service's folder; undefined if it points anywhere else. */
export function servicePath(service: string, raw: string): string | undefined {
  let path = raw.trim().replace(/\\/g, "/").replace(/^\/?workspace\//, "");
  if (path.startsWith(`${service}/`)) path = path.slice(service.length + 1);
  path = path.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return path;
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) await Promise.all(items.slice(index, index + size).map(run));
}

export class IncidentRun implements ToolHost {
  readonly id: string;
  readonly #host: RunHost;
  #session: CoordinatorSession | undefined;
  /** Bumped by every attach and detach: callbacks of an older session object are ignored. */
  #generation = 0;
  #attaching: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  #starting: Promise<void> | undefined;
  #busy = false;
  #activity: string | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshAgain = false;
  #refreshTimer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #closed = false;
  /** route_fix_to_factory in flight: a second call waits for it. */
  #routing: Promise<ToolOutcome> | undefined;
  #factoryTimer: NodeJS.Timeout | undefined;
  #factoryCheck: Promise<void> | undefined;
  /** Consecutive checks that couldn't reach the factory (or Copilot): the next one waits longer. */
  #factoryFailures = 0;

  constructor(host: RunHost, id: string) {
    this.#host = host;
    this.id = id;
  }

  get #incident(): StoredIncident {
    const incident = this.#host.store.get(this.id);
    if (!incident) throw new AppError("not_found", `${this.id} doesn't exist anymore.`, 404);
    return incident;
  }

  get #fixRoute(): FixRoute {
    return this.#incident.fixRoute ?? "workers";
  }

  get attached(): boolean {
    return this.#session !== undefined;
  }

  #update(change: (incident: StoredIncident) => void): void {
    if (this.#host.store.update(this.id, change)) this.#host.changed(this.id);
  }

  #note(kind: Parameters<Store["note"]>[1], text: string, detail?: string, at?: string): void {
    this.#host.store.note(this.id, kind, text, detail, at);
    this.#host.changed(this.id);
  }

  #handlers(generation: number) {
    const route = this.#fixRoute;
    return {
      model: this.#host.config.model,
      tools: incidentTools(this, { factory: route === "factory" }),
      onPermissionRequest: (request: PermissionRequest) => this.#permission(request, generation),
      onEvent: (event: SessionEvent) => {
        if (generation === this.#generation) this.#event(event);
      },
      systemMessage: { content: runbook(this.#host.workerEnvironment(), route) },
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Creates the coordinator session and sends it the alert; for an incident that has one, attaches instead. */
  start(): Promise<void> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    if (this.#closed) return;
    if (this.#incident.sessionId) return this.attach();
    const generation = ++this.#generation;
    let session: CoordinatorSession;
    try {
      session = await this.#host.platform.createSession(this.#handlers(generation));
    } catch (error) {
      this.#update((incident) => {
        incident.problem = `Copilot couldn't start: ${errorText(error)}. Incident Commander tries again when Managed Copilot is back.`;
      });
      log.warn("Couldn't start an incident's coordinator", { incident: this.id, error: errorText(error) });
      return;
    }
    this.#session = session;
    this.#update((incident) => {
      incident.sessionId = session.sessionId;
      incident.coordinator.state = "working";
      delete incident.problem;
    });
    log.info("Started an incident", { incident: this.id, sessionId: session.sessionId });
    await this.#prompt(session);
  }

  /** Sends the alert, once. */
  async #prompt(session: CoordinatorSession): Promise<void> {
    const incident = this.#incident;
    if (incident.prompted) return;
    this.#busy = true;
    this.#activity = "Reading the alert";
    try {
      await session.send({ prompt: alertPrompt(incident.id, incident.alert) });
      this.#update((stored) => {
        stored.prompted = true;
        stored.coordinator.state = "working";
      });
      this.#note("platform", "Copilot took the incident");
      this.#startPolling();
    } catch (error) {
      this.#busy = false;
      this.#activity = undefined;
      this.#update((stored) => {
        stored.problem = `The alert didn't reach Copilot: ${errorText(error)}. Incident Commander tries again when it reconnects.`;
      });
    }
  }

  /** Resumes the coordinator session on the current client. Requests waiting on the platform are delivered again. */
  attach(): Promise<void> {
    if (this.#session || this.#closed) return Promise.resolve();
    const pending = this.#attaching;
    if (pending && pending.generation === this.#generation) return pending.promise;
    const generation = ++this.#generation;
    const promise = this.#attach(generation).finally(() => {
      if (this.#attaching?.promise === promise) this.#attaching = undefined;
    });
    this.#attaching = { generation, promise };
    return promise;
  }

  async #attach(generation: number): Promise<void> {
    const sessionId = this.#incident.sessionId;
    if (!sessionId) return;
    try {
      const session = await this.#host.platform.resumeSession(sessionId, { ...this.#handlers(generation), continuePendingWork: true, suppressResumeEvent: true });
      if (generation !== this.#generation || this.#closed) {
        await session.disconnect().catch(() => undefined);
        return;
      }
      this.#session = session;
      this.#update((incident) => {
        delete incident.problem;
      });
      if (!this.#incident.prompted) return void (await this.#prompt(session));
      const info = await this.#host.platform.sessionInfo(sessionId).catch(() => undefined);
      if (info?.lastTurn?.status === "running") {
        this.#busy = true;
        this.#update((incident) => {
          if (incident.coordinator.state !== "done") incident.coordinator.state = "working";
        });
        this.#startPolling();
      }
      log.info("Attached to an incident", { incident: this.id, sessionId, working: this.#busy });
      void this.refresh();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (isMissingSession(error)) return this.#gone();
      this.#update((incident) => {
        incident.problem = `Couldn't reach Copilot's session: ${errorText(error)}`;
      });
      log.warn("Couldn't attach to an incident", { incident: this.id, error: errorText(error) });
    }
  }

  /** Lets go of the session. Its work and its waiting requests stay on the platform. */
  async detach(): Promise<void> {
    ++this.#generation;
    const session = this.#session;
    this.#session = undefined;
    this.#stopPolling();
    await session?.disconnect().catch(() => undefined);
  }

  /** The client this session lived on is gone (the platform reconnected): forget it without calling it. */
  forget(): void {
    ++this.#generation;
    this.#session = undefined;
    this.#stopPolling();
  }

  /** Stops everything (the app is shutting down); the incident keeps going on the platform. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#factoryTimer) clearTimeout(this.#factoryTimer);
    this.#factoryTimer = undefined;
    await this.detach();
  }

  /** Deletes the coordinator session; the platform deletes its workers and sandboxes with it. */
  async delete(): Promise<void> {
    const sessionId = this.#host.store.get(this.id)?.sessionId;
    await this.close();
    if (!sessionId) return;
    try {
      await this.#host.platform.deleteSession(sessionId);
    } catch (error) {
      if (!isMissingSession(error)) {
        this.#closed = false;
        this.followFactory();
        throw new AppError("delete_failed", `Couldn't delete the incident's session: ${errorText(error)}`, 502);
      }
    }
  }

  /** The session no longer exists on the platform. */
  #gone(): void {
    this.forget();
    this.#update((incident) => {
      incident.coordinator.state = incident.status === "resolved" ? "done" : "failed";
      if (incident.status !== "resolved") incident.problem = "Copilot's session for this incident was deleted.";
    });
  }

  /** After a (re)connection: pick the incident up where it is. */
  async resume(): Promise<void> {
    this.forget();
    this.followFactory();
    const incident = this.#incident;
    if (incident.status === "resolved" && incident.coordinator.state === "done") return;
    if (!incident.sessionId) return this.start();
    const approval = incident.approval;
    // A decision made while the platform was away still has to reach the coordinator.
    if (approval?.state === "approved" || approval?.state === "declined") return this.attach();
    if (approval?.state === "waiting") return;
    let info;
    try {
      info = await this.#host.platform.sessionInfo(incident.sessionId);
    } catch (error) {
      if (isMissingSession(error)) return this.#gone();
      return;
    }
    if (!incident.prompted || info.lastTurn?.status === "running" || info.pendingActions.some((action) => action.state === "pending")) return this.attach();
    void this.refresh();
  }

  // ─── The person ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Approves or declines the waiting deploy. The decision is recorded first, then delivered by re-attaching. `where`: the
   * person decided here, or on the work order's deploy gate in Software Factory.
   */
  async decide(approve: boolean, reason: string | undefined, login: string | undefined, where: "incident-commander" | "software-factory" = "incident-commander"): Promise<void> {
    const approval = this.#incident.approval;
    if (!approval || approval.state !== "waiting") throw new AppError("not_actionable", "This deploy request was already answered.", 409);
    const now = new Date().toISOString();
    this.#update((incident) => {
      const stored = incident.approval!;
      stored.state = approve ? "approved" : "declined";
      stored.decidedAt = now;
      stored.decidedIn = where;
      if (login) stored.decidedBy = login;
      if (reason) stored.reason = reason;
      if (where === "software-factory" && stored.gate) stored.gate = { ...stored.gate, state: "answered" };
    });
    const who = login ? `@${login}` : "You";
    const place = where === "software-factory" ? " in Software Factory" : "";
    this.#note("person", approve ? `${who} approved the deploy${place}` : `${who} declined the deploy${place}${reason ? `: ${reason}` : ""}`);
    log.info(approve ? "Deploy approved" : "Deploy declined", { incident: this.id, where, waitedSeconds: Math.round((Date.parse(now) - Date.parse(approval.requestedAt)) / 1000) });
    // Answered here while it waited on the work order's gate too: close it there.
    if (where === "incident-commander" && (approval.gate?.state === "opening" || approval.gate?.state === "open")) void this.checkFactory();
    // The request waits on the platform: attaching delivers it again, and the recorded decision answers it.
    if (this.#session) await this.detach();
    await this.attach();
  }

  /** Sends Copilot a note from the on-call engineer. */
  async message(text: string, login: string | undefined): Promise<void> {
    if (this.#incident.approval?.state === "waiting") throw new AppError("busy", "Answer the deploy request first.", 409);
    await this.attach();
    const session = this.#session;
    if (!session) throw new AppError("unavailable", this.#incident.problem ?? "Copilot's session isn't reachable right now. Try again in a moment.", 503);
    try {
      await session.send({ prompt: `A note from the on-call engineer${login ? ` (@${login})` : ""}: ${text}`, ...(this.#busy ? { mode: "immediate" as const } : {}) });
    } catch (error) {
      throw new AppError("send_failed", `Your note didn't reach Copilot: ${errorText(error)}`, 502);
    }
    this.#busy = true;
    this.#update((incident) => {
      if (incident.coordinator.state !== "done") incident.coordinator.state = "working";
    });
    this.#startPolling();
    this.#note("person", login ? `@${login}: ${text}` : text);
  }

  // ─── Permissions ───────────────────────────────────────────────────────────────────────────────────────────

  /** Sandboxes are isolated, so the agent works freely there. Production (deploy_fix) waits for a person. */
  async #permission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    if (request.kind === "custom-tool" && request.toolName === TOOLS.deploy) {
      if (generation !== this.#generation) return { kind: "no-result" };
      return this.#deployPermission(request, "live");
    }
    return { kind: "approve-once" };
  }

  /** The webhook's answer to prompts that wait while the app isn't attached: the same policy, without attesting a person. */
  #webhookPermission(request: PermissionRequest): Promise<PermissionRequestResult> | PermissionRequestResult {
    if (request.kind === "custom-tool" && request.toolName === TOOLS.deploy) return this.#deployPermission(request, "webhook");
    return { kind: "approve-once" };
  }

  async #deployPermission(request: PermissionRequest & { kind: "custom-tool" }, via: "live" | "webhook"): Promise<PermissionRequestResult> {
    const id = request.toolCallId ?? "deploy";
    const approval = this.#incident.approval;
    if (approval?.id === id && approval.state === "approved") return via === "live" ? { kind: "approve-once", approvedInteractively: true } : { kind: "approve-once" };
    if (approval?.id === id && approval.state === "declined") {
      return { kind: "reject", feedback: `The on-call engineer declined the deploy${approval.reason ? `: ${approval.reason}` : "."} Don't ask to deploy again; record the reason with ${TOOLS.update} and end your turn.` };
    }
    if (approval?.id !== id) {
      let input: DeployInput;
      try {
        input = parseDeploy(request.args);
      } catch (error) {
        if (error instanceof ToolInputError) return { kind: "reject", feedback: `${error.message} Call ${TOOLS.deploy} again.` };
        throw error;
      }
      const refused = await this.#recordApproval(id, input);
      if (refused) return { kind: "reject", feedback: refused };
    }
    // Leave the request to the platform: it waits there for a person, and the app lets go of the session.
    if (via === "live") setImmediate(() => void this.detach());
    return { kind: "no-result" };
  }

  /**
   * Snapshots the changes from Copilot's own sandbox, so the person reviews (and approves) exactly what ships: the files
   * that differ from what runs now. Returns why the request is refused instead, when none of the files changed.
   */
  async #recordApproval(id: string, input: DeployInput): Promise<string | undefined> {
    const incident = this.#incident;
    const service = incident.alert.service;
    const read: { path: string; content: string }[] = [];
    const problems: string[] = [];
    try {
      const own = await this.#ownSandbox();
      if (!own) throw new Error("Copilot's own sandbox isn't running");
      for (const raw of input.files) {
        const path = servicePath(service, raw);
        if (!path) throw new Error(`${raw} isn't inside the service's folder`);
        if (!read.some((file) => file.path === path)) read.push({ path, content: await this.#host.platform.readFile(own.id, `${service}/${path}`) });
      }
    } catch (error) {
      problems.push(`Couldn't read the changes from Copilot's sandbox: ${errorText(error)}.`);
    }
    let originals: ReadonlyMap<string, string> | undefined;
    try {
      originals = await this.#host.catalog.originals(service);
    } catch (error) {
      const why = error instanceof ServiceLoadError ? sentence(error.message) : `Couldn't read the ${service} service's files: ${sentence(errorText(error))}`;
      problems.push(`${why} So the change can't be shown here; what ships is Copilot's copy of ${pathList(read, 6) || "the files it listed"}.`);
    }
    // A file Copilot listed but didn't change doesn't ship.
    const snapshot = originals ? read.filter((file) => originals.get(file.path) !== file.content) : read;
    if (problems.length === 0 && snapshot.length === 0) {
      return `None of the files you listed differ from what runs in production now (${pathList(read, 6)}). Make sure the fix is in /workspace/${service} in your own sandbox, then call ${TOOLS.deploy} again with the files it changed and added.`;
    }
    const files: FileChange[] = originals ? snapshot.map((file) => diffFile(file.path, originals.get(file.path), file.content)) : [];
    const problem = problems.length ? problems.join(" ") : undefined;
    // The fix Software Factory released, copied into Copilot's sandbox: the person sees where it came from.
    const work = incident.factory;
    const factory = work?.appliedAt && work.files?.length ? { number: work.number, url: work.url } : undefined;
    const gate = this.#approvalGate(incident, factory !== undefined);
    const approval: StoredApproval = {
      id,
      state: "waiting",
      summary: input.summary,
      ...(input.tests ? { tests: input.tests } : {}),
      files,
      snapshot,
      ...(problem ? { problem } : {}),
      ...(factory ? { factory } : {}),
      ...(gate ? { gate } : {}),
      requestedAt: new Date().toISOString(),
    };
    this.#update((stored) => {
      stored.approval = approval;
      if (stored.status === "investigating") stored.status = "mitigating";
      stored.milestones.mitigatingAt ??= approval.requestedAt;
    });
    const detail = [input.tests ? `Tests: ${input.tests}` : "", factory ? `Built by Software Factory as ${workOrderLabel(factory.number)}` : ""].filter(Boolean).join("\n");
    this.#note("approval", `Copilot asked to deploy: ${input.summary}`, detail || undefined);
    log.info("Deploy requested; waiting for a person", { incident: this.id, files: snapshot.length, decidedIn: gate?.state === "opening" ? "software-factory" : "incident-commander" });
    if (gate?.state === "unavailable" && gate.reason) this.#note("approval", "The deploy request is decided here, not in Software Factory", gate.reason);
    // Decided on the work order's gate: put the request there now, and follow the work order for the decision.
    if (gate?.state === "opening") {
      void this.checkFactory();
      this.followFactory();
    }
    return undefined;
  }

  /** Where the deploy request is decided: on the work order's deploy gate in Software Factory, or here, and why. */
  #approvalGate(incident: StoredIncident, builtByFactory: boolean): ApprovalGateView | undefined {
    const work = incident.factory;
    if (!work) {
      return incident.fixRoute === "factory"
        ? { state: "unavailable", reason: "The fix didn't go through Software Factory, so there's no work order to approve it on. Approve or decline it here." }
        : undefined;
    }
    const label = workOrderLabel(work.number);
    const where = { workOrderId: work.workOrderId, number: work.number, url: work.url };
    if (!builtByFactory) return { state: "unavailable", ...where, reason: `The fix Copilot asks to deploy isn't the one ${label} released, so approve or decline it here.` };
    if (!this.#host.factory) return { state: "unavailable", ...where, reason: "Software Factory isn't connected anymore (SOFTWARE_FACTORY_URL isn't set), so approve or decline it here." };
    if (!work.deployGate) return { state: "unavailable", ...where, reason: `${label} has no deploy gate in Software Factory (it doesn't take deploy requests), so approve or decline it here.` };
    return { state: "opening", ...where };
  }

  // ─── Session events ────────────────────────────────────────────────────────────────────────────────────────

  #event(event: SessionEvent): void {
    switch (event.type) {
      case "user.message":
        this.#busy = true;
        this.#update((incident) => {
          if (incident.coordinator.state !== "done") incident.coordinator.state = "working";
        });
        this.#startPolling();
        return;
      case "assistant.turn_start":
        if (!this.#activity) this.#activity = "Thinking";
        break;
      case "tool.execution_start": {
        if (event.agentId) break;
        this.#activity = describeTool(event.data.toolName, event.data.arguments as Record<string, unknown> | undefined);
        break;
      }
      case "tool.execution_complete":
        this.#scheduleRefresh(300);
        return;
      case "assistant.message": {
        if (event.agentId || !event.data.content?.trim()) return;
        const message = one(event.data.content, 400);
        this.#update((incident) => {
          incident.coordinator.lastMessage = message;
        });
        return;
      }
      case "session.error":
        this.#note("error", `Copilot hit an error: ${one(event.data.message, 200)}`);
        return;
      case "session.idle":
        this.#turnEnded();
        // Nothing to answer until something new happens: let go, and pick it up again then.
        void this.detach();
        return;
      default:
        return;
    }
    this.#host.changed(this.id);
  }

  #turnEnded(endedAt = new Date().toISOString()): void {
    this.#busy = false;
    this.#activity = undefined;
    this.#stopPolling();
    this.#update((incident) => {
      incident.coordinator.state = incident.status === "resolved" ? "done" : "idle";
      // The turn that asked ended before anyone answered (a late delivery about an earlier turn changes nothing).
      if (incident.approval?.state === "waiting" && endedAt >= incident.approval.requestedAt) incident.approval.state = "expired";
    });
    void this.refresh();
  }

  // ─── Webhook ───────────────────────────────────────────────────────────────────────────────────────────────

  /** A platform event about this incident's coordinator, from the webhook. */
  async webhook(event: VerifiedWebhookEvent): Promise<void> {
    switch (event.type) {
      case "session.action_required": {
        const actions = (event.data as { actions?: { kind?: string; tool?: string }[] }).actions ?? [];
        const deploy = actions.some((action) => action.kind === "permission" && action.tool === TOOLS.deploy);
        const approval = this.#host.store.get(this.id)?.approval;
        if (deploy && approval && !approval.announcedAt) {
          this.#update((incident) => {
            if (incident.approval) incident.approval.announcedAt = event.createdAt;
          });
          this.#note("platform", "The deploy request waits on the platform for a person. Nothing runs meanwhile.", undefined, event.createdAt);
        }
        // While the app is attached, its live session answers. Otherwise answer here: the app's tools and sandbox work.
        if (this.#session) return;
        await event.handleActions({ tools: incidentTools(this, { factory: this.#fixRoute === "factory" }), onPermissionRequest: (request) => this.#webhookPermission(request) });
        return;
      }
      case "session.idle":
        // While attached, the live session reports the end of its turn itself.
        if (!this.#session) this.#turnEnded(event.createdAt);
        return;
      case "session.failed":
        this.#busy = false;
        this.#activity = undefined;
        this.#update((incident) => {
          incident.coordinator.state = "failed";
          // Nothing can answer a request of a session that failed.
          if (incident.approval?.state === "waiting" && event.createdAt >= incident.approval.requestedAt) incident.approval.state = "expired";
        });
        this.#note("error", `Copilot's session failed${typeof event.data.error === "string" ? `: ${one(event.data.error, 200)}` : "."}`);
        return;
      default:
        if (event.type.startsWith("worker.")) this.#scheduleRefresh(100);
    }
  }

  // ─── Sandboxes ─────────────────────────────────────────────────────────────────────────────────────────────

  async #ownSandbox(): Promise<{ id: string } | undefined> {
    const sessionId = this.#incident.sessionId;
    if (!sessionId) return undefined;
    const workers = await this.#host.platform.workers(sessionId);
    return workers.find((worker) => worker.role === "hands" && worker.state !== "stopped");
  }

  #scheduleRefresh(delay: number): void {
    if (this.#refreshTimer || this.#closed) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refresh();
    }, delay);
    this.#refreshTimer.unref?.();
  }

  #startPolling(): void {
    if (this.#poll || this.#closed) return;
    this.#poll = setInterval(() => void this.refresh(), this.#host.config.pollIntervalMs);
    this.#poll.unref?.();
  }

  #stopPolling(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = undefined;
  }

  /** Reads the coordinator's sandboxes from the platform (one read at a time; a request during a read runs once more). */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#refreshAgain = false;
        await this.#loadSandboxes();
      } while (this.#refreshAgain && !this.#closed);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #loadSandboxes(): Promise<void> {
    const sessionId = this.#host.store.get(this.id)?.sessionId;
    if (!sessionId || this.#host.platform.status.state !== "connected") return;
    let workers;
    try {
      workers = await this.#host.platform.workers(sessionId);
    } catch (error) {
      if (isMissingSession(error)) this.#gone();
      else log.debug("Couldn't list an incident's sandboxes", { incident: this.id, error: errorText(error) });
      return;
    }
    const own = workers.find((worker) => worker.role === "hands" && worker.state !== "stopped");
    let commands: { count: number; last?: string } | undefined;
    if (own) {
      try {
        const execs = await this.#host.platform.execs(own.id);
        const last = execs.filter((exec) => exec.caller?.name === "bash").at(-1)?.command;
        commands = { count: execs.length, ...(last ? { last: one(last.split("\n")[0], 120) } : {}) };
      } catch (error) {
        log.debug("Couldn't list the commands in Copilot's sandbox", { incident: this.id, error: errorText(error) });
      }
    }
    const incident = this.#host.store.get(this.id);
    if (!incident) return;
    const before = new Map(incident.sandboxes.map((sandbox) => [sandbox.id, sandbox]));
    const next: SandboxView[] = [...workers]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((worker): SandboxView => {
        const previous = before.get(worker.id);
        const role = worker.role === "hands" ? "own" : "worker";
        const counted = role === "own" && worker.id === own?.id ? commands : undefined;
        const lastCommand = counted?.last ?? previous?.lastCommand;
        return {
          id: worker.id,
          role,
          name: role === "own" ? "Triage" : worker.name,
          environment: worker.environment,
          state: worker.state,
          done: role === "worker" && (worker.state === "idle" || (previous?.done ?? false)),
          ...(role === "worker" && worker.task ? { task: one(worker.task, 1_000) } : {}),
          ...(worker.result ? { report: worker.result.trim().slice(0, 4_000) } : previous?.report ? { report: previous.report } : {}),
          ...(worker.error ? { error: one(worker.error, 300) } : {}),
          ...(role === "own" ? { commands: counted?.count ?? previous?.commands ?? 0 } : {}),
          ...(lastCommand ? { lastCommand } : {}),
          startedAt: worker.createdAt,
          updatedAt: worker.updatedAt,
        };
      });
    const changed = JSON.stringify(next) !== JSON.stringify(incident.sandboxes);
    if (!changed) return;
    for (const sandbox of next) {
      const previous = before.get(sandbox.id);
      if (!previous) {
        if (sandbox.role === "own") this.#host.store.note(this.id, "sandbox", "Copilot started its own sandbox for triage", undefined, sandbox.startedAt);
        else this.#host.store.note(this.id, "worker", `Handed "${sandbox.name}" to a worker in its own sandbox`, sandbox.task, sandbox.startedAt);
      }
      if (sandbox.role === "worker" && sandbox.done && !previous?.done) this.#host.store.note(this.id, "worker", `"${sandbox.name}" reported back`, sandbox.report, sandbox.updatedAt);
      if (sandbox.state === "failed" && previous?.state !== "failed") this.#host.store.note(this.id, "error", `"${sandbox.name}" failed${sandbox.error ? `: ${sandbox.error}` : ""}`, undefined, sandbox.updatedAt);
    }
    this.#update((stored) => {
      stored.sandboxes = next;
      const firstWorker = next.find((sandbox) => sandbox.role === "worker");
      if (firstWorker && stored.status === "investigating") stored.status = "mitigating";
      if (firstWorker) stored.milestones.mitigatingAt ??= firstWorker.startedAt;
    });
  }

  // ─── The app's tools (ToolHost) ────────────────────────────────────────────────────────────────────────────

  async openWorkspace(): Promise<ToolOutcome> {
    const own = await this.#ownSandbox();
    if (!own) return failure("Your own sandbox hasn't started yet. Run `pwd` with bash first, then call open_workspace again.");
    const incident = this.#incident;
    const service = incident.alert.service;
    let workspace: Awaited<ReturnType<ServiceCatalog["workspace"]>>;
    try {
      workspace = await this.#host.catalog.workspace(service, incident.demo);
    } catch (error) {
      if (!(error instanceof ServiceLoadError)) throw error;
      this.#note("error", error.message);
      return failure(
        `${sentence(error.message)} Wait half a minute (sleep 30 in your sandbox) and call ${TOOLS.openWorkspace} once more. If it fails again, record what the alert tells you, and that the service's files couldn't be loaded, with ${TOOLS.update}, then end your turn.`,
      );
    }
    const { files, version } = workspace;
    if (files.size === 0) {
      return `No code, tests, or logs are on file for the "${service}" service. Work from the alert's details: record what it tells you and what to check next with ${TOOLS.update}.`;
    }
    // The incident opened while the service couldn't be loaded: its version comes with its files.
    if (version && !incident.serviceVersion) {
      this.#update((stored) => {
        stored.serviceVersion ??= version;
      });
    }
    const entries = [...files];
    await inBatches(entries, 4, async ([path, content]) => this.#host.platform.writeFile(own.id, `${service}/${path}`, content));
    this.#note("sandbox", `Copied the ${service} service into Copilot's sandbox (${files.size} files)`);
    void this.refresh();
    const folders = [...new Set(entries.map(([path]) => (path.includes("/") ? `${path.split("/")[0]}/` : path)))].sort();
    const start = files.has("README.md") ? ` Start with /workspace/${service}/README.md.` : "";
    return `Copied ${files.size} files into /workspace/${service}: ${folders.join(", ")}.${start}`;
  }

  update(input: UpdateInput): ToolOutcome {
    const now = new Date().toISOString();
    this.#update((incident) => {
      // The evidence belongs to the root cause: later notes (verification, the deploy) keep it unless the cause changes.
      const revised = input.rootCause !== undefined && input.rootCause !== incident.findings.rootCause;
      if (input.evidence.length && (revised || incident.findings.evidence.length === 0)) incident.findings.evidence = [...input.evidence];
      if (input.rootCause) incident.findings.rootCause = input.rootCause;
      if (input.rootCause) incident.milestones.triagedAt ??= now;
    });
    this.#note("note", input.note, input.evidence.length ? input.evidence.join("\n") : undefined, now);
    return "Recorded on the incident page.";
  }

  /** route_fix_to_factory: one work order per incident. A repeated (or, after a restart, replayed) call answers with it. */
  routeFix(input: RouteFixInput): Promise<ToolOutcome> {
    this.#routing ??= this.#routeFix(input).finally(() => {
      this.#routing = undefined;
    });
    return this.#routing;
  }

  async #routeFix(input: RouteFixInput): Promise<ToolOutcome> {
    const incident = this.#incident;
    if (incident.factory) return this.#routed(incident.factory);
    const factory = this.#host.factory;
    if (!factory) return this.#routeFailed("Software Factory isn't connected to Incident Commander (SOFTWARE_FACTORY_URL isn't set).");
    const service = incident.alert.service;
    const files: string[] = [];
    for (const raw of input.files) {
      const path = servicePath(service, raw);
      if (!path) return failure(`${raw} isn't inside the service's folder. List files relative to it, for example src/storage.js, and call ${TOOLS.routeFix} again.`);
      if (!files.includes(path)) files.push(path);
    }
    let workspace: ReadonlyMap<string, string>;
    try {
      workspace = (await this.#host.catalog.workspace(service, incident.demo)).files;
    } catch (error) {
      if (error instanceof ServiceLoadError) return this.#routeFailed(error.message);
      throw error;
    }
    const project = projectFiles(workspace);
    if (project.length === 0) {
      return failure(`No code is on file for the "${service}" service, so Software Factory has nothing to change. Record what you found and what to check next with ${TOOLS.update}, then end your turn.`);
    }
    const tooLarge = projectTooLarge(service, project);
    if (tooLarge) return this.#routeFailed(tooLarge);
    const order = fixWorkOrder({
      incidentId: incident.id,
      alert: incident.alert,
      ...(incident.serviceVersion ? { serviceVersion: incident.serviceVersion } : {}),
      evidence: incident.findings.evidence,
      fix: { ...input, files },
      workspace,
      // The incident's page: the UI's hash route (src/web/lib/router.ts).
      incidentUrl: `${this.#host.config.publicUrl}/#/incidents/${encodeURIComponent(incident.id)}`,
    });
    let created: WorkOrderInfo;
    try {
      // One created just before a restart, before it was recorded here, is this incident's work order.
      created = (await this.#recordedByFactory(factory, incident)) ?? (await factory.create(order));
    } catch (error) {
      return this.#routeFailed(errorText(error));
    }
    const now = new Date().toISOString();
    const work: StoredFactoryWork = {
      workOrderId: created.id,
      number: created.number,
      title: created.title || order.title,
      url: factory.link(created.id),
      status: created.status,
      routedAt: now,
      updatedAt: now,
      ...(created.gates?.some((gate) => gate.id === DEPLOY_GATE) ? { deployGate: true } : {}),
    };
    this.#update((stored) => {
      stored.factory = work;
      stored.findings.rootCause ??= input.rootCause;
      stored.milestones.triagedAt ??= now;
      if (stored.status === "investigating") stored.status = "mitigating";
      stored.milestones.mitigatingAt ??= now;
    });
    this.#note("factory", `Routed the fix to Software Factory as ${workOrderLabel(created.number)}`, `${work.title}\n${work.url}`, now);
    log.info("Routed a fix to Software Factory", { incident: this.id, workOrder: created.id, number: created.number });
    this.followFactory();
    return this.#routed(work);
  }

  /** The work order the factory has for this incident, if any. Only an unreachable factory is an error here. */
  async #recordedByFactory(factory: FactoryClient, incident: StoredIncident): Promise<WorkOrderInfo | undefined> {
    try {
      return await factory.find(incident.id, incident.createdAt);
    } catch (error) {
      if (error instanceof FactoryError && error.status === undefined) throw error;
      return undefined;
    }
  }

  /** What route_fix_to_factory answers for the incident's work order. */
  #routed(work: StoredFactoryWork): ToolOutcome {
    const label = workOrderLabel(work.number);
    const service = this.#incident.alert.service;
    if (work.files?.length) return `Software Factory already released the fix as ${label}. Call ${TOOLS.applyFix} to copy it into /workspace/${service}.`;
    if (work.error || work.status === "failed" || work.status === "cancelled") return failure(this.#fallback(work));
    return `Software Factory took the fix as ${label} (${work.url}). It plans the fix, builds it in its own sandboxes, reviews it, and releases it with tests. Meanwhile, hand the repro to a "repro" worker as the runbook says, then end your turn: Incident Commander messages you when the factory releases the fix.`;
  }

  #routeFailed(reason: string): ToolOutcome {
    this.#note("error", `Couldn't route the fix to Software Factory: ${one(reason, 200)}`, 'Copilot fixes it with a "fix" worker instead.');
    log.warn("Couldn't route a fix to Software Factory", { incident: this.id, error: reason });
    return failure(`Software Factory couldn't take the work order: ${sentence(reason)} Instead, ${fixWorkerFallback(this.#host.workerEnvironment(), this.#incident.alert.service)}`);
  }

  /** The work order ended without a fix: what Copilot does instead. */
  #fallback(work: StoredFactoryWork): string {
    const why = work.error ?? `${workOrderLabel(work.number)} was ${work.status}.`;
    return `Software Factory couldn't build the fix (${workOrderLabel(work.number)}): ${sentence(why)} Now ${fixWorkerFallback(this.#host.workerEnvironment(), this.#incident.alert.service)}`;
  }

  /** apply_factory_fix: copies the released fix into Copilot's own sandbox. */
  async applyFactoryFix(): Promise<ToolOutcome> {
    const incident = this.#incident;
    const work = incident.factory;
    if (!work) return failure(`Nothing went to Software Factory yet. Call ${TOOLS.routeFix} first.`);
    const label = workOrderLabel(work.number);
    if (!work.files?.length) {
      if (work.error || work.status === "failed" || work.status === "cancelled") return failure(this.#fallback(work));
      return failure(`Software Factory hasn't finished ${label} yet (it's ${work.status}). Incident Commander messages you when it releases the fix; end your turn until then.`);
    }
    const own = await this.#ownSandbox();
    if (!own) return failure(`Your own sandbox isn't running. Run \`pwd\` with bash first, then call ${TOOLS.applyFix} again.`);
    const service = incident.alert.service;
    const fix: readonly FixFile[] = work.files;
    await inBatches(fix, 4, async (file) => this.#host.platform.writeFile(own.id, `${service}/${file.path}`, file.content));
    const now = new Date().toISOString();
    if (!work.appliedAt) {
      this.#update((stored) => {
        if (stored.factory) stored.factory.appliedAt ??= now;
      });
      this.#note("factory", `Copied ${label}'s fix into Copilot's sandbox (${fix.length} ${fix.length === 1 ? "file" : "files"})`, fix.map((file) => file.path).join("\n"), now);
    }
    void this.refresh();
    const tests = work.tests ? ` Software Factory's own test run: ${describeTests(work.tests)}.` : "";
    return `Copied Software Factory's fix (${label}) into /workspace/${service}: ${fix.map((file) => `${file.path} (${file.status})`).join(", ")}.${tests} Run the whole test suite now, repro's test included, and record the result with ${TOOLS.update}.`;
  }

  async deploy(input: DeployInput, toolCallId: string): Promise<ToolOutcome> {
    const incident = this.#incident;
    const approval = incident.approval?.id === toolCallId ? incident.approval : undefined;
    // A replayed call (after a restart) reports the deploy that already ran; it never deploys twice.
    if (approval && (approval.state === "deployed" || approval.state === "failed") && incident.deploy) {
      return incident.deploy.ok ? incident.deploy.message : failure(incident.deploy.message);
    }
    const service = incident.alert.service;
    let files = approval?.snapshot ?? [];
    if (files.length === 0) {
      // Approved somewhere else (Copilot CLI) before this app saw the request: read what's in the sandbox now.
      const own = await this.#ownSandbox();
      if (!own) return failure("Your own sandbox isn't running, so there's nothing to deploy from.");
      files = [];
      for (const raw of input.files) {
        const path = servicePath(service, raw);
        if (!path) return failure(`${raw} isn't inside the service's folder.`);
        files.push({ path, content: await this.#host.platform.readFile(own.id, `${service}/${path}`) });
      }
    }
    const request: DeployRequest = {
      incident: incident.id,
      service,
      ...(incident.serviceVersion ? { version: incident.serviceVersion } : {}),
      summary: input.summary,
      ...(input.tests ? { tests: input.tests } : {}),
      files,
      ...(approval?.decidedBy ? { approvedBy: approval.decidedBy } : {}),
      ...(approval?.decidedAt ? { approvedAt: approval.decidedAt } : {}),
      idempotencyKey: `${incident.sessionId ?? incident.id}:${toolCallId}`,
    };
    const deploy = this.#host.config.deploy;
    const outcome: DeployOutcome = incident.demo
      ? deployDemo(request)
      : deploy
        ? await deployWebhook(deploy, request)
        : { ok: false, target: "webhook", message: "No deploy pipeline is configured. Set INCIDENT_DEPLOY_URL to send approved fixes for your own services to it." };
    const now = new Date().toISOString();
    this.#update((stored) => {
      stored.deploy = { ...outcome, files: files.map((file) => file.path), at: now };
      if (stored.approval?.id === toolCallId) stored.approval.state = outcome.ok ? "deployed" : "failed";
      if (outcome.ok) {
        stored.status = "resolved";
        stored.resolvedAt = now;
        stored.milestones.resolvedAt = now;
        if (stored.demo) stored.alert = { ...stored.alert, resolvedAt: now };
      }
    });
    this.#note("deploy", outcome.ok ? `Deployed ${service}${outcome.version ? ` v${outcome.version}` : ""}` : "The deploy failed", outcome.message, now);
    if (outcome.ok && incident.demo) this.#note("resolved", `${incident.alert.name} resolved: the 5xx rate is back to 0%`);
    log.info(outcome.ok ? "Deployed a fix" : "A deploy failed", { incident: this.id, target: outcome.target, version: outcome.version });
    // Decided on the work order's deploy gate: tell it how the deploy went.
    if (this.#host.store.get(this.id)?.approval?.gate?.state === "answered") void this.checkFactory();
    return outcome.ok ? outcome.message : failure(outcome.message);
  }

  postmortem(input: PostmortemInput): ToolOutcome {
    const now = new Date().toISOString();
    this.#update((incident) => {
      incident.postmortem = { ...input, followUps: [...input.followUps], publishedAt: now };
    });
    this.#note("postmortem", "Copilot published the postmortem", undefined, now);
    return "Published on the incident page.";
  }

  // ─── Software Factory ──────────────────────────────────────────────────────────────────────────────────────

  /** The work order still needs following: the factory works on it, Copilot hasn't heard how it ended, or its deploy gate has news. */
  #needsFollowing(incident: StoredIncident | undefined): boolean {
    const work = incident?.factory;
    if (!incident || !work) return false;
    if (ACTIVE_FACTORY_STATUSES.includes(work.status)) return true;
    if (this.#gateNeedsFollowing(incident)) return true;
    // Nobody to tell: the incident was resolved some other way, or Copilot's session is gone.
    return !work.deliveredAt && incident.status !== "resolved" && incident.coordinator.state !== "failed";
  }

  /** The deploy gate has something to do: the request goes on it, waits for a decision there, or the outcome is due. */
  #gateNeedsFollowing(incident: StoredIncident): boolean {
    const approval = incident.approval;
    const gate = approval?.gate;
    if (!approval || !gate) return false;
    if (gate.state === "opening" || gate.state === "open") return true;
    return gate.state === "answered" && (approval.state === "approved" || ((approval.state === "deployed" || approval.state === "failed") && !gate.reportedAt));
  }

  /** Follows the work order until Copilot learned how it ended. Everything it needs is stored, so it resumes after a restart. */
  followFactory(): void {
    const incident = this.#host.store.get(this.id);
    if (this.#factoryTimer || this.#closed || !this.#host.factory || !this.#needsFollowing(incident)) return;
    // A person may be deciding on the work order's gate right now: notice it sooner.
    const gateOpen = incident?.approval?.gate?.state === "open";
    const every = gateOpen ? Math.min(this.#host.config.factoryPollMs, 2_000) : this.#host.config.factoryPollMs;
    const delay = this.#factoryFailures ? Math.max(every, reconnectDelay(this.#factoryFailures)) : every;
    this.#factoryTimer = setTimeout(() => {
      this.#factoryTimer = undefined;
      void this.checkFactory().finally(() => this.followFactory());
    }, delay);
    this.#factoryTimer.unref?.();
  }

  /** Reads the work order once: records what changed, takes the fix from its release, and tells Copilot how it ended. */
  checkFactory(): Promise<void> {
    this.#factoryCheck ??= this.#checkFactory()
      .catch((error: unknown) => log.warn("Couldn't follow a work order", { incident: this.id, error: errorText(error) }))
      .finally(() => {
        this.#factoryCheck = undefined;
      });
    return this.#factoryCheck;
  }

  async #checkFactory(): Promise<void> {
    const factory = this.#host.factory;
    let work = this.#host.store.get(this.id)?.factory;
    if (!factory || !work || this.#closed) return;
    const label = workOrderLabel(work.number);
    if (ACTIVE_FACTORY_STATUSES.includes(work.status)) {
      let order: WorkOrderInfo | undefined;
      try {
        order = await factory.get(work.workOrderId);
      } catch (error) {
        // 404: it was deleted in the factory. Anything else (unreachable, a refusal) may pass: keep the last status, retry.
        if (!(error instanceof FactoryError && error.status === 404)) return this.#factoryTrouble(`Can't reach Software Factory to follow ${label}: ${sentence(errorText(error))} Incident Commander keeps trying.`);
      }
      this.#factoryReached();
      if (order) this.#factoryStatus(order);
      else this.#factoryGone(label);
      work = this.#host.store.get(this.id)?.factory;
      if (!work) return;
    }
    if (work.status === "completed" && !work.files && !work.error) {
      let release: ReleaseFiles;
      try {
        release = await factory.release(work.workOrderId);
      } catch (error) {
        const missing = error instanceof FactoryError && error.status === 404;
        return this.#factoryTrouble(
          missing
            ? `Software Factory finished ${label}, but its release isn't available yet. Incident Commander keeps checking.`
            : `Can't reach Software Factory to read ${label}'s release: ${sentence(errorText(error))} Incident Commander keeps trying.`,
        );
      }
      const trouble = await this.#takeRelease(release);
      if (trouble) return this.#factoryTrouble(trouble);
      this.#factoryReached();
      work = this.#host.store.get(this.id)?.factory;
      if (!work) return;
    }
    const ended = Boolean(work.files?.length) || work.error !== undefined || work.status === "failed" || work.status === "cancelled";
    if (ended && !work.deliveredAt) await this.#deliverFactory();
    await this.#followGate();
  }

  // ─── The deploy gate ───────────────────────────────────────────────────────────────────────────────────────

  #setGate(change: Partial<ApprovalGateView>, remove: readonly (keyof ApprovalGateView)[] = []): void {
    this.#update((stored) => {
      const gate = stored.approval?.gate;
      if (!stored.approval || !gate) return;
      const next: Record<string, unknown> = { ...gate, ...change };
      for (const key of remove) delete next[key];
      stored.approval.gate = next as unknown as ApprovalGateView;
    });
  }

  /** Software Factory can't be reached for the gate right now: say so on the approval (where its buttons come back). */
  #gateTrouble(problem: string): void {
    this.#factoryFailures++;
    if (this.#host.store.get(this.id)?.approval?.gate?.problem === problem) return;
    log.warn("Can't reach a work order's deploy gate", { incident: this.id, problem });
    this.#setGate({ problem });
  }

  /** Software Factory can't take the request: it's decided here, and the approval says why. */
  #gateUnavailable(reason: string): void {
    this.#setGate({ state: "unavailable", reason }, ["problem"]);
    this.#note("approval", "The deploy request is decided here, not in Software Factory", reason);
    log.warn("A work order's deploy gate can't take the request", { incident: this.id, reason });
  }

  /** The deploy request on the work order's gate: put it there, read the decision, close it, or report how the deploy went. */
  async #followGate(): Promise<void> {
    const factory = this.#host.factory;
    const incident = this.#host.store.get(this.id);
    const approval = incident?.approval;
    const gate = approval?.gate;
    if (!factory || !incident || !approval || !gate?.workOrderId || this.#closed) return;
    if (gate.state === "opening" || gate.state === "open") {
      // Answered here, or the request ended: there's nothing left to decide there.
      if (approval.state !== "waiting") return this.#closeGate(factory, gate.workOrderId);
      if (gate.state === "opening") return this.#openGate(factory, gate.workOrderId);
      return this.#readGate(factory, gate.workOrderId);
    }
    if (gate.state === "answered" && (approval.state === "deployed" || approval.state === "failed") && !gate.reportedAt) return this.#reportGate(factory, gate.workOrderId);
  }

  async #openGate(factory: FactoryClient, workOrderId: string): Promise<void> {
    const incident = this.#incident;
    const approval = incident.approval!;
    const label = workOrderLabel(approval.gate?.number ?? incident.factory?.number ?? 0);
    const service = incident.alert.service;
    const version = nextVersion(incident.serviceVersion);
    const request: GateRequest = {
      requestId: approval.id,
      title: `Deploy the fix for ${incident.id}`,
      summary: approval.summary.slice(0, 2000),
      target: service,
      ...(version ? { version } : {}),
      ...(incident.serviceVersion ? { previousVersion: incident.serviceVersion } : {}),
      ...(approval.tests ? { tests: approval.tests.slice(0, 300) } : {}),
      ...(approval.snapshot.length ? { files: approval.snapshot.slice(0, 100).map((file) => file.path) } : {}),
      url: `${this.#host.config.publicUrl}/#/incidents/${encodeURIComponent(incident.id)}`,
    };
    try {
      await factory.openGate(workOrderId, DEPLOY_GATE, request);
    } catch (error) {
      // A refusal won't change by asking again: it's decided here. Anything else may pass.
      if (error instanceof FactoryError && error.status !== undefined && error.status < 500) {
        return this.#gateUnavailable(`Software Factory couldn't take the deploy request on ${label}: ${sentence(errorText(error))} Approve or decline it here.`);
      }
      return this.#gateTrouble(`Can't reach Software Factory to put the deploy request on ${label}: ${sentence(errorText(error))} Approve or decline it here, or wait: Incident Commander keeps trying.`);
    }
    this.#factoryFailures = 0;
    const now = new Date().toISOString();
    this.#setGate({ state: "open", openedAt: now }, ["problem"]);
    this.#note("approval", `The deploy request waits in Software Factory, on ${label}`, approval.gate?.url, now);
    log.info("Put the deploy request on a work order's gate", { incident: this.id, workOrder: workOrderId });
  }

  async #readGate(factory: FactoryClient, workOrderId: string): Promise<void> {
    const approval = this.#incident.approval!;
    const label = workOrderLabel(approval.gate?.number ?? 0);
    let order: WorkOrderInfo;
    try {
      order = await factory.get(workOrderId);
    } catch (error) {
      if (error instanceof FactoryError && error.status === 404) return this.#gateUnavailable(`${label} no longer exists in Software Factory, so approve or decline the deploy here.`);
      return this.#gateTrouble(`Can't reach Software Factory to read the decision on ${label}: ${sentence(errorText(error))} Approve or decline it here, or wait: Incident Commander keeps trying.`);
    }
    this.#factoryFailures = 0;
    if (approval.gate?.problem) this.#setGate({}, ["problem"]);
    const gate = order.gates?.find((candidate) => candidate.id === DEPLOY_GATE);
    // The gate shows another request, or none: put this one back.
    if (!gate || gate.requestId !== approval.id) return this.#openGate(factory, workOrderId);
    const decision = gate.decision;
    if (decision?.requestId === approval.id && gate.state !== "open") {
      if (this.#incident.approval?.state !== "waiting") return;
      log.info("A person decided the deploy in Software Factory", { incident: this.id, workOrder: workOrderId, approve: decision.approve });
      await this.decide(decision.approve, decision.reason, decision.by, "software-factory");
      return;
    }
    if (gate.state === "closed") this.#gateUnavailable(`${label}'s deploy gate was closed in Software Factory without a decision, so approve or decline the deploy here.`);
  }

  /** The request was answered here, or ended, while it waited on the gate: close it there. */
  async #closeGate(factory: FactoryClient, workOrderId: string): Promise<void> {
    const approval = this.#incident.approval!;
    const decided = approval.state !== "expired";
    const who = approval.decidedBy ? ` by @${approval.decidedBy}` : "";
    const message = decided ? `${approval.state === "declined" ? "Declined" : "Approved"} in Incident Commander${who}.` : "Copilot's deploy request ended before it was deployed.";
    try {
      await factory.reportGate(workOrderId, DEPLOY_GATE, { requestId: approval.id, outcome: "closed", message });
    } catch (error) {
      // 404 and 409: the gate never showed this request, or it already ran its course there. Nothing to close.
      if (!(error instanceof FactoryError && error.status !== undefined && error.status < 500)) {
        return this.#gateTrouble(`Can't reach Software Factory to close the deploy request on ${workOrderLabel(approval.gate?.number ?? 0)}: ${sentence(errorText(error))} Incident Commander keeps trying.`);
      }
      log.info("A work order's deploy gate had nothing to close", { incident: this.id, workOrder: workOrderId, error: errorText(error) });
    }
    this.#factoryFailures = 0;
    this.#setGate({ state: "closed" }, ["problem"]);
  }

  /** The deploy ran: tell the gate how it went. */
  async #reportGate(factory: FactoryClient, workOrderId: string): Promise<void> {
    const incident = this.#incident;
    const approval = incident.approval!;
    const deploy = incident.deploy;
    try {
      await factory.reportGate(workOrderId, DEPLOY_GATE, {
        requestId: approval.id,
        outcome: approval.state === "deployed" ? "deployed" : "failed",
        ...(deploy?.message ? { message: deploy.message.slice(0, 1000) } : {}),
        ...(deploy?.ok && deploy.version ? { version: deploy.version } : {}),
      });
    } catch (error) {
      if (!(error instanceof FactoryError && error.status !== undefined && error.status < 500)) {
        return this.#gateTrouble(`Can't reach Software Factory to report the deploy on ${workOrderLabel(approval.gate?.number ?? 0)}: ${sentence(errorText(error))} Incident Commander keeps trying.`);
      }
      // A refusal won't change by sending it again.
      log.warn("A work order's deploy gate refused the deploy's outcome", { incident: this.id, workOrder: workOrderId, error: errorText(error) });
    }
    this.#factoryFailures = 0;
    this.#setGate({ reportedAt: new Date().toISOString() }, ["problem"]);
  }

  /** A status the factory reported; a timeline entry for each step it reaches. */
  #factoryStatus(order: WorkOrderInfo): void {
    const work = this.#incident.factory;
    if (!work) return;
    const label = workOrderLabel(work.number);
    const changed = order.status !== work.status;
    const tests = order.tests && JSON.stringify(order.tests) !== JSON.stringify(work.tests) ? order.tests : undefined;
    if (!changed && !tests) return;
    const now = new Date().toISOString();
    const error =
      order.status === "failed" ? (order.error?.message ?? `${label} failed.`) : order.status === "cancelled" ? `${label} was cancelled in Software Factory.` : undefined;
    this.#update((stored) => {
      const current = stored.factory;
      if (!current) return;
      if (tests) current.tests = tests;
      if (!changed) return;
      current.status = order.status;
      current.updatedAt = now;
      if (error) current.error = error;
    });
    if (!changed) return;
    log.info("A work order moved on", { incident: this.id, workOrder: work.workOrderId, status: order.status });
    if (order.status === "planning") this.#note("factory", `Software Factory is planning ${label}`, undefined, now);
    else if (order.status === "building") {
      const tasks = order.taskCount ? ` (${order.taskCount} ${order.taskCount === 1 ? "task" : "tasks"})` : "";
      this.#note("factory", `Software Factory is building ${label}${tasks}`, undefined, now);
    } else if (order.status === "releasing") this.#note("factory", `Software Factory is releasing ${label}`, undefined, now);
    else if (order.status === "failed") this.#note("error", `Software Factory couldn't build ${label}${order.error ? `: ${one(order.error.message, 200)}` : ""}`, undefined, now);
    else if (order.status === "cancelled") this.#note("error", `${label} was cancelled in Software Factory`, undefined, now);
  }

  /** The work order disappeared from the factory (deleted there): it won't build the fix. */
  #factoryGone(label: string): void {
    const now = new Date().toISOString();
    this.#update((stored) => {
      if (!stored.factory) return;
      stored.factory.status = "failed";
      stored.factory.updatedAt = now;
      stored.factory.error = `${label} no longer exists in Software Factory.`;
    });
    this.#note("error", `${label} no longer exists in Software Factory`, undefined, now);
  }

  /**
   * The released files: the fix to hand Copilot, or why there's none. Returns what to retry instead, when the service
   * (over HTTP) can't be loaded to compare the release with.
   */
  async #takeRelease(release: ReleaseFiles): Promise<string | undefined> {
    const incident = this.#incident;
    const work = incident.factory;
    if (!work) return undefined;
    const label = workOrderLabel(work.number);
    let fix: FixFile[] = [];
    let error: string | undefined;
    try {
      const originals = new Map(projectFiles(await this.#host.catalog.originals(incident.alert.service)).map((file) => [file.path, file.content]));
      fix = releasedFix(release, originals);
      if (fix.length === 0) error = `Software Factory released ${label} without changing the service's code.`;
    } catch (failed) {
      // The service over HTTP is down for now: the release keeps, so it's taken on a later check.
      if (failed instanceof ServiceLoadError) return `${sentence(failed.message)} Incident Commander needs it to take ${label}'s fix, and keeps trying.`;
      error = `Software Factory released ${label}, but Incident Commander can't use it: ${sentence(errorText(failed))}`;
    }
    const tests = release.tests ?? work.tests;
    this.#update((stored) => {
      if (!stored.factory) return;
      if (tests) stored.factory.tests = tests;
      if (error) stored.factory.error = error;
      else stored.factory.files = fix;
    });
    if (error) {
      this.#note("error", error);
      return undefined;
    }
    log.info("Software Factory released a fix", { incident: this.id, workOrder: work.workOrderId, files: fix.length });
    this.#note("factory", `Software Factory released ${label}: ${pathList(fix)}${tests ? `; ${describeTests(tests)}` : ""}`, release.notes?.trim().slice(0, 1_500));
    return undefined;
  }

  #factoryTrouble(problem: string): void {
    this.#factoryFailures++;
    const work = this.#host.store.get(this.id)?.factory;
    if (!work || work.problem === problem) return;
    log.warn("Can't follow a work order in Software Factory", { incident: this.id, workOrder: work.workOrderId, problem });
    this.#update((stored) => {
      if (stored.factory) stored.factory.problem = problem;
    });
  }

  #factoryReached(): void {
    this.#factoryFailures = 0;
    if (!this.#host.store.get(this.id)?.factory?.problem) return;
    this.#update((stored) => {
      if (stored.factory) delete stored.factory.problem;
    });
  }

  /** Tells Copilot how the work order ended, once: the fix to verify and deploy, or to fall back to a "fix" worker. */
  async #deliverFactory(): Promise<void> {
    const incident = this.#incident;
    const work = incident.factory;
    if (!work || work.deliveredAt || !this.#needsFollowing(incident)) return;
    // A deploy request waits for a person, or their approval is on its way: that goes first.
    if (incident.approval?.state === "waiting" || incident.approval?.state === "approved") return;
    if (this.#host.platform.status.state !== "connected") {
      this.#factoryFailures++;
      return;
    }
    await this.attach();
    const session = this.#session;
    if (!session) {
      this.#factoryFailures++;
      return;
    }
    const fixed = Boolean(work.files?.length);
    const label = workOrderLabel(work.number);
    try {
      // Queued behind a running turn by the platform; otherwise it starts the next one.
      await session.send({ prompt: fixed ? this.#releasedPrompt(work) : `Incident Commander: ${this.#fallback(work)}` });
    } catch (error) {
      this.#factoryFailures++;
      log.warn("Couldn't tell Copilot how its work order ended", { incident: this.id, workOrder: work.workOrderId, error: errorText(error) });
      return;
    }
    const now = new Date().toISOString();
    this.#busy = true;
    this.#update((stored) => {
      if (stored.factory) stored.factory.deliveredAt = now;
      if (stored.coordinator.state !== "done") stored.coordinator.state = "working";
    });
    this.#startPolling();
    this.#note("factory", fixed ? `Handed ${label}'s fix to Copilot to verify and deploy` : `Falling back: Copilot fixes it with a "fix" worker`, undefined, now);
    log.info(fixed ? "Handed a factory fix to Copilot" : "Told Copilot to fall back to a fix worker", { incident: this.id, workOrder: work.workOrderId });
  }

  #releasedPrompt(work: StoredFactoryWork): string {
    const service = this.#incident.alert.service;
    const label = workOrderLabel(work.number);
    const files = (work.files ?? []).map((file) => `${file.path} (${file.status})`).join(", ");
    return [
      `Incident Commander: Software Factory released the fix as ${label} (${work.url}): ${files}.${work.tests ? ` Its own test run: ${describeTests(work.tests)}.` : ""}`,
      `Call ${TOOLS.applyFix} to copy those files into /workspace/${service}, run the whole test suite (repro's test included), and record the result with ${TOOLS.update}. If something fails, make the smallest change yourself, run the suite again, and record what you changed. Then call ${TOOLS.deploy}, and once it is deployed, ${TOOLS.postmortem} (say that Software Factory built the fix as ${label}).`,
    ].join("\n");
  }

  #factoryView(incident: StoredIncident): FactoryWorkView | undefined {
    const work = incident.factory;
    if (!work) return undefined;
    const { files, problem, ...rest } = work;
    // Configuration changed since the work order was routed: say so instead of going quiet.
    const shown =
      problem ??
      (!this.#host.factory && this.#needsFollowing(incident)
        ? `Software Factory isn't connected anymore (SOFTWARE_FACTORY_URL isn't set), so ${workOrderLabel(work.number)} can't be followed.`
        : undefined);
    return {
      ...rest,
      ...(files ? { files: files.map(({ path, status }) => ({ path, status })) } : {}),
      ...(shown ? { problem: shown } : {}),
    };
  }

  // ─── Views ─────────────────────────────────────────────────────────────────────────────────────────────────

  #coordinatorState(incident: StoredIncident): CoordinatorState {
    if (incident.approval?.state === "waiting") return "waiting";
    if (this.#busy) return "working";
    return incident.coordinator.state;
  }

  view(): IncidentView {
    const incident = this.#incident;
    const { snapshot: _snapshot, ...approval } = incident.approval ?? { snapshot: [] };
    const state = this.#coordinatorState(incident);
    const factory = this.#factoryView(incident);
    return {
      ...summarize(incident),
      alert: incident.alert,
      ...(incident.serviceVersion ? { serviceVersion: incident.serviceVersion } : {}),
      coordinator: {
        state,
        ...(state === "working" && this.#activity ? { activity: this.#activity } : {}),
        ...(incident.coordinator.lastMessage ? { lastMessage: incident.coordinator.lastMessage } : {}),
        ...(incident.sessionId ? { sessionId: incident.sessionId } : {}),
        environment: this.#host.config.environment,
        model: this.#host.config.model,
        attached: this.attached,
      },
      sandboxes: incident.sandboxes,
      ...(factory ? { factory } : {}),
      findings: incident.findings,
      ...(incident.approval ? { approval: approval as IncidentView["approval"] } : {}),
      ...(incident.deploy ? { deploy: incident.deploy } : {}),
      ...(incident.postmortem ? { postmortem: incident.postmortem } : {}),
      timeline: incident.timeline,
      milestones: incident.milestones,
      ...(incident.problem ? { problem: incident.problem } : {}),
    };
  }
}

export function summarize(incident: StoredIncident): IncidentSummary {
  return {
    id: incident.id,
    title: incident.title,
    service: incident.alert.service,
    severity: incident.alert.severity,
    status: incident.status,
    needsYou: incident.approval?.state === "waiting",
    demo: incident.demo !== undefined,
    fixRoute: incident.fixRoute ?? "workers",
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}),
  };
}
