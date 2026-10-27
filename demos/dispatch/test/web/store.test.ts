import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ConversationView } from "../../src/shared/types.js";

const api = vi.hoisted(() => ({ conversation: vi.fn(), send: vi.fn() }));

vi.mock("../../src/web/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/web/lib/api.js")>()),
  api,
}));

const { getState, loadConversation, sendMessage, settleOutgoing } = await import("../../src/web/lib/store.js");
type Outgoing = NonNullable<ReturnType<typeof getState>["outgoing"][string]>[number];

const user = (content: string, index: number, messageId?: string): ChatMessage => ({ id: `m${index}`, role: "user", content, at: "2026-10-27T12:00:00.000Z", index, via: "dispatch", ...(messageId ? { messageId } : {}) });

function view(...messages: ChatMessage[]): ConversationView {
  return {
    id: "c",
    title: "t",
    createdAt: "",
    updatedAt: "",
    status: "idle",
    messageCount: messages.length,
    sandboxCount: 0,
    liveSandboxes: 0,
    messages,
    workers: [],
    approvals: [],
    settings: { approvals: "ask" },
    busy: false,
    attachCommand: "",
  };
}

const sent = (key: number, text: string, messageId?: string, failed?: string): Outgoing => ({ key, text, at: 0, ...(messageId ? { messageId } : {}), ...(failed ? { failed } : {}) });

describe("settleOutgoing", () => {
  it("settles a sent message when the conversation shows its ID, whatever the clocks say", () => {
    const outgoing = { c: [sent(1, "add a chart", "m-1")] };
    expect(settleOutgoing(outgoing, view())).toBe(outgoing);
    expect(settleOutgoing(outgoing, view(user("add a chart", 1, "m-1")))).toEqual({});
  });

  it("never lets one arrival settle another send of the same words", () => {
    const outgoing = { c: [sent(1, "continue", "m-1"), sent(2, "continue", "m-2")] };
    const once = settleOutgoing(outgoing, view(user("continue", 1, "m-1")));
    expect(once).toEqual({ c: [outgoing.c[1]] });
    // The same snapshot again changes nothing.
    expect(settleOutgoing(once, view(user("continue", 1, "m-1")))).toBe(once);
    expect(settleOutgoing(once, view(user("continue", 1, "m-1"), user("continue", 2, "m-2")))).toEqual({});
  });

  it("keeps messages still being sent and failed sends", () => {
    const outgoing = { c: [sent(1, "go"), sent(2, "go", undefined, "Your message wasn't delivered.")] };
    expect(settleOutgoing(outgoing, view(user("go", 1, "m-9")))).toBe(outgoing);
  });
});

describe("store", () => {
  it("settles a sent message from a catch-up load when its event was missed", async () => {
    api.send.mockResolvedValue({ messageId: "m-1" });
    api.conversation.mockResolvedValueOnce(view());
    await loadConversation("c");
    await expect(sendMessage("c", "add a chart")).resolves.toBe(true);
    expect(getState().outgoing["c"]).toEqual([expect.objectContaining({ text: "add a chart", messageId: "m-1" })]);
    // The event stream was down when the message arrived; reconnecting loads the conversation again.
    api.conversation.mockResolvedValueOnce(view(user("add a chart", 1, "m-1")));
    await loadConversation("c");
    expect(getState().outgoing["c"]).toBeUndefined();
  });

  it("settles at once when the message arrived before the send returned", async () => {
    api.conversation.mockResolvedValueOnce(view(user("quick", 1, "m-2")));
    await loadConversation("c");
    api.send.mockResolvedValueOnce({ messageId: "m-2" });
    await sendMessage("c", "quick");
    expect(getState().outgoing["c"]).toBeUndefined();
  });
});