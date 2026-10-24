import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { describeSessionError, parseTestSummary, StationActivityMapper, summarizeToolCall } from "../src/server/pipeline/activity.js";
import { chooseModels } from "../src/server/models.js";
import { FactoryStore } from "../src/server/store.js";
import { createZip, crc32 } from "../src/server/zip.js";
import type { ActivityItem, TestSummary, UsageSummary } from "../src/shared/types.js";

const event = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: "e", parentId: null, timestamp: "", type, data, ...extra }) as unknown as SessionEvent;

function collect() {
  const items = new Map<string, ActivityItem>();
  const deltas: string[] = [];
  const tests: TestSummary[] = [];
  const usage: UsageSummary[] = [];
  const mapper = new StationActivityMapper("wo", "build:a", {
    item: (item) => items.set(item.id, item),
    delta: (_id, text) => deltas.push(text),
    tests: (summary) => tests.push(summary),
    usage: (value) => usage.push(value),
  });
  return { mapper, items, deltas, tests, usage };
}

describe("activity mapper", () => {
  it("streams root deltas and records complete messages", () => {
    const { mapper, items, deltas } = collect();
    mapper.handle(event("assistant.message_delta", { messageId: "m1", deltaContent: "Hel" }));
    mapper.handle(event("assistant.message_delta", { messageId: "m2", deltaContent: "sub" }, { agentId: "explore" }));
    mapper.handle(event("assistant.message", { messageId: "m1", content: "Hello" }));
    expect(deltas).toEqual(["Hel"]);
    expect(items.get("msg:m1")).toMatchObject({ kind: "message", text: "Hello" });
    expect(mapper.lastMessage).toBe("Hello");
  });

  it("turns tool calls into rows and harness output into test results", () => {
    const { mapper, items, tests } = collect();
    mapper.handle(event("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "npm run check" } }));
    expect(items.get("tool:c1")?.tool).toMatchObject({ status: "running", summary: "npm run check" });
    mapper.handle(
      event("tool.execution_complete", {
        toolCallId: "c1",
        success: true,
        result: { content: 'ok\nFACTORY_TEST_SUMMARY {"total":3,"passed":2,"failed":1,"skipped":0,"durationMs":12}' },
        shellExecution: { exitCode: 1 },
      }),
    );
    expect(items.get("tool:c1")?.tool).toMatchObject({ status: "failed", exitCode: 1 });
    expect(items.get("test:c1")).toMatchObject({ kind: "test", level: "error", text: "2 passed · 1 failed" });
    expect(tests[0]).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it("hides bookkeeping tools, deduplicates intents, and tracks usage", () => {
    const { mapper, items, usage } = collect();
    mapper.handle(event("tool.execution_start", { toolCallId: "c2", toolName: "report_intent", arguments: {} }));
    mapper.handle(event("assistant.intent", { intent: "Writing the parser" }));
    mapper.handle(event("assistant.intent", { intent: "Writing the parser" }));
    mapper.handle(event("assistant.usage", { model: "m", inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, duration: 30 }));
    mapper.handle(event("assistant.usage", { model: "m", inputTokens: 5, outputTokens: 1 }));
    expect([...items.values()].map((item) => item.kind)).toEqual(["intent"]);
    expect(usage.at(-1)).toEqual({ inputTokens: 15, outputTokens: 3, cacheReadTokens: 4, requests: 2, durationMs: 30 });
  });

  it("fails tool rows left running when a turn stops", () => {
    const { mapper, items } = collect();
    mapper.handle(event("tool.execution_start", { toolCallId: "c3", toolName: "view", arguments: { path: "/workspace/src/a.js" } }));
    expect(items.get("tool:c3")?.tool?.summary).toBe("view src/a.js");
    mapper.handle(event("abort", { reason: "user" }));
    expect(items.get("tool:c3")?.tool?.status).toBe("failed");
  });

  it("summarizes tools and errors without stack traces", () => {
    expect(summarizeToolCall("submit_review", { verdict: "approve" })).toBe("Submitting the review: approve");
    expect(summarizeToolCall("grep", { pattern: "TODO" })).toBe("grep TODO");
    expect(describeSessionError({ errorType: "rate_limit", message: "Too many requests\n    at stack" })).toBe("Model rate limit reached: Too many requests");
    expect(parseTestSummary("no marker")).toBeUndefined();
    expect(parseTestSummary('FACTORY_TEST_SUMMARY {"total":"x"}')).toMatchObject({ total: 0 });
    // Only a harness line counts: the marker quoted mid-line (as in SKILL.md) does not.
    expect(parseTestSummary('a line such as `FACTORY_TEST_SUMMARY {"total":9,"passed":9}`.')).toBeUndefined();
    expect(parseTestSummary('FACTORY_TEST_SUMMARY {"total":1,"passed":1}\r\nFACTORY_TEST_SUMMARY {"total":2,"passed":2}\r\n')).toMatchObject({ total: 2 });
  });

  it("only treats shell output as a test run", () => {
    const { mapper, items, tests } = collect();
    mapper.handle(event("tool.execution_start", { toolCallId: "v1", toolName: "view", arguments: { path: "SKILL.md" } }));
    mapper.handle(event("tool.execution_complete", { toolCallId: "v1", success: true, result: { content: 'FACTORY_TEST_SUMMARY {"total":9,"passed":9}' } }));
    expect(items.has("test:v1")).toBe(false);
    expect(tests).toEqual([]);
  });
});

describe("model selection", () => {
  it("picks available models and keeps the reviewer on a different family than the builder", () => {
    const available = ["claude-haiku-5.5", "claude-sonnet-5", "gpt-5.6-terra"].map((id) => ({ id, policy: { state: "enabled" } }));
    expect(chooseModels(available)).toEqual({ planner: "claude-haiku-5.5", builder: "claude-sonnet-5", reviewer: "gpt-5.6-terra", release: "claude-sonnet-5" });
    expect(chooseModels(available, { reviewer: "claude-sonnet-5" }).reviewer).toBe("claude-sonnet-5");
    expect(chooseModels([{ id: "gpt-5.6-terra", policy: { state: "disabled" } }, { id: "gpt-6-luna" }]).reviewer).toBe("gpt-6-luna");
    expect(chooseModels(undefined).builder).toBe("claude-sonnet-5");
  });
});

describe("factory store", () => {
  it("persists work orders, ordered activity, and artifact versions", () => {
    const store = new FactoryStore(":memory:");
    expect([store.nextWorkOrderNumber(), store.nextWorkOrderNumber()]).toEqual([1, 2]);
    const base = { workOrderId: "wo", stationId: "s", at: "", kind: "status" as const };
    store.upsertActivity({ ...base, id: "a", text: "first" });
    store.upsertActivity({ ...base, id: "b", text: "second" });
    store.upsertActivity({ ...base, id: "a", text: "first (updated)" });
    expect(store.listActivity("wo").map((item) => item.text)).toEqual(["first (updated)", "second"]);
    const artifact = { workOrderId: "wo", stationId: "s", path: "a.js", round: 1, size: 1, digest: "d", contentType: "text/plain", publishedAt: "" };
    store.putArtifact({ ...artifact, version: 1, content: "v1" });
    store.putArtifact({ ...artifact, version: 2, content: "v2" });
    store.putArtifact({ ...artifact, path: "img.png", version: 1 });
    expect(store.getArtifact("wo", "s", "a.js")?.content).toBe("v2");
    expect(store.getArtifact("wo", "s", "a.js", 1)?.content).toBe("v1");
    expect(store.latestArtifacts("wo", "s").map((item) => `${item.path}@${item.version}`)).toEqual(["a.js@2", "img.png@1"]);
    expect(store.listArtifacts("wo").find((item) => item.path === "img.png")?.hasContent).toBe(false);
    store.deleteWorkOrder("wo");
    expect(store.listActivity("wo")).toEqual([]);
    store.close();
  });
});

describe("zip writer", () => {
  it("writes a readable archive with correct checksums", () => {
    const zip = createZip([
      { path: "csvjson/README.md", content: "# hi\n" },
      { path: "csvjson/bin/cli.js", content: "#!/usr/bin/env node\n" },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    let offset = zip.readUInt32LE(end + 16);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
      const nameLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      const local = zip.readUInt32LE(offset + 42);
      const size = zip.readUInt32LE(local + 18);
      const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26), local + 30 + zip.readUInt16LE(local + 26) + size);
      expect(crc32(data)).toBe(zip.readUInt32LE(offset + 16));
      names.push(name);
      offset += 46 + nameLength;
    }
    expect(names).toEqual(["csvjson/README.md", "csvjson/bin/cli.js"]);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
