// One run, start to finish, in one sandbox: Repo Doctor checks out the code and runs the tests itself (`managed.exec`),
// Copilot sets the project up and fixes it (agent turns in the same sandbox), and the sandbox is deleted at the end.
import { randomUUID } from "node:crypto";
import { approveAll } from "@github/copilot-sdk";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import { diffTotals, parseDiff } from "../shared/diff.js";
import { cloneUrl } from "../shared/repo.js";
import type { PatchView, RunStatus, StepId, TestReport } from "../shared/types.js";
import { AgentObserver, fixPrompt, noTestsTool, REPO_DIR, SETUP_PROMPT, SYSTEM_MESSAGE, testCommandTool } from "./agent.js";
import type { DoctorConfig } from "./config.js";
import { errorText } from "./errors.js";
import { describeAllowed, hostsReachedBy, parseRegistries, REGISTRY_PROBE, type Registries } from "./inference.js";
import { log } from "./log.js";
import type { CommandResult, DoctorPlatform, DoctorSession } from "./platform.js";
import { tail, type Run } from "./run.js";
import type { SampleProject } from "./sample.js";
import { parseTestOutput, stripAnsi } from "./testsummary.js";

export interface DriverDeps {
  readonly platform: DoctorPlatform;
  readonly config: DoctorConfig;
  readonly sample: SampleProject;
}

/** A step that couldn't do its job: the run fails with this code and message, and the step shows `summary`. */
class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly summary?: string,
  ) {
    super(message);
  }
}

class Stopped extends Error {}

/** New files under these paths stay out of patches: installed dependencies, caches, and coverage output. */
const EXCLUDES = ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".tox", "coverage", ".nyc_output"]
  .map((dir) => `':(exclude,glob)**/${dir}/**'`)
  .concat("':(exclude,glob)**/*.pyc'", "':(exclude,glob)**/*.egg-info/**'")
  .join(" ");

const PATCH_LIMIT = 512 * 1024;
const TEST_TAIL = 4_000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Records the working tree as a git tree, without touching the repository's index, branches, or history. */
export function snapshotScript(name: string): string {
  return [
    `cd ${REPO_DIR}`,
    `export GIT_INDEX_FILE=/tmp/repo-doctor-${name}.index`,
    'rm -f "$GIT_INDEX_FILE"',
    // Start from HEAD so tracked files count even where .gitignore or the exclusions would skip them; then new files.
    "{ git read-tree HEAD 2>/dev/null || true; }",
    "git add -u",
    `git add -A -- . ${EXCLUDES}`,
    "git write-tree",
  ].join(" && ");
}

/** The trees hold tracked files and new files outside the exclusions, so the diff compares them whole. */
export function diffScript(from: string, to: string, stat = false): string {
  return `cd ${REPO_DIR} && git diff --no-color --no-ext-diff --find-renames${stat ? " --stat" : ""} ${from} ${to}`;
}

