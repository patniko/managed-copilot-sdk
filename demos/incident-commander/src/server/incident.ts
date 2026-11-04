// One incident: its coordinator session (a mixed orchestrator) and everything the app learns about it. The app holds a
// live session only while the agent works. When the agent asks to deploy, the app records the request, leaves it to the
// platform, and lets go: the request waits there (durably, for up to 24 hours) with no browser tab, no live connection,
// and no app memory involved. A person's decision re-attaches; the platform delivers the request again, and the decision
// answers it. Without the app attached, the platform's webhook keeps it informed and answers what needs no person.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { VerifiedWebhookEvent } from "@managed-copilot/sdk";
import type { CoordinatorState, FileChange, IncidentSummary, IncidentView, SandboxView } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { deployDemo, deployWebhook, type DeployOutcome, type DeployRequest } from "./deploy.js";
import { diffFile } from "./diff.js";
import { AppError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { CoordinatorSession, IncidentPlatform } from "./platform.js";
import { alertPrompt, runbook, TOOLS } from "./runbook.js";
import type { ServiceCatalog } from "./services.js";
import type { StoredApproval, StoredIncident, Store } from "./store.js";
import { failure, incidentTools, parseDeploy, ToolInputError, type DeployInput, type PostmortemInput, type ToolHost, type ToolOutcome, type UpdateInput } from "./tools.js";

export interface RunHost {
  readonly config: AppConfig;
  readonly platform: IncidentPlatform;
  readonly store: Store;
  readonly catalog: ServiceCatalog;
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

const base = (path: unknown): string => one(path).split("/").filter(Boolean).at(-1) ?? "";

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

  constructor(host: RunHost, id: string) {
    this.#host = host;
    this.id = id;
  }

  get #incident(): StoredIncident {
    const incident = this.#host.store.get(this.id);
    if (!incident) throw new AppError("not_found", `${this.id} doesn't exist anymore.`, 404);
    return incident;
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
    return {
      model: this.#host.config.model,
      tools: incidentTools(this),
      onPermissionRequest: (request: PermissionRequest) => this.#permission(request, generation),
      onEvent: (event: SessionEvent) => {
        if (generation === this.#generation) this.#event(event);
      },
      systemMessage: { content: runbook(this.#host.workerEnvironment()) },
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

  /** Approves or declines the waiting deploy. The decision is recorded first, then delivered by re-attaching. */
  async decide(approve: boolean, reason: string | undefined, login: string | undefined): Promise<void> {
    const approval = this.#incident.approval;
    if (!approval || approval.state !== "waiting") throw new AppError("not_actionable", "This deploy request was already answered.", 409);
    const now = new Date().toISOString();
    this.#update((incident) => {
      const stored = incident.approval!;
      stored.state = approve ? "approved" : "declined";
      stored.decidedAt = now;
      if (login) stored.decidedBy = login;
      if (reason) stored.reason = reason;
    });
    const who = login ? `@${login}` : "You";
    this.#note("person", approve ? `${who} approved the deploy` : `${who} declined the deploy${reason ? `: ${reason}` : ""}`);
    log.info(approve ? "Deploy approved" : "Deploy declined", { incident: this.id, waitedSeconds: Math.round((Date.parse(now) - Date.parse(approval.requestedAt)) / 1000) });
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
      await this.#recordApproval(id, input);
    }
    // Leave the request to the platform: it waits there for a person, and the app lets go of the session.
    if (via === "live") setImmediate(() => void this.detach());
    return { kind: "no-result" };
  }

  /** Snapshots the changes from Copilot's own sandbox, so the person reviews (and approves) exactly what ships. */
  async #recordApproval(id: string, input: DeployInput): Promise<void> {
    const incident = this.#incident;
    const service = incident.alert.service;
    const snapshot: { path: string; content: string }[] = [];
    const files: FileChange[] = [];
    let problem: string | undefined;
    try {
      const own = await this.#ownSandbox();
      if (!own) throw new Error("Copilot's own sandbox isn't running");
      const originals = await this.#host.catalog.originals(service);
      for (const raw of input.files) {
        const path = servicePath(service, raw);
        if (!path) throw new Error(`${raw} isn't inside the service's folder`);
        const content = await this.#host.platform.readFile(own.id, `${service}/${path}`);
        snapshot.push({ path, content });
        files.push(diffFile(path, originals.get(path), content));
      }
    } catch (error) {
      problem = `Couldn't read the changes from Copilot's sandbox: ${errorText(error)}.`;
    }
    const approval: StoredApproval = {
      id,
      state: "waiting",
      summary: input.summary,
      ...(input.tests ? { tests: input.tests } : {}),
      files,
      snapshot,
      ...(problem ? { problem } : {}),
      requestedAt: new Date().toISOString(),
    };
    this.#update((stored) => {
      stored.approval = approval;
      if (stored.status === "investigating") stored.status = "mitigating";
      stored.milestones.mitigatingAt ??= approval.requestedAt;
    });
    this.#note("approval", `Copilot asked to deploy: ${input.summary}`, input.tests ? `Tests: ${input.tests}` : undefined);
    log.info("Deploy requested; waiting for a person", { incident: this.id, files: files.length });
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
        await event.handleActions({ tools: incidentTools(this), onPermissionRequest: (request) => this.#webhookPermission(request) });
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
    const { files } = await this.#host.catalog.workspace(service, incident.demo);
    if (files.size === 0) {
      return `No code, tests, or logs are on file for the "${service}" service. Work from the alert's details: record what it tells you and what to check next with ${TOOLS.update}.`;
    }
    const entries = [...files];
    await inBatches(entries, 4, async ([path, content]) => this.#host.platform.writeFile(own.id, `${service}/${path}`, content));
    this.#note("sandbox", `Copied the ${service} service into Copilot's sandbox (${files.size} files)`);
    void this.refresh();
    const folders = [...new Set(entries.map(([path]) => (path.includes("/") ? `${path.split("/")[0]}/` : path)))].sort();
    return `Copied ${files.size} files into /workspace/${service}: ${folders.join(", ")}. Start with /workspace/${service}/README.md.`;
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
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}),
  };
}
