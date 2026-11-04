// One research question: a lead session in the research-swarm orchestrator (on the shared runtime), the researchers it
// starts (workers, each in a sandbox of its own), the pages they read, and the report. The lead decides; the app
// observes the researchers through worker listings, `worker.*` and `network.blocked` events, and each researcher's
// source log, and owns the three tools that bracket the work: plan_research, list_sources, and submit_report.
import { defineTool, type PermissionRequest, type PermissionRequestResult, type SessionEvent, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import type { PlatformEvent, WorkerEventData, WorkerInfo, WorkerState } from "@managed-copilot/sdk";
import type { Researcher, ResearcherState, Run, RunStatus, SwarmInfo } from "../shared/types.js";
import { errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { LeadSession, SwarmPlatform } from "./platform.js";
import { NUDGE, planSize, planText, questionPrompt, sourcesText, systemMessage } from "./prompts.js";
import { buildReport, checkDraft, parsePages, SOURCE_LOG, SourceRegistry } from "./sources.js";

export interface RunHost {
  readonly platform: SwarmPlatform;
  readonly pollMs: number;
  readonly timeoutMs: number;
  /** The run changed: publish and save it. */
  changed(run: Run): void;
}

const ACTIVE: ReadonlySet<RunStatus> = new Set(["planning", "researching", "writing"]);
const WORKING: ReadonlySet<ResearcherState> = new Set(["queued", "starting", "reading"]);
const MAX_NUDGES = 2;
/** After the report is saved, how long the lead's turn gets to end before the run cleans up anyway. */
const GRACE_MS = 20_000;
const SUB_QUESTION_MAX = 300;
/**
 * The stock runtime in each researcher's sandbox also calls its own Copilot service hosts; under the researchers'
 * strict allowlist those calls are blocked and reported too. They aren't research, so they aren't shown.
 */
const RUNTIME_HOSTS = /(^|\.)githubcopilot\.com$/i;

const ACTIVITY: Readonly<Record<string, string>> = {
  plan_research: "Splitting the question",
  start_worker: "Starting researchers",
  wait_for_workers: "Waiting for researchers",
  read_worker_file: "Reading a researcher's notes",
  list_sources: "Collecting sources",
  submit_report: "Writing the report",
};

export function isActive(run: Run): boolean {
  return ACTIVE.has(run.status);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const failure = (message: string): ToolResultObject => ({ textResultForLlm: message, resultType: "failure", error: message });

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]).finally(() => clearTimeout(timer));
}

function researcherState(state: WorkerState, current: ResearcherState): ResearcherState {
  switch (state) {
    case "starting":
      return "starting";
    case "working":
      return "reading";
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return current === "done" ? "done" : "stopped";
  }
}

/** The first line of a worker's task, as the question of a researcher the plan didn't name. */
function taskQuestion(task: string): string {
  const line = task.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
  return line.replace(/\s+/g, " ").trim().slice(0, SUB_QUESTION_MAX);
}

export class ResearchRun {
  readonly #host: RunHost;
  readonly #swarm: SwarmInfo;
  /** The most sub-questions (and so researchers) the lead may plan. */
  readonly #max: number;
  #run: Run;
  #session: LeadSession | undefined;
  readonly #registry = new SourceRegistry();
  #nudges = 0;
  #leadError: string | undefined;
  #poll: NodeJS.Timeout | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #grace: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;
  #stopping = false;
  #finished = false;
  /** Researchers whose source log gets one more read (they just finished). */
  readonly #finalRead = new Set<string>();
  /** start_worker calls in flight, by tool call: the researcher each one starts. */
  readonly #starting = new Map<string, string>();
  /** Worker names the lead chose, by the planned researcher each start_worker call was for. */
  readonly #names = new Map<string, string>();
  /** The latest list_sources call: when it completes, the lead starts writing. */
  #sourcesCall: string | undefined;

  constructor(host: RunHost, swarm: SwarmInfo, run: Run, maxResearchers = swarm.researchers.max) {
    this.#host = host;
    this.#swarm = swarm;
    this.#max = Math.min(maxResearchers, swarm.researchers.max);
    this.#run = run;
  }

  get run(): Run {
    return this.#run;
  }

