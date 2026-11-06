/**
 * The scripted happy path: one real race through Pattern Race's HTTP API, followed live over its event stream, then
 * checked. The default job, "Quick answer", costs one premium request per lane.
 *
 *   pnpm happy-path                                      # http://localhost:7420, shifted by MANAGED_COPILOT_PORT_OFFSET
 *   pnpm happy-path --url http://localhost:8820 --job code
 *
 * Exits 0 when all six lanes raced and answered, every lane's session (and its sandboxes) was deleted, and the race had
 * a winner (for the quick answer, every lane must be right); 1 otherwise. Ctrl+C or a timeout stops the race, which
 * deletes its sessions.
 */
import { parseArgs } from "node:util";
import { isJobId, jobById, type JobId } from "../shared/jobs.js";
import { laneById } from "../shared/lanes.js";
import { agentCount, elapsedMs, formatClock, formatCount, ordinal, plural, premiumRequests, sandboxCount } from "../shared/score.js";
import type { ApiErrorBody, AppState, LaneRun, RaceSnapshot } from "../shared/types.js";

const timeoutMs = Number(process.env.HAPPY_PATH_TIMEOUT_MINUTES ?? 15) * 60_000;
const started = Date.now();
let base = "";

function options(): JobId {
  const { values } = parseArgs({ options: { url: { type: "string" }, job: { type: "string", default: "answer" } } });
  base = (values.url ?? `http://localhost:${7420 + Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0)}`).replace(/\/+$/, "");
  if (!isJobId(values.job)) throw new Error("Use --job answer, --job code, or --job split.");
  return values.job;
}

function log(message: string): void {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${message}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return response.status === 204 ? undefined : ((await response.json()) as T);
}

/** Opens the event stream, starts the race, and follows it until it ends. */
async function race(job: JobId): Promise<RaceSnapshot> {
  const controller = new AbortController();
  let interrupted = false;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const interrupt = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  const seen = new Map<string, string>();
  let id: string | undefined;
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Pattern Race's event stream answered ${response.status}.`);
    id = (await api<RaceSnapshot>("/api/race", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job }) }))!.id;
    log(`Started race ${id}: ${jobById(job).title}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Pattern Race's event stream closed.");
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
        const current = (JSON.parse(data) as AppState).race;
        if (!current || current.id !== id) continue;
        for (const lane of current.lanes) {
          const line = `${lane.status}${lane.activity ? ` · ${lane.activity}` : ""}`;
          if (seen.get(lane.lane) === line) continue;
          seen.set(lane.lane, line);
          log(`  ${laneById(lane.lane).pattern.padEnd(10)} ${line}`);
        }
        if (current.state !== "running") {
          await reader.cancel();
          return current;
        }
      }
    }
  } catch (error) {
    if (id && controller.signal.aborted) {
      await api("/api/race/stop", { method: "POST" }).catch(() => undefined);
      throw new Error(interrupted ? "Interrupted; the race was stopped and its sessions deleted." : `The race didn't finish within ${timeoutMs / 60_000} minutes, so it was stopped.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
  }
}

function row(snapshot: RaceSnapshot, lane: LaneRun): string {
  const pattern = laneById(lane.lane);
  const place = lane.place ? ordinal(lane.place) : "–";
  const time = formatClock(elapsedMs(snapshot, lane, lane.finishedAt ?? Date.now()));
  const counts = [plural(sandboxCount(lane), "sandbox", "sandboxes"), plural(agentCount(lane), "agent", "agents"), plural(premiumRequests(lane), "premium request", "premium requests")].join(" · ");
  return `  ${place.padEnd(4)} ${pattern.pattern.padEnd(10)} ${`"${pattern.environment}"`.padEnd(10)} ${time.padStart(7)}  ${(lane.verdict ?? lane.status).padEnd(8)} ${counts}`;
}

async function main(): Promise<void> {
  const job = options();
  const state = await api<AppState>("/api/state").catch((error: Error) => {
    throw new Error(`Can't reach Pattern Race at ${base} (${error.message}). Start it with \`aspire run\`, or pass --url.`);
  });
  if (state!.platform.state !== "connected") throw new Error(`Pattern Race isn't connected to Managed Copilot: ${state!.platform.message ?? state!.platform.state}`);
  const missing = state!.lanes.filter((lane) => !lane.available);
  if (missing.length) throw new Error(`Not every lane can race here: ${missing.map((lane) => `${laneById(lane.lane).pattern} (${lane.reason})`).join("; ")}`);
  if (state!.race?.state === "running") throw new Error("A race is already running. Wait for it to finish, or stop it in the page.");
  log(`Pattern Race at ${base} · ${state!.platform.deployment} (${state!.platform.mode}) · ${state!.model.name} · @${state!.platform.account?.login}`);

  const snapshot = await race(job);
  const ranked = [...snapshot.lanes].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  log(`Race ${snapshot.state} in ${formatClock((snapshot.finishedAt ?? Date.now()) - snapshot.startedAt)}:`);
  for (const lane of ranked) console.log(row(snapshot, lane));
  log(`Premium requests in all: ${formatCount(snapshot.lanes.reduce((sum, lane) => sum + premiumRequests(lane), 0))}`);

  const problems: string[] = [];
  if (snapshot.state !== "finished") problems.push(`the race ended ${snapshot.state}`);
  for (const lane of snapshot.lanes) {
    const name = laneById(lane.lane).pattern;
    if (lane.status !== "done") problems.push(`${name} ${lane.status}${lane.error ? `: ${lane.error}` : ""}`);
    if (lane.sandboxes.some((token) => token.state !== "stopped")) problems.push(`${name} kept a sandbox (its session wasn't deleted)`);
  }
  if (!snapshot.lanes.some((lane) => lane.place === 1)) problems.push("no lane answered correctly");
  if (job === "answer") for (const lane of snapshot.lanes.filter((candidate) => candidate.verdict !== "correct")) problems.push(`${laneById(lane.lane).pattern} answered ${lane.verdict ?? "nothing"}`);
  if (problems.length) throw new Error(problems.join("; "));
  log("✔ Happy path passed: every lane raced, answered, and cleaned up.");
}

main().catch((error: unknown) => {
  console.error(`✖ Happy path failed: ${(error as Error).message}`);
  process.exit(1);
});
