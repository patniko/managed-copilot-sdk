/**
 * The scripted happy path: one real incident, end to end, through Incident Commander's HTTP API.
 *
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path                  # http://localhost:7445 + MANAGED_COPILOT_PORT_OFFSET
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --url http://localhost:9345
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --keep           # keep the incident and its sandbox
 *
 * Simulates an incident, waits until Copilot's deploy request waits on the platform (the app let go of the session),
 * approves it, and waits for Resolved and the postmortem. Then deletes the incident, its session, and its sandboxes.
 * Exits 0 when the incident resolved; 1 otherwise.
 */
import { parseArgs } from "node:util";
import type { ApiErrorBody, AppState, CreatedIncident, IncidentView } from "../shared/types.js";

const { values } = parseArgs({ options: { url: { type: "string" }, keep: { type: "boolean", default: false } } });
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${7445 + offset}`).replace(/\/+$/, "");
const started = Date.now();

function elapsed(): string {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const say = (message: string): void => console.log(`[${elapsed()}] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (from: string, to: string | undefined) => (to ? `${Math.round((Date.parse(to) - Date.parse(from)) / 1000)} s` : "n/a");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (response.status === 204 || response.status === 202 ? undefined : await response.json()) as T;
}

/** Polls the incident, printing its new timeline entries, until `done` says so. */
async function follow(id: string, what: string, timeoutMs: number, done: (incident: IncidentView) => boolean, printed: { count: number }): Promise<IncidentView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const incident = await api<IncidentView>(`/api/incidents/${id}`);
    for (const entry of incident.timeline.slice(printed.count)) say(`  ${entry.text}`);
    printed.count = incident.timeline.length;
    if (done(incident)) return incident;
    if (incident.coordinator.state === "failed") throw new Error(`Copilot's session failed while ${what}.`);
    if (incident.coordinator.state === "idle" && incident.approval?.state !== "approved") throw new Error(`Copilot stopped while ${what}: ${incident.coordinator.lastMessage ?? "no message"}`);
    if (Date.now() > deadline) throw new Error(`Timed out ${what} after ${Math.round(timeoutMs / 60_000)} minutes.`);
    await sleep(3_000);
  }
}

let id: string | undefined;
try {
  say(`Incident Commander at ${base}`);
  let state = await api<AppState>("/api/state");
  for (let attempt = 0; state.platform.state !== "connected" && attempt < 20; attempt++) {
    await sleep(3_000);
    state = await api<AppState>("/api/state");
  }
  if (state.platform.state !== "connected") throw new Error(`Managed Copilot isn't connected: ${state.platform.message ?? state.platform.state}`);

  ({ id } = await api<CreatedIncident>("/api/simulate", { method: "POST" }));
  say(`Simulated ${id}`);
  const printed = { count: 0 };
  const announced = (incident: IncidentView) => !state.integrations.webhookConfigured || incident.approval?.announcedAt !== undefined;
  const waiting = await follow(id, "triaging and fixing", 15 * 60_000, (incident) => incident.approval?.state === "waiting" && !incident.coordinator.attached && announced(incident), printed);
  const own = waiting.sandboxes.find((sandbox) => sandbox.role === "own");
  const workers = waiting.sandboxes.filter((sandbox) => sandbox.role === "worker");
  if (!own || workers.length === 0) throw new Error("The incident didn't use both Copilot's own sandbox and workers.");
  const names = workers.map((worker) => worker.name).join(" and ");
  say(`Mixed: ${own.commands ?? 0} commands in Copilot's own sandbox; workers ${names}`);
  say(`The deploy request waits on the platform, and the app holds no session. Approving: ${waiting.approval!.summary}`);

  await api<void>(`/api/incidents/${id}/decision`, { method: "POST", body: JSON.stringify({ approve: true }) });
  const resolved = await follow(id, "deploying", 10 * 60_000, (incident) => incident.status === "resolved" && incident.postmortem !== undefined && incident.coordinator.state === "done", printed);

  console.log("");
  console.log(`✓ ${resolved.id} resolved: ${resolved.title}`);
  console.log(`  Root cause:  ${resolved.postmortem!.rootCause}`);
  console.log(`  Deployed:    ${resolved.deploy?.message ?? "n/a"}`);
  console.log(`  Sandboxes:   Copilot's own (${own.commands ?? 0} commands), workers ${names}`);
  console.log(`  Triaged in ${seconds(resolved.createdAt, resolved.milestones.triagedAt)}, fixed in ${seconds(resolved.createdAt, resolved.approval?.requestedAt)}, resolved in ${seconds(resolved.createdAt, resolved.milestones.resolvedAt)}`);
} catch (error) {
  process.exitCode = 1;
  console.error(`\n✗ ${(error as Error).message}`);
} finally {
  if (id && !values.keep) {
    await api<void>(`/api/incidents/${id}`, { method: "DELETE" }).then(
      () => say(`Deleted ${id} with its session and sandboxes.`),
      (error: Error) => {
        process.exitCode = 1;
        console.error(`Couldn't delete ${id}: ${error.message}`);
      },
    );
  }
}
