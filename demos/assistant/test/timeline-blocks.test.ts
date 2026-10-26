import { describe, expect, it } from "vitest";
import type { ApprovalItem, AssistantItem, NoticeItem, TimelineItem, ToolItem, TriggerItem, UserItem } from "../src/shared/protocol.js";
import { dayLabel } from "../src/web/src/format.js";
import { buildBlocks, type Block } from "../src/web/src/timelineBlocks.js";

const LA = "America/Los_Angeles";
/** Friday, January 15, 2027, 2:00 PM in Los Angeles (PST, UTC-8). Far from the real date, so labels prove `now` is used. */
const NOW = new Date("2027-01-15T22:00:00Z");

/** An ISO time on a January 2027 day, as a Los Angeles clock reads it. */
const la = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2027, 0, day, hour + 8, minute)).toISOString();

const user = (id: string, at: string): UserItem => ({ kind: "user", id, at, text: "Hello" });
const reply = (id: string, at: string, proactive = false): AssistantItem => ({ kind: "assistant", id, at, text: "Done.", streaming: false, proactive });
const tool = (id: string, at: string, name = "search_email"): ToolItem => ({ kind: "tool", id, at, name, icon: "mail", title: `Used ${name}`, status: "succeeded" });
const trigger = (id: string, at: string, scheduleName?: string): TriggerItem => ({ kind: "trigger", id, at, text: "Brief me on my day.", scheduleName });
const notice = (id: string, at: string, level: NoticeItem["level"]): NoticeItem => ({ kind: "notice", id, at, level, text: "Stopped." });
/** An approval for tool call `toolCallId`; the server names it `approval:<toolCallId>`. */
const approval = (toolCallId: string, at: string, status: ApprovalItem["status"] = "approved"): ApprovalItem => ({
  kind: "approval",
  id: `approval:${toolCallId}`,
  at,
  tool: "create_event",
  title: "Add this event to your calendar?",
  preview: { type: "generic", summary: "{}" },
  status,
  actionable: status === "pending",
});

const build = (items: readonly TimelineItem[], unreadAnchor?: string) => buildBlocks(items, LA, unreadAnchor, NOW);

/** A compact picture of the blocks, like ["day:2027-01-15", "user:u1", "run:t1,t2", "unread", "assistant:a1"]. */
function shape(blocks: readonly Block[]): string[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "day":
        return block.key;
      case "unread":
        return "unread";
      case "run":
        return `run:${block.items.map((item) => item.id).join(",")}`;
      case "item":
        return `${block.item.kind}:${block.item.id}`;
    }
  });
}

function itemBlock(blocks: readonly Block[], id: string): Extract<Block, { type: "item" }> {
  const block = blocks.find((candidate): candidate is Extract<Block, { type: "item" }> => candidate.type === "item" && candidate.item.id === id);
  if (!block) throw new Error(`No item block for ${id}`);
  return block;
}

