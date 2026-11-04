// Every research run: starting, stopping, and removing them, routing platform events to the run they belong to,
// publishing changes to browsers, and cleaning up after runs a restart or a lost connection interrupted.
import { randomUUID } from "node:crypto";
import type { AppState, Run, RunSummary, ServerEvent } from "../shared/types.js";
import { QUESTION_MAX } from "../shared/types.js";
import type { SwarmConfig } from "./config.js";
import { errorText, isMissingSession, SwarmError } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { SwarmPlatform } from "./platform.js";
import { isActive, ResearchRun } from "./run.js";
import { reportMarkdown } from "./sources.js";
import type { Store } from "./store.js";

const PUBLISH_MS = 150;

function summarize(run: Run): RunSummary {
  return {
    id: run.id,
    question: run.question,
    ...(run.report ? { title: run.report.title } : {}),
    status: run.status,
    researchers: run.researchers.length,
    sources: run.report ? run.report.sources.length : new Set(run.researchers.flatMap((researcher) => researcher.pages.map((page) => page.url))).size,
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

export class RunManager {
  readonly #platform: SwarmPlatform;
  readonly #config: SwarmConfig;
  readonly #store: Store;
  readonly #hub: EventHub;
  /** Runs this process started that still have a session to finish or clean up. */
  readonly #live = new Map<string, ResearchRun>();
  /** Runs deleted by the person. */
  readonly #removed = new Set<string>();
  readonly #pending = new Map<string, Run>();
  #publishTimer: NodeJS.Timeout | undefined;
  #stateDirty = false;
  #sweeping: Promise<void> | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(platform: SwarmPlatform, config: SwarmConfig, store: Store, hub: EventHub) {
    this.#platform = platform;
    this.#config = config;
    this.#store = store;
    this.#hub = hub;
  }

  get platform(): SwarmPlatform {
    return this.#platform;
  }

  start(): void {
    // Runs a previous process left unfinished can't continue: their lead's tools lived in that process.
    for (const run of this.#store.list().filter(isActive)) {
      this.#store.put({ ...run, status: "stopped", activity: undefined, error: "Research Swarm restarted during this research. Start it again.", finishedAt: run.finishedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    let previous = this.#platform.status.state;
    this.#unsubscribe.push(
      this.#platform.onStatus((status) => {
        if (previous === "connected" && status.state !== "connected") for (const run of this.#live.values()) if (isActive(run.run)) void run.lost();
        if (status.state === "connected") void this.#sweep();
        previous = status.state;
        this.#stateChanged();
      }),
      this.#platform.onEvent((event) => {
        for (const run of this.#live.values()) {
          if (run.owns(event.sessionId)) {
            run.handle(event);
            return;
          }
        }
      }),
    );
  }

  state(): AppState {
    const swarm = this.#platform.swarm;
    return { platform: this.#platform.status, ...(swarm ? { swarm } : {}), runs: this.#store.list().map(summarize) };
  }

  initialEvents(): ServerEvent[] {
    return [{ type: "state", state: this.state() }];
  }

  get(id: string): Run {
    const run = this.#store.get(id);
    if (!run) throw new SwarmError("not_found", "This research isn't here anymore.");
    return run;
  }

  /** Starts researching a question; returns once the run exists (the research itself goes on in the background). */
  create(question: string, researchers?: number): Run {
    const text = question.replace(/\s+/g, " ").trim();
    if (!text) throw new SwarmError("invalid_request", "Write a question first.");
    if (text.length > QUESTION_MAX) throw new SwarmError("invalid_request", `Keep the question under ${QUESTION_MAX} characters.`);
    const swarm = this.#platform.swarm;
    if (this.#platform.status.state !== "connected" || !swarm) throw new SwarmError("upstream_unavailable", this.#platform.status.message ?? "Managed Copilot isn't connected yet. Try again in a moment.");
    if (researchers !== undefined && (!Number.isInteger(researchers) || researchers < 2 || researchers > swarm.researchers.max)) {
      throw new SwarmError("invalid_request", `Ask for 2 to ${swarm.researchers.max} researchers.`);
    }
    const active = [...this.#live.values()].filter((run) => isActive(run.run)).length;
    if (active >= this.#config.maxRuns) {
      throw new SwarmError("conflict", `${active === 1 ? "A research run is" : `${active} research runs are`} in progress. Wait for ${active === 1 ? "it" : "one"} to finish, or stop ${active === 1 ? "it" : "one"}.`);
    }
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), question: text, status: "planning", activity: "Reading the question", researchers: [], model: this.#config.model, createdAt: now, updatedAt: now };
    const research = new ResearchRun({ platform: this.#platform, pollMs: this.#config.pollMs, timeoutMs: this.#config.runTimeoutMs, changed: (changed) => this.#changed(changed) }, swarm, run, researchers);
    this.#live.set(run.id, research);
    this.#changed(run);
    void research.start();
    return run;
  }

  async stop(id: string): Promise<Run> {
    const research = this.#live.get(id);
    if (!research || !isActive(research.run)) return this.get(id);
    await research.stop();
    return research.run;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    const research = this.#live.get(id);
    if (research) {
      if (isActive(research.run)) await research.stop();
      // A run stopped while its lead was being created deletes that session itself once it exists.
      if (research.run.sessionId && !research.run.cleanedUp) throw new SwarmError("upstream_unavailable", "Couldn't delete this research's sandboxes yet. Try again in a moment.");
      this.#live.delete(id);
    } else {
      const run = this.#store.get(id);
      if (run?.sessionId && !run.cleanedUp) {
        try {
          await this.#platform.deleteSession(run.sessionId);
        } catch (error) {
          if (!isMissingSession(error)) throw new SwarmError("upstream_unavailable", `Couldn't delete this research's sandboxes yet: ${errorText(error)}`);
        }
      }
    }
    this.#store.remove(id);
    this.#removed.add(id);
    this.#pending.delete(id);
    this.#hub.publish({ type: "removed", id });
    this.#stateChanged();
  }

  report(id: string): { filename: string; markdown: string } {
    const run = this.get(id);
    if (!run.report) throw new SwarmError("conflict", "This research has no report yet.");
    const slug = run.report.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "research";
    return { filename: `${slug}.md`, markdown: reportMarkdown(run) };
  }

  /** Stops the runs in progress (their sessions and sandboxes are deleted) before the process exits. */
  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    await Promise.all([...this.#live.values()].filter((run) => isActive(run.run)).map((run) => run.stop().catch(() => undefined)));
    this.#flush();
    this.#store.flush();
  }

  /** Deletes the sessions of runs that ended without being cleaned up (a lost connection, an earlier process). */
  #sweep(): Promise<void> {
    this.#sweeping ??= (async () => {
      for (const run of this.#store.list()) {
        if (!run.sessionId || run.cleanedUp || isActive(run)) continue;
        const research = this.#live.get(run.id);
        if (research) {
          await research.cleanUp();
          continue;
        }
        try {
          await this.#platform.deleteSession(run.sessionId);
        } catch (error) {
          if (!isMissingSession(error)) {
            log.warn("Couldn't delete an earlier run's session yet", { run: run.id, sessionId: run.sessionId, error: errorText(error) });
            continue;
          }
        }
        this.#changed({ ...this.#store.get(run.id)!, cleanedUp: true, updatedAt: new Date().toISOString() });
        log.info("Deleted an earlier run's lead, researchers, and sandboxes", { run: run.id, sessionId: run.sessionId });
      }
    })().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  #changed(run: Run): void {
    // A removed run may still finish deleting its session; its record stays gone.
    if (this.#removed.has(run.id)) return;
    const before = this.#store.get(run.id);
    this.#store.put(run);
    if (!before || before.status !== run.status || before.report !== run.report || summarize(before).sources !== summarize(run).sources) this.#stateDirty = true;
    // A run that ended and was cleaned up needs nothing more from this process.
    if (!isActive(run) && run.cleanedUp) this.#live.delete(run.id);
    this.#pending.set(run.id, run);
    this.#schedule();
  }

  #stateChanged(): void {
    this.#stateDirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#publishTimer) return;
    this.#publishTimer = setTimeout(() => this.#flush(), PUBLISH_MS);
    this.#publishTimer.unref?.();
  }

  #flush(): void {
    clearTimeout(this.#publishTimer);
    this.#publishTimer = undefined;
    for (const run of this.#pending.values()) this.#hub.publish({ type: "run", run });
    this.#pending.clear();
    if (this.#stateDirty) {
      this.#stateDirty = false;
      this.#hub.publish({ type: "state", state: this.state() });
    }
  }
}
