import { randomBytes } from "node:crypto";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import { parseRepoInput } from "../shared/repo.js";
import { STEP_IDS, summarize, type AppState, type RunDetail, type RunSource, type RunView, type ServerEvent } from "../shared/types.js";
import type { DoctorConfig } from "./config.js";
import { drive } from "./driver.js";
import { DoctorError, errorText } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { BlockedRequest, DoctorPlatform } from "./platform.js";
import { nextRevision, Run, type RunSink } from "./run.js";
import type { SampleProject } from "./sample.js";
import type { RunStore } from "./store.js";

/** A finished run whose sandbox may still exist: the manager deletes it (again) when the platform is reachable. */
function needsCleanUp(view: RunView): boolean {
  return view.status !== "running" && view.sessionId !== undefined && view.sandbox.state !== "deleted" && view.sandbox.state !== "failed";
}

export function parseSource(body: unknown): RunSource {
  const value = (body ?? {}) as { repo?: unknown; sample?: unknown };
  if (value.sample === true) return { kind: "sample" };
  if (typeof value.repo !== "string") throw new DoctorError("invalid_request", "Paste a GitHub repository, or try the sample.");
  const parsed = parseRepoInput(value.repo);
  if ("error" in parsed) throw new DoctorError("invalid_request", parsed.error);
  return { kind: "github", owner: parsed.owner, repo: parsed.repo, ...(parsed.ref ? { ref: parsed.ref } : {}) };
}

