import { describe, expect, it } from "vitest";
import { parseResult, Transcript } from "../src/server/projection.js";
import type { MessageItem, ToolItem } from "../src/shared/types.js";
import { event } from "./fakes.js";

const toolStart = (id: string, name: string, args: Record<string, unknown> = {}) => event("tool.execution_start", { toolCallId: id, toolName: name, arguments: args });
const toolDone = (id: string, result: unknown, success = true) => event("tool.execution_complete", { toolCallId: id, success, result: { content: JSON.stringify(result) } });
const asking = (id: string, name: string, args: Record<string, unknown> = {}) => event("permission.requested", { requestId: `r-${id}`, permissionRequest: { kind: "custom-tool", toolCallId: id, toolName: name, args } });
const answered = (id: string, kind: string) => event("permission.completed", { requestId: `r-${id}`, toolCallId: id, result: { kind } });
const tool = (transcript: Transcript, id: string) => transcript.items.find((item): item is ToolItem => item.kind === "tool" && item.id === id)!;

describe("transcript", () => {
  it("shows the customer's message, then the agent's answer as it streams in", () => {
    const transcript = new Transcript();
    expect(transcript.apply(event("user.message", { content: "Where's my tent?" }))).toBe(true);
    expect(transcript.busy).toBe(true);
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: "It's in " }, { ephemeral: true }));
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: "Denver." }, { ephemeral: true }));
    expect(transcript.items.at(-1)).toMatchObject({ kind: "message", from: "agent", text: "It's in Denver.", streaming: true });
    transcript.apply(event("assistant.message", { messageId: "m1", content: "It's in Denver, held by weather." }));
    const answer = transcript.items.at(-1) as MessageItem;
    expect(answer).toMatchObject({ from: "agent", text: "It's in Denver, held by weather." });
    expect(answer.streaming).toBeUndefined();
    transcript.apply(event("session.idle", {}, { ephemeral: true }));
    expect(transcript.busy).toBe(false);
    expect(transcript.items.map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("drops the placeholder of a message that only called tools, and ignores repeated events", () => {
    const transcript = new Transcript();
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: " " }));
    transcript.apply(event("assistant.message", { messageId: "m1", content: "", toolRequests: [{}] }));
    expect(transcript.items).toHaveLength(0);
    const same = event("user.message", { content: "Hi" });
    transcript.apply(same);
    expect(transcript.apply(same)).toBe(false);
    expect(transcript.items).toHaveLength(1);
  });

  it("follows a refund through the operator's approval to the store's answer", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "Refund my headlamp" }));
    transcript.apply(toolStart("t1", "request_refund", { orderId: "CO-48177", reason: "broken" }));
    expect(tool(transcript, "t1").status).toBe("running");
    transcript.apply(asking("t1", "request_refund"));
    expect(tool(transcript, "t1").status).toBe("asking");
    expect(transcript.asking).toHaveLength(1);
    transcript.apply(answered("t1", "approved"));
    expect(tool(transcript, "t1").status).toBe("running");
    transcript.apply(toolDone("t1", { ok: true, orderId: "CO-48177", refunded: 39 }));
    expect(tool(transcript, "t1")).toMatchObject({ status: "done", result: { refunded: 39 } });
    expect(transcript.effects()).toEqual([{ id: "t1", tool: "request_refund", args: { orderId: "CO-48177", reason: "broken" } }]);
  });

  it("keeps a declined request declined, and records no effect", () => {
    const transcript = new Transcript();
    transcript.apply(toolStart("t1", "cancel_order", { orderId: "CO-48231" }));
    transcript.apply(asking("t1", "cancel_order"));
    transcript.apply(answered("t1", "denied-interactively-by-user"));
    transcript.apply(toolDone("t1", "Permission denied", false));
    expect(tool(transcript, "t1").status).toBe("declined");
    expect(transcript.effects()).toEqual([]);
  });

  it("marks a refused call that named another customer's order as blocked", () => {
    const transcript = new Transcript((args) => args["orderId"] === "CO-48177");
    transcript.apply(toolStart("t1", "get_order", { orderId: "CO-48177" }));
    transcript.apply(toolDone("t1", { ok: false, error: "No order CO-48177 on this account." }));
    transcript.apply(toolStart("t2", "get_order", { orderId: "CO-99999" }));
    transcript.apply(toolDone("t2", { ok: false, error: "No order CO-99999 on this account." }));
    expect(tool(transcript, "t1")).toMatchObject({ status: "refused", blocked: true });
    expect(tool(transcript, "t2").status).toBe("refused");
    expect(tool(transcript, "t2").blocked).toBeUndefined();
    expect(transcript.blocked).toBe(1);
  });

  it("is resolved once the agent says so, until the customer writes again", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "When will it arrive?" }));
    transcript.apply(toolStart("t1", "resolve_conversation", { summary: "Told them Friday" }));
    transcript.apply(toolDone("t1", { ok: true }));
    expect(transcript.resolved).toBe(true);
    transcript.apply(event("user.message", { content: "One more thing" }));
    expect(transcript.resolved).toBe(false);
  });

  it("settles a turn that ended without an idle event: nothing streams or runs anymore", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "Hi" }));
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: "Hel" }));
    transcript.apply(toolStart("t1", "list_my_orders"));
    expect(transcript.settle()).toBe(true);
    expect(transcript.busy).toBe(false);
    expect((transcript.items[1] as MessageItem).streaming).toBeUndefined();
    expect(tool(transcript, "t1").status).toBe("failed");
    expect(transcript.settle()).toBe(false);
  });

  it("records an error the platform reports", () => {
    const transcript = new Transcript();
    transcript.apply(event("session.error", { message: "Rate limited" }));
    expect(transcript.problem).toBe("Rate limited");
  });

  it("reads tool results as JSON, and keeps other text", () => {
    expect(parseResult('{"ok":true}')).toEqual({ ok: true });
    expect(parseResult("Permission denied")).toEqual({ text: "Permission denied" });
    expect(parseResult("[1,2]")).toEqual({ text: "[1,2]" });
    expect(parseResult("")).toBeUndefined();
  });
});
