import { defineTool } from "@github/copilot-sdk";
import {
  TERMINAL_STATION_STATUSES,
  workOrderMode,
  type OutputManifest,
  type PlanTask,
  type ReleaseChange,
  type ReleaseSummary,
  type ReviewRecord,
  type TestReport,
} from "../../shared/types.js";
import { CancelledError, StationError } from "./errors.js";
import { projectChanges } from "./inputs.js";
import { PlanInputSchema, ReviewInputSchema, topologicalOrder, validatePlan, validateReview, type ValidReview } from "./plan.js";
import {
  buildPrompt,
  checkFailedPrompt,
  fixPrompt,
  planPrompt,
  planRetryPrompt,
  releasePrompt,
  retryPrompt,
  reviewPrompt,
  reviewRetryPrompt,
} from "./prompts.js";
import { builderSeed, projectPackageName, releaseSeed, type TaskOutcome } from "./seed.js";
import { type ActiveSession, type Capture, type CheckOutcome, MAX_NUDGES, type MStation, now, parseJson, type Run, summaryOf } from "./factory-shared.js";
import { FactoryGitHub } from "./factory-github.js";

/** Classic work orders: plan, parallel builds with review loops, and release. */
export abstract class FactoryStages extends FactoryGitHub {
  // ─── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────

