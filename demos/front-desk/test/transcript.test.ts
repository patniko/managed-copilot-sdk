import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { Transcript } from "../src/server/transcript.js";

let counter = 0;
const ev = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: `e${++counter}`, parentId: null, timestamp: new Date(Date.UTC(2026, 10, 4, 6, 0, counter)).toISOString(), type, data, ...extra }) as unknown as SessionEvent;

describe("transcript", () => {
  it("ignores pieces of an answer it already has in full, as when a conversation reopens mid-answer", () => {
    const transcript = new Transcript();
    const answer = ev("assistant.message", { messageId: "a1", content: "Hello world" });
    transcript.replaceAll([ev("user.message", { messageId: "u1", content: "Hi" }), ev("assistant.turn_start"), answer]);
    // Live events that arrived while the history loaded: the same answer's pieces, the answer, then the end of the turn.
    for (const event of [ev("assistant.message_delta", { messageId: "a1", deltaContent: "Hello" }), ev("assistant.message_delta", { messageId: "a1", deltaContent: " world" }), answer, ev("session.idle")]) {
      transcript.apply(event);
    }
    expect(transcript.items).toEqual([expect.objectContaining({ kind: "user", text: "Hi" }), expect.objectContaining({ kind: "assistant", id: "a1", text: "Hello world" })]);
    expect(transcript.items[1]).not.toHaveProperty("streaming", true);
    expect(transcript.busy).toBe(false);
  });

  it("numbers the turns it works on, so a late stop can tell its turn from the next", () => {
    const transcript = new Transcript();
    transcript.markBusy();
    const stopped = transcript.turn;
    transcript.apply(ev("abort"));
    expect(transcript.busy).toBe(false);
    transcript.markBusy();
    expect(transcript.turn).toBe(stopped + 1);
  });

  it("streams an answer, then settles it when the session goes idle", () => {
    const transcript = new Transcript();
    transcript.apply(ev("user.message", { messageId: "u1", content: "Hi" }));
    expect(transcript.busy).toBe(true);
    const first = transcript.apply(ev("assistant.message_delta", { messageId: "a1", deltaContent: "Hel" }));
    expect(first).toContainEqual(expect.objectContaining({ type: "item", item: expect.objectContaining({ id: "a1", text: "Hel", streaming: true }) }));
    expect(transcript.apply(ev("assistant.message_delta", { messageId: "a1", deltaContent: "lo" }))).toContainEqual({ type: "delta", itemId: "a1", delta: "lo" });
    transcript.apply(ev("assistant.message", { messageId: "a1", content: "Hello", model: "m" }));
    const idle = transcript.apply(ev("session.idle"));
    expect(idle).toContainEqual({ type: "busy", busy: false });
    expect(transcript.items).toEqual([
      expect.objectContaining({ kind: "user", id: "u1", text: "Hi" }),
      expect.objectContaining({ kind: "assistant", id: "a1", text: "Hello", model: "m" }),
    ]);
    expect(transcript.items[1]).not.toHaveProperty("streaming", true);
  });

  it("shows memory tools in plain words, and nothing else the agent ran", () => {
    const transcript = new Transcript();
    transcript.apply(ev("tool.execution_start", { toolCallId: "t1", toolName: "remember", arguments: { fact: "Likes tea" } }));
    transcript.apply(ev("tool.execution_start", { toolCallId: "t2", toolName: "task_complete", arguments: {} }));
    const done = transcript.apply(ev("tool.execution_complete", { toolCallId: "t1", success: true }));
    expect(done).toContainEqual({ type: "memory" });
    expect(transcript.items).toEqual([expect.objectContaining({ kind: "tool", tool: "remember", label: "Remembered", detail: "Likes tea", status: "done" })]);
  });

  it("ignores sub-agent events and events it has already seen", () => {
    const transcript = new Transcript();
    const once = ev("user.message", { messageId: "u1", content: "Hi" });
    transcript.apply(once);
    expect(transcript.apply(once)).toEqual([]);
    transcript.apply(ev("assistant.message", { messageId: "s1", content: "from a sub-agent", parentToolCallId: "x" }));
    transcript.apply(ev("assistant.message", { messageId: "s2", content: "also a sub-agent" }, { agentId: "agent-1" }));
    expect(transcript.items.map((item) => item.id)).toEqual(["u1"]);
  });

  it("drops an empty answer that only asked for tools", () => {
    const transcript = new Transcript();
    transcript.apply(ev("assistant.message", { messageId: "a1", content: "", toolRequests: [{ name: "recall" }] }));
    expect(transcript.items).toEqual([]);
  });

  it("reports errors and stops, and ends the turn", () => {
    const transcript = new Transcript();
    transcript.apply(ev("user.message", { messageId: "u1", content: "Hi" }));
    transcript.apply(ev("session.error", { message: "The model isn't available.", errorType: "x" }));
    expect(transcript.busy).toBe(false);
    transcript.apply(ev("user.message", { messageId: "u2", content: "Again" }));
    transcript.apply(ev("abort", { reason: "user" }));
    expect(transcript.busy).toBe(false);
    expect(transcript.items.filter((item) => item.kind === "notice").map((item) => ("text" in item ? item.text : ""))).toEqual(["The model isn't available.", "Stopped."]);
  });

  it("tells a finished history from one whose last turn is still running", () => {
    const finished = new Transcript();
    finished.replaceAll([ev("user.message", { messageId: "u1", content: "Hi" }), ev("assistant.turn_start"), ev("assistant.message", { messageId: "a1", content: "Hello" }), ev("assistant.turn_end")]);
    expect(finished.busy).toBe(false);
    const running = new Transcript();
    running.replaceAll([ev("user.message", { messageId: "u1", content: "Hi" }), ev("assistant.turn_start"), ev("tool.execution_start", { toolCallId: "t", toolName: "recall" })]);
    expect(running.busy).toBe(true);
    const asking = new Transcript();
    asking.replaceAll([ev("user.message", { messageId: "u1", content: "Hi" }), ev("assistant.message", { messageId: "a1", content: "Let me check", toolRequests: [{ name: "recall" }] })]);
    expect(asking.busy).toBe(true);
    expect(running.settle("This answer stopped arriving.")[0]).toMatchObject({ type: "item", item: { kind: "notice", tone: "warning" } });
    expect(running.busy).toBe(false);
  });

  it("is busy as soon as a message is accepted, and not after a turn that ended before send returned", () => {
    const transcript = new Transcript();
    expect(transcript.markBusy()).toEqual([{ type: "busy", busy: true }]);
    transcript.apply(ev("user.message", { messageId: "u1", content: "Hi" }));
    transcript.apply(ev("session.idle"));
    expect(transcript.busy).toBe(false);
  });
});