  /** Whether a session is the lead's or one of its researchers'. */
  owns(sessionId: string | undefined): boolean {
    return sessionId !== undefined && (sessionId === this.#run.sessionId || this.#run.researchers.some((researcher) => researcher.workerId === sessionId));
  }

  /** Creates the lead's session and asks it the question; the work then runs on the platform. */
  async start(): Promise<void> {
    try {
      const session = await this.#host.platform.createSession({
        model: this.#run.model,
        systemMessage: {
          content: systemMessage({
            researcherEnvironment: this.#swarm.researchers.environment,
            researcherModel: this.#swarm.researchers.model,
            maxResearchers: this.#max,
          }),
        },
        tools: this.#tools(),
        onPermissionRequest: (request) => this.#permission(request),
        onEvent: (event) => this.#onEvent(event),
      });
      this.#session = session;
      this.#update({ sessionId: session.sessionId });
      if (this.#stopping || this.#finished) return void (await this.cleanUp());
      log.info("Started a research run", { run: this.#run.id, sessionId: session.sessionId });
      this.#poll = setInterval(() => void this.#sync(), this.#host.pollMs);
      this.#poll.unref?.();
      this.#deadline = setTimeout(() => void this.#halt("failed", `It ran longer than ${Math.round(this.#host.timeoutMs / 60_000)} minutes, so Research Swarm stopped it.`), this.#host.timeoutMs);
      this.#deadline.unref?.();
      await session.send({ prompt: questionPrompt(this.#run.question) });
    } catch (error) {
      log.warn("Couldn't start a research run", { run: this.#run.id, error: errorText(error) });
      await this.#finish("failed", `Couldn't start the research: ${errorText(error)}`);
    }
  }

  /** Stops the run at the person's request: its lead, researchers, and sandboxes are deleted. */
  stop(): Promise<void> {
    return this.#halt("stopped");
  }

  /** The connection to the platform was replaced: this run's session can't be reached anymore. */
  lost(): Promise<void> {
    this.#session = undefined;
    return this.#finish("failed", "Lost the connection to Managed Copilot during the research. Start it again.");
  }

  /** A worker or network event of the caller's sessions. */
  handle(event: PlatformEvent): void {
    if (this.#finished) return;
    if (event.type === "network.blocked") {
      const researcher = this.#run.researchers.find((candidate) => candidate.workerId === event.sessionId);
      const host = str(event.data["host"]);
      if (!researcher || !host || RUNTIME_HOSTS.test(host) || researcher.blocked.some((blocked) => blocked.host === host)) return;
      const blocked = [...researcher.blocked, { host, reason: str(event.data["reason"]) ?? "blocked", at: event.createdAt }].slice(-10);
      this.#updateResearcher(researcher.id, { blocked });
      return;
    }
    if (event.sessionId !== this.#run.sessionId) return;
    const data = event.data as unknown as WorkerEventData;
    if (data.role === "hands" || !data.workerId) return;
    this.#applyWorker({ id: data.workerId, name: data.name, environment: data.environment, state: data.state, ...(data.error ? { error: data.error } : {}) }, event.createdAt);
    void this.#sync();
  }

  // ─── The lead's tools ──────────────────────────────────────────────────────────────────────────────────────

  #tools(): Tool<unknown>[] {
    return [
      defineTool("plan_research", {
        description: "Records your research plan: the sub-questions that one researcher each will answer. Returns each researcher's name. Call it once, before starting researchers.",
        parameters: {
          type: "object",
          properties: { subQuestions: { type: "array", items: { type: "string" }, description: `${planSize(this.#max).replace(/^t/, "T")} specific, independent sub-questions that together answer the question.` } },
          required: ["subQuestions"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: (args) => this.#plan(args),
      }),
      defineTool("list_sources", {
        description: "Lists every page your researchers read, numbered for citation. Call it after wait_for_workers, before submit_report.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        skipPermission: true,
        handler: async () => {
          await this.#sync(true);
          return sourcesText(this.#registry.sources);
        },
      }),
      defineTool("submit_report", {
        description: "Saves the finished report and ends your turn. Every factual sentence must cite numbers from list_sources, like [2] or [1][3].",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "A short title, at most 10 words." },
            summary: { type: "string", description: "The direct answer, in at most two sentences, with citations." },
            body: { type: "string", description: "Markdown, 120 to 300 words, in two or three sections with ## headings, every factual sentence ending with citations." },
          },
          required: ["title", "summary", "body"],
          additionalProperties: false,
        },
        skipPermission: true,
        isTerminal: true,
        handler: (args) => this.#submit(args),
      }),
    ];
  }

  #plan(args: unknown): string | ToolResultObject {
    if (this.#run.researchers.length > 0) return planText(this.#run.researchers, true);
    const raw = record(args)["subQuestions"];
    const questions = (Array.isArray(raw) ? raw : []).map((value) => str(value)?.replace(/\s+/g, " ")).filter((value): value is string => value !== undefined);
    const max = this.#max;
    if (questions.length === 0) return failure(`Pass subQuestions: ${planSize(max)} sub-questions.`);
    if (questions.length > max) return failure(`Plan at most ${max} sub-questions: that's how many researchers this question gets.`);
    const researchers: Researcher[] = questions.map((question, index) => ({ id: `r${index + 1}`, question: question.slice(0, SUB_QUESTION_MAX), state: "queued", pages: [], blocked: [] }));
    this.#update({ researchers, status: "researching" });
    return planText(researchers, false);
  }

  async #submit(args: unknown): Promise<string | ToolResultObject> {
    if (this.#finished) return failure("This research was stopped.");
    const input = record(args);
    const draft = { title: str(input["title"]) ?? "", summary: str(input["summary"]) ?? "", body: str(input["body"]) ?? "" };
    await this.#sync(true);
    const problems = checkDraft(draft, this.#registry.sources);
    if (problems.length > 0) return failure(problems.join("\n"));
    const report = buildReport(draft, this.#registry.sources);
    this.#update({ status: "done", report, finishedAt: new Date().toISOString(), activity: undefined });
    log.info("A report is ready", { run: this.#run.id, sources: report.sources.length });
    // The lead's turn ends now; clean up when it does, or after a grace period if its end is never seen.
    this.#grace = setTimeout(() => void this.#finish("done"), GRACE_MS);
    this.#grace.unref?.();
    return "Saved. The person can read the report now; end your turn.";
  }

  // ─── Approvals ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Asking a question approves its researchers: starting one (in the researcher environment, after a plan, one per
   * sub-question plus a replacement) is approved here, and approving it covers what it does in its sandbox. The lead
   * gets nothing else that asks.
   */
  #permission(request: PermissionRequest): PermissionRequestResult {
    const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });
    if (this.#finished || this.#stopping) return reject("This research was stopped.");
    if (request.kind === "custom-tool" && request.toolName === "start_worker") {
      const args = record(request.args);
      const environment = str(args["environment"]) ?? this.#swarm.researchers.environment;
      if (environment !== this.#swarm.researchers.environment) return reject(`Start researchers only in "${this.#swarm.researchers.environment}".`);
      const planned = this.#run.researchers.length;
      if (planned === 0) return reject("Call plan_research first, then start one researcher per sub-question.");
      const started = this.#run.researchers.filter((researcher) => researcher.workerId).length + this.#starting.size;
      if (started > planned + 1) return reject("Every sub-question already has a researcher. Wait for them with wait_for_workers.");
      return { kind: "approve-once" };
    }
    if (request.kind === "url") return reject("Only your researchers read the web. Start a researcher for it instead.");
    return reject(`Research Swarm doesn't allow "${request.kind}" actions for the lead.`);
  }

  // ─── The lead's events ─────────────────────────────────────────────────────────────────────────────────────

  #onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "tool.execution_start": {
        if (this.#finished || !isActive(this.#run)) return;
        const name = event.data.toolName;
        if (name === "list_sources" || name === "submit_report") this.#update({ status: "writing" });
        if (name === "list_sources") this.#sourcesCall = event.data.toolCallId;
        const activity = ACTIVITY[name];
        if (activity) this.#update({ activity });
        if (name === "start_worker") {
          const workerName = str(record(event.data.arguments)["name"]);
          const researcher = this.#researcherFor(workerName);
          if (researcher && researcher.state === "queued") {
            this.#starting.set(event.data.toolCallId, researcher.id);
            if (workerName) this.#names.set(workerName.toLowerCase(), researcher.id);
            this.#updateResearcher(researcher.id, { state: "starting" });
          }
        }
        return;
      }
      case "tool.execution_complete": {
        // Once the sources are in, the lead composes the report before it calls submit_report.
        if (event.data.success && this.#sourcesCall === event.data.toolCallId && isActive(this.#run) && !this.#finished) this.#update({ activity: "Writing the report" });
        const id = this.#starting.get(event.data.toolCallId);
        if (id === undefined) return;
        this.#starting.delete(event.data.toolCallId);
        const researcher = this.#run.researchers.find((candidate) => candidate.id === id);
        // A start that was refused or failed leaves the sub-question waiting.
        if (!event.data.success && researcher && !researcher.workerId) this.#updateResearcher(id, { state: "queued" });
        return;
      }
      case "session.error":
        this.#leadError = `The lead stopped with an error: ${event.data.message}`;
        return;
      case "session.idle":
        void this.#turnEnded();
        return;
    }
  }

  async #turnEnded(): Promise<void> {
    if (this.#finished || this.#stopping) return;
    if (this.#run.report) return this.#finish("done");
    if (this.#leadError) return this.#finish("failed", this.#leadError);
    if (this.#nudges < MAX_NUDGES && this.#session) {
      this.#nudges++;
      log.info("The lead ended its turn without a report; asking it to finish", { run: this.#run.id, nudge: this.#nudges });
      try {
        await this.#session.send({ prompt: NUDGE });
        return;
      } catch (error) {
        return this.#finish("failed", `Couldn't reach the lead: ${errorText(error)}`);
      }
    }
    return this.#finish("failed", "The lead finished without writing a report.");
  }

  // ─── Researchers ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The planned researcher a worker name belongs to: the one with that name (r1, r2, …), the one a start_worker call
   * under that name was for, else the first one not started yet.
   */
  #researcherFor(name: string | undefined): Researcher | undefined {
    const researchers = this.#run.researchers;
    const key = name?.toLowerCase();
    const started = key ? this.#names.get(key) : undefined;
    return (
      researchers.find((researcher) => researcher.id.toLowerCase() === key) ??
      researchers.find((researcher) => researcher.id === started) ??
      researchers.find((researcher) => !researcher.workerId && researcher.state === "queued")
    );
  }

  #applyWorker(worker: { id: string; name: string; environment?: string; state: WorkerState; model?: string; result?: string; error?: string; task?: string; createdAt?: string }, at: string): void {
    let researcher = this.#run.researchers.find((candidate) => candidate.workerId === worker.id);
    if (!researcher) {
      const planned = this.#researcherFor(worker.name);
      if (planned && !planned.workerId) {
        researcher = planned;
      } else if (worker.task !== undefined) {
        // A researcher the plan didn't name, such as a replacement: shown with its task's first line.
        researcher = { id: worker.name, question: taskQuestion(worker.task), state: "queued", pages: [], blocked: [] };
        this.#update({ researchers: [...this.#run.researchers, researcher] });
      } else {
        return;
      }
    }
    const state = researcherState(worker.state, researcher.state);
    const finished = state === "done" || state === "failed" || state === "stopped";
    if (finished && WORKING.has(researcher.state)) this.#finalRead.add(researcher.id);
    this.#updateResearcher(researcher.id, {
      workerId: worker.id,
      state,
      ...(worker.environment ? { environment: worker.environment } : {}),
      ...(worker.model ? { model: worker.model } : {}),
      ...(worker.result ? { report: worker.result } : {}),
      ...(state === "failed" && worker.error ? { error: worker.error } : {}),
      ...(researcher.startedAt ? {} : { startedAt: worker.createdAt ?? at }),
      ...(finished ? (researcher.finishedAt && !WORKING.has(researcher.state) ? {} : { finishedAt: at }) : { finishedAt: undefined }),
    });
  }

  #applyListing(worker: WorkerInfo): void {
    if (worker.role === "hands") return;
    this.#applyWorker(
      {
        id: worker.id,
        name: worker.name,
        environment: worker.environment,
        state: worker.state,
        task: worker.task,
        createdAt: worker.createdAt,
        ...(worker.model ? { model: worker.model } : {}),
        ...(worker.result ? { result: worker.result } : {}),
        ...(worker.error ? { error: worker.error } : {}),
      },
      worker.updatedAt,
    );
  }

  /** Reads the workers' listing, the source logs of researchers at work (`all`: every researcher's), and sandbox IDs. */
  #sync(all = false): Promise<void> {
    const run = async () => {
      if (this.#syncing) await this.#syncing.catch(() => undefined);
      await this.#syncOnce(all);
    };
    if (this.#syncing && !all) return this.#syncing;
    const syncing: Promise<void> = run().finally(() => {
      if (this.#syncing === syncing) this.#syncing = undefined;
    });
    this.#syncing = syncing;
    return syncing;
  }

  async #syncOnce(all: boolean): Promise<void> {
    const sessionId = this.#run.sessionId;
    if (!sessionId || this.#run.cleanedUp) return;
    const platform = this.#host.platform;
    try {
      for (const worker of await platform.workers(sessionId)) this.#applyListing(worker);
    } catch (error) {
      log.debug("Couldn't list the researchers", { run: this.#run.id, error: errorText(error) });
    }
    const reads = this.#run.researchers.filter((researcher) => researcher.workerId && (all || researcher.state === "starting" || researcher.state === "reading" || this.#finalRead.has(researcher.id)));
    await Promise.all(reads.map((researcher) => this.#readPages(researcher)));
    const unplaced = this.#run.researchers.filter((researcher) => researcher.workerId && !researcher.sandboxId && researcher.state !== "queued");
    await Promise.all(
      unplaced.map(async (researcher) => {
        try {
          const sandboxId = (await platform.sessionInfo(researcher.workerId!)).sandbox?.id;
          if (sandboxId) this.#updateResearcher(researcher.id, { sandboxId });
        } catch (error) {
          log.debug("Couldn't read a researcher's sandbox", { run: this.#run.id, researcher: researcher.id, error: errorText(error) });
        }
      }),
    );
  }

  async #readPages(researcher: Researcher): Promise<void> {
    try {
      const pages = parsePages(await this.#host.platform.readFile(researcher.workerId!, SOURCE_LOG));
      this.#finalRead.delete(researcher.id);
      this.#registry.add(researcher.id, pages);
      const current = this.#run.researchers.find((candidate) => candidate.id === researcher.id);
      if (current && pages.map((page) => page.url).join("\n") !== current.pages.map((page) => page.url).join("\n")) this.#updateResearcher(researcher.id, { pages });
    } catch (error) {
      // No log yet (nothing read), or the sandbox is gone: what was seen stays.
      if (isMissingSession(error)) this.#finalRead.delete(researcher.id);
      else log.debug("Couldn't read a researcher's sources", { run: this.#run.id, researcher: researcher.id, error: errorText(error) });
    }
  }

  // ─── Ending ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Ends the lead's turn, then finishes the run. */
  async #halt(status: "failed" | "stopped", error?: string): Promise<void> {
    if (this.#finished || this.#stopping) return;
    this.#stopping = true;
    if (isActive(this.#run)) this.#update({ activity: "Stopping" });
    const session = this.#session;
    if (session) await timeout(session.abort().catch(() => undefined), 5_000);
    await this.#finish(status, error);
  }

  /** Settles the run's final state and deletes the lead's session, which deletes its researchers and their sandboxes. */
  async #finish(status: "done" | "failed" | "stopped", error?: string): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    clearInterval(this.#poll);
    clearTimeout(this.#deadline);
    clearTimeout(this.#grace);
    // The last pages read, before the sandboxes go.
    await timeout(this.#sync(true), 15_000);
    const final: RunStatus = this.#run.report ? "done" : status;
    const researchers = this.#run.researchers.map((researcher) => (WORKING.has(researcher.state) ? { ...researcher, state: "stopped" as const } : researcher));
    this.#update({
      status: final,
      researchers,
      activity: undefined,
      finishedAt: this.#run.finishedAt ?? new Date().toISOString(),
      ...(final !== "done" && error ? { error } : {}),
    });
    log.info(final === "done" ? "Research done" : `Research ${final}`, { run: this.#run.id, ...(final !== "done" && error ? { reason: error } : {}) });
    await this.cleanUp();
  }

  /** Deletes the lead's session (and so every researcher and sandbox). Safe to call again until it succeeds. */
  async cleanUp(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (session) await timeout(session.disconnect().catch(() => undefined), 5_000);
    const sessionId = this.#run.sessionId;
    if (!sessionId || this.#run.cleanedUp) return;
    try {
      await this.#host.platform.deleteSession(sessionId);
    } catch (error) {
      if (!isMissingSession(error)) {
        log.warn("Couldn't delete a run's session yet; trying again later", { run: this.#run.id, sessionId, error: errorText(error) });
        return;
      }
    }
    this.#update({ cleanedUp: true });
    log.info("Deleted the run's lead, researchers, and sandboxes", { run: this.#run.id, sessionId });
  }

  // ─── State ─────────────────────────────────────────────────────────────────────────────────────────────────

  #update(patch: Partial<Run>): void {
    const next = { ...this.#run, ...patch };
    const changed = (Object.keys(patch) as (keyof Run)[]).some((key) => next[key] !== this.#run[key]);
    if (!changed) return;
    this.#run = { ...next, updatedAt: new Date().toISOString() };
    this.#host.changed(this.#run);
  }

  #updateResearcher(id: string, patch: Partial<Researcher>): void {
    const index = this.#run.researchers.findIndex((researcher) => researcher.id === id);
    if (index < 0) return;
    const current = this.#run.researchers[index]!;
    const next: Researcher = { ...current, ...patch };
    if ((Object.keys(patch) as (keyof Researcher)[]).every((key) => next[key] === current[key])) return;
    for (const key of Object.keys(next) as (keyof Researcher)[]) if (next[key] === undefined) delete (next as Partial<Record<keyof Researcher, unknown>>)[key];
    const researchers = [...this.#run.researchers];
    researchers[index] = next;
    this.#update({ researchers });
  }
}
