/**
 * How the chat timeline groups into blocks for display. Pure (no React, no DOM), so the grouping rules are unit tested
 * on their own (test/timeline-blocks.test.ts).
 */
import type { ApprovalItem, AssistantItem, NoticeItem, TimelineItem, ToolItem, TriggerItem, UserItem, WorkerItem } from "../../shared/protocol";
import { dayKey, dayLabel } from "./format";

/** An informational note (like "Stopped."). It reads as part of the activity around it; warnings and errors stand alone. */
export type InfoNotice = NoticeItem & { readonly level: "info" };

/** Tool calls, schedule runs, and info notes between turns, shown together as one run of timeline events. */
export type RunItem = ToolItem | TriggerItem | InfoNotice;

export type Block =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string }
  | {
      type: "item";
      key: string;
      item: UserItem | AssistantItem | ApprovalItem | NoticeItem | WorkerItem;
      scheduleLabel?: string;
      outcome?: ToolItem;
      /** A sandbox card: the person's approval that started the sandbox. */
      approval?: ApprovalItem;
      /** A turn's last reply: the sandbox cards before it in that turn, whose images show under it. */
      sandboxCards?: WorkerItem[];
    }
  | { type: "run"; key: string; items: RunItem[] };

function isRunItem(item: TimelineItem): item is RunItem {
  return item.kind === "tool" || item.kind === "trigger" || (item.kind === "notice" && item.level === "info");
}

/**
 * Groups timeline items into display blocks:
 * - a day divider (in `timeZone`) before each new local day, labeled relative to `now`;
 * - an unread divider before the item `unreadAnchor` names;
 * - consecutive tool calls, schedule runs, and info notes as one run, which day and unread dividers split;
 * - every other item on its own, with warning and error notices standing alone;
 * - a proactive reply labeled with the schedule whose trigger started it (the label clears at the person's next message);
 * - an approved call's tool progress attached to its approval card (tool `<id>` ↔ approval `approval:<id>`), not in a run;
 * - a sandbox the person approved shown as its card, carrying that approval; one waiting for (or refused) approval
 *   shown as its approval card;
 * - each turn's last reply carrying the sandbox cards before it, so their images show under the answer.
 */
export function buildBlocks(items: readonly TimelineItem[], timeZone: string, unreadAnchor: string | undefined, now: Date = new Date()): Block[] {
  const blocks: Block[] = [];
  const approvals = new Map(items.filter((item): item is ApprovalItem => item.kind === "approval").map((item) => [item.id, item]));
  // A consequential tool call's progress is shown inside its approval card instead of as a separate row.
  const outcomes = new Map<string, ToolItem>();
  /** Sandbox cards shown as their (pending or refused) approval card instead. */
  const asApproval = new Set<string>();
  /** Approvals shown as the card of the sandbox they started, by card ID. */
  const approvedBy = new Map<string, ApprovalItem>();
  for (const item of items) {
    const approval = approvals.get(`approval:${item.id}`);
    if (!approval) continue;
    if (item.kind === "tool") outcomes.set(approval.id, item);
    else if (item.kind === "worker") {
      if (approval.status === "approved") approvedBy.set(item.id, approval);
      else asApproval.add(item.id);
    }
  }
  const startApprovals = new Set([...approvedBy.values()].map((approval) => approval.id));
  const hidden = (item: TimelineItem) =>
    (item.kind === "tool" && outcomes.has(`approval:${item.id}`)) || (item.kind === "worker" && asApproval.has(item.id)) || (item.kind === "approval" && startApprovals.has(item.id));

  // Each turn's last reply shows the images of the sandbox cards before it in that turn.
  const replyCards = new Map<string, WorkerItem[]>();
  let turnCards: WorkerItem[] = [];
  let lastReply: { id: string; cards: WorkerItem[] } | undefined;
  const endTurn = () => {
    if (lastReply && lastReply.cards.length > 0) replyCards.set(lastReply.id, lastReply.cards);
    turnCards = [];
    lastReply = undefined;
  };
  for (const item of items) {
    if (item.kind === "user" || item.kind === "trigger") endTurn();
    else if (item.kind === "worker" && item.status === "succeeded" && !hidden(item)) turnCards.push(item);
    else if (item.kind === "assistant") lastReply = { id: item.id, cards: [...turnCards] };
  }
  endTurn();

  let lastDay: string | undefined;
  let run: RunItem[] | undefined;
  let scheduleLabel: string | undefined;
  /** The unread anchor was an item shown elsewhere (an approval shown as its sandbox's card): mark the next one. */
  let unreadPending = false;
  const flush = () => {
    if (run?.length) blocks.push({ type: "run", key: `run:${run[0]!.id}`, items: run });
    run = undefined;
  };
  for (const item of items) {
    if (hidden(item)) {
      if (item.id === unreadAnchor) unreadPending = true;
      continue;
    }
    const day = dayKey(item.at, timeZone);
    if (day !== lastDay) {
      flush();
      blocks.push({ type: "day", key: `day:${day}`, label: dayLabel(item.at, timeZone, now) });
      lastDay = day;
    }
    if (item.id === unreadAnchor || unreadPending) {
      flush();
      blocks.push({ type: "unread", key: "unread" });
      unreadPending = false;
    }
    if (item.kind === "trigger") scheduleLabel = item.scheduleName;
    if (item.kind === "user") scheduleLabel = undefined;
    if (isRunItem(item)) {
      (run ??= []).push(item);
      continue;
    }
    flush();
    blocks.push({
      type: "item",
      key: item.id,
      item,
      scheduleLabel: item.kind === "assistant" && item.proactive ? scheduleLabel : undefined,
      outcome: item.kind === "approval" ? outcomes.get(item.id) : undefined,
      approval: item.kind === "worker" ? approvedBy.get(item.id) : undefined,
      sandboxCards: item.kind === "assistant" ? replyCards.get(item.id) : undefined,
    });
  }
  flush();
  return blocks;
}