  protected async plan(run: Run): Promise<void> {
    const station = this.station(run, "plan");
    this.setWorkOrder(run, { status: "planning", startedAt: run.wo.startedAt ?? now() });
    try {
      const capture: Capture = {};
      const inputs = this.inputs(run);
      // A plan for an existing project keeps the project's own package name.
      const projectName = projectPackageName(inputs);
      const submitPlan = defineTool("submit_plan", {
        description: "Submit the work order's build plan to the factory. Returns 'Accepted' or the problems to fix before resubmitting.",
        parameters: PlanInputSchema,
        skipPermission: true,
        handler: async (args: unknown) => {
          const result = validatePlan(args);
          if (!result.ok) {
            this.addActivity(run.wo, station.id, `Plan rejected: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} to fix`, "warning");
            return `Rejected. Fix these problems and call submit_plan again:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
          }
          capture.plan = projectName ? { ...result.value, projectName } : result.value;
          return `Accepted: ${result.value.tasks.length} task(s). Builders are starting now.`;
        },
      });
      const active = await this.openSharedSession(run, station, { tools: [submitPlan] }, capture);
      await this.turn(run, station, active, planPrompt(run.wo, inputs ? { inputs } : {}), "work", 1);
      if (!capture.plan) await this.turn(run, station, active, planRetryPrompt(), "nudge", 1);
      const plan = capture.plan;
      if (!plan) throw new StationError("plan_missing", "The planner didn't submit a plan.");
      const tasks = topologicalOrder(plan.tasks);
      run.wo.plan = plan;
      run.wo.taskCount = plan.tasks.length;
      run.wo.stations = [
        station,
        ...(workOrderMode(run.wo) === "agent" ? [this.station(run, "coordinator")] : []),
        ...tasks.flatMap((task) => [this.newStation("build", task), this.newStation("review", task)]),
        this.station(run, "release"),
      ];
      this.updateStation(run, station, { status: "done", detail: `${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} planned`, finishedAt: now() });
      this.addActivity(run.wo, station.id, `Plan accepted: ${plan.tasks.map((task) => task.title).join(" · ")}`, "success");
      await this.closeSession(run, station.id);
    } catch (error) {
      await this.failStation(run, station, error);
      throw error;
    }
  }

  // ─── Build and review ───────────────────────────────────────────────────────────────────────────────────────

  protected async buildAll(run: Run): Promise<void> {
    const plan = run.wo.plan!;
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const running = new Map<string, Promise<void>>();
    const runTask = (task: PlanTask): Promise<void> => {
      const existing = running.get(task.id);
      if (existing) return existing;
      const promise = (async () => {
        if (task.dependsOn.length > 0) {
          const build = this.station(run, `build:${task.id}`);
          if (build.status === "waiting") {
            const names = task.dependsOn.map((dep) => byId.get(dep)?.title ?? dep).join(", ");
            this.updateStation(run, build, { detail: `Waiting for ${names}` });
          }
        }
        const settled = await Promise.allSettled(task.dependsOn.map((dep) => runTask(byId.get(dep)!)));
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) {
          // A dependency that lost its platform connection didn't fail: this task waits for the work order to resume.
          if (run.interrupted && !run.failed) throw rejected.reason;
          for (const id of [`build:${task.id}`, `review:${task.id}`]) {
            const station = this.station(run, id);
            if (!TERMINAL_STATION_STATUSES.includes(station.status)) this.updateStation(run, station, { status: "skipped", detail: "Skipped: a dependency failed" });
          }
          throw new StationError("dependency_failed", `Task "${task.id}" was skipped because a task it depends on failed.`);
        }
        await this.buildTask(run, task);
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

  protected override dependencyFiles(run: Run, task: PlanTask): Map<string, string> {
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
    for (const id of order) for (const [path, content] of this.taskFiles(run, id)) files.set(path, content);
    return files;
  }

  /** The files a task currently publishes: its latest manifest's inventory, read from `outputs/files/**`. */
  protected taskFiles(run: Run, taskId: string): Map<string, string> {
    return this.currentFiles(run.wo.id, `build:${taskId}`, "files/");
  }

  /**
   * A station's current files under `prefix`, keyed by project path. The harness's latest manifest is the inventory,
   * so files deleted in a later round don't come back from the artifact history.
   */
  protected currentFiles(workOrderId: string, stationId: string, prefix: string): Map<string, string> {
    const latest = new Map(this.store.latestArtifacts(workOrderId, stationId).map((artifact) => [artifact.path, artifact]));
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

  protected async buildTask(run: Run, task: PlanTask): Promise<void> {
    const build = this.station(run, `build:${task.id}`);
    const review = this.station(run, `review:${task.id}`);
    if (review.status === "done") return;
    let current = build;
    if (build.status === "waiting") this.updateStation(run, build, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.sandboxes.acquire(run.abort.signal);
    try {
      const dependencyFiles = this.dependencyFiles(run, task);
      const inputs = this.inputs(run);
      const active = await this.openSandboxSession(run, build, () => builderSeed(run.wo, run.wo.plan!, task, dependencyFiles, this.skillsRoot, inputs));
      await this.bringTurnCurrent(run, build, active, false, () => buildPrompt(run.wo, task, [...dependencyFiles.keys()], this.notes(run)));

      let nudges = 0;
      for (;;) {
        current = build;
        let report: TestReport | undefined;
        if (build.passedRound !== build.round) {
          const outcome = await this.collect(run, build, false);
          if (!outcome.passed) {
            if (nudges >= MAX_NUDGES) throw new StationError(outcome.code, `The builder couldn't get the factory check to pass: ${outcome.problem}`);
            nudges++;
            this.addActivity(run.wo, build.id, `Check failed: ${outcome.problem}. Asking the builder to fix it.`, "warning");
            await this.turn(run, build, active, checkFailedPrompt(outcome.problem, outcome.report, false), "nudge", build.round);
            continue;
          }
          report = outcome.report;
          this.updateStation(run, build, {
            status: "done",
            passedRound: build.round,
            detail: `${report!.summary.passed} tests passed · in review`,
            finishedAt: now(),
          });
        } else {
          // This round already passed its check (a restart or retry stopped during review): review it as published.
          report = this.latestReport(run, build.id);
          if (build.status !== "done") this.updateStation(run, build, { status: "done", detail: "Tests passed · in review", finishedAt: build.finishedAt ?? now() });
        }

        current = review;
        const verdict = await this.reviewRound(run, task, build, report, active.mapper.lastMessage);
        const passedTests = `${report?.summary.passed ?? build.tests?.passed ?? 0} tests passed`;
        if (verdict.verdict === "approve") {
          this.updateStation(run, review, { status: "done", detail: `Approved in round ${build.round}`, finishedAt: now() });
          this.updateStation(run, build, { detail: passedTests });
          return;
        }
        if (build.round >= run.wo.maxReviewRounds) {
          this.updateStation(run, review, {
            status: "done",
            acceptedWithFindings: true,
            detail: `Accepted after ${build.round} rounds with findings open`,
            finishedAt: now(),
          });
          this.updateStation(run, build, { detail: passedTests });
          this.addActivity(run.wo, review.id, "Maximum review rounds reached: accepting the task and passing open findings to the release notes", "warning");
          return;
        }
        nudges = 0;
        current = build;
        this.updateStation(run, build, { finishedAt: undefined });
        await this.turn(run, build, active, fixPrompt(build.round + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary), "fix", build.round + 1);
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.stopping) await this.failStation(run, current, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.stopping) {
        // Detach from finished stations; their sessions (and sandboxes) stay on the platform for history and attach.
        await this.closeSession(run, build.id);
        await this.closeSession(run, review.id);
      }
    }
  }

  /** Makes sure the station's latest turn has run: the first prompt, a retry note, or an in-flight turn after a restart. */
  protected async bringTurnCurrent(run: Run, station: MStation, active: ActiveSession, release: boolean, firstPrompt: () => string): Promise<void> {
    if (!station.turn) {
      await this.turn(run, station, active, firstPrompt(), "work", 1);
    } else if (station.retryNote) {
      const note = station.retryNote;
      this.updateStation(run, station, { retryNote: undefined, passedRound: undefined });
      await this.turn(run, station, active, retryPrompt(note, release), "retry", Math.max(station.round, 1));
    } else if (!station.turn.completedAt) {
      await this.awaitTurn(run, station, active, release);
    }
  }

  protected override latestReport(run: Run, stationId: string): TestReport | undefined {
    return parseJson<TestReport>(this.store.latestArtifacts(run.wo.id, stationId).find((artifact) => artifact.path === "test-report.json")?.content);
  }

  protected override async reviewRound(run: Run, task: PlanTask, build: MStation, report: TestReport | undefined, builderSummary: string | undefined, reuse = true): Promise<ValidReview> {
    const review = this.station(run, `review:${task.id}`);
    const round = build.round;
    const existing = reuse ? review.reviews?.find((record) => record.round === round) : undefined;
    if (existing) return existing;
    const files = [...this.taskFiles(run, task.id)]
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => Number(/\.(test|spec)\./.test(a.path)) - Number(/\.(test|spec)\./.test(b.path)) || a.path.localeCompare(b.path));
    const previous = review.reviews?.at(-1)?.findings;
    const inputs = this.inputs(run);
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
    return this.review(run, review, build, round, () =>
      reviewPrompt(task, round, run.wo.maxReviewRounds, { files, report, builderSummary, ...(project ? { project } : {}) }, previous),
    );
  }

  /**
   * One review turn: opens (or reuses) the review station's shared session with `submit_review`, sends the prompt, and
   * records the verdict for the build's `round`. Requested changes are announced on the build station.
   */
  protected override async review(run: Run, review: MStation, build: MStation, round: number, prompt: () => string, label = round): Promise<ValidReview> {
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
      active = await this.openSharedSession(run, review, { tools: [submitReview] }, capture);
    }
    delete capture.review;
    const captured = (): ValidReview | undefined => capture.review;
    this.updateStation(run, review, { round, detail: `Reviewing round ${label}` });
    await this.turn(run, review, active, prompt(), "review", round);
    if (!captured()) await this.turn(run, review, active, reviewRetryPrompt(), "nudge", round);
    const verdict = captured();
    if (!verdict) throw new StationError("review_missing", "The reviewer didn't submit a verdict.");
    const record: ReviewRecord = { round, verdict: verdict.verdict, summary: verdict.summary, findings: verdict.findings, at: now() };
    this.updateStation(run, review, { reviews: [...(review.reviews ?? []).filter((item) => item.round !== round), record] });
    const blocking = verdict.findings.filter((finding) => finding.severity !== "minor").length;
    this.emitItem(run.wo, {
      id: `${review.id}:review:${round}`,
      stationId: review.id,
      kind: "review",
      review: { round, verdict: verdict.verdict, findings: verdict.findings.length },
      text: verdict.summary,
      level: verdict.verdict === "approve" ? "success" : "warning",
    });
    if (verdict.verdict === "request_changes") {
      this.updateStation(run, review, { status: "changes_requested", detail: `${blocking} finding${blocking === 1 ? "" : "s"} sent back to the ${build.role === "developer" ? "developer" : "builder"}` });
      this.addActivity(run.wo, build.id, `Reviewer requested changes: ${blocking} finding${blocking === 1 ? "" : "s"} to fix`, "warning");
    }
    return verdict;
  }

  // ─── Release ────────────────────────────────────────────────────────────────────────────────────────────────

  protected async runRelease(run: Run): Promise<void> {
    const station = this.station(run, "release");
    if (station.status === "done" && run.wo.release) return;
    const plan = run.wo.plan!;
    const outcomes = this.outcomes(run);
    const seed = releaseSeed(run.wo, plan, outcomes, this.skillsRoot, this.inputs(run));
    this.updateStation(run, station, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.sandboxes.acquire(run.abort.signal);
    try {
      const active = await this.openSandboxSession(run, station, () => [...seed.files]);
      await this.bringTurnCurrent(run, station, active, true, () => releasePrompt(run.wo, plan, seed.conflicts, this.notes(run)));
      let nudges = 0;
      for (;;) {
        const outcome = await this.collect(run, station, true);
        const latest = this.store.latestArtifacts(run.wo.id, station.id);
        const notes = latest.find((artifact) => artifact.path === "RELEASE.md")?.content;
        const problem = !outcome.passed ? outcome.problem : notes ? undefined : "outputs/RELEASE.md is missing";
        if (problem) {
          if (nudges >= MAX_NUDGES) throw new StationError(outcome.passed ? "release_incomplete" : outcome.code, `The release couldn't be completed: ${problem}`);
          nudges++;
          this.addActivity(run.wo, station.id, `Release check failed: ${problem}. Asking the release agent to fix it.`, "warning");
          await this.turn(run, station, active, checkFailedPrompt(problem, outcome.report, true), "nudge", station.round);
          continue;
        }
        this.acceptRelease(run, station, outcome);
        return;
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.stopping) await this.failStation(run, station, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.stopping) await this.closeSession(run, station.id);
    }
  }

  protected override outcomes(run: Run): TaskOutcome[] {
    return run.wo.plan!.tasks.map((task) => {
      const review = this.station(run, `review:${task.id}`);
      return { task, reviews: review.reviews ?? [], acceptedWithFindings: Boolean(review.acceptedWithFindings), files: this.taskFiles(run, task.id) };
    });
  }

  protected override acceptRelease(run: Run, station: MStation, outcome: CheckOutcome): void {
    const latest = this.store.latestArtifacts(run.wo.id, station.id);
    const patch = latest.find((artifact) => artifact.path === "project.patch");
    const notes = latest.find((artifact) => artifact.path === "RELEASE.md")?.content;
    const manifest = outcome.manifest!;
    const project = this.inputs(run)?.project;
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
    this.updateStation(run, station, { status: "done", detail: `Release ready · ${release.tests!.passed} tests passed`, finishedAt: now() });
    const changed = changes ? `, ${changes.filter((change) => change.status !== "added").length} of ${project!.name}'s files changed and ${changes.filter((change) => change.status === "added").length} added` : "";
    this.addActivity(run.wo, station.id, `Release ready: ${release.files} files${changed}, ${release.tests!.passed} tests passed`, "success");
  }
}
