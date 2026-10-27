/**
 * What a sandbox card shows: the start or follow-up card (a coordinator tool call, from the chat's history) joined with
 * the sandbox's live state, timing, and outputs (`SandboxesView`, from the platform). Pure, so it is unit tested on its
 * own (test/sandbox-cards.test.ts).
 */
import type { AssistantItem, SandboxEnvironmentView, SandboxesView, SandboxOutputView, SandboxWorkerView, TimelineItem, WorkerItem } from "../../shared/protocol";

export type CardPhase =
  /** The tool call is still running (for a start: just after it was approved). */
  | "calling"
  /** The tool call failed: no sandbox was started, or the follow-up didn't reach it. */
  | "call-failed"
  | "starting"
  | "working"
  | "done"
  | "failed"
  | "stopped";

export interface CardState {
  readonly environment?: SandboxEnvironmentView;
  readonly worker?: SandboxWorkerView;
  /** Unknown until the sandboxes have been listed. */
  readonly phase?: CardPhase;
  /** When this card's work started (the tool call returned) and ended. */
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** What this card's work published (the files published between it and the sandbox's next card). */
  readonly outputs: readonly SandboxOutputView[];
  /** This is its sandbox's latest card, so the sandbox's current state is this card's. */
  readonly latest: boolean;
}

const SLACK_MS = 5_000;

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Builds the lookup once per render: every card's state, given the chat's items and the sandboxes. */
export function sandboxCardStates(items: readonly TimelineItem[], sandboxes: SandboxesView | undefined): (card: WorkerItem) => CardState {
  const workers = sandboxes?.workers ?? [];
  const cards = items.filter((item): item is WorkerItem => item.kind === "worker");
  const workerOf = (card: WorkerItem): SandboxWorkerView | undefined => {
    const id = sandboxes?.runs[card.id]?.workerId ?? card.workerId;
    if (id) return workers.find((worker) => worker.id === id);
    // The newest sandbox by that name that existed by then.
    const by = time(card.endedAt ?? card.at) + SLACK_MS;
    return workers.filter((worker) => worker.name === card.worker && time(worker.createdAt) <= by).sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  };
  const resolved = new Map<string, SandboxWorkerView | undefined>();
  const sequence = new Map<string, WorkerItem[]>();
  for (const card of cards) {
    const worker = workerOf(card);
    resolved.set(card.id, worker);
    if (worker && card.status === "succeeded") sequence.set(worker.id, [...(sequence.get(worker.id) ?? []), card]);
  }
  const environments = sandboxes?.environments ?? [];

  return (card) => {
    const worker = resolved.get(card.id) ?? workerOf(card);
    const run = sandboxes?.runs[card.id];
    const environment = environments.find((candidate) => candidate.name === (card.environment ?? worker?.environment));
    const startedAt = run?.startedAt ?? card.endedAt ?? card.at;
    const siblings = worker ? (sequence.get(worker.id) ?? []) : [];
    const index = siblings.findIndex((candidate) => candidate.id === card.id);
    const next = index >= 0 ? siblings[index + 1] : undefined;
    const latest = card.status === "succeeded" && index >= 0 && next === undefined;
    // Consecutive cards of a sandbox split its outputs at the next card's start; only the first allows for clock slack.
    const startOf = (entry: WorkerItem) => sandboxes?.runs[entry.id]?.startedAt ?? entry.endedAt ?? entry.at;
    const from = index > 0 ? time(startedAt) : time(startedAt) - SLACK_MS;
    const until = next ? time(startOf(next)) : Number.POSITIVE_INFINITY;
    const outputs = card.status !== "succeeded" ? [] : (worker?.outputs ?? []).filter((output) => (output.publishedAt ? time(output.publishedAt) >= from && time(output.publishedAt) < until : latest));

    let phase: CardPhase | undefined;
    let finishedAt = run?.finishedAt;
    if (card.status === "running") phase = "calling";
    else if (card.status === "failed") phase = "call-failed";
    else if (run?.finishedAt && run.outcome) phase = run.outcome === "idle" ? "done" : run.outcome;
    else if (worker && latest) {
      // A listing from before a follow-up's message says nothing about its work yet: it counts fewer messages and is
      // older (both must agree, since the platform's clock and the one that timed the card can differ). A start card
      // has no earlier work to confuse, and a stopped sandbox is stopped for good.
      const finished = worker.state === "idle" || worker.state === "failed";
      const stale = index > 0 && finished && worker.messages < index + 1 && time(worker.updatedAt) < time(startedAt) - SLACK_MS / 5;
      if (stale) phase = card.action === "start" ? "starting" : "working";
      else {
        phase = worker.state === "idle" ? "done" : worker.state;
        if (phase !== "starting" && phase !== "working") finishedAt ??= worker.updatedAt;
      }
    } else if (worker) {
      // An earlier card of a sandbox that has moved on: its work ended before the next card's.
      phase = worker.state === "stopped" && !next ? "stopped" : "done";
    } else if (sandboxes?.enabled && card.status === "succeeded" && !run) {
      // Just started or messaged: the sandboxes haven't been listed since (once they are, every card has a run).
      phase = card.action === "start" ? "starting" : "working";
    }
    return { environment, worker, phase, startedAt, finishedAt, outputs, latest };
  };
}

/** "0:21", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** An image a sandbox published, shown under a reply. */
export interface ReplyImage {
  readonly output: SandboxOutputView;
  /** The sandbox's name. */
  readonly worker: string;
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Which reply each published image shows under: the first reply written after it was published that names the file
 * (the assistant is told to mention charts by name), else the first reply written after it was published. Replies
 * written while the sandbox worked (for example to a question asked meanwhile) come before its outputs, so they never
 * take them. An image without a publication time goes under the first reply after its card that names it. Each image
 * shows once.
 */
export function replyImages(items: readonly TimelineItem[], stateOf: (card: WorkerItem) => CardState): Map<string, ReplyImage[]> {
  const images = new Map<string, ReplyImage[]>();
  const shown = new Set<string>();
  items.forEach((item, index) => {
    if (item.kind !== "worker" || item.status !== "succeeded") return;
    const replies = items.slice(index + 1).filter((entry): entry is AssistantItem => entry.kind === "assistant");
    for (const output of stateOf(item).outputs) {
      if (!output.image || shown.has(output.id)) continue;
      const name = fileName(output.path);
      const published = output.publishedAt ? time(output.publishedAt) - SLACK_MS / 5 : undefined;
      const after = published === undefined ? [] : replies.filter((reply) => time(reply.at) >= published);
      const reply = published === undefined ? replies.find((candidate) => candidate.text.includes(name)) : (after.find((candidate) => candidate.text.includes(name)) ?? after[0]);
      if (!reply) continue;
      shown.add(output.id);
      images.set(reply.id, [...(images.get(reply.id) ?? []), { output, worker: item.worker }]);
    }
  });
  return images;
}