/** A run that was going when Repo Doctor stopped can't be picked up again: it reads as failed, and its sandbox is deleted. */
export function interrupted(view: RunView, now = new Date().toISOString()): RunView {
  if (view.status !== "running") return view;
  return {
    ...view,
    revision: nextRevision(view),
    status: "failed",
    finishedAt: now,
    error: { code: "interrupted", message: "Repo Doctor restarted during this run." },
    steps: view.steps.map((step) => {
      if (step.status === "pending") return { ...step, status: "skipped" };
      if (step.status !== "running") return step;
      const { activity: _activity, ...rest } = step;
      return { ...rest, status: "failed", finishedAt: now, summary: "Interrupted" };
    }),
    sandbox: view.sessionId ? view.sandbox : { ...view.sandbox, state: "failed" },
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
}

export class RunManager {
  readonly #platform: DoctorPlatform;
  readonly #config: DoctorConfig;
  readonly #store: RunStore;
  readonly #hub: EventHub;
  readonly #sample: SampleProject;
  readonly #runs = new Map<string, Run>();
  readonly #drivers = new Map<string, Promise<void>>();
  readonly #publishing = new Map<string, NodeJS.Timeout>();
  readonly #saving = new Map<string, NodeJS.Timeout>();
  #counter = 0;
  #cleaning = false;
  readonly #sink: RunSink = {
    changed: (run) => {
      this.#schedule(this.#publishing, run, 100, () => this.#hub.publish({ type: "run", run: run.view }));
      this.#schedule(this.#saving, run, 500, () => this.#save(run));
    },
    logged: (run, step, line) => {
      this.#hub.publish({ type: "log", runId: run.id, step, line });
      this.#schedule(this.#saving, run, 500, () => this.#save(run));
    },
  };

  constructor(platform: DoctorPlatform, config: DoctorConfig, store: RunStore, hub: EventHub, sample: SampleProject) {
    this.#platform = platform;
    this.#config = config;
    this.#store = store;
    this.#hub = hub;
    this.#sample = sample;
  }

  get platform(): DoctorPlatform {
    return this.#platform;
  }

  /** Loads the run history, then follows the platform's status and network events. */
  start(): void {
    for (const stored of this.#store.load()) {
      const view = interrupted(stored.run);
      const run = new Run(view, stored.logs, this.#sink);
      this.#runs.set(view.id, run);
      if (view !== stored.run) this.#save(run);
      this.#counter = Math.max(this.#counter, view.number);
    }
    this.#counter = Math.max(this.#counter, this.#store.counter());
    this.#platform.onBlocked((request) => this.#blocked(request));
    this.#platform.onStatus((platform) => {
      this.#hub.publish({ type: "platform", platform });
      if (platform.state === "connected") void this.#cleanUp();
    });
    if (this.#platform.status.state === "connected") void this.#cleanUp();
  }

  state(): AppState {
    return {
      platform: this.#platform.status,
      runs: this.#sorted().map((run) => summarize(run.view)),
      sample: { name: this.#sample.name, description: this.#sample.description },
      model: this.#config.model,
      maxRuns: this.#config.maxRuns,
    };
  }

  initialEvents(): ServerEvent[] {
    return [{ type: "platform", platform: this.#platform.status }];
  }

  detail(id: string): RunDetail {
    const run = this.#get(id);
    return { run: run.view, logs: run.logs };
  }

  create(body: unknown): RunView {
    const source = parseSource(body);
    if (this.#platform.status.state !== "connected") throw new DoctorError("platform_unavailable", this.#platform.status.message ?? "Managed Copilot isn't connected yet.", 503);
    const going = [...this.#runs.values()].filter((run) => run.view.status === "running").length;
    if (going >= this.#config.maxRuns) {
      throw new DoctorError("busy", `${this.#config.maxRuns === 1 ? "A run is" : `${this.#config.maxRuns} runs are`} already going. Wait for one to finish.`, 409);
    }
    const number = ++this.#counter;
    this.#store.saveCounter(number);
    const view: RunView = {
      id: `r-${randomBytes(6).toString("hex")}`,
      number,
      revision: 0,
      source,
      title: source.kind === "github" ? `${source.owner}/${source.repo}` : this.#sample.name,
      status: "running",
      createdAt: new Date().toISOString(),
      model: this.#config.model,
      sandbox: { state: "creating", environment: this.#config.environment },
      steps: STEP_IDS.map((id) => ({ id, status: "pending" })),
      network: { access: "unknown", allowed: [], blocked: [] },
    };
    const run = new Run(view, undefined, this.#sink);
    this.#runs.set(view.id, run);
    this.#sink.changed(run);
    log.info("Run started", { run: view.id, number, source: view.title });
    const driving = drive(run, { platform: this.#platform, config: this.#config, sample: this.#sample })
      .catch((error: unknown) => log.error("A run stopped unexpectedly", { run: view.id, error: errorText(error) }))
      .finally(() => {
        this.#drivers.delete(view.id);
        this.#flush(run);
        log.info("Run finished", { run: view.id, status: run.view.status });
        this.#prune();
      });
    this.#drivers.set(view.id, driving);
    return run.view;
  }

  stop(id: string): void {
    const run = this.#get(id);
    if (run.view.status !== "running") throw new DoctorError("not_running", "This run already finished.", 409);
    run.controller.abort();
  }

  /** Deletes a finished run's record, after making sure its sandbox is gone. */
  async delete(id: string): Promise<void> {
    const run = this.#get(id);
    if (run.view.status === "running") throw new DoctorError("running", "Stop the run before deleting it.", 409);
    if (needsCleanUp(run.view)) {
      try {
        await this.#platform.deleteSession(run.view.sessionId!);
      } catch (error) {
        if (!isManagedCopilotError(error, "not_found")) throw new DoctorError("cleanup_failed", "Couldn't delete this run's sandbox. Try again once Managed Copilot is connected.", 503);
      }
    }
    this.#forget(run);
  }

  patch(id: string): { readonly filename: string; readonly text: string } {
    const run = this.#get(id);
    if (!run.view.patch?.text) throw new DoctorError("not_found", "This run has no patch.", 404);
    return { filename: `${slug(run.view.title)}-run-${run.view.number}.patch`, text: run.view.patch.text };
  }

  /** Stops runs in progress (their sandboxes are deleted) and writes every record. */
  async close(): Promise<void> {
    for (const run of this.#runs.values()) if (run.view.status === "running") run.controller.abort();
    await Promise.race([Promise.allSettled([...this.#drivers.values()]), new Promise((resolve) => setTimeout(resolve, 15_000).unref())]);
    for (const run of this.#runs.values()) this.#flush(run);
  }

  #get(id: string): Run {
    const run = this.#runs.get(id);
    if (!run) throw new DoctorError("not_found", "There's no such run. It may have been deleted.", 404);
    return run;
  }

  #sorted(): Run[] {
    return [...this.#runs.values()].sort((a, b) => b.view.number - a.view.number);
  }

  #schedule(timers: Map<string, NodeJS.Timeout>, run: Run, ms: number, action: () => void): void {
    if (timers.has(run.id)) return;
    timers.set(
      run.id,
      setTimeout(() => {
        timers.delete(run.id);
        if (this.#runs.get(run.id) === run) action();
      }, ms),
    );
  }

  #save(run: Run): void {
    try {
      this.#store.save({ run: run.view, logs: run.logs });
    } catch (error) {
      log.warn("Couldn't save a run", { run: run.id, error: errorText(error) });
    }
  }

  /** Publishes and saves at once (the run finished, or the server is closing). */
  #flush(run: Run): void {
    for (const timers of [this.#publishing, this.#saving]) {
      clearTimeout(timers.get(run.id));
      timers.delete(run.id);
    }
    if (this.#runs.get(run.id) !== run) return;
    this.#hub.publish({ type: "run", run: run.view });
    this.#save(run);
  }

  #forget(run: Run): void {
    for (const timers of [this.#publishing, this.#saving]) {
      clearTimeout(timers.get(run.id));
      timers.delete(run.id);
    }
    this.#runs.delete(run.id);
    this.#store.remove(run.id);
    this.#hub.publish({ type: "run.deleted", id: run.id });
  }

  /** Keeps the newest finished runs whose sandboxes are gone. */
  #prune(): void {
    const finished = this.#sorted().filter((run) => run.view.status !== "running" && !needsCleanUp(run.view));
    for (const run of finished.slice(this.#config.keepRuns)) this.#forget(run);
  }

  #blocked(request: BlockedRequest): void {
    [...this.#runs.values()].find((candidate) => candidate.view.sessionId === request.sessionId)?.blocked(request);
  }

  /** Deletes sandboxes that finished runs couldn't delete, for example while the platform was unreachable. */
  async #cleanUp(): Promise<void> {
    if (this.#cleaning) return;
    this.#cleaning = true;
    try {
      for (const run of this.#runs.values()) {
        if (!needsCleanUp(run.view) || this.#drivers.has(run.id)) continue;
        const { sessionId, sandbox } = run.view;
        try {
          await this.#platform.deleteSession(sessionId!);
        } catch (error) {
          if (!isManagedCopilotError(error, "not_found")) {
            log.warn("Couldn't delete a finished run's sandbox", { run: run.id, error: errorText(error) });
            continue;
          }
        }
        // A session still being created when the run ended may never have existed: then there was nothing to delete.
        run.update({ sandbox: { ...sandbox, state: sandbox.state === "creating" ? "failed" : "deleted" } });
        this.#flush(run);
      }
    } finally {
      this.#cleaning = false;
    }
  }
}
