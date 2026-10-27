import { blueprintKind } from "../../shared/catalog.js";
import type { Blueprint, BlueprintKind, ConversationView, Decision, WorkerView } from "../../shared/types.js";
import { parseTime } from "./format.js";

export function blueprintFor(environment: string, blueprints: readonly Blueprint[]): Blueprint | undefined {
  return blueprints.find((blueprint) => blueprint.name === environment);
}

export function kindOf(environment: string, blueprints: readonly Blueprint[]): BlueprintKind {
  return blueprintFor(environment, blueprints)?.kind ?? blueprintKind(environment);
}

export interface ConversationStats {
  readonly messages: number;
  readonly created: number;
  /** Follow-ups sent to sandboxes that already existed. */
  readonly reused: number;
  readonly stopped: number;
  readonly live: number;
}

export function conversationStats(view: ConversationView): ConversationStats {
  let reused = 0;
  for (const message of view.messages) {
    for (const decision of message.decisions ?? []) if (decision.kind === "message" && (decision.status === "done" || decision.status === "running")) reused += 1;
  }
  const stopped = view.workers.filter((worker) => worker.state === "stopped").length;
  return { messages: view.messageCount, created: view.workers.length, reused, stopped, live: view.workers.length - stopped };
}

export interface WorkItem {
  readonly index: number;
  readonly kind: "create" | "message";
  readonly task: string;
  readonly at: string;
}

/** The task a worker started with and every follow-up sent to it, with the user message each one served. */
export function workGiven(view: ConversationView, worker: WorkerView): WorkItem[] {
  const created = parseTime(worker.createdAt) ?? 0;
  const items: WorkItem[] = [];
  for (const message of view.messages) {
    if (message.role !== "user" || message.index === undefined) continue;
    for (const decision of message.decisions ?? []) {
      if (decision.worker !== worker.name || decision.status === "denied" || decision.status === "failed") continue;
      const at = parseTime(decision.at) ?? 0;
      // Names can be reused after a stop: only this worker's own creation and later follow-ups.
      if (decision.kind === "create" && at >= created - 120_000 && at <= created + 120_000) items.push({ index: message.index, kind: "create", task: decision.task ?? worker.task, at: decision.at });
      if (decision.kind === "message" && at >= created) items.push({ index: message.index, kind: "message", task: decision.task ?? "", at: decision.at });
    }
  }
  if (!items.some((item) => item.kind === "create")) items.unshift({ index: worker.createdBy ?? 0, kind: "create", task: worker.task, at: worker.createdAt });
  return items;
}

/** How long the coordinator took over a message: from the message to its last recorded step. */
export function handlingTime(at: string, decisions: readonly Decision[], now: number, current: boolean): number {
  const start = parseTime(at) ?? now;
  if (current) return Math.max(0, now - start);
  const ends = decisions.map((decision) => parseTime(decision.endedAt) ?? parseTime(decision.at) ?? start);
  return Math.max(0, Math.max(start, ...ends) - start);
}
