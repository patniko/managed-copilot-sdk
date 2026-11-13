/**
 * The scripted happy path: one real incident, end to end, through Incident Commander's HTTP API.
 *
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path                  # http://localhost:7445 + MANAGED_COPILOT_PORT_OFFSET
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --url http://localhost:9345
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --keep           # keep the incident and its sandbox
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --factory        # route the fix through Software Factory
 *   pnpm --filter @managed-copilot/demo-incident-commander happy-path --factory --factory-url http://localhost:7480
 *
 * Simulates an incident, waits until Copilot's deploy request waits on the platform (the app let go of the session),
 * approves it, and waits for Resolved and the postmortem. Then deletes the incident, its session, and its sandboxes.
 * The fix is made by Copilot's workers, whatever the app's setting; with --factory, Software Factory builds it as a work
 * order (and the run takes longer), and the deploy is approved on the work order's deploy gate in Software Factory (at
 * --factory-url, by default the address Incident Commander links to). Exits 0 when the incident resolved; 1 otherwise.
 */
import { parseArgs } from "node:util";
import type { ApiErrorBody, AppState, CreatedIncident, FixRoute, IncidentView, SimulateRequest } from "../shared/types.js";

const { values } = parseArgs({
  options: { url: { type: "string" }, keep: { type: "boolean", default: false }, factory: { type: "boolean", default: false }, "factory-url": { type: "string" } },
});
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${7445 + offset}`).replace(/\/+$/, "");
const fixRoute: FixRoute = values.factory ? "factory" : "workers";
const started = Date.now();

function elapsed(): string {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const say = (message: string): void => console.log(`[${elapsed()}] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (from: string, to: string | undefined) => (to ? `${Math.round((Date.parse(to) - Date.parse(from)) / 1000)} s` : "n/a");
const workOrder = (number: number): string => `WO-${String(number).padStart(4, "0")}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (response.status === 204 || response.status === 202 ? undefined : await response.json()) as T;
}

/** Copilot ended its turn on purpose: Software Factory builds the fix, and the app hands it over once it's released. */
const waitingForFactory = (incident: IncidentView): boolean => incident.factory !== undefined && incident.factory.deliveredAt === undefined;

/** Polls the incident, printing its new timeline entries, until `done` says so. */
async function follow(id: string, what: string, timeoutMs: number, done: (incident: IncidentView) => boolean, printed: { count: number }): Promise<IncidentView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const incident = await api<IncidentView>(`/api/incidents/${id}`);
    for (const entry of incident.timeline.slice(printed.count)) say(`  ${entry.text}`);
    printed.count = incident.timeline.length;
    if (done(incident)) return incident;
    if (incident.coordinator.state === "failed") throw new Error(`Copilot's session failed while ${what}.`);
    if (incident.coordinator.state === "idle" && incident.approval?.state !== "approved" && !waitingForFactory(incident)) {
      throw new Error(`Copilot stopped while ${what}: ${incident.coordinator.lastMessage ?? "no message"}`);
    }
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
  if (values.factory && !state.integrations.factory?.configured) {
    throw new Error("Software Factory isn't connected to Incident Commander. Start it with `aspire run` (the root AppHost sets SOFTWARE_FACTORY_URL), then try again.");
  }

  const simulate: SimulateRequest = { fixRoute };
  ({ id } = await api<CreatedIncident>("/api/simulate", { method: "POST", body: JSON.stringify(simulate) }));
  say(`Simulated ${id}${values.factory ? ": Software Factory builds the fix" : ""}`);
  const printed = { count: 0 };
  let announcedOrder = false;
  const announced = (incident: IncidentView) => !state.integrations.webhookConfigured || incident.approval?.announcedAt !== undefined;
  const ready = (incident: IncidentView) => {
    if (incident.factory && !announcedOrder) {
      announcedOrder = true;
      say(`Software Factory: ${workOrder(incident.factory.number)} ${incident.factory.url}`);
    }
    const gate = incident.approval?.gate;
    return incident.approval?.state === "waiting" && !incident.coordinator.attached && announced(incident) && (gate?.state !== "opening" || gate.problem !== undefined);
  };
  // Through the factory: triage, then the factory plans, builds, reviews, and releases the fix before Copilot verifies it.
  const waiting = await follow(id, values.factory ? "triaging, and while Software Factory built the fix" : "triaging and fixing", (values.factory ? 45 : 15) * 60_000, ready, printed);
  const own = waiting.sandboxes.find((sandbox) => sandbox.role === "own");
  const workers = waiting.sandboxes.filter((sandbox) => sandbox.role === "worker");
  if (!own || workers.length === 0) throw new Error("The incident didn't use both Copilot's own sandbox and workers.");
  if (values.factory && !waiting.approval?.factory) {
    const work = waiting.factory;
    throw new Error(
      work
        ? `The fix waiting for approval isn't Software Factory's: ${workOrder(work.number)} is ${work.status}${work.error ? ` (${work.error})` : ""}, and Copilot fell back to a "fix" worker.`
        : "Copilot didn't route the fix to Software Factory.",
    );
  }
  const names = workers.map((worker) => worker.name).join(" and ");
  say(`Mixed: ${own.commands ?? 0} commands in Copilot's own sandbox; workers ${names}${waiting.approval?.factory ? `; the fix by Software Factory (${workOrder(waiting.approval.factory.number)})` : ""}`);
  say(`The deploy request waits on the platform, and the app holds no session. Approving: ${waiting.approval!.summary}`);

  const gate = waiting.approval?.gate;
  if (gate?.state === "open" && gate.workOrderId && !gate.problem) {
    // Decided on the work order's deploy gate: approve it there, as a person on the factory floor would.
    const factoryUrl = (values["factory-url"] ?? state.integrations.factory?.url)?.replace(/\/+$/, "");
    if (!factoryUrl) throw new Error("The deploy request waits in Software Factory, but its address isn't known. Pass --factory-url.");
    say(`Approving in Software Factory: ${workOrder(gate.number ?? 0)}'s deploy gate`);
    const response = await fetch(`${factoryUrl}/api/work-orders/${encodeURIComponent(gate.workOrderId)}/gates/deploy/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true, requestId: waiting.approval!.id }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
      throw new Error(`Software Factory didn't take the approval: ${body?.error.message ?? `HTTP ${response.status}`}`);
    }
  } else {
    if (values.factory && (gate?.problem ?? gate?.reason)) say(`Approving here: ${gate?.problem ?? gate?.reason}`);
    await api<void>(`/api/incidents/${id}/decision`, { method: "POST", body: JSON.stringify({ approve: true }) });
  }
  const resolved = await follow(id, "deploying", 10 * 60_000, (incident) => incident.status === "resolved" && incident.postmortem !== undefined && incident.coordinator.state === "done", printed);

  console.log("");
  console.log(`✓ ${resolved.id} resolved: ${resolved.title}`);
  console.log(`  Root cause:  ${resolved.postmortem!.rootCause}`);
  console.log(`  Deployed:    ${resolved.deploy?.message ?? "n/a"}`);
  console.log(`  Sandboxes:   Copilot's own (${own.commands ?? 0} commands), workers ${names}`);
  if (resolved.factory) {
    const tests = resolved.factory.tests ? `; its tests: ${resolved.factory.tests.passed} passed, ${resolved.factory.tests.failed} failed` : "";
    console.log(`  Factory:     ${workOrder(resolved.factory.number)} ${resolved.factory.url}${tests}`);
  }
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
