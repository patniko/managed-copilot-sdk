import { describe, expect, it } from "vitest";
import { CUSTOMERS } from "../src/server/seed.js";
import { Shop } from "../src/server/shop.js";
import { APPROVAL_TOOLS, checkRequest, customerTools, systemMessage, TOOLS } from "../src/server/tools.js";
import { TOOL_NAMES } from "../src/shared/types.js";

const shop = () => new Shop(new Date("2026-11-03T15:00:00.000Z"));
const invocation = (toolCallId: string) => ({ sessionId: "s", toolCallId, toolName: "t", arguments: {} });

describe("the support tools", () => {
  it("are the eight tools the UI knows, and only refunds and cancellations need approval", () => {
    const tools = customerTools(shop(), "c01");
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.skipPermission === true, tool.name).toBe(!APPROVAL_TOOLS.has(tool.name));
      expect(TOOLS.find((info) => info.name === tool.name)?.approval, tool.name).toBe(APPROVAL_TOOLS.has(tool.name));
      expect(tool.description?.length, tool.name).toBeGreaterThan(30);
    }
  });

  it("take no customer: each session's tools can only reach its own customer's orders", async () => {
    const store = shop();
    const liam = customerTools(store, "c02");
    const sofia = customerTools(store, "c03");
    const run = (tools: ReturnType<typeof customerTools>, name: string, args: Record<string, unknown>, id = "call-1") => tools.find((tool) => tool.name === name)!.handler!(args, invocation(id));
    for (const tool of liam) expect(JSON.stringify(tool.parameters)).not.toMatch(/customer/i);
    expect(await run(liam, "get_order", { orderId: "DH-20417" })).toEqual({ ok: false, error: "No order DH-20417 on this account." });
    expect(await run(liam, "check_unlock", { orderId: "dh-20417" })).toEqual({ ok: false, error: "No order DH-20417 on this account." });
    expect(await run(liam, "request_refund", { orderId: "DH-20417", reason: "bought by mistake" })).toEqual({ ok: false, error: "No order DH-20417 on this account." });
    expect(await run(sofia, "get_order", { orderId: "DH-20417" })).toMatchObject({ orderId: "DH-20417", total: 4.99 });
    expect(await run(sofia, "request_refund", { orderId: "DH-20417", reason: "bought by mistake" }, "call-9")).toMatchObject({ ok: true, refunded: 4.99 });
    expect(await run(sofia, "request_refund", { orderId: "DH-20417", reason: "bought by mistake" }, "call-9")).toMatchObject({ ok: true, refunded: 4.99 });
    expect(store.getOrder("c03", "DH-20417")).toMatchObject({ refunded: 4.99 });
  });

  it("tell the agent what was wrong with invalid arguments", async () => {
    const tools = customerTools(shop(), "c01");
    const result = await tools.find((tool) => tool.name === "get_order")!.handler!({}, invocation("call-1"));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("orderId") });
  });

  it("check a refund or cancellation before the operator sees it", () => {
    const store = shop();
    expect(checkRequest(store, "c03", "request_refund", { orderId: "DH-20417" })).toEqual({ ok: true, amount: 4.99 });
    expect(checkRequest(store, "c04", "cancel_order", { orderId: "DH-20911" })).toEqual({ ok: true, amount: 5.99 });
    expect(checkRequest(store, "c02", "cancel_order", { orderId: "DH-20911" })).toMatchObject({ ok: false });
  });

  it("report a problem with the shop, naming only the player's own orders", async () => {
    const aisha = customerTools(shop(), "c05").find((tool) => tool.name === "report_bug")!;
    const report = {
      area: "promo-codes",
      title: "TRAIL15 rejected at checkout",
      whatHappened: "Pasted TRAIL15 from the newsletter at checkout and got 'Invalid code.'",
      expected: "TRAIL15 takes 15% off.",
    };
    expect(aisha.skipPermission).toBe(true);
    expect(await aisha.handler!({ ...report, orderId: "dh-20540" }, invocation("call-1"))).toEqual({ ok: true, area: "promo-codes", orderId: "DH-20540", sentTo: "the engineering team" });
    expect(await aisha.handler!(report, invocation("call-2"))).toEqual({ ok: true, area: "promo-codes", sentTo: "the engineering team" });
    // Sofia's order: answered like an order that doesn't exist.
    expect(await aisha.handler!({ ...report, orderId: "DH-20417" }, invocation("call-3"))).toEqual({ ok: false, error: "No order DH-20417 on this account." });
    expect(await aisha.handler!({ ...report, area: "checkout" }, invocation("call-4"))).toMatchObject({ ok: false, error: expect.stringContaining("area") });
    expect(await aisha.handler!({ area: "cart" }, invocation("call-5"))).toMatchObject({ ok: false, error: expect.stringContaining("title") });
  });

  it("brief the agent with the player's name, today's date, the shop's policy, and order privacy", () => {
    const text = systemMessage(CUSTOMERS[0]!, shop());
    expect(text).toContain("chatting with Maya");
    expect(text).toContain("Tuesday, 2026-11-03");
    expect(text).toContain("Downhill's launch day");
    expect(text).toContain("within 14 days");
    expect(text).toContain("get_order or check_unlock");
    expect(text).toContain("resolve_conversation");
  });

  it("brief the agent to report problems with the shop, and to make up for what they cost the player", () => {
    const text = systemMessage(CUSTOMERS[4]!, shop());
    expect(text).toContain("TRAIL15 (15% off everything");
    expect(text).toContain("call report_bug once");
    expect(text).toContain("partial refund of the difference");
  });
});
