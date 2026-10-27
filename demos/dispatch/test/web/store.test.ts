import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ConversationView } from "../../src/shared/types.js";

const api = vi.hoisted(() => ({ conversation: vi.fn(), send: vi.fn() }));

vi.mock("../../src/web/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/web/lib/api.js")>()),
  api,
}));

const { getState, loadConversation, sendMessage, settleOutgoing } = await import("../../src/web/lib/store.js");
type Outgoing = NonNullable<ReturnType<typeof getState>["outgoing"][string]>[number];

const user = (content: string, index: number): ChatMessage => ({ id: `m${index}`, role: "user", content, at: "2026-10-27T12:00:00.000Z", index, via: "dispatch" });

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

const sent = (key: number, text: string, baseline: number, failed?: string): Outgoing => ({ key, text, at: 0, baseline, ...(failed ? { failed } : {}) });

describe("settleOutgoing", () => {
  it("settles a sent message once the conversation shows it, whatever the clocks say", () => {
    const outgoing = { c: [sent(1, "add a chart", 0)] };
    expect(settleOutgoing(outgoing, view())).toBe(outgoing);
    // The platform's timestamp can be minutes off the browser's: arrival is counted, not timed.
    expect(settleOutgoing(outgoing, view(user("add a chart", 1)))).toEqual({});
  });

  it("settles repeated texts one arrival at a time, and ignores messages that were already there", () => {
    const outgoing = { c: [sent(1, "continue", 1), sent(2, "continue", 1)] };
    expect(settleOutgoing(outgoing, view(user("continue", 1)))).toBe(outgoing);
    expect(settleOutgoing(outgoing, view(user("continue", 1), user("continue", 2)))).toEqual({ c: [outgoing.c[1]] });
    expect(settleOutgoing(outgoing, view(user("continue", 1), user("continue", 2), user("continue", 3)))).toEqual({});
  });

  it("keeps failed sends until they're dismissed", () => {
    const outgoing = { c: [sent(1, "go", 0, "Your message wasn't delivered.")] };
    expect(settleOutgoing(outgoing, view(user("go", 1)))).toBe(outgoing);
  });
});

describe("store", () => {
  it("settles a sent message from a catch-up load when its event was missed", async () => {
    api.send.mockResolvedValue(undefined);
    api.conversation.mockResolvedValueOnce(view());
    await loadConversation("c");
    await expect(sendMessage("c", "add a chart")).resolves.toBe(true);
    expect(getState().outgoing["c"]).toHaveLength(1);
    // The event stream was down when the message arrived; reconnecting loads the conversation again.
    api.conversation.mockResolvedValueOnce(view(user("add a chart", 1)));
    await loadConversation("c");
    expect(getState().outgoing["c"]).toBeUndefined();
  });
});
