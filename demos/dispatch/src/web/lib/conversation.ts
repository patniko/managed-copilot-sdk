import { blueprintKind } from "../../shared/catalog.js";
import type { Blueprint, BlueprintKind, ConversationView, WorkerView } from "../../shared/types.js";
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
  /** Commands the coordinator and its sub-agents ran in their own sandbox. */
  readonly commands: number;
  /** Sub-agents it started. */
  readonly subagents: number;
}

export function conversationStats(view: ConversationView): ConversationStats {
  let reused = 0;
  let commands = 0;
  let subagents = 0;
  for (const message of view.messages) {
    for (const decision of message.decisions ?? []) if (decision.kind === "message" && (decision.status === "done" || decision.status === "running")) reused += 1;
    commands += (message.commands ?? []).filter((command) => command.kind === "run" && command.status !== "denied" && command.status !== "asking").length;
    subagents += message.subagents?.length ?? 0;
  }
  const stopped = view.workers.filter((worker) => worker.state === "stopped").length;
  // A coordinator's own sandbox is reused when later messages ran more commands in it.
  for (const worker of view.workers) if (worker.role === "hands") reused += worker.sentWorkBy.length;
  return { messages: view.messageCount, created: view.workers.length, reused, stopped, live: view.workers.length - stopped, commands, subagents };
}

export interface WorkItem {
  readonly index: number;
  readonly kind: "create" | "message";
  readonly task: string;
  readonly at: string;
}

/** The task a worker started with and every follow-up sent to it, with the user message each one served. */
export function workGiven(view: ConversationView, worker: WorkerView): WorkItem[] {
  const items: WorkItem[] = [];
  for (const message of view.messages) {
    if (message.role !== "user" || message.index === undefined) continue;
    for (const decision of message.decisions ?? []) {
      // The server resolves each decision to the worker's session ID, so a reused name never mixes two workers up.
      if (decision.workerId !== worker.id || decision.status === "denied" || decision.status === "failed") continue;
      if (decision.kind === "create") items.push({ index: message.index, kind: "create", task: decision.task ?? worker.task, at: decision.at });
      else if (decision.kind === "message") items.push({ index: message.index, kind: "message", task: decision.task ?? "", at: decision.at });
    }
  }
  if (!items.some((item) => item.kind === "create")) items.unshift({ index: worker.createdBy ?? 0, kind: "create", task: worker.task, at: worker.createdAt });
  return items;
}

/** How long the coordinator took over a message: from the message to its last recorded step (decision, command, sub-agent). */
export function handlingTime(at: string, steps: readonly { readonly at: string; readonly endedAt?: string }[], now: number, current: boolean): number {
  const start = parseTime(at) ?? now;
  if (current) return Math.max(0, now - start);
  const ends = steps.map((step) => parseTime(step.endedAt) ?? parseTime(step.at) ?? start);
  return Math.max(0, Math.max(start, ...ends) - start);
}
