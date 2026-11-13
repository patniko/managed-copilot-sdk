import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { FACTORY_ENVIRONMENTS, PR_REVIEWER_AGENT, ROLE_AGENTS } from "../../shared/environments.js";
import { mediaTypeOf, type ChangeCheck, type ChangeRevision, type GitHubWork, type MediaItem, type ReviewRecord } from "../../shared/types.js";
import type { TreeEntry } from "../github.js";
import { log } from "../log.js";
import { CancelledError, StationError, toFactoryError } from "./errors.js";
import { sha256 } from "./seed.js";
import {
  blobScript,
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
  type Snapshot,
} from "./repo.js";
import {
  type ActiveSession,
  type Capture,
  CHANGE_BUILD,
  CHANGE_REVIEW,
  CHANGE_TASK,
  describeChange,
  explainSetupFailure,
  MAX_ARCHIVE_BYTES,
  MAX_NUDGES,
  MAX_PATCH_BYTES,
  mediaKey,
  type MStation,
  type Mutable,
  now,
  type Run,
  SANDBOX_COMMAND_TIMEOUT_MS,
  spokenDuration,
} from "./factory-shared.js";
import { FactoryCoordination } from "./factory-coordination.js";

/** GitHub work orders: one change lane developed in a repository checkout, reviewed, and opened as a pull request. */
export abstract class FactoryGitHub extends FactoryCoordination {
  // ─── GitHub work orders ─────────────────────────────────────────────────────────────────────────────────────

  /** One lane: the developer's change (a `factory-repo` sandbox), its review, and the pull request the factory opens. */
  protected changeStations(title: string): MStation[] {
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
        model: this.platform.models.developer,
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
        model: this.platform.models.reviewer,
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

  protected revision(run: Run): ChangeRevision {
    return run.wo.github!.revisions.at(-1)!;
  }

  /** Updates the current revision (the last one); `undefined` values remove a field. */
  protected updateRevision(run: Run, patch: Partial<Mutable<ChangeRevision>>): ChangeRevision {
    if (run.closed) return this.revision(run);
    const github = run.wo.github!;
    const revisions = [...github.revisions];
    const current: Record<string, unknown> = { ...revisions.at(-1)! };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete current[key];
      else current[key] = value;
    }
    revisions[revisions.length - 1] = current as unknown as ChangeRevision;
    run.wo.github = { ...github, revisions };
    this.persist(run.wo);
    return revisions.at(-1)!;
  }

  protected updateGitHub(run: Run, patch: Partial<Mutable<GitHubWork>>): void {
    if (run.closed) return;
    run.wo.github = { ...run.wo.github!, ...patch };
    this.persist(run.wo);
  }

