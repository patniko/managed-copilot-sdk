/**
 * The scripted happy path: runs the bundled sample through a running Repo Doctor, follows it to the end, checks the
 * fix, and deletes the run again. One run is two Copilot turns in one sandbox.
 *
 *   pnpm --filter @managed-copilot/demo-repo-doctor happy-path                       # http://localhost:7435, shifted by MANAGED_COPILOT_PORT_OFFSET
 *   pnpm --filter @managed-copilot/demo-repo-doctor happy-path --url http://localhost:9135
 *   pnpm --filter @managed-copilot/demo-repo-doctor happy-path --repo github.com/owner/repo   # a public repository instead
 *   pnpm --filter @managed-copilot/demo-repo-doctor happy-path --keep                 # keep the run in Repo Doctor's history
 *
 * Exits 0 when the run ends Fixed: the tests failed before, pass after, and the patch isn't empty. Exits 1 otherwise.
 */
import { parseArgs } from "node:util";
import { STEP_LABELS, type ApiErrorBody, type AppState, type RunDetail, type RunView } from "../shared/types.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    repo: { type: "string" },
    keep: { type: "boolean", default: false },
    "timeout-minutes": { type: "string", default: "20" },
  },
});
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${7435 + (Number.isInteger(offset) ? offset : 0)}`).replace(/\/+$/, "");
const timeoutMs = Number(values["timeout-minutes"]) * 60_000;
const started = Date.now();

function log(message: string): void {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${message}`);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", ...init.headers } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a finished run's sandbox gets to be deleted: Repo Doctor tries a failed delete again for about 30 s. */
const DELETE_WAIT_MS = 60_000;

/** Polls the run, printing each step as it changes, until it ends and its sandbox is deleted (or can't be). */
async function follow(id: string, interrupted: () => boolean): Promise<RunView> {
  const seen = new Map<string, string>();
  let blocked = 0;
  let ended: number | undefined;
  for (;;) {
    const { run } = await api<RunDetail>(`/api/runs/${id}`);
    for (const step of run.steps) {
      const key = `${step.status}|${step.summary ?? ""}`;
      if (seen.get(step.id) === key || step.status === "pending") continue;
      seen.set(step.id, key);
      log(`  ${STEP_LABELS[step.id].padEnd(10)} ${step.status}${step.summary ? ` · ${step.summary}` : ""}`);
    }
    for (const entry of run.network.blocked.slice(blocked)) log(`  network    blocked ${entry.host}${entry.runtime ? " (the Copilot runtime's own call)" : ""}`);
    blocked = run.network.blocked.length;
    if (run.status !== "running") {
      ended ??= Date.now();
      if (run.sandbox.state === "deleted" || run.sandbox.state === "failed" || Date.now() - ended > DELETE_WAIT_MS) return run;
    }
    if (Date.now() - started > timeoutMs && !interrupted()) throw new Error(`The run didn't finish within ${values["timeout-minutes"]} minutes.`);
    await sleep(2_000);
  }
}

/** The app's state once it's connected to Managed Copilot: right after a start it may still be starting or connecting. */
async function connectedState(): Promise<AppState> {
  for (;;) {
    const waited = Date.now() - started > 60_000;
    const state = await api<AppState>("/api/state").catch((error: Error) => {
      if (waited) throw new Error(`Can't reach Repo Doctor at ${base} (${error.message}). Start it with \`aspire run\`, or pass --url.`);
      return undefined;
    });
    if (state?.platform.state === "connected") return state;
    if (state && waited) throw new Error(`Repo Doctor isn't connected to Managed Copilot: ${state.platform.message ?? state.platform.state}`);
    await sleep(2_000);
  }
}

async function main(): Promise<number> {
  const state = await connectedState();
  log(`Repo Doctor at ${base} · ${state.platform.deployment} (${state.platform.mode}) · signed in as ${state.platform.account?.login}`);

  const created = await api<RunView>("/api/runs", { method: "POST", body: JSON.stringify(values.repo ? { repo: values.repo } : { sample: true }) });
  log(`Started run #${created.number}: ${created.title}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("Stopping the run…");
    void api(`/api/runs/${created.id}/stop`, { method: "POST" }).catch(() => undefined);
  };
  process.once("SIGINT", stop);
  let run: RunView;
  try {
    run = await follow(created.id, () => stopping);
  } catch (error) {
    stop();
    await follow(created.id, () => true).catch(() => undefined);
    throw error;
  } finally {
    process.off("SIGINT", stop);
  }

  const seconds = Math.round((Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.createdAt)) / 1000);
  const used = run.network.allowed.filter((entry) => entry.used).map((entry) => entry.host);
  const problems: string[] = [];
  if (run.status !== "fixed") problems.push(`the run ended ${run.status}${run.error ? `: ${run.error.message}` : ""}`);
  if (!run.before?.failed) problems.push("the tests didn't fail before the fix");
  if (run.after?.exitCode !== 0) problems.push("the tests don't pass after the fix");
  if (!run.patch?.files.length) problems.push("the patch is empty");
  if (run.sandbox.state !== "deleted") problems.push(`the sandbox wasn't deleted (${run.sandbox.state})`);

  log(`${problems.length ? "✖" : "✔"} Run #${run.number} ${run.status} in ${seconds}s`);
  log(`  tests      ${run.before ? `${run.before.failed ?? "?"} failing` : "not run"} → ${run.after ? (run.after.exitCode === 0 ? `${run.after.passed ?? "all"} passing` : `${run.after.failed ?? "?"} failing`) : "not run"} (${run.testCommand ?? "no test command"})`);
  log(`  patch      ${run.patch ? `${run.patch.files.map((file) => file.path).join(", ")} +${run.patch.additions} −${run.patch.deletions}` : "none"}`);
  log(`  network    used ${used.join(", ") || "none"} · blocked ${run.network.blocked.map((entry) => entry.host).join(", ") || "none"}`);
  if (run.diagnosis) log(`  copilot    ${run.diagnosis.replace(/\s+/g, " ")}`);

  if (values.keep) log(`  kept       ${base}/#/runs/${run.id}`);
  else {
    await api(`/api/runs/${run.id}`, { method: "DELETE" });
    log("  deleted the run");
  }
  if (problems.length) {
    console.error(`✖ Happy path failed: ${problems.join("; ")}.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`✖ Happy path failed: ${(error as Error).message}`);
    process.exit(1);
  },
);
