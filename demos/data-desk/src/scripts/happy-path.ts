/**
 * The scripted happy path: one real pass through a running Data Desk's API, the move into a sandbox included.
 *
 *   pnpm happy-path                                   # http://localhost:7430, shifted by MANAGED_COPILOT_PORT_OFFSET
 *   pnpm happy-path --url https://data-desk.<environment-domain>
 *   pnpm happy-path --keep                             # leave the analysis (and its sandbox) for a look in the UI
 *   pnpm happy-path --dataset live-downhill-sales      # Downhill's shop sales, fetched now (Data Desk needs DOWNHILL_URL)
 *
 * It starts an analysis of the coffee sales sample, asks a question Data Desk's tools answer on the shared runtime,
 * then asks for a chart: the agent requests a sandbox, the script approves, and the same session moves and draws it.
 * Two messages, so about two premium requests. The analysis is deleted at the end (its sandbox with it) unless --keep.
 * Exits 0 when every check passes; 1 otherwise.
 */
import { parseArgs } from "node:util";
import type { AnalysisView, ApiErrorBody, ChatItem, DeskState } from "../shared/types.js";

const { values } = parseArgs({ options: { url: { type: "string" }, keep: { type: "boolean", default: false }, dataset: { type: "string", default: "sample-coffee-sales" } } });
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${7430 + (Number.isInteger(offset) ? offset : 0)}`).replace(/\/+$/, "");
const started = Date.now();

function log(message: string): void {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${message}`);
}

class HappyPathError extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new HappyPathError(`Can't reach Data Desk at ${base}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new HappyPathError(failure?.error.message ?? `${method} ${path} answered ${response.status}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Polls the analysis until `done` says so, reporting each settled step and reply once. */
async function until(id: string, what: string, done: (view: AnalysisView) => boolean, timeoutMs: number, seen: Set<string>): Promise<AnalysisView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await api<AnalysisView>("GET", `/api/analyses/${encodeURIComponent(id)}`);
    for (const item of view.items) report(item, seen);
    if (done(view)) return view;
    if (Date.now() > deadline) throw new HappyPathError(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function report(item: ChatItem, seen: Set<string>): void {
  if ((item.kind === "assistant" && item.streaming) || (item.kind === "step" && (item.status === "running" || item.status === "asking"))) return;
  const key = `${item.id}:${item.kind === "step" ? item.status : ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (item.kind === "step") log(`  ${item.status === "done" ? "✓" : "✗"} ${item.label}${item.outcome ? ` · ${item.outcome}` : ""}`);
  else if (item.kind === "assistant") log(`  Copilot: ${item.text.split("\n")[0]!.slice(0, 120)}`);
  else if (item.kind === "moved") log(`  ⇢ Moved into a sandbox${item.durationMs !== undefined ? ` in ${(item.durationMs / 1000).toFixed(1)} s` : ""}`);
  else if (item.kind === "error") log(`  ✗ ${item.text}`);
}

/** The turn ended with a reply after the person's last message. */
const answered = (view: AnalysisView) => !view.busy && view.items.at(-1)?.kind !== "user" && view.items.some((item) => item.kind === "assistant" && !item.streaming);

async function run(): Promise<string[]> {
  const health = await api<{ status: string; platform: string }>("GET", "/api/health");
  if (health.platform !== "connected") throw new HappyPathError(`Data Desk isn't connected to Managed Copilot yet (${health.platform}).`);
  const state = await api<DeskState>("GET", "/api/state");
  // A remote sample is fetched fresh when the analysis starts, and its prompts come with that copy.
  const listed = state.datasets.find((candidate) => candidate.id === values.dataset);
  const picked = listed ?? state.remoteSamples?.find((candidate) => candidate.id === values.dataset);
  if (!picked) throw new HappyPathError(`No dataset "${values.dataset}" (have: ${[...(state.remoteSamples ?? []), ...state.datasets].map((candidate) => candidate.id).join(", ")}).`);
  if (listed && listed.prompts.length < 2) throw new HappyPathError(`The dataset "${listed.id}" has no starting prompts.`);
  log(`Data Desk at ${base} · ${listed ? `${listed.name} (${listed.rows} rows)` : `${picked.name} (fetched now)`}`);

  const created = await api<AnalysisView>("POST", "/api/analyses", { datasetId: picked.id });
  const id = created.id;
  const seen = new Set<string>();
  log(`Started session ${id} on the ${created.placement === "shared" ? "shared runtime" : created.placement}`);
  try {
    const [question, chart] = created.dataset?.prompts ?? [];
    if (!question || !chart) throw new HappyPathError(`The dataset "${picked.id}" has no starting prompts.`);
    if (created.placement !== "shared") throw new HappyPathError(`A new analysis should start on the shared runtime, not ${created.placement}.`);
    log(`You: ${question.text}`);
    await api("POST", `/api/analyses/${id}/messages`, { prompt: question.text });
    const first = await until(id, "the first answer", answered, 3 * 60_000, seen);
    if (first.placement !== "shared") throw new HappyPathError("The first question moved the session; Data Desk's tools should have answered it on the shared runtime.");
    if (first.results.length === 0) throw new HappyPathError("The first answer didn't use Data Desk's tools.");

    log(`You: ${chart.text}`);
    await api("POST", `/api/analyses/${id}/messages`, { prompt: chart.text });
    const asking = await until(id, "a request to move into a sandbox", (view) => view.moveRequest !== undefined || (answered(view) && view.items.filter((item) => item.kind === "user").length >= 2), 3 * 60_000, seen);
    if (!asking.moveRequest) throw new HappyPathError("The agent answered without asking to move into a sandbox.");
    log(`  ? Move into a sandbox: "${asking.moveRequest.reason}" · approving`);
    await api("POST", `/api/analyses/${id}/move`, { approve: true });
    await until(id, "the move and the chart", (view) => view.placement === "sandbox" && answered(view), 10 * 60_000, seen);
    const published = await until(id, "the chart to be published", (view) => view.outputs.some((output) => output.kind === "chart"), 90_000, seen);
    if (published.id !== id) throw new HappyPathError("The session ID changed across the move.");
    const file = published.outputs.find((output) => output.kind === "chart")!;
    const response = await fetch(`${base}/api/analyses/${id}/output?path=${encodeURIComponent(file.path)}&v=${file.version}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) throw new HappyPathError(`The chart ${file.path} couldn't be read back.`);
    const usage = published.usage;
    return [
      `Shared runtime: answered with Data Desk's tools (${first.results.length} table${first.results.length === 1 ? "" : "s"})`,
      `Moved into ${published.sandboxId ?? "its sandbox"}${published.moveMs !== undefined ? ` in ${(published.moveMs / 1000).toFixed(1)} s` : ""}: same session ${id}`,
      `Chart: ${file.path} (${(file.size / 1024).toFixed(1)} KB)`,
      `Premium requests: ${usage?.premiumRequests ?? "unknown"}${usage?.beforeMove !== undefined ? ` (${usage.beforeMove} counted before the move)` : ""}`,
    ];
  } finally {
    if (values.keep) log(`Kept the analysis: ${base}/#/a/${encodeURIComponent(id)}`);
    else {
      try {
        await api("DELETE", `/api/analyses/${encodeURIComponent(id)}`);
        log("Deleted the analysis and its sandbox");
      } catch (error) {
        log(`✗ Couldn't delete the analysis ${id}: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }
  }
}

try {
  const summary = await run();
  console.log("");
  for (const line of summary) console.log(`✓ ${line}`);
  console.log(`\nHappy path passed in ${Math.round((Date.now() - started) / 1000)} s.`);
} catch (error) {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
}
