/**
 * The scripted happy path: submits the featured work order ("CSV ⇄ JSON toolkit") to a running factory, follows it
 * live over the factory's event stream, and checks the release.
 *
 *   pnpm happy-path                       # agent-led; FACTORY_URL defaults to http://localhost:7480
 *   pnpm happy-path --mode classic         # original app-orchestrated pipeline
 *   pnpm happy-path --require-reuse        # acceptance: also require a builder reused for review fixes
 *   FACTORY_URL=http://localhost:7584 pnpm happy-path
 *
 * Exits 0 when the work order completes with every test passing; 1 otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HAPPY_PATH_TEMPLATE_ID } from "../shared/templates.js";
import {
  formatWorkOrderNumber,
  type ActivityItem,
  type ApiErrorBody,
  type FactoryState,
  type ServerEvent,
  type Station,
  type WorkOrder,
  type WorkOrderMode,
} from "../shared/types.js";

const { values } = parseArgs({ options: { mode: { type: "string", default: "agent" }, "require-reuse": { type: "boolean", default: false } } });
if (values.mode !== "agent" && values.mode !== "classic") throw new Error('Use --mode agent or --mode classic.');
if (values["require-reuse"] && values.mode !== "agent") throw new Error("--require-reuse applies to agent-led work orders.");
const mode: WorkOrderMode = values.mode;
const base = (process.env.FACTORY_URL ?? `http://localhost:${process.env.PORT ?? 7480}`).replace(/\/+$/, "");
const timeoutMs = Number(process.env.HAPPY_PATH_TIMEOUT_MINUTES ?? 20) * 60_000;
const started = Date.now();

function elapsed(): string {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function log(message: string): void {
  console.log(`[${elapsed()}] ${message}`);
}

class FactoryApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000), headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new FactoryApiError(response.status, body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
}

function describe(station: Station): string {
  const parts = [station.status, station.detail].filter(Boolean).join(" · ");
  return `${station.title.padEnd(34)} ${parts}`;
}

/**
 * Opens the server-sent event stream, then submits the work order, so no update can be missed, and follows it until
 * it settles. A restart reconnects and reloads the recorded work order; it never submits a second one.
 */
