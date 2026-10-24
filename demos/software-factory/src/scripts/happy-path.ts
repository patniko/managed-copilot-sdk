/**
 * The scripted happy path: submits the featured work order ("CSV ⇄ JSON toolkit") to a running factory, follows it
 * live over the factory's event stream, and checks the release.
 *
 *   pnpm happy-path                       # FACTORY_URL defaults to http://localhost:7480
 *   FACTORY_URL=http://localhost:7584 pnpm happy-path
 *
 * Exits 0 when the work order completes with every test passing; 1 otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAPPY_PATH_TEMPLATE_ID } from "../shared/templates.js";
import {
  formatWorkOrderNumber,
  type ApiErrorBody,
  type FactoryState,
  type ServerEvent,
  type Station,
  type WorkOrder,
} from "../shared/types.js";

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(body?.error.message ?? `HTTP ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
}

function describe(station: Station): string {
  const parts = [station.status, station.detail].filter(Boolean).join(" · ");
  return `${station.title.padEnd(34)} ${parts}`;
}

/**
 * Opens the server-sent event stream, then submits the work order, so no update can be missed, and follows it until
 * it settles.
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
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    if (!response.body) throw new Error("The factory's event stream is unavailable.");
    const created = await submit();
    id = created.id;
    const current = await api<WorkOrder>(`/api/work-orders/${id}`);
    report(current);
    if (settled(current)) return current;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
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
        if (event.type === "activity" && event.item.workOrderId === id && event.item.kind === "test" && event.item.tests) {
          log(`  ${event.item.stationId}: tests ${event.item.text}`);
        }
        if (event.type !== "workOrder" || event.workOrder.id !== id) continue;
        report(event.workOrder);
        if (settled(event.workOrder)) return event.workOrder;
      }
    }
    throw new Error("The factory's event stream closed before the work order finished.");
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
  const template = state.templates.find((candidate) => candidate.id === HAPPY_PATH_TEMPLATE_ID)!;
  log(`Factory at ${base} · platform ${state.platform.deployment?.name} (${state.platform.deployment?.mode}) · signed in as ${state.platform.account?.login}`);
  for (const env of state.platform.environments) log(`  ${env.name.padEnd(17)} ${env.type.padEnd(8)} ${env.model}`);

  let created: WorkOrder | undefined;
  const settled = await follow(async () => {
    created = await api<WorkOrder>("/api/work-orders", {
      method: "POST",
      body: JSON.stringify({ title: template.title, brief: template.brief, templateId: template.id }),
    });
    log(`Submitted ${formatWorkOrderNumber(created.number)} "${created.title}" (${created.id})`);
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

  const zip = await fetch(`${base}/api/work-orders/${wo.id}/bundle.zip`);
  if (zip.ok) {
    const dir = resolve(process.env.HAPPY_PATH_OUTPUT ?? join(process.cwd(), ".data", "happy-path"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${wo.plan?.projectName ?? "release"}-${formatWorkOrderNumber(wo.number)}.zip`);
    writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
    log(`  bundle: ${file}`);
  }
  if ((wo.release.tests?.failed ?? 1) > 0) throw new Error("The release reported failing tests.");
}

main().catch((error: unknown) => {
  console.error(`✖ Happy path failed: ${(error as Error).message}`);
  process.exit(1);
});
