/**
 * The scripted happy path: asks a running Research Swarm one small question, follows the run live over its event
 * stream, checks that the report cites only pages its researchers read and that its sandboxes were deleted, and then
 * deletes the run.
 *
 *   pnpm --filter @managed-copilot/demo-research-swarm happy-path            # http://localhost:7425 (+ MANAGED_COPILOT_PORT_OFFSET)
 *   pnpm --filter @managed-copilot/demo-research-swarm happy-path --url https://research-swarm.<environment-domain>
 *   pnpm --filter @managed-copilot/demo-research-swarm happy-path --keep     # keep the report in the app
 *
 * It asks for two researchers, so a pass costs a handful of premium requests and two small sandboxes for a few
 * minutes. Exits 0 when the cited report is ready and its sandboxes are gone; 1 otherwise (the run is stopped and
 * deleted).
 */
import { parseArgs } from "node:util";
import { DEFAULT_PORT, type ApiErrorBody, type AppState, type Researcher, type Run, type ServerEvent } from "../shared/types.js";

const QUESTION = "What is WebAssembly, and which browsers support it?";
/** After the report, how long the app gets to delete the run's sandboxes. */
const CLEANUP_MS = 90_000;

const { values } = parseArgs({ options: { url: { type: "string" }, question: { type: "string" }, keep: { type: "boolean", default: false }, "timeout-minutes": { type: "string", default: "15" } } });
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${DEFAULT_PORT + (Number.isInteger(offset) ? offset : 0)}`).replace(/\/+$/, "");
const question = values.question ?? QUESTION;
const timeoutMs = Number(values["timeout-minutes"]) * 60_000;
const started = Date.now();

function elapsed(ms = Date.now() - started): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function log(message: string): void {
  console.log(`[${elapsed()}] ${message}`);
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), headers: { "content-type": "application/json", ...init.headers } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(response.status, body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const finished = (run: Run) => run.status === "done" || run.status === "failed" || run.status === "stopped";
/** A done run is settled once its sandboxes are gone; the app deletes them when the lead's turn ends. */
const settled = (run: Run, doneAt: number | undefined) => finished(run) && (run.status !== "done" || run.cleanedUp === true || (doneAt !== undefined && Date.now() - doneAt > CLEANUP_MS));

function describe(researcher: Researcher): string {
  const pages = researcher.pages.length;
  const question = researcher.question.length > 80 ? `${researcher.question.slice(0, 79)}…` : researcher.question;
  return `${researcher.id} ${researcher.state}${pages ? ` · ${pages} ${pages === 1 ? "page" : "pages"}` : ""} · ${question}`;
}

/** Prints what changed since the last view of the run. */
function reporter(): (run: Run) => void {
  const seen = new Map<string, string>();
  const once = (key: string, value: string, line: string) => {
    if (seen.get(key) === value) return;
    seen.set(key, value);
    log(line);
  };
  return (run) => {
    once("lead", `${run.status}|${run.activity ?? ""}`, `lead: ${run.status}${run.activity ? ` · ${run.activity}` : ""}`);
    for (const researcher of run.researchers) {
      once(researcher.id, `${researcher.state}|${researcher.pages.length}`, `  ${describe(researcher)}`);
      for (const blocked of researcher.blocked) once(`${researcher.id}|${blocked.host}`, "blocked", `  ${researcher.id} blocked: ${blocked.host} (${blocked.reason})`);
    }
    if (run.cleanedUp) once("cleanup", "done", "lead, researchers, and sandboxes deleted");
  };
}

/**
 * Opens the event stream, then starts the run, so no update can be missed, and follows it until it settles. A dropped
 * stream reconnects and reloads the same run; it never starts a second one.
 */
async function follow(start: () => Promise<Run>, signal: AbortSignal): Promise<Run> {
  const report = reporter();
  let id: string | undefined;
  let doneAt: number | undefined;
  const seen = (run: Run): boolean => {
    report(run);
    if (run.status === "done") doneAt ??= Date.now();
    return settled(run, doneAt);
  };
  for (;;) {
    const connection = new AbortController();
    const both = AbortSignal.any([signal, connection.signal]);
    try {
      const response = await fetch(`${base}/api/events`, { signal: both });
      if (!response.ok || !response.body) throw new ApiError(response.status, "Research Swarm's event stream is unavailable.");
      id ??= (await start()).id;
      const current = await api<Run>(`/api/runs/${id}`, { signal: AbortSignal.any([both, AbortSignal.timeout(30_000)]) });
      if (seen(current)) return current;
      // A done run whose cleanup this stream might not report: look again once the cleanup has had its time.
      const recheck = setInterval(() => {
        if (doneAt !== undefined && Date.now() - doneAt > CLEANUP_MS) connection.abort();
      }, 1_000);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as ServerEvent;
            if (event.type === "run" && event.run.id === id && seen(event.run)) return event.run;
            if (event.type === "removed" && event.id === id) throw new Error("The run was deleted while it ran.");
          }
        }
      } finally {
        clearInterval(recheck);
        reader.releaseLock();
      }
      throw new Error("Research Swarm's event stream closed.");
    } catch (error) {
      if (signal.aborted) throw error;
      if (!id || (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) || (error as Error).message.includes("was deleted")) throw error;
      if (!connection.signal.aborted) log(`Connection interrupted (${(error as Error).message}); following run ${id} again, not starting a new one.`);
      await new Promise((resolve) => setTimeout(resolve, connection.signal.aborted ? 0 : 2_000));
    } finally {
      connection.abort();
    }
  }
}

/** What's wrong with a settled run; empty when it passed. */
function problems(run: Run): string[] {
  if (run.status !== "done" || !run.report) return [`The run ${run.status}${run.error ? `: ${run.error}` : "."}`];
  const found: string[] = [];
  const report = run.report;
  const read = new Set(run.researchers.flatMap((researcher) => researcher.pages.map((page) => page.url)));
  if (report.sources.length === 0) found.push("The report cites no sources.");
  for (const source of report.sources) if (!read.has(source.url)) found.push(`Source ${source.n} is a page no researcher read: ${source.url}`);
  const cited = [...`${report.summary}\n${report.body}`.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (cited.length === 0 || cited.some((n) => n < 1 || n > report.sources.length)) found.push("The report's citations don't match its sources.");
  if (run.researchers.filter((researcher) => researcher.workerId).length < 2) found.push("Fewer than two researchers ran.");
  if (!run.cleanedUp) found.push("The run's sandboxes weren't deleted.");
  return found;
}

async function main(): Promise<void> {
  const state = await api<AppState>("/api/state").catch((error: Error) => {
    throw new Error(`Can't reach Research Swarm at ${base} (${error.message}). Start it with \`aspire run\`, or pass --url.`);
  });
  if (state.platform.state !== "connected" || !state.swarm) throw new Error(`Research Swarm can't research yet: ${state.platform.message ?? state.platform.state}`);
  log(`Research Swarm at ${base} · ${state.platform.deployment ?? "Managed Copilot"} (${state.platform.mode ?? "?"}) · signed in as ${state.platform.account?.login ?? "?"}`);
  log(`  lead: ${state.swarm.lead.environment} · ${state.swarm.lead.model}; researchers: ${state.swarm.researchers.environment} · ${state.swarm.researchers.model}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let interrupted = false;
  let id: string | undefined;
  const interrupt = () => {
    interrupted = true;
    log("Interrupted; stopping the run.");
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  try {
    const run = await follow(async () => {
      const created = await api<Run>("/api/runs", { method: "POST", body: JSON.stringify({ question, researchers: 2 }) });
      id = created.id;
      log(`Asked "${created.question}" (run ${created.id}, two researchers)`);
      return created;
    }, controller.signal).catch((error: Error) => {
      throw controller.signal.aborted ? new Error(interrupted ? "Interrupted." : `The run didn't settle within ${values["timeout-minutes"]} minutes.`) : error;
    });
    const found = problems(run);
    if (found.length > 0) throw new Error(found.join(" "));
    const markdown = await fetch(`${base}/api/runs/${run.id}/report.md`, { signal: AbortSignal.timeout(30_000) }).then((response) => (response.ok ? response.text() : ""));
    if (!markdown.includes("## Sources")) throw new Error("The report didn't export as Markdown.");
    const report = run.report!;
    const read = new Set(run.researchers.flatMap((researcher) => researcher.pages.map((page) => page.url))).size;
    const blocked = [...new Set(run.researchers.flatMap((researcher) => researcher.blocked.map((entry) => entry.host)))];
    log(`✔ "${report.title}" in ${elapsed(Date.parse(run.finishedAt ?? run.updatedAt) - Date.parse(run.createdAt))}`);
    log(`  ${report.summary}`);
    for (const researcher of run.researchers) log(`  ${describe(researcher)}${researcher.sandboxId ? ` · sandbox ${researcher.sandboxId}` : ""}`);
    log(`  sources: ${report.sources.length} cited of ${read} read · blocked: ${blocked.length ? blocked.join(", ") : "none"} · Markdown ${markdown.length.toLocaleString("en-US")} characters`);
    if (values.keep) id = undefined;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    if (id) {
      // Deleting a run that's still going stops it first; its lead, researchers, and sandboxes go with it.
      await api(`/api/runs/${id}`, { method: "DELETE", signal: AbortSignal.timeout(60_000) }).then(
        () => log(`Deleted run ${id}.`),
        (error: Error) => console.error(`✖ Couldn't delete run ${id}: ${error.message}`),
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(`✖ Happy path failed: ${(error as Error).message}`);
  process.exit(1);
});