async function follow(submit: () => Promise<WorkOrder>): Promise<WorkOrder> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen = new Map<string, string>();
  let id: string | undefined;
  const settled = (wo: WorkOrder) => ["completed", "failed", "cancelled"].includes(wo.status);
  const report = (wo: WorkOrder) => {
    for (const station of wo.stations) {
      const key = `${station.status}|${station.detail}`;
      if (seen.get(station.id) !== key) {
        seen.set(station.id, key);
        log(describe(station));
      }
    }
  };
  try {
    for (;;) {
      const connection = new AbortController();
      try {
        const signal = AbortSignal.any([controller.signal, connection.signal]);
        const response = await fetch(`${base}/api/events`, { signal });
        if (!response.ok || !response.body) throw new FactoryApiError(response.status, "The factory's event stream is unavailable.");
        if (!id) id = (await submit()).id;
        const current = await api<WorkOrder>(`/api/work-orders/${id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        report(current);
        if (settled(current)) {
          await response.body.cancel();
          return current;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
              if (!data) continue;
              const event = JSON.parse(data) as ServerEvent;
              if (event.type === "activity" && event.item.workOrderId === id && event.item.kind === "test" && event.item.tests) {
                log(`  ${event.item.stationId}: tests ${event.item.text}`);
              }
              if (event.type === "activity" && event.item.workOrderId === id && event.item.decision?.status === "done") {
                log(`  coordinator: ${event.item.text?.replace(/\*\*/g, "")}`);
              }
              if (event.type !== "workOrder" || event.workOrder.id !== id) continue;
              report(event.workOrder);
              if (settled(event.workOrder)) return event.workOrder;
            }
          }
        } finally {
          reader.releaseLock();
        }
        throw new Error("The factory's event stream closed.");
      } catch (error) {
        if (!id || controller.signal.aborted || (error instanceof FactoryApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) throw error;
        log(`Factory connection interrupted (${(error as Error).message}); reconnecting to ${id}, not submitting new work.`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      } finally {
        connection.abort();
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`The work order didn't finish within ${timeoutMs / 60_000} minutes.`);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main(): Promise<void> {
  const state = await api<FactoryState>("/api/state").catch((error: Error) => {
    throw new Error(`Can't reach the factory at ${base} (${error.message}). Start it with \`aspire run\` or \`pnpm dev\`.`);
  });
  if (!state.platform.features.runs) {
    throw new Error(`The factory can't run work orders yet: ${state.platform.message ?? state.platform.state}${state.platform.hint ? ` ${state.platform.hint}` : ""}`);
  }
  if (mode === "agent" && !state.platform.features.agentLed) throw new Error(state.platform.agentLedHint ?? "The platform doesn't offer the factory's orchestrator environment.");
  const template = state.templates.find((candidate) => candidate.id === HAPPY_PATH_TEMPLATE_ID)!;
  log(`Factory at ${base} · platform ${state.platform.deployment?.name} (${state.platform.deployment?.mode}) · signed in as ${state.platform.account?.login}`);
  for (const env of state.platform.environments) log(`  ${env.name.padEnd(17)} ${env.type.padEnd(8)} ${env.model}`);

  let created: WorkOrder | undefined;
  const settled = await follow(async () => {
    created = await api<WorkOrder>("/api/work-orders", {
      method: "POST",
      body: JSON.stringify({ title: template.title, brief: template.brief, templateId: template.id, mode }),
    });
    log(`Submitted ${formatWorkOrderNumber(created.number)} "${created.title}" (${created.id}) · ${mode === "agent" ? "Agent-led" : "App-driven"}`);
    return created;
  });
  const wo = await api<WorkOrder>(`/api/work-orders/${settled.id}`);

  const duration = wo.completedAt && wo.startedAt ? Math.round((Date.parse(wo.completedAt) - Date.parse(wo.startedAt)) / 1000) : undefined;
  if (settled.status !== "completed" || !wo.release) {
    throw new Error(`${formatWorkOrderNumber(wo.number)} ${wo.status}: ${wo.error?.message ?? "no release"}`);
  }
  const reviews = wo.stations.filter((station) => station.kind === "review");
  log(`✔ ${formatWorkOrderNumber(wo.number)} completed in ${duration ?? "?"}s`);
  log(`  plan: ${wo.plan?.tasks.map((task) => task.id).join(", ")}`);
  log(`  reviews: ${reviews.map((station) => `${station.taskId} ${station.reviews?.map((review) => review.verdict).join("→")}`).join("; ")}`);
  log(`  release: ${wo.release.files} files · ${wo.release.tests?.passed}/${wo.release.tests?.total} tests passed · patch ${wo.release.patchBytes ?? 0} bytes`);
  const tests = wo.release.tests;
  if (!tests || tests.total < 1 || tests.passed < 1 || tests.failed !== 0 || tests.passed + tests.skipped !== tests.total) {
    throw new Error("The release must report a nonempty, fully passing test suite.");
  }
  if (mode === "agent") {
    const coordinator = wo.stations.find((station) => station.kind === "coordinate");
    const workers = wo.stations.filter((station) => station.kind === "build" || station.kind === "release");
    if (!coordinator?.sessionId || coordinator.status !== "done" || workers.some((station) => !station.worker || station.worker.id !== station.sessionId)) {
      throw new Error("Agent-led acceptance failed: the coordinator and every build/release worker must be recorded.");
    }
    const reused = workers.filter((station) => station.kind === "build" && station.round > (station.worker?.createdRound ?? 0));
    log(`  coordinator: ${coordinator.sessionId}`);
    for (const station of workers) log(`  ${station.worker!.name}: ${station.environment} · ${station.sessionId} · ${station.sandbox?.id ?? "sandbox unavailable"}${station.round > 1 ? ` · reused for round ${station.round}` : ""}`);
    if (values["require-reuse"] && reused.length === 0) throw new Error("This run had no review fixes. --require-reuse requires a builder reused for a later review round.");
  }

  const zip = await fetch(`${base}/api/work-orders/${wo.id}/bundle.zip`);
  if (!zip.ok) throw new Error(`Couldn't download the release (HTTP ${zip.status}).`);
  const dir = resolve(process.env.HAPPY_PATH_OUTPUT ?? join(process.cwd(), ".data", "happy-path"));
  mkdirSync(dir, { recursive: true });
  const name = `${wo.plan?.projectName ?? "release"}-${formatWorkOrderNumber(wo.number)}`;
  const file = join(dir, `${name}.zip`);
  writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(wo, null, 2));
  const activity = await api<ActivityItem[]>(`/api/work-orders/${wo.id}/activity`);
  writeFileSync(join(dir, `${name}-activity.json`), JSON.stringify(activity, null, 2));
  log(`  bundle: ${file}`);
}

main().catch((error: unknown) => {
  console.error(`✖ Happy path failed: ${(error as Error).message}`);
  process.exit(1);
});