describe("buildBlocks", () => {
  it("returns nothing for an empty conversation", () => {
    expect(build([])).toEqual([]);
  });

  it("lays out a realistic two days with unique keys", () => {
    const booking = tool("c1", la(15, 10, 2), "create_event");
    const blocks = build(
      [
        user("u1", la(14, 9)),
        tool("t1", la(14, 9)),
        tool("t2", la(14, 9)),
        reply("a1", la(14, 9, 1)),
        trigger("tr1", la(15, 8), "Weekday briefing"),
        tool("t3", la(15, 8)),
        reply("a2", la(15, 8, 1), true),
        user("u2", la(15, 10)),
        tool("t4", la(15, 10)),
        approval("c1", la(15, 10, 1)),
        booking,
        reply("a3", la(15, 10, 3)),
        user("u3", la(15, 11)),
        reply("a4", la(15, 11)),
        notice("n1", la(15, 11, 1), "info"),
      ],
      "tr1",
    );
    expect(shape(blocks)).toEqual([
      "day:2027-01-14",
      "user:u1",
      "run:t1,t2",
      "assistant:a1",
      "day:2027-01-15",
      "unread",
      "run:tr1,t3",
      "assistant:a2",
      "user:u2",
      "run:t4",
      "approval:approval:c1",
      "assistant:a3",
      "user:u3",
      "assistant:a4",
      "run:n1",
    ]);
    expect(itemBlock(blocks, "a2").scheduleLabel).toBe("Weekday briefing");
    expect(itemBlock(blocks, "approval:c1").outcome).toBe(booking);
    const keys = blocks.map((block) => block.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("runs", () => {
    it("groups consecutive tool calls, schedule runs, and info notes into one run", () => {
      const items = [
        user("u1", la(15, 9)),
        tool("t1", la(15, 9, 1)),
        tool("t2", la(15, 9, 2)),
        notice("n1", la(15, 9, 3), "info"),
        trigger("tr1", la(15, 9, 4), "Weekday briefing"),
        tool("t3", la(15, 9, 5)),
        reply("a1", la(15, 9, 6), true),
      ];
      const blocks = build(items);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "user:u1", "run:t1,t2,n1,tr1,t3", "assistant:a1"]);
      // Keyed by its first item, holding the timeline's own items in order.
      expect(blocks[2]).toEqual({ type: "run", key: "run:t1", items: items.slice(1, 6) });
    });

    it("ends a run at the person's messages, replies, and approvals", () => {
      const blocks = build([
        tool("t1", la(15, 9)),
        user("u1", la(15, 9, 1)),
        tool("t2", la(15, 9, 2)),
        reply("a1", la(15, 9, 3)),
        tool("t3", la(15, 9, 4)),
        approval("c9", la(15, 9, 5), "pending"),
        tool("t4", la(15, 9, 6)),
      ]);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "run:t1", "user:u1", "run:t2", "assistant:a1", "run:t3", "approval:approval:c9", "run:t4"]);
    });

    it("keeps warnings and errors on their own, splitting the run around them", () => {
      const blocks = build([
        tool("t1", la(15, 9)),
        notice("w1", la(15, 9, 1), "warning"),
        tool("t2", la(15, 9, 2)),
        notice("e1", la(15, 9, 3), "error"),
        notice("i1", la(15, 9, 4), "info"),
      ]);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "run:t1", "notice:w1", "run:t2", "notice:e1", "run:i1"]);
      expect(itemBlock(blocks, "w1").item).toMatchObject({ level: "warning" });
    });
  });

  describe("schedule labels", () => {
    it("labels every proactive reply after a trigger with its schedule's name", () => {
      const blocks = build([
        trigger("tr1", la(15, 8), "Weekday briefing"),
        tool("t1", la(15, 8, 1)),
        reply("a1", la(15, 8, 2), true),
        tool("t2", la(15, 8, 3)),
        reply("a2", la(15, 8, 4), true),
      ]);
      expect(itemBlock(blocks, "a1").scheduleLabel).toBe("Weekday briefing");
      expect(itemBlock(blocks, "a2").scheduleLabel).toBe("Weekday briefing");
    });

    it("labels only proactive replies", () => {
      const blocks = build([trigger("tr1", la(15, 8), "Weekday briefing"), reply("a1", la(15, 8, 1), false)]);
      expect(itemBlock(blocks, "a1").scheduleLabel).toBeUndefined();
    });

    it("follows the latest trigger, including one without a schedule name", () => {
      const blocks = build([
        trigger("tr1", la(15, 8), "Weekday briefing"),
        reply("a1", la(15, 8, 1), true),
        trigger("tr2", la(15, 12), "Lunch reminder"),
        reply("a2", la(15, 12, 1), true),
        trigger("tr3", la(15, 17)),
        reply("a3", la(15, 17, 1), true),
      ]);
      expect(itemBlock(blocks, "a1").scheduleLabel).toBe("Weekday briefing");
      expect(itemBlock(blocks, "a2").scheduleLabel).toBe("Lunch reminder");
      expect(itemBlock(blocks, "a3").scheduleLabel).toBeUndefined();
    });

    it("clears the label at the person's next message", () => {
      const blocks = build([
        trigger("tr1", la(15, 8), "Weekday briefing"),
        reply("a1", la(15, 8, 1), true),
        user("u1", la(15, 9)),
        reply("a2", la(15, 9, 1), true),
      ]);
      expect(itemBlock(blocks, "a1").scheduleLabel).toBe("Weekday briefing");
      expect(itemBlock(blocks, "a2").scheduleLabel).toBeUndefined();
    });

    it("carries the label across the day and unread dividers", () => {
      const blocks = build([trigger("tr1", la(14, 23, 59), "Nightly digest"), reply("a1", la(15, 0, 1), true)], "a1");
      expect(shape(blocks)).toEqual(["day:2027-01-14", "run:tr1", "day:2027-01-15", "unread", "assistant:a1"]);
      expect(itemBlock(blocks, "a1").scheduleLabel).toBe("Nightly digest");
    });
  });

  describe("approvals", () => {
    it("attaches an approved call's progress to its approval instead of a run", () => {
      const booking = tool("c1", la(15, 9, 3), "create_event");
      const blocks = build([user("u1", la(15, 9)), tool("t1", la(15, 9, 1)), approval("c1", la(15, 9, 2)), booking, reply("a1", la(15, 9, 4))]);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "user:u1", "run:t1", "approval:approval:c1", "assistant:a1"]);
      expect(itemBlock(blocks, "approval:c1").outcome).toBe(booking);
    });

    it("finds the call wherever it sits, and it starts no day of its own", () => {
      const early = tool("c1", la(15, 9), "create_event");
      const before = build([early, approval("c1", la(15, 9, 1))]);
      expect(shape(before)).toEqual(["day:2027-01-15", "approval:approval:c1"]);
      expect(itemBlock(before, "approval:c1").outcome).toBe(early);

      const late = tool("c2", la(15, 0, 1), "create_event");
      const after = build([approval("c2", la(14, 23, 59)), late]);
      expect(shape(after)).toEqual(["day:2027-01-14", "approval:approval:c2"]);
      expect(itemBlock(after, "approval:c2").outcome).toBe(late);
    });

    it("leaves other calls in runs, and an approval without a call has no outcome", () => {
      const blocks = build([approval("c1", la(15, 9), "pending"), tool("c2", la(15, 9, 1))]);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "approval:approval:c1", "run:c2"]);
      expect(itemBlock(blocks, "approval:c1").outcome).toBeUndefined();
    });
  });

  describe("dividers", () => {
    it("starts a new day, and a new run, at local midnight", () => {
      const blocks = build([tool("t1", la(14, 23, 30)), tool("t2", la(14, 23, 45)), tool("t3", la(15, 0, 15)), reply("a1", la(15, 0, 16))]);
      expect(shape(blocks)).toEqual(["day:2027-01-14", "run:t1,t2", "day:2027-01-15", "run:t3", "assistant:a1"]);
      expect(blocks.flatMap((block) => (block.type === "day" ? [block.label] : []))).toEqual(["Yesterday", "Today"]);
    });

    it("finds days in the configured time zone", () => {
      // The same moments are 08:30 to 09:16 on January 15 in Berlin (UTC+1): one day, one run.
      const items = [tool("t1", la(14, 23, 30)), tool("t2", la(14, 23, 45)), tool("t3", la(15, 0, 15)), reply("a1", la(15, 0, 16))];
      const blocks = buildBlocks(items, "Europe/Berlin", undefined, NOW);
      expect(shape(blocks)).toEqual(["day:2027-01-15", "run:t1,t2,t3", "assistant:a1"]);
      expect(blocks[0]).toEqual({ type: "day", key: "day:2027-01-15", label: "Today" });
    });

    it("labels older days with their date", () => {
      const at = la(11, 10);
      const [day] = build([user("u1", at)]);
      expect(day).toEqual({ type: "day", key: "day:2027-01-11", label: dayLabel(at, LA, NOW) });
      expect(day?.type === "day" ? day.label : "").not.toMatch(/Today|Yesterday|Tomorrow/);
    });

    it("puts the unread divider before the first unread item, splitting a run", () => {
      const blocks = build([tool("t1", la(15, 8)), trigger("tr1", la(15, 8, 1), "Weekday briefing"), tool("t2", la(15, 8, 2)), reply("a1", la(15, 8, 3), true)], "tr1");
      expect(shape(blocks)).toEqual(["day:2027-01-15", "run:t1", "unread", "run:tr1,t2", "assistant:a1"]);
      expect(blocks.map((block) => block.key)).toEqual(["day:2027-01-15", "run:t1", "unread", "run:tr1", "a1"]);
    });

    it("puts the unread divider after the day divider when the unread item starts the day", () => {
      const blocks = build([tool("t1", la(14, 22)), reply("a1", la(15, 7), true)], "a1");
      expect(shape(blocks)).toEqual(["day:2027-01-14", "run:t1", "day:2027-01-15", "unread", "assistant:a1"]);
    });

    it("shows no unread divider when nothing is unread or the anchor isn't in the timeline", () => {
      const items = [tool("t1", la(15, 8)), reply("a1", la(15, 8, 1))];
      expect(shape(build(items))).toEqual(["day:2027-01-15", "run:t1", "assistant:a1"]);
      expect(shape(build(items, "gone"))).toEqual(["day:2027-01-15", "run:t1", "assistant:a1"]);
    });
  });
});
