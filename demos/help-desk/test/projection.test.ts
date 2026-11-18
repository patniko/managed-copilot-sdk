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
  it("shows a proposed memory as a store_memory call that never waits for the operator", () => {
    const transcript = new Transcript();
    transcript.apply(event("permission.requested", { requestId: "r-m1", permissionRequest: { kind: "memory", action: "store", toolCallId: "m1", subject: "Returns", fact: "Return labels expire after 30 days.", citations: "Order help" } }));
    expect(tool(transcript, "m1")).toMatchObject({ name: "store_memory", status: "running", args: { subject: "Returns", fact: "Return labels expire after 30 days.", citations: "Order help" } });
    expect(transcript.asking).toEqual([]);
    transcript.apply(answered("m1", "approved"));
    transcript.apply(event("tool.execution_complete", { toolCallId: "m1", success: true, result: { content: "Memory stored successfully." } }));
    expect(tool(transcript, "m1").status).toBe("done");
  });

  it("keeps the text the agent writes alongside a store_memory call out of the customer's conversation", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "Cancel my Aurora Paint. Turning off the Painterly filter fixed my stutter, by the way." }));
    transcript.apply(event("assistant.message_delta", { messageId: "a1", deltaContent: "I'll cancel it and note the tip for the team." }, { ephemeral: true }));
    transcript.apply(event("assistant.message", { messageId: "a1", content: "I'll cancel it and note the tip for the team.", toolRequests: [{ toolCallId: "t1", name: "cancel_order" }, { toolCallId: "m1", name: "store_memory" }] }));
    transcript.apply(event("assistant.message", { messageId: "a2", content: "I've found your order.", toolRequests: [{ toolCallId: "t2", name: "get_order" }] }));
    expect(transcript.items.filter((item): item is MessageItem => item.kind === "message").map((item) => item.text)).toEqual(["Cancel my Aurora Paint. Turning off the Painterly filter fixed my stutter, by the way.", "I've found your order."]);
  });

  it("shows the customer's message, then the agent's answer as it streams in", () => {
    const transcript = new Transcript();
    expect(transcript.apply(event("user.message", { content: "Where's my Golden Mona?" }))).toBe(true);
    expect(transcript.busy).toBe(true);
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: "Her payment is " }, { ephemeral: true }));
    transcript.apply(event("assistant.message_delta", { messageId: "m1", deltaContent: "clearing." }, { ephemeral: true }));
    expect(transcript.items.at(-1)).toMatchObject({ kind: "message", from: "agent", text: "Her payment is clearing.", streaming: true });
    transcript.apply(event("assistant.message", { messageId: "m1", content: "Her payment is clearing: eChecks take 3 to 5 business days." }));
    const answer = transcript.items.at(-1) as MessageItem;
    expect(answer).toMatchObject({ from: "agent", text: "Her payment is clearing: eChecks take 3 to 5 business days." });
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

  it("follows a refund through the operator's approval to the shop's answer", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "Refund my Ruby Copilot" }));
    transcript.apply(toolStart("t1", "request_refund", { orderId: "DH-20417", reason: "bought by mistake" }));
    expect(tool(transcript, "t1").status).toBe("running");
    transcript.apply(asking("t1", "request_refund"));
    expect(tool(transcript, "t1").status).toBe("asking");
    expect(transcript.asking).toHaveLength(1);
    transcript.apply(answered("t1", "approved"));
    expect(tool(transcript, "t1").status).toBe("running");
    transcript.apply(toolDone("t1", { ok: true, orderId: "DH-20417", refunded: 4.99 }));
    expect(tool(transcript, "t1")).toMatchObject({ status: "done", result: { refunded: 4.99 } });
    expect(transcript.effects()).toEqual([{ id: "t1", tool: "request_refund", args: { orderId: "DH-20417", reason: "bought by mistake" } }]);
  });

  it("keeps a declined request declined, and records no effect", () => {
    const transcript = new Transcript();
    transcript.apply(toolStart("t1", "cancel_order", { orderId: "DH-20911" }));
    transcript.apply(asking("t1", "cancel_order"));
    transcript.apply(answered("t1", "denied-interactively-by-user"));
    transcript.apply(toolDone("t1", "Permission denied", false));
    expect(tool(transcript, "t1").status).toBe("declined");
    expect(transcript.effects()).toEqual([]);
  });

  it("marks a refused call that named another customer's order as blocked", () => {
    const transcript = new Transcript((args) => args["orderId"] === "DH-20417");
    transcript.apply(toolStart("t1", "get_order", { orderId: "DH-20417" }));
    transcript.apply(toolDone("t1", { ok: false, error: "No order DH-20417 on this account." }));
    transcript.apply(toolStart("t2", "get_order", { orderId: "DH-99999" }));
    transcript.apply(toolDone("t2", { ok: false, error: "No order DH-99999 on this account." }));
    expect(tool(transcript, "t1")).toMatchObject({ status: "refused", blocked: true });
    expect(tool(transcript, "t2").status).toBe("refused");
    expect(tool(transcript, "t2").blocked).toBeUndefined();
    expect(transcript.blocked).toBe(1);
  });

  it("is resolved once the agent says so, until the customer writes again", () => {
    const transcript = new Transcript();
    transcript.apply(event("user.message", { content: "When will it unlock?" }));
    transcript.apply(toolStart("t1", "resolve_conversation", { summary: "Told them it unlocks once the eCheck clears" }));
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

  it("projects the problem with the shop the agent reported", () => {
    const transcript = new Transcript();
    const report = { area: "promo-codes", title: " TRAIL15 rejected at checkout ", whatHappened: "Pasted TRAIL15 and got 'Invalid code.'", expected: "15% off.", orderId: "dh-20540" };
    transcript.apply(event("user.message", { content: "The code TRAIL15 says 'Invalid code.'" }));
    transcript.apply(toolStart("t1", "report_bug", report));
    expect(transcript.bug).toBeUndefined();
    transcript.apply(toolDone("t1", { ok: true, area: "promo-codes", orderId: "DH-20540", sentTo: "the engineering team" }));
    expect(transcript.bug).toEqual({ area: "promo-codes", title: "TRAIL15 rejected at checkout", whatHappened: report.whatHappened, expected: "15% off.", orderId: "DH-20540", at: tool(transcript, "t1").at });

    // A report the tool refused isn't one; the latest report that went through is the ticket's.
    transcript.apply(toolStart("t2", "report_bug", { ...report, orderId: "DH-20417" }));
    transcript.apply(toolDone("t2", { ok: false, error: "No order DH-20417 on this account." }));
    expect(transcript.bug?.orderId).toBe("DH-20540");
    transcript.apply(toolStart("t3", "report_bug", { area: "made-up", title: "Checkout page error", whatHappened: "An error page at checkout.", expected: "The order goes through." }));
    transcript.apply(toolDone("t3", { ok: true, area: "made-up", sentTo: "the engineering team" }));
    expect(transcript.bug).toMatchObject({ area: "other", title: "Checkout page error" });
    expect(transcript.bug).not.toHaveProperty("orderId");
  });

  it("rebuilds a reported problem from the session's history, which keeps no streaming or idle events", () => {
    const events = [
      event("user.message", { content: "I tapped Add to cart twice and got charged for Stealth Copilot twice." }),
      toolStart("t1", "report_bug", { area: "cart", title: "A look added twice is charged twice", whatHappened: "Tapped Add to cart twice, charged twice.", expected: "Charged once." }),
      toolDone("t1", { ok: true, area: "cart", sentTo: "the engineering team" }),
      event("assistant.message_delta", { messageId: "m1", deltaContent: "I reported it" }, { ephemeral: true }),
      event("assistant.message", { messageId: "m1", content: "I reported it to our engineering team." }),
      event("session.idle", {}, { ephemeral: true }),
    ];
    const live = new Transcript();
    for (const item of events) live.apply(item);
    const rebuilt = new Transcript();
    for (const item of events.filter((candidate) => !(candidate as { ephemeral?: boolean }).ephemeral)) rebuilt.apply(item);
    expect(rebuilt.bug).toEqual(live.bug);
    expect(rebuilt.bug).toMatchObject({ area: "cart", title: "A look added twice is charged twice", expected: "Charged once." });
  });

  it("reads tool results as JSON, and keeps other text", () => {
    expect(parseResult('{"ok":true}')).toEqual({ ok: true });
    expect(parseResult("Permission denied")).toEqual({ text: "Permission denied" });
    expect(parseResult("[1,2]")).toEqual({ text: "[1,2]" });
    expect(parseResult("")).toBeUndefined();
  });
});