export function cloneFailure(output: string, name: string): string {
  if (/Remote branch .* not found|couldn't find remote ref/i.test(output)) return `Couldn't clone ${name}: that branch or tag doesn't exist.`;
  if (/not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(output)) return `Couldn't clone ${name}: it doesn't exist, or it isn't public.`;
  if (/CONNECT tunnel failed|response 403/i.test(output)) return `Couldn't clone ${name}: the sandbox's network rules blocked it.`;
  return `Couldn't clone ${name}.`;
}

export function testsSummary(report: TestReport): string {
  if (report.exitCode === 0) return report.passed !== undefined ? `${report.passed} passing` : "Passing";
  if (report.failed) return `${report.failed} failing`;
  return report.exitCode === undefined ? "Didn't finish" : `Exit code ${report.exitCode}`;
}

function failingCount(report: TestReport): number | undefined {
  return report.exitCode === 0 ? 0 : report.failed;
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return `${value} minute${value === 1 ? "" : "s"}`;
}

const headOf = (output: string) => /^HEAD (\w+)/m.exec(output)?.[1];

/** Emits streamed output in whole lines, a few times a second. */
class OutputBuffer {
  #pending = "";
  #timer: NodeJS.Timeout | undefined;
  readonly #emit: (text: string) => void;

  constructor(emit: (text: string) => void) {
    this.#emit = emit;
  }

  push(chunk: string): void {
    this.#pending += chunk;
    this.#timer ??= setTimeout(() => this.#flush(false), 250);
  }

  #flush(all: boolean): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const cut = all ? this.#pending.length : this.#pending.lastIndexOf("\n") + 1;
    if (cut <= 0) {
      if (this.#pending) this.#timer = setTimeout(() => this.#flush(false), 250);
      return;
    }
    const text = stripAnsi(this.#pending.slice(0, cut)).replace(/\s+$/, "");
    this.#pending = this.#pending.slice(cut);
    if (text) this.#emit(text);
    if (this.#pending) this.#timer = setTimeout(() => this.#flush(false), 250);
  }

  end(): void {
    this.#flush(true);
  }
}

export async function drive(run: Run, deps: DriverDeps): Promise<void> {
  const { platform, config, sample } = deps;
  const { timeouts } = config;
  const signal = run.controller.signal;
  const source = run.view.source;
  let session: DoctorSession | undefined;
  let detach: (() => void) | undefined;
  let registries: Registries = { npm: [], pip: [] };
  let testCommand: string | undefined;
  let noTests: string | undefined;
  let status: RunStatus = "failed";
  const gitRemote = source.kind === "github" ? "github.com" : undefined;

  const observer = new AgentObserver({
    log: (line) => run.current && run.log(run.current, line),
    activity: (text) => run.current && run.step(run.current, { activity: text }),
    succeeded: (command, output) => run.used(hostsReachedBy(command, output, registries, gitRemote), command),
  });

  const checkStopped = () => {
    if (signal.aborted) throw new Stopped();
  };

  /** Runs a command in the sandbox for `step`, streaming its output into the step's log. */
  const command = async (step: StepId, display: string, script: string, timeoutMs: number): Promise<CommandResult> => {
    checkStopped();
    run.log(step, { kind: "command", text: display });
    run.step(step, { activity: display });
    const output = new OutputBuffer((text) => run.log(step, { kind: "output", text }));
    let result: CommandResult;
    try {
      result = await platform.run(session!.sessionId, script, { timeoutMs, signal, onOutput: (chunk) => output.push(chunk) });
    } finally {
      output.end();
    }
    checkStopped();
    if (result.exitCode !== undefined) run.log(step, { kind: "note", text: `Exit code ${result.exitCode}`, exitCode: result.exitCode });
    else run.log(step, { kind: "error", text: result.state === "timed_out" ? `Timed out after ${minutes(timeoutMs)}` : `The command ${result.state.replace(/_/g, " ")}${result.reason ? `: ${result.reason}` : ""}` });
    return result;
  };

  /** One of Copilot's turns in the sandbox. Returns its reply. */
  const turn = async (prompt: string, timeoutMs: number): Promise<string | undefined> => {
    checkStopped();
    const abort = () => void session!.abort().catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const reply = await session!.sendAndWait({ prompt }, timeoutMs);
      checkStopped();
      return reply?.data.content?.trim() || observer.lastMessage;
    } catch (error) {
      checkStopped();
      if (/^Timeout after/.test(errorText(error))) {
        await session!.abort().catch(() => undefined);
        throw new StepFailure("timed_out", `Copilot didn't finish within ${minutes(timeoutMs)}.`);
      }
      throw new StepFailure("agent_failed", `Copilot stopped with an error: ${errorText(error).split("\n")[0]}`);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };

  const tests = async (step: StepId, testCommand: string): Promise<TestReport> => {
    const started = Date.now();
    const result = await command(step, testCommand, `cd ${REPO_DIR} && ${testCommand}`, timeouts.testsMs);
    const { failures, ...counts } = parseTestOutput(result.output);
    return {
      command: testCommand,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...counts,
      failures,
      durationMs: Date.now() - started,
      tail: tail(stripAnsi(result.output).replace(/\s+$/, ""), TEST_TAIL),
    };
  };

  const snapshot = async (name: string): Promise<string> => {
    checkStopped();
    const result = await platform.run(session!.sessionId, snapshotScript(name), { timeoutMs: timeouts.checkoutMs, signal });
    checkStopped();
    const tree = [...result.output.matchAll(/^([0-9a-f]{40}|[0-9a-f]{64})\s*$/gm)].at(-1)?.[1];
    if (result.exitCode !== 0 || !tree) throw new StepFailure("snapshot_failed", "Couldn't read the repository's files to build the patch.");
    return tree;
  };

  try {
    // The sandbox: a new session of the isolated environment, under an ID recorded first, so the session can be deleted
    // even if creating it fails on this side after the platform started it.
    const created = Date.now();
    run.update({ sessionId: randomUUID() });
    session = await platform.createSession({
      sessionId: run.view.sessionId!,
      model: config.model,
      systemMessage: { content: SYSTEM_MESSAGE },
      tools: [
        testCommandTool((reported) => {
          if (testCommand) return `The test command is already recorded: ${testCommand}`;
          testCommand = reported;
          run.update({ testCommand });
          run.log("setup", { kind: "note", text: `Test command: ${reported}` });
          return "Recorded. Repo Doctor runs it next, so this step is done.";
        }),
        noTestsTool((reason) => {
          noTests ??= reason;
          run.log("setup", { kind: "note", text: `No tests: ${reason}` });
          return "Recorded. Repo Doctor ends the run, so you're done.";
        }),
      ],
      onPermissionRequest: approveAll,
    });
    detach = session.on((event) => observer.handle(event));
    checkStopped();
    const sandbox = await platform.sandbox(session.sessionId);
    const probe = await platform.run(session.sessionId, REGISTRY_PROBE, { timeoutMs: 60_000, signal });
    registries = parseRegistries(probe.output);
    run.update({
      sandbox: { state: "ready", environment: config.environment, ...(sandbox?.id ? { id: sandbox.id } : {}), ...(sandbox?.size ? { size: sandbox.size } : {}), readyMs: Date.now() - created },
      network: { access: sandbox?.network.access ?? "unknown", allowed: describeAllowed(sandbox?.network.allowedDomains ?? [], registries), blocked: run.view.network.blocked },
    });

    // Checkout: Repo Doctor clones the repository, or uploads the sample, into /workspace/repo.
    run.start("checkout");
    if (source.kind === "sample") {
      for (const file of sample.files) {
        checkStopped();
        await platform.writeFile(session.sessionId, `repo/${file.path}`, file.content);
      }
      run.log("checkout", { kind: "note", text: `Uploaded ${sample.name} ${sample.version}: ${sample.files.length} files` });
      const committed = await command(
        "checkout",
        "git init && git commit",
        `cd ${REPO_DIR} && git init -q -b main && git add -A && git -c user.name='Repo Doctor' -c user.email='repo-doctor@users.noreply.github.com' commit -q -m ${shellQuote(`${sample.name} ${sample.version}`)} && git log -1 --format='HEAD %h %s'`,
        timeouts.checkoutMs,
      );
      if (committed.exitCode !== 0) throw new StepFailure("checkout_failed", "Couldn't set up the sample project in the sandbox.");
      run.finish("checkout", "passed", headOf(committed.output) ?? sample.name);
    } else {
      const url = cloneUrl(source);
      const branch = source.ref ? ` --branch ${shellQuote(source.ref)}` : "";
      const display = `git clone --depth 1${source.ref ? ` --branch ${source.ref}` : ""} ${url} repo`;
      const cloned = await command("checkout", display, `GIT_TERMINAL_PROMPT=0 git clone --depth 1${branch} ${shellQuote(url)} repo && git -C repo log -1 --format='HEAD %h %s'`, timeouts.checkoutMs);
      if (cloned.exitCode !== 0) throw new StepFailure("clone_failed", cloneFailure(cloned.output, `${source.owner}/${source.repo}`));
      run.used(["github.com"], display);
      run.finish("checkout", "passed", headOf(cloned.output));
    }

    // Set up: Copilot installs what the tests need and reports how to run them.
    run.start("setup");
    await turn(SETUP_PROMPT, timeouts.setupMs);
    if (!testCommand && noTests) throw new StepFailure("no_tests", `Copilot found no tests to run in ${run.view.title}.`, "No tests");
    if (!testCommand) throw new StepFailure("no_test_command", "Copilot didn't find a way to run the tests.");
    run.finish("setup", "passed", testCommand);

    // Reproduce: Repo Doctor runs the tests itself.
    run.start("reproduce");
    const before = await tests("reproduce", testCommand);
    const failingBefore = failingCount(before);
    run.update({ before, ...(failingBefore !== undefined ? { failingBefore } : {}) });
    if (before.exitCode === undefined) throw new StepFailure("tests_unfinished", `The tests didn't finish within ${minutes(timeouts.testsMs)}.`);
    if (before.exitCode === 0) {
      run.finish("reproduce", "passed", testsSummary(before));
      for (const id of ["fix", "patch", "verify"] as const) run.step(id, { status: "skipped" });
      status = "healthy";
      return;
    }
    run.finish("reproduce", "failed", testsSummary(before));
    const baseline = await snapshot("before");

    // Fix: Copilot changes the code until the tests pass.
    run.start("fix");
    const reply = await turn(fixPrompt(before), timeouts.fixMs);
    if (reply) run.update({ diagnosis: tail(reply, 1_200) });
    run.finish("fix", "passed");

    // Patch: Repo Doctor diffs the working tree before and after the fix.
    run.start("patch");
    const fixed = await snapshot("after");
    await command("patch", "git diff --stat", diffScript(baseline, fixed, true), timeouts.checkoutMs);
    const diff = await platform.run(session.sessionId, diffScript(baseline, fixed), { timeoutMs: timeouts.checkoutMs, signal });
    checkStopped();
    if (diff.exitCode !== 0) throw new StepFailure("patch_failed", "Couldn't build the patch.");
    const text = diff.output.length > PATCH_LIMIT ? diff.output.slice(0, PATCH_LIMIT) : diff.output;
    const files = parseDiff(text);
    const totals = diffTotals(files);
    const patch: PatchView = { text, files: files.map(({ path, additions, deletions }) => ({ path, additions, deletions })), ...totals };
    run.update({ patch, ...totals });
    run.finish("patch", files.length ? "passed" : "failed", files.length ? `+${totals.additions} −${totals.deletions}` : "No changes");

    // Verify: Repo Doctor runs the same tests again.
    run.start("verify");
    const after = await tests("verify", testCommand);
    const failingAfter = failingCount(after);
    run.update({ after, ...(failingAfter !== undefined ? { failingAfter } : {}) });
    const passed = after.exitCode === 0;
    run.finish("verify", passed ? "passed" : "failed", testsSummary(after));
    status = passed && files.length > 0 ? "fixed" : "not_fixed";
    if (!files.length) run.update({ error: { code: "no_changes", message: "Copilot didn't change any files." } });
    else if (!passed) run.update({ error: { code: "still_failing", message: "The tests still fail after Copilot's changes." } });
  } catch (error) {
    const stopped = error instanceof Stopped || signal.aborted;
    status = stopped ? "stopped" : "failed";
    if (!stopped) {
      const code = error instanceof StepFailure ? error.code : ((error as { code?: unknown })?.code as string | undefined) ?? "run_failed";
      const message = error instanceof StepFailure ? error.message : errorText(error);
      if (!(error instanceof StepFailure)) log.warn("A run failed", { run: run.id, error: message });
      run.update({ error: { code, message } });
    }
    const now = new Date().toISOString();
    const summary = stopped ? "Stopped" : error instanceof StepFailure ? error.summary : undefined;
    for (const step of run.view.steps) {
      if (step.status === "running") run.step(step.id, { status: "failed", finishedAt: now, activity: undefined, summary: summary ?? step.summary ?? "Failed" });
      else if (step.status === "pending") run.step(step.id, { status: "skipped" });
    }
  } finally {
    run.current = undefined;
    run.update({ status, finishedAt: new Date().toISOString() });
    detach?.();
    await cleanUp(run, deps, session);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes the run's session, and with it its sandbox, once the last network reports arrived. While the platform is
 * unreachable the sandbox stays `deleting`, and the run manager deletes it when the platform is back.
 */
async function cleanUp(run: Run, { platform, config }: DriverDeps, session: DoctorSession | undefined): Promise<void> {
  const sessionId = run.view.sessionId;
  if (!sessionId) return;
  await session?.disconnect().catch(() => undefined);
  run.update({ sandbox: { ...run.view.sandbox, state: "deleting" } });
  if (session && !run.stopping) await sleep(config.timeouts.graceMs);
  let failure: unknown;
  for (const wait of [0, ...config.timeouts.deleteRetriesMs]) {
    await sleep(wait);
    try {
      await platform.deleteSession(sessionId);
      run.update({ sandbox: { ...run.view.sandbox, state: "deleted" } });
      return;
    } catch (error) {
      // Not found: the platform never created it (or it's gone already).
      if (isManagedCopilotError(error, "not_found")) {
        run.update({ sandbox: { ...run.view.sandbox, state: session ? "deleted" : "failed" } });
        return;
      }
      failure = error;
      if (platform.status.state !== "connected") break;
    }
  }
  log.warn("Couldn't delete a run's sandbox; Repo Doctor tries again when it reconnects", { run: run.id, error: errorText(failure) });
}
