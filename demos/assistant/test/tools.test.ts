import type { Tool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { EffectLedger } from "../src/server/effects.js";
import { createLogger } from "../src/server/log.js";
import { Store } from "../src/server/store.js";
import { isoInZone } from "../src/server/time.js";
import { DemoWorkspace, parseMailQuery } from "../src/server/tools/demo/provider.js";
import { APPROVAL_TOOLS, createTools } from "../src/server/tools/index.js";

const LA = "America/Los_Angeles";
const NOW = new Date("2026-10-23T17:30:00Z"); // Friday 10:30 AM PDT

function setup() {
  const store = new Store(":memory:");
  store.upsertUser({ id: 42, login: "octo", name: "Octo Cat" });
  const workspace = new DemoWorkspace(store, { accountId: 42, name: "Octo Cat", address: "octo@example.com" }, () => LA);
  workspace.reset(NOW);
  const offline: string[] = [];
  const tools = createTools({
    workspace: async () => workspace,
    timeZone: () => LA,
    effects: new EffectLedger(store),
    log: createLogger("test"),
    onCall: (id) => offline.push(id),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let seq = 0;
  const call = async (name: string, args: unknown, toolCallId = `call_${++seq}`) => {
    const tool = byName.get(name) as Tool<unknown>;
    const invocation: ToolInvocation = { sessionId: "s1", toolCallId, toolName: name, arguments: args };
    const result = await tool.handler!(args, invocation);
    return result as Record<string, unknown> & Partial<ToolResultObject>;
  };
  return { store, workspace, tools, call, offline };
}

describe("demo workspace", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("seeds a realistic inbox and calendar relative to now", async () => {
    const unread = await ctx.workspace.mail.search({ query: "is:unread", max: 25 });
    expect(unread.length).toBeGreaterThanOrEqual(6);
    expect(unread[0]!.subject).toMatch(/Urgent/);
    const events = await ctx.workspace.calendar.list({ start: new Date("2026-10-23T07:00:00Z"), end: new Date("2026-10-24T07:00:00Z") });
    expect(events.map((e) => e.title)).toContain("1:1 with Priya");
    // Every address is a reserved example domain.
    const all = await ctx.workspace.mail.search({ query: "in:anywhere", max: 50 });
    for (const message of all) expect(message.fromEmail).toMatch(/\.example$|example\.(com|org|net)$/);
  });

  it("supports Gmail-style queries", async () => {
    expect(parseMailQuery('from:sam is:unread "launch plan" newer_than:2d')).toMatchObject({ from: ["sam"], unread: true, words: ["launch plan"] });
    const fromSam = await ctx.workspace.mail.search({ query: "from:sam", max: 10 });
    expect(fromSam.map((m) => m.subject)).toEqual(["Q3 launch plan: can we find 30 minutes?", "Beta cohort shortlist"]);
    const sent = await ctx.workspace.mail.search({ query: "in:sent", max: 10 });
    expect(sent).toHaveLength(1);
  });

  it("keeps each account's data separate", async () => {
    const other = new DemoWorkspace(ctx.store, { accountId: 7, name: "Other", address: "other@example.com" }, () => LA);
    other.reset(NOW);
    await other.mail.send({ to: ["sam.rivera@contoso.example"], subject: "Only mine", body: "x" });
    expect(await ctx.workspace.mail.search({ query: "subject:only", max: 10 })).toHaveLength(0);
    expect(await other.mail.search({ query: "in:sent subject:only", max: 10 })).toHaveLength(1);
  });
});

describe("assistant tools", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("asks for approval only on consequential tools", () => {
    for (const tool of ctx.tools) expect(Boolean(tool.skipPermission)).toBe(!APPROVAL_TOOLS.has(tool.name));
    expect([...APPROVAL_TOOLS].sort()).toEqual(["create_event", "delete_event", "send_email", "update_event"]);
  });

  it("publishes JSON schemas from zod", () => {
    const send = ctx.tools.find((tool) => tool.name === "send_email")!;
    const schema = (send.parameters as { toJSONSchema(): { properties: Record<string, unknown>; required: string[] } }).toJSONSchema();
    expect(Object.keys(schema.properties)).toEqual(["to", "cc", "subject", "body", "replyToId"]);
    expect(schema.required).toEqual(["to", "subject", "body"]);
  });

  it("searches and reads mail", async () => {
    const result = await ctx.call("search_email", { query: "is:unread is:important" });
    expect(result.mailbox).toMatch(/Demo workspace/);
    const messages = result.messages as { id: string; subject: string }[];
    expect(messages.length).toBeGreaterThan(0);
    const read = await ctx.call("read_email", { id: messages[0]!.id });
    expect(read.body).toMatch(/502/);
  });

  it("returns readable failures for bad input", async () => {
    const result = await ctx.call("send_email", { to: [], subject: "x", body: "y" });
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toMatch(/Invalid arguments for send_email/);
    const missing = await ctx.call("read_email", { id: "msg_nope" });
    expect(missing.textResultForLlm).toMatch(/No message with id/);
    const badTime = await ctx.call("list_events", { start: "next tuesday", end: "2026-10-30" });
    expect(badTime.textResultForLlm).toMatch(/ISO 8601/);
  });

  it("sends mail once per tool call, even when the call is replayed", async () => {
    const args = { to: ["sam.rivera@contoso.example"], subject: "Re: Q3 launch plan", body: "Monday 9:00 works.", replyToId: "msg_002" };
    const first = await ctx.call("send_email", args, "call_send");
    const replay = await ctx.call("send_email", args, "call_send");
    expect(replay).toEqual(first);
    const sent = await ctx.workspace.mail.search({ query: "in:sent subject:\"Re: Q3\"", max: 10 });
    expect(sent).toHaveLength(1);
    expect(ctx.offline).toContain("call_send");
  });

  it("creates, moves, and deletes events in the person's time zone", async () => {
    const created = await ctx.call("create_event", {
      title: "Q3 launch plan review",
      start: "2026-10-26T09:00",
      end: "2026-10-26T09:30",
      attendees: ["sam.rivera@contoso.example", "octo@example.com"],
    });
    const event = created.event as { id: string; start: string; attendees: string[] };
    expect(event.start).toBe("2026-10-26T09:00:00-07:00");
    expect(event.attendees).toEqual(["sam.rivera@contoso.example"]);

    const moved = await ctx.call("update_event", { id: event.id, start: "2026-10-27T10:00:00-07:00" });
    const after = moved.event as { start: string; end: string };
    expect(after.start).toBe("2026-10-27T10:00:00-07:00");
    expect(after.end).toBe("2026-10-27T10:30:00-07:00");

    const deleted = await ctx.call("delete_event", { id: event.id });
    expect(deleted).toMatchObject({ status: "Deleted", title: "Q3 launch plan review" });
    const bad = await ctx.call("create_event", { title: "x", start: "2026-10-26T10:00", end: "2026-10-26T09:00" });
    expect(bad.textResultForLlm).toMatch(/end after it starts/);
  });

  it("finds free time around existing events", async () => {
    const result = await ctx.call("find_free_time", { start: "2026-10-26T00:00", end: "2026-10-27T00:00", durationMinutes: 30 });
    const suggestions = result.suggestions as { start: string }[];
    expect(suggestions.length).toBeGreaterThan(0);
    // The standup (9:30-9:45) and design review (10-11) are busy on Monday.
    for (const slot of suggestions) {
      const start = slot.start.slice(11, 16);
      expect(["09:30", "10:00", "10:30"]).not.toContain(start);
    }
    expect(isoInZone(new Date(suggestions[0]!.start), LA)).toBe(suggestions[0]!.start);
  });
});
