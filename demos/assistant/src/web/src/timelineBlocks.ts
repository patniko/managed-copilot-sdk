/**
 * How the chat timeline groups into blocks for display. Pure (no React, no DOM), so the grouping rules are unit tested
 * on their own (test/timeline-blocks.test.ts).
 */
import type { ApprovalItem, AssistantItem, NoticeItem, TimelineItem, ToolItem, TriggerItem, UserItem } from "../../shared/protocol";
import { dayKey, dayLabel } from "./format";

/** An informational note (like "Stopped."). It reads as part of the activity around it; warnings and errors stand alone. */
export type InfoNotice = NoticeItem & { readonly level: "info" };

/** Tool calls, schedule runs, and info notes between turns, shown together as one run of timeline events. */
export type RunItem = ToolItem | TriggerItem | InfoNotice;

export type Block =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string }
  | { type: "item"; key: string; item: UserItem | AssistantItem | ApprovalItem | NoticeItem; scheduleLabel?: string; outcome?: ToolItem }
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
 * - an approved call's tool progress attached to its approval card (tool `<id>` ↔ approval `approval:<id>`), not in a run.
 */
export function buildBlocks(items: readonly TimelineItem[], timeZone: string, unreadAnchor: string | undefined, now: Date = new Date()): Block[] {
  const blocks: Block[] = [];
  // A consequential tool call's progress is shown inside its approval card instead of as a separate row.
  const approvalIds = new Set(items.filter((item) => item.kind === "approval").map((item) => item.id));
  const outcomes = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === "tool" && approvalIds.has(`approval:${item.id}`)) outcomes.set(`approval:${item.id}`, item);
  }
  let lastDay: string | undefined;
  let run: RunItem[] | undefined;
  let scheduleLabel: string | undefined;
  const flush = () => {
    if (run?.length) blocks.push({ type: "run", key: `run:${run[0]!.id}`, items: run });
    run = undefined;
  };
  for (const item of items) {
    if (item.kind === "tool" && outcomes.has(`approval:${item.id}`)) continue;
    const day = dayKey(item.at, timeZone);
    if (day !== lastDay) {
      flush();
      blocks.push({ type: "day", key: `day:${day}`, label: dayLabel(item.at, timeZone, now) });
      lastDay = day;
    }
    if (item.id === unreadAnchor) {
      flush();
      blocks.push({ type: "unread", key: "unread" });
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
    });
  }
  flush();
  return blocks;
}
