import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { mergeEvents, timeline } from "../src/app/web-ui/lib/timeline.js";

const base = { timestamp: "2026-11-04T15:00:00Z", parentId: null };
const user: SessionEvent = { ...base, id: "user", type: "user.message", data: { content: "Hello" } };
const delta: SessionEvent = { ...base, id: "delta", type: "assistant.message_delta", ephemeral: true, data: { messageId: "reply", deltaContent: "Hi" } };
const reply: SessionEvent = { ...base, id: "final", type: "assistant.message", data: { messageId: "reply", content: "Hi there." } };

describe("timeline", () => {
  it("shows attached files from <file> elements before the prompt", () => {
    const event: SessionEvent = { ...user, data: { content: '<file path="/work/uploads/notes.txt" />\nSummarize this' } };

    expect(timeline([event])).toEqual([{ kind: "user", id: "user", content: "Summarize this", attachments: ["notes.txt"] }]);
  });

  it("streams a message before it completes", () => {
    expect(timeline([user, delta])).toEqual([
      { kind: "user", id: "user", content: "Hello" },
      { kind: "assistant", id: "reply", content: "Hi" },
    ]);
  });

  it("merges history and live events without duplicating text", () => {
    const merged = mergeEvents([user, reply], [user, delta, reply]);

    expect(timeline(merged)).toEqual([
      { kind: "user", id: "user", content: "Hello" },
      { kind: "assistant", id: "reply", content: "Hi there." },
    ]);
  });

  it("attaches tool results to the right call", () => {
    const start: SessionEvent = { ...base, id: "start", type: "tool.execution_start", data: { toolCallId: "call", toolName: "lookup", arguments: {} } };
    const finish: SessionEvent = { ...base, id: "end", type: "tool.execution_complete", data: { toolCallId: "call", success: false, error: { message: "Unavailable" } } };

    expect(timeline([start, finish])).toEqual([
      { kind: "tool", id: "call", name: "lookup", input: {}, success: false, output: undefined, error: "Unavailable" },
    ]);
  });
});
