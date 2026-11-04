import { describe, expect, it } from "vitest";
import { parseSse, SseParser } from "../src/lib/sse.js";

describe("SseParser", () => {
  it("parses named events with ids", () => {
    const messages = parseSse('event: platform\nid: evt_1\ndata: {"id":"evt_1"}\n\nevent: log\ndata: {"seq":4}\n\n');
    expect(messages).toEqual([
      { event: "platform", data: '{"id":"evt_1"}', id: "evt_1" },
      { event: "log", data: '{"seq":4}', id: "evt_1" },
    ]);
  });

  it("defaults the event name to message and joins multi-line data", () => {
    expect(parseSse("data: first\ndata: second\ndata:\n\n")).toEqual([{ event: "message", data: "first\nsecond\n", id: undefined }]);
  });

  it("strips only one leading space from values", () => {
    expect(parseSse("data:  indented\n\ndata:tight\n\n").map((message) => message.data)).toEqual([" indented", "tight"]);
  });

  it("ignores comments and counts them as heartbeats", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n:\n")).toEqual([]);
    expect(parser.comments).toBe(2);
    expect(parser.push("data: after\n\n")).toEqual([{ event: "message", data: "after", id: undefined }]);
  });

  it("handles CRLF and lone CR line endings", () => {
    expect(parseSse("event: log\r\ndata: a\r\n\r\nevent: platform\rdata: b\r\r")).toEqual([
      { event: "log", data: "a", id: undefined },
      { event: "platform", data: "b", id: undefined },
    ]);
  });

  it("handles chunk boundaries anywhere, including between CR and LF", () => {
    const text = 'event: platform\r\nid: 7\r\ndata: {"a":1}\r\n\r\n: ping\r\n\r\nevent: log\r\ndata: x\r\n\r\n';
    for (let size = 1; size <= 7; size += 1) {
      const parser = new SseParser();
      const messages = [];
      for (let index = 0; index < text.length; index += size) messages.push(...parser.push(text.slice(index, index + size)));
      expect(messages).toEqual([
        { event: "platform", data: '{"a":1}', id: "7" },
        { event: "log", data: "x", id: "7" },
      ]);
    }
  });

  it("does not dispatch blocks without data, or an unterminated block", () => {
    const parser = new SseParser();
    expect(parser.push("event: platform\n\n")).toEqual([]);
    expect(parser.push("event: log\ndata: pending")).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ event: "log", data: "pending", id: undefined }]);
  });

  it("treats a field without a colon as an empty value and ignores unknown fields", () => {
    expect(parseSse("data\nfoo: bar\n\n")).toEqual([{ event: "message", data: "", id: undefined }]);
  });

  it("strips a leading byte order mark and keeps the last id across messages", () => {
    const parser = new SseParser();
    expect(parser.push("\ufeffid: 1\ndata: a\n\n")).toEqual([{ event: "message", data: "a", id: "1" }]);
    expect(parser.push("data: b\n\n")).toEqual([{ event: "message", data: "b", id: "1" }]);
    expect(parser.lastEventId).toBe("1");
  });

  it("ignores ids containing NUL and reads retry", () => {
    const parser = new SseParser();
    parser.push("id: ok\nretry: 2500\nretry: soon\n\nid: bad\u0000\ndata: z\n\n");
    expect(parser.lastEventId).toBe("ok");
    expect(parser.retryMs).toBe(2500);
  });
});
