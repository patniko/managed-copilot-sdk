import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { describeApproval, describeTool, humanizeName, scheduleDisplayName, scheduleIdFrom } from "../src/server/describe.js";
import { approvalItemId, Timeline } from "../src/server/timeline.js";

let seq = 0;
function event(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEvent {
  seq++;
  return { id: `evt-${seq}`, parentId: null, timestamp: new Date(Date.UTC(2026, 9, 23, 17, 0, seq)).toISOString(), type, data, ...extra } as unknown as SessionEvent;
}

function timeline(actionable = new Set<string>()) {
  return new Timeline({
    timeZone: () => "America/Los_Angeles",
    scheduleNameFor: (_id, text) => (text.startsWith("Remind me") ? "Call Sam" : undefined),
    isOffline: (id) => id === "call-offline",
    isActionable: (id) => actionable.has(id),
  });
}

describe("Timeline", () => {
  it("renders a streamed turn with a tool call", () => {
    const t = timeline();
    t.apply(event("user.message", { content: "Triage my inbox", messageId: "m1" }));
    expect(t.apply(event("assistant.turn_start", { turnId: "t1" }))).toEqual([{ type: "busy", busy: true }]);
    t.apply(event("tool.execution_start", { toolCallId: "c1", toolName: "search_email", arguments: { query: "is:unread" } }));
    t.apply(event("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: JSON.stringify({ count: 7 }) } }));
    t.apply(event("assistant.message_delta", { messageId: "a1", deltaContent: "7 unread" }, { ephemeral: true }));
    const delta = t.apply(event("assistant.message_delta", { messageId: "a1", deltaContent: " messages" }, { ephemeral: true }));
    expect(delta).toEqual([{ type: "delta", id: "a1", text: " messages" }]);
    t.apply(event("assistant.message", { messageId: "a1", content: "7 unread messages." }));
    const idle = t.apply(event("session.idle", {}, { ephemeral: true }));
    expect(idle).toContainEqual({ type: "busy", busy: false });

    const items = t.list();
    expect(items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
    expect(items[1]).toMatchObject({ title: "Searched your inbox for “is:unread”", detail: "7 messages", status: "succeeded" });
    expect(items[2]).toMatchObject({ text: "7 unread messages.", streaming: false, proactive: false });
  });

  it("treats schedule-delivered prompts as triggers and flags proactive replies", () => {
    const t = timeline();
    t.apply(event("user.message", { content: "Remind me to call Sam", source: "system", messageId: "m2" }));
    t.apply(event("assistant.turn_start", { turnId: "t2" }));
    t.apply(event("assistant.message", { messageId: "a2", content: "⏰ Time to call Sam about the launch plan." }));
    const changes = t.apply(event("session.idle", {}, { ephemeral: true }));
    expect(changes).toContainEqual({ type: "proactive", itemId: "a2", text: "⏰ Time to call Sam about the launch plan." });
    const [trigger, reply] = t.list();
    expect(trigger).toMatchObject({ kind: "trigger", scheduleName: "Call Sam" });
    expect(reply).toMatchObject({ kind: "assistant", proactive: true });
  });

  it("hides sub-agent activity, injected messages, and internal tools", () => {
    const t = timeline();
    t.apply(event("user.message", { content: "skill text", source: "skill-pdf" }));
    t.apply(event("assistant.message", { messageId: "sub", content: "from a sub-agent" }, { agentId: "agent-1" }));
    t.apply(event("tool.execution_start", { toolCallId: "c2", toolName: "report_intent", arguments: {} }));
    t.apply(event("tool.execution_complete", { toolCallId: "c2", success: true }));
    t.apply(event("assistant.message", { messageId: "empty", content: "" }));
    expect(t.list()).toEqual([]);
  });

  it("tracks approvals from permission events and keys them by tool call", () => {
    const actionable = new Set<string>();
    const t = timeline(actionable);
    t.apply(event("tool.execution_start", { toolCallId: "c3", toolName: "send_email", arguments: { to: ["sam@contoso.example"], subject: "Hi", body: "Hello" } }));
    t.apply(
      event("permission.requested", {
        requestId: "r1",
        permissionRequest: { kind: "custom-tool", toolName: "send_email", toolCallId: "c3", toolDescription: "", args: { to: ["sam@contoso.example"], subject: "Hi", body: "Hello" } },
      }),
    );
    const approval = t.get("approval:c3");
    expect(approval).toMatchObject({ kind: "approval", status: "pending", actionable: false, title: "Send this email to sam@contoso.example?" });
    actionable.add("approval:c3");
    expect(t.refresh()).toHaveLength(1);
    t.apply(event("permission.completed", { requestId: "r1", result: { kind: "approved" } }));
    expect(t.get("approval:c3")).toMatchObject({ status: "approved", actionable: false });
    t.apply(
      event("permission.requested", { requestId: "r2", permissionRequest: { kind: "custom-tool", toolName: "delete_event", toolCallId: "c4", toolDescription: "", args: { id: "evt_1" } } }),
    );
    t.apply(event("permission.completed", { requestId: "r2", result: { kind: "denied-interactively-by-user", feedback: "Keep it" } }));
    expect(t.get("approval:c4")).toMatchObject({ status: "denied", feedback: "Keep it" });
  });

  it("rebuilds from history without idle events and dedupes live replays", () => {
    const history = [
      event("user.message", { content: "Hello", messageId: "m1" }),
      event("assistant.turn_start", { turnId: "t1" }),
      event("assistant.message", { messageId: "a1", content: "Hi!" }),
      event("assistant.turn_end", { turnId: "t1" }),
    ];
    const t = timeline();
    t.replaceAll(history);
    expect(t.busy).toBe(false);
    expect(t.apply(history[2]!)).toEqual([]);

    const running = timeline();
    running.replaceAll([...history, event("user.message", { content: "Next", messageId: "m2" }), event("assistant.turn_start", { turnId: "t2" })]);
    expect(running.busy).toBe(true);
  });

  it("marks tool calls answered while no client was attached", () => {
    const t = timeline();
    t.apply(event("tool.execution_start", { toolCallId: "call-offline", toolName: "list_events", arguments: { start: "2026-10-26", end: "2026-10-27" } }));
    expect(t.get("call-offline")).toMatchObject({ handledOffline: true });
  });

  it("ignores late deltas for a message that already completed", () => {
    const t = timeline();
    t.apply(event("assistant.message", { messageId: "a9", content: "Done." }));
    expect(t.apply(event("assistant.message_delta", { messageId: "a9", deltaContent: "Do" }, { ephemeral: true }))).toEqual([]);
    expect(t.get("a9")).toMatchObject({ text: "Done.", streaming: false });
  });

  it("treats stopped or failed turns as finished when rebuilding", () => {
    const stopped = timeline();
    stopped.replaceAll([
      event("user.message", { content: "Search everything", messageId: "m1" }),
      event("assistant.turn_start", { turnId: "t1" }),
      event("tool.execution_start", { toolCallId: "c9", toolName: "search_email", arguments: { query: "x" } }),
      event("abort", { reason: "user initiated" }),
    ]);
    expect(stopped.busy).toBe(false);
    expect(stopped.get("c9")).toMatchObject({ status: "failed", error: "Stopped before it finished." });

    const failed = timeline();
    failed.replaceAll([event("assistant.turn_start", { turnId: "t2" }), event("session.error", { errorType: "model", message: "Model unavailable" })]);
    expect(failed.busy).toBe(false);
  });

  it("keeps looked-up event details on approval cards when rebuilding", () => {
    const t = timeline();
    const current = { title: "Dentist", start: "2026-10-27T17:00:00.000Z", end: "2026-10-27T18:00:00.000Z" };
    t.enrichApproval("approval:c10", describeApproval("delete_event", { id: "evt_9" }, "America/Los_Angeles", current));
    t.replaceAll([
      event("permission.requested", {
        requestId: "r10",
        permissionRequest: { kind: "custom-tool", toolName: "delete_event", toolCallId: "c10", toolDescription: "", args: { id: "evt_9" } },
      }),
    ]);
    expect(t.get("approval:c10")).toMatchObject({ title: "Cancel “Dentist”?", preview: { current } });
  });

  it("names trigger pills once their schedules are known", () => {
    const names = new Map<string, string>();
    const t = new Timeline({ timeZone: () => "UTC", scheduleNameFor: (_id, text) => names.get(text), isOffline: () => false, isActionable: () => false });
    t.apply(event("user.message", { content: "Brief me", source: "system", messageId: "m5" }));
    expect(t.get("m5")).toMatchObject({ kind: "trigger", scheduleName: undefined });
    names.set("Brief me", "Morning briefing");
    expect(t.refresh()).toEqual([{ type: "item", item: expect.objectContaining({ id: "m5", scheduleName: "Morning briefing" }) }]);
  });

  it("keys approvals without a tool call by their full arguments", () => {
    const body = "x".repeat(300);
    const a = approvalItemId({ toolName: "send_email", args: { to: ["sam@contoso.example"], body: `${body}a` } });
    const b = approvalItemId({ toolName: "send_email", args: { to: ["sam@contoso.example"], body: `${body}b` } });
    expect(a).not.toBe(b);
    expect(approvalItemId({ toolCallId: "c1", toolName: "send_email" })).toBe("approval:c1");
  });
});

describe("descriptions", () => {
  it("humanizes schedule names", () => {
    expect(humanizeName("stretch-water-reminder")).toBe("Stretch water reminder");
    expect(humanizeName("stretch-water-reminder-2QQq")).toBe("Stretch water reminder");
    expect(humanizeName("Stretch reminder-UIEP")).toBe("Stretch reminder");
    expect(humanizeName("report-2024")).toBe("Report 2024");
    expect(humanizeName("q3-launch-plan")).toBe("Q3 launch plan");
    expect(humanizeName("Weekday morning briefing")).toBe("Weekday morning briefing");
    expect(scheduleDisplayName("task-Yb4iEB", "Remind Patrick to stretch and grab some water.")).toBe("Remind Patrick to stretch and grab some water");
    expect(scheduleDisplayName("call-sam", "Remind me to call Sam")).toBe("Call sam");
  });

  it("describes scheduling tools and extracts schedule IDs", () => {
    const at = new Date("2026-10-23T23:00:00Z");
    const oneShot = describeTool("schedule_task", { name: "Call Sam", runAt: "2026-10-23T16:00:00-07:00" }, "succeeded", "Scheduled sch_abc123 for 4:00 PM", "America/Los_Angeles", at);
    expect(oneShot).toMatchObject({ icon: "bell", title: "Set a reminder" });
    expect(oneShot.detail).toMatch(/Call Sam/);
    const recurring = describeTool("schedule_task", { prompt: "Brief me", cron: "0 8 * * 1-5", timeZone: "America/Los_Angeles" }, "running", undefined, "America/Los_Angeles", at);
    expect(recurring).toMatchObject({ icon: "repeat", detail: "“Brief me” · Every weekday at 8:00 AM" });
    expect(scheduleIdFrom("Scheduled sch_abc123 for 4:00 PM")).toBe("sch_abc123");
    expect(scheduleIdFrom(JSON.stringify({ schedule: { id: "s-42-xyz" } }))).toBe("s-42-xyz");
  });

  it("builds approval previews with times in the person's zone", () => {
    const create = describeApproval("create_event", { title: "Sync", start: "2026-10-26T09:00", end: "2026-10-26T09:30", attendees: ["sam@contoso.example"] }, "America/Los_Angeles");
    expect(create.preview).toMatchObject({ type: "event", action: "create", start: "2026-10-26T16:00:00.000Z", end: "2026-10-26T16:30:00.000Z" });
    const update = describeApproval("update_event", { id: "evt_1", start: "2026-10-27T10:00" }, "America/Los_Angeles", { title: "Sync", start: "x", end: "y" });
    expect(update.title).toBe("Change “Sync”?");
  });
});
