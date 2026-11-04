import { describe, expect, it } from "vitest";
import { CUSTOMERS } from "../src/server/seed.js";
import { Shop } from "../src/server/shop.js";
import { APPROVAL_TOOLS, checkRequest, customerTools, systemMessage, TOOLS } from "../src/server/tools.js";
import { TOOL_NAMES } from "../src/shared/types.js";

const shop = () => new Shop(new Date("2026-11-03T15:00:00.000Z"));
const invocation = (toolCallId: string) => ({ sessionId: "s", toolCallId, toolName: "t", arguments: {} });

describe("the store's tools", () => {
  it("are the six tools the UI knows, and only refunds and cancellations need approval", () => {
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
    expect(await run(liam, "get_order", { orderId: "CO-48177" })).toEqual({ ok: false, error: "No order CO-48177 on this account." });
    expect(await run(liam, "track_shipment", { orderId: "co-48177" })).toEqual({ ok: false, error: "No order CO-48177 on this account." });
    expect(await run(liam, "request_refund", { orderId: "CO-48177", reason: "broken" })).toEqual({ ok: false, error: "No order CO-48177 on this account." });
    expect(await run(sofia, "get_order", { orderId: "CO-48177" })).toMatchObject({ orderId: "CO-48177", total: 39 });
    expect(await run(sofia, "request_refund", { orderId: "CO-48177", reason: "broken" }, "call-9")).toMatchObject({ ok: true, refunded: 39 });
    expect(await run(sofia, "request_refund", { orderId: "CO-48177", reason: "broken" }, "call-9")).toMatchObject({ ok: true, refunded: 39 });
    expect(store.getOrder("c03", "CO-48177")).toMatchObject({ refunded: 39 });
  });

  it("tell the agent what was wrong with invalid arguments", async () => {
    const tools = customerTools(shop(), "c01");
    const result = await tools.find((tool) => tool.name === "get_order")!.handler!({}, invocation("call-1"));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("orderId") });
  });

  it("check a refund or cancellation before the operator sees it", () => {
    const store = shop();
    expect(checkRequest(store, "c03", "request_refund", { orderId: "CO-48177" })).toEqual({ ok: true, amount: 39 });
    expect(checkRequest(store, "c04", "cancel_order", { orderId: "CO-48231" })).toEqual({ ok: true, amount: 159 });
    expect(checkRequest(store, "c02", "cancel_order", { orderId: "CO-48231" })).toMatchObject({ ok: false });
  });

  it("brief the agent with the customer's name, today's date, the store's policy, and order privacy", () => {
    const text = systemMessage(CUSTOMERS[0]!, shop());
    expect(text).toContain("chatting with Maya");
    expect(text).toContain("Tuesday, 2026-11-03");
    expect(text).toContain("within 30 days");
    expect(text).toContain("get_order or track_shipment");
    expect(text).toContain("resolve_conversation");
  });
});