  protected submitChangeTool(run: Run, capture: Capture): Tool<unknown> {
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
        this.updateRevision(run, {
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

  protected async develop(run: Run): Promise<void> {
    const build = this.station(run, CHANGE_BUILD);
    const review = this.station(run, CHANGE_REVIEW);
    if (this.revision(run).acceptedRound !== undefined) return;
    let current = build;
    if (build.status === "waiting") this.updateStation(run, build, { detail: "Queued for a sandbox" });
    const releaseSlot = await this.sandboxes.acquire(run.abort.signal);
    try {
      const capture: Capture = {};
      const active = await this.openSandboxSession(run, build, () => [{ path: ".factory/REQUEST.md", content: requestMarkdown(run.wo) }], {
        extra: { tools: [this.submitChangeTool(run, capture)] },
        capture,
        prepare: (opened) => this.checkout(run, build, opened),
      });
      await this.startRevision(run, build, active);

      let nudges = 0;
      for (;;) {
        current = build;
        if (build.passedRound !== build.round) {
          const submitted = this.revision(run);
          if (submitted.summary === undefined && submitted.answer === undefined) {
            if (nudges >= MAX_NUDGES) throw new StationError("change_missing", "The developer didn't submit its change with submit_change.");
            nudges++;
            this.addActivity(run.wo, build.id, "The developer finished without calling submit_change; asking it to", "warning");
            await this.turn(run, build, active, submitChangeRetryPrompt(), "nudge", build.round);
            continue;
          }
          const check = await this.verifyChange(run, build);
          if (check && !check.passed && nudges < MAX_NUDGES) {
            nudges++;
            this.addActivity(run.wo, build.id, `\`${check.command}\` failed when the factory re-ran it; asking the developer to fix it`, "warning");
            await this.turn(run, build, active, changeCheckFailedPrompt(check), "nudge", build.round);
            continue;
          }
          this.updateStation(run, build, { status: "done", passedRound: build.round, detail: describeChange(this.revision(run)), finishedAt: now() });
        }
        const revision = this.revision(run);
        if ((revision.files ?? []).length === 0) {
          this.updateStation(run, review, { status: "skipped", detail: "No file changes to review", round: build.round });
          this.updateRevision(run, { acceptedRound: build.round });
          return;
        }

        current = review;
        const startRound = revision.startRound ?? 1;
        const used = build.round - startRound + 1;
        const existing = review.reviews?.find((record) => record.round === build.round);
        const previous = review.reviews?.filter((record) => record.round >= startRound && record.round < build.round).at(-1)?.findings;
        const verdict =
          existing ??
          (await this.review(run, review, build, build.round, () => this.changeReviewPrompt(run, build, used, previous), used));
        if (verdict.verdict === "approve") {
          this.updateStation(run, review, { status: "done", detail: `Approved in round ${used}`, finishedAt: now() });
          this.updateRevision(run, { acceptedRound: build.round });
          return;
        }
        if (used >= run.wo.maxReviewRounds) {
          this.updateStation(run, review, {
            status: "done",
            acceptedWithFindings: true,
            detail: `Accepted after ${used} rounds with findings open`,
            finishedAt: now(),
          });
          this.addActivity(run.wo, review.id, "Maximum review rounds reached: the pull request lists the open findings", "warning");
          this.updateRevision(run, { acceptedRound: build.round });
          return;
        }
        nudges = 0;
        current = build;
        this.updateStation(run, build, { finishedAt: undefined });
        await this.turn(run, build, active, changeFixPrompt(used + 1, run.wo.maxReviewRounds, verdict.findings, verdict.summary), "fix", build.round + 1);
      }
    } catch (caught) {
      const error = explainSetupFailure(caught);
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.stopping) await this.failStation(run, current, error);
      throw error;
    } finally {
      releaseSlot();
      if (!this.stopping) {
        // Detach; the session (and its sandbox, with the working tree) stays for the pull request and later revisions.
        await this.closeSession(run, build.id);
        await this.closeSession(run, review.id);
      }
    }
  }

  /**
   * Makes sure the current revision's request reached the developer: its first turn (the request), a retry note, or a
   * turn still in flight after a restart.
   */
  protected async startRevision(run: Run, build: MStation, active: ActiveSession): Promise<void> {
    const revision = this.revision(run);
    const sent = revision.startRound !== undefined && (build.turn?.round ?? 0) >= revision.startRound;
    if (!sent) {
      this.updateStation(run, build, { retryNote: undefined });
      const round = build.round + 1;
      this.updateRevision(run, { startRound: round });
      // REQUEST.md lists every follow-up so far.
      await this.platform.files(active.session.sessionId).write(".factory/REQUEST.md", requestMarkdown(run.wo));
      const prompt = revision.number === 1 ? developPrompt(run.wo) : revisionPrompt(revision, run.wo.github!.pullRequest);
      await this.turn(run, build, active, prompt, "work", round);
    } else if (build.retryNote) {
      const note = build.retryNote;
      this.updateStation(run, build, { retryNote: undefined, passedRound: undefined });
      await this.turn(run, build, active, changeRetryPrompt(note), "retry", Math.max(build.round, 1));
    } else if (build.turn && !build.turn.completedAt) {
      await this.awaitTurn(run, build, active, "change");
    }
  }

  /**
   * Puts the repository into the sandbox without a credential: the factory downloads the base commit's archive with its
   * own GitHub token and uploads it, and the sandbox unpacks it into a git repository. A replacement sandbox also gets
   * the work already pushed to the branch.
   */
  protected async checkout(run: Run, station: MStation, active: ActiveSession): Promise<void> {
    const github = this.requireGitHub();
    const work = run.wo.github!;
    const { owner, name, fullName } = work.repository;
    const pushed = [...work.revisions].reverse().find((revision) => revision.pushed && revision.commitSha)?.commitSha;
    this.updateStation(run, station, { detail: `Checking out ${fullName}` });
    active.mapper.status(`Checking out ${fullName} at ${work.baseSha.slice(0, 7)} (${work.repository.defaultBranch})${pushed ? `, with the work already pushed (${pushed.slice(0, 7)})` : ""}`);
    const dir = mkdtempSync(join(tmpdir(), "factory-checkout-"));
    try {
      const files = this.platform.files(active.session.sessionId);
      const archives: [string, string][] = [[work.baseSha, "base.tar.gz"], ...(pushed ? ([[pushed, "head.tar.gz"]] as [string, string][]) : [])];
      for (const [ref, file] of archives) {
        const local = join(dir, file);
        const size = await github.downloadTarball(owner, name, ref, local);
        if (size > MAX_ARCHIVE_BYTES) throw new StationError("repository_too_large", `${fullName} is ${Math.round(size / 1024 / 1024)} MB packed; the factory checks out repositories up to ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
        this.throwIfCancelled(run);
        await files.upload(local, `.factory/${file}`);
      }
      const result = await this.platform.exec(
        active.session.sessionId,
        checkoutScript({ branch: work.branch, baseArchive: ".factory/base.tar.gz", ...(pushed ? { headArchive: ".factory/head.tar.gz" } : {}), label: `${fullName}@${work.baseSha.slice(0, 12)}` }),
        { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal },
      );
      this.throwIfCancelled(run);
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
  protected async snapshot(run: Run, station: MStation): Promise<Snapshot> {
    const result = await this.platform.exec(station.sessionId!, snapshotScript(), { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal });
    this.throwIfCancelled(run);
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
  protected async verifyChange(run: Run, build: MStation): Promise<ChangeCheck | undefined> {
    this.updateStation(run, build, { status: "collecting", detail: "Collecting the change" });
    await this.capturePublication(run, build);
    const revision = this.revision(run);
    const media = this.matchMedia(run, build, revision.requestedMedia ?? []);
    const snapshot = await this.snapshot(run, build);
    await this.savePatch(run, build, snapshot);
    let check: ChangeCheck | undefined;
    if (snapshot.files.length > 0 && revision.testCommand) {
      this.updateStation(run, build, { detail: `Running ${revision.testCommand}` });
      const started = Date.now();
      const result = await this.platform.exec(build.sessionId!, checkScript(revision.testCommand), {
        timeoutMs: this.options.config.checkTimeoutMs ?? 10 * 60_000,
        signal: run.abort.signal,
      });
      this.throwIfCancelled(run);
      const passed = result.state === "completed" && result.exitCode === 0;
      check = {
        command: revision.testCommand,
        passed,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        durationMs: Date.now() - started,
        output: outputTail(result.output),
        at: now(),
      };
      this.addActivity(
        run.wo,
        build.id,
        passed
          ? `The factory re-ran \`${check.command}\`: passed (${spokenDuration(check.durationMs)})`
          : `The factory re-ran \`${check.command}\`: ${result.state === "timed_out" ? "it timed out" : `exit ${result.exitCode ?? result.state}`}`,
        passed ? "success" : "warning",
      );
    }
    this.updateRevision(run, { files: snapshot.files, media, check });
    if (snapshot.files.length === 0) this.addActivity(run.wo, build.id, revision.answer ? "Answered the request without changing files" : "The developer didn't change any files", "info");
    return check;
  }

  /** The media the developer listed, matched to what its turn actually published (and the factory kept). */
  protected matchMedia(run: Run, build: MStation, requested: readonly { readonly path: string; readonly caption: string }[]): MediaItem[] {
    const metas = this.store.listArtifacts(run.wo.id).filter((meta) => meta.stationId === build.id);
    const media: MediaItem[] = [];
    for (const item of requested) {
      const meta = metas.find((candidate) => candidate.path === item.path && candidate.hasBytes);
      const type = mediaTypeOf(item.path);
      if (!meta || !type) {
        const published = metas.find((candidate) => candidate.path === item.path);
        this.addActivity(
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
  protected async savePatch(run: Run, build: MStation, snapshot: Snapshot): Promise<void> {
    let content = "";
    if (snapshot.files.length > 0) {
      const result = await this.platform.exec(build.sessionId!, patchScript(snapshot.tree), { timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS, signal: run.abort.signal });
      this.throwIfCancelled(run);
      if (result.state !== "completed" || result.exitCode !== 0) throw new StationError("diff_failed", `Couldn't read the change's diff: ${outputTail(result.output, 400) || result.state}`);
      content = result.output;
    }
    const digest = `sha256:${sha256(content)}`;
    const latest = this.store.listArtifacts(run.wo.id).find((meta) => meta.stationId === build.id && meta.path === "change.patch");
    if (latest?.digest === digest) return;
    const bytes = Buffer.byteLength(content, "utf8");
    this.store.putArtifact({
      workOrderId: run.wo.id,
      stationId: build.id,
      path: "change.patch",
      version: this.store.nextArtifactVersion(run.wo.id, build.id, "change.patch"),
      round: build.round,
      size: bytes,
      digest,
      contentType: "text/x-diff",
      publishedAt: now(),
      ...(bytes <= MAX_PATCH_BYTES ? { content } : {}),
    });
    this.options.hub.publish({ type: "artifacts", workOrderId: run.wo.id });
  }

  protected changeReviewPrompt(run: Run, build: MStation, used: number, previous: ReviewRecord["findings"] | undefined): string {
    const revision = this.revision(run);
    const patch = this.store.latestArtifacts(run.wo.id, build.id).find((artifact) => artifact.path === "change.patch")?.content ?? "(The diff is too large to show.)";
    const developerSummary = run.sessions.get(build.id)?.mapper.lastMessage;
    return changeReviewPrompt(run.wo, used, run.wo.maxReviewRounds, { patch, files: revision.files ?? [], revision, ...(developerSummary ? { developerSummary } : {}) }, previous);
  }

  protected async pullRequest(run: Run): Promise<void> {
    const station = this.station(run, "release");
    const build = this.station(run, CHANGE_BUILD);
    const review = this.station(run, CHANGE_REVIEW);
    let revision = this.revision(run);
    if (revision.completedAt) return;
    const work = run.wo.github!;
    if ((revision.files ?? []).length === 0) {
      this.updateStation(run, station, { status: "skipped", detail: work.pullRequest ? "No new changes to push" : "No changes, so no pull request", finishedAt: now() });
      this.updateRevision(run, { outcome: "no_changes", completedAt: now() });
      return;
    }
    const github = this.requireGitHub();
    const { owner, name } = work.repository;
    try {
      this.updateStation(run, station, { status: "working", detail: "Pushing the change", startedAt: station.startedAt ?? now(), round: build.round });
      if (!revision.pushed) await this.pushRevision(run, station, build);
      revision = this.revision(run);
      const urls = await this.uploadMedia(run, station, revision.media ?? []);
      const text = {
        wo: run.wo,
        revision,
        reviews: (review.reviews ?? []).filter((record) => record.round >= (revision.startRound ?? 1)),
        acceptedWithFindings: Boolean(review.acceptedWithFindings),
        mediaUrls: urls,
        mediaKey,
        models: { developer: build.model ?? this.platform.models.developer, reviewer: review.model ?? this.platform.models.reviewer },
      };
      const existing = run.wo.github!.pullRequest;
      if (!existing) {
        this.updateStation(run, station, { detail: "Opening the pull request" });
        const pull =
          (await github.findPullRequest(owner, name, work.branch)) ??
          (await github.createPullRequest(owner, name, { title: revision.title ?? run.wo.title, body: pullRequestBody(text), head: work.branch, base: work.repository.defaultBranch }));
        this.updateGitHub(run, { pullRequest: pull });
        this.updateRevision(run, { outcome: "pull_request", completedAt: now() });
        this.addActivity(run.wo, station.id, `Opened pull request #${pull.number}: ${pull.title}`, "success");
        this.updateStation(run, station, { status: "done", detail: `Opened #${pull.number}`, finishedAt: now() });
      } else {
        this.updateStation(run, station, { detail: `Commenting on #${existing.number}` });
        const url = revision.commentUrl ?? (await github.comment(owner, name, existing.number, revisionComment(text)));
        this.updateRevision(run, { commentUrl: url, outcome: "pushed", completedAt: now() });
        await this.loadPullRequest(run.wo).catch((error: unknown) => log.debug("Couldn't refresh the pull request", { error: (error as Error).message }));
        this.addActivity(run.wo, station.id, `Pushed revision ${revision.number} to pull request #${existing.number}`, "success");
        this.updateStation(run, station, { status: "done", detail: `Revision ${revision.number} pushed to #${existing.number}`, finishedAt: now() });
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !run.abort.signal.aborted && !this.stopping) await this.failStation(run, station, error);
      throw error;
    }
  }

  /**
   * Turns the sandbox's working tree into a commit on the work order's branch with GitHub's Git Data API: a blob per
   * changed file, a tree on top of the base commit's, and a commit whose parent is the last one the factory pushed. The
   * branch only moves forward: commits the factory didn't make stop the push instead of being overwritten.
   */
  protected async pushRevision(run: Run, station: MStation, build: MStation): Promise<void> {
    const github = this.requireGitHub();
    const work = run.wo.github!;
    const { owner, name } = work.repository;
    let revision = this.revision(run);
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
      const snapshot = await this.snapshot(run, build);
      if (snapshot.files.length === 0) throw new StationError("nothing_to_push", "The working tree no longer has any changes to push.");
      this.updateStation(run, station, { detail: `Uploading ${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"}` });
      const entries = await this.treeEntries(run, build, snapshot);
      const baseTree = await github.commitTree(owner, name, work.baseSha);
      const tree = await github.createTree(owner, name, baseTree, entries);
      const commit = await github.createCommit(owner, name, { message: commitMessage(run.wo, revision, work.issue), tree, parents: [parent] });
      revision = this.updateRevision(run, { commitSha: commit, files: snapshot.files });
    }
    const commit = revision.commitSha!;
    if (remote !== commit) {
      if (remote) await github.updateBranch(owner, name, work.branch, commit);
      else await github.createBranch(owner, name, work.branch, commit);
    }
    this.updateRevision(run, { pushed: true });
    const files = revision.files?.length ?? 0;
    this.addActivity(run.wo, station.id, `Pushed ${files} changed file${files === 1 ? "" : "s"} to ${work.branch} (${commit.slice(0, 7)})`, "success");
  }

  protected async treeEntries(run: Run, build: MStation, snapshot: Snapshot): Promise<TreeEntry[]> {
    const github = this.requireGitHub();
    const { owner, name } = run.wo.github!.repository;
    const sessionId = build.sessionId!;
    const files = this.platform.files(sessionId);
    const changed = snapshot.entries.filter((entry) => entry.mode !== "160000");
    if (changed.length > MAX_PUSH_FILES) throw new StationError("change_too_large", `The change touches ${changed.length} files; the factory pushes at most ${MAX_PUSH_FILES}.`);
    const entries: TreeEntry[] = [];
    let total = 0;
    const queue = [...changed];
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        this.throwIfCancelled(run);
        if (entry.status === "deleted" || !entry.sha) {
          entries.push({ path: entry.path, mode: "100644", sha: null });
          continue;
        }
        let bytes: Uint8Array;
        if (entry.mode === "120000") {
          const result = await this.platform.exec(sessionId, blobScript(entry.sha), { timeoutMs: 60_000, signal: run.abort.signal });
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
  protected async uploadMedia(run: Run, station: MStation, media: readonly MediaItem[]): Promise<Record<string, string>> {
    const github = this.requireGitHub();
    const work = run.wo.github!;
    const urls: Record<string, string> = { ...(work.uploads ?? {}) };
    const pending = media.filter((item) => !urls[mediaKey(item)]);
    if (pending.length > 0) this.updateStation(run, station, { detail: `Attaching ${pending.length} screenshot${pending.length === 1 ? "" : "s"} and recording${pending.length === 1 ? "" : "s"}` });
    for (const item of pending) {
      this.throwIfCancelled(run);
      const stored = this.store.getArtifactBytes(run.wo.id, item.stationId, item.path, item.version);
      if (!stored) {
        this.addActivity(run.wo, station.id, `${item.path} is no longer stored, so it's left out of the pull request`, "warning");
        continue;
      }
      try {
        urls[mediaKey(item)] = await github.uploadAttachment(work.repository.id, item.path.split("/").pop() ?? item.path, item.contentType, stored.bytes);
        this.updateGitHub(run, { uploads: { ...(run.wo.github!.uploads ?? {}), [mediaKey(item)]: urls[mediaKey(item)]! } });
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        this.addActivity(run.wo, station.id, `Couldn't attach ${item.path} to the pull request: ${toFactoryError(error).message}`, "warning");
      }
    }
    return urls;
  }
}
